#!/usr/bin/env node
// PreToolUse hard-gate: blocks outbound email-send for sub-agents.
//
// Governance control (Szabi 2026-06-25, after the Boni incident: a sub-agent
// autonomously emailed a fabricated address asking for money in Szabi's name).
// Sub-agents may NOT send outbound email; any email must be routed through the
// main agent (Marveen) for approval -- only Marveen retains email-send.
//
// Why a hook and not a permissions deny-list: permissive security profiles
// launch Claude Code with --dangerously-skip-permissions, which BYPASSES the
// settings.json allow/deny list. A PreToolUse hook runs regardless of
// permission mode, so it is the only reliable mode-independent gate.
//
// This file is wired into every sub-agent's .claude/settings.json by
// writeAgentSettingsFromProfile() (agent-scaffold.ts), guarded by
// name !== MAIN_AGENT_ID, and re-applied on every spawn (respawn-safe).

import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// Bash command patterns that send mail. Read-only inspection of these tools
// (e.g. cat'ing the send script) may be caught too -- acceptable: a sub-agent
// has no legitimate need to invoke them, and the gate fails safe toward
// blocking only actual send-shaped commands.
const SEND_PATTERNS = [
  /support-mail\/send\.py/i,
  /\bsend\.py\b/i,
  /api\.resend\.com/i,
  // Bounded on purpose. Unbounded `[^\n]*` matched "resend" at offset 0 against
  // "message" 4KB later on the same line, which is every single-line JSON body
  // ever posted. Real invocations (`resend send --email ...`) are short; actual
  // API use is caught by the api.resend.com pattern above.
  /\bresend\b[^\n]{0,60}\b(email|send|message)\b/i,
  /\bsendmail\b/i,
  /\bmsmtp\b/i,
  /\bswaks\b/i,
  /\bsmtplib\b|SMTP\s*\(/i,
  /\bmail\.send\b|\bsendEmail\b/i,
  // graph-mail.ts (PR #668, M365/Exchange Online client-credentials mailbox):
  // its CLI is `tsx scripts/graph-mail.ts send ...`, which none of the above
  // patterns catch (no "sendmail"/"mail.send" substring). Also gate any direct
  // call to the exported sendMail() (e.g. a one-off `node -e`/`tsx -e` that
  // imports the module without going through the CLI).
  /\bgraph-mail\b[^\n]{0,80}\bsend\b/i,
  /\bsendMail\s*\(/i,
]

// Data-flag payloads are TRANSMITTED, not executed. Scanning them for
// send-shaped patterns is a category error, and on 2026-07-31 it cost us a
// real message: the security agent's inter-agent findings report on
// /api/subscribe was denied as "outbound email" because reviewing a
// subscription endpoint necessarily uses the words `resend` and `sendEmail`.
// A curl -d payload is one long line, so the (then unbounded) resend pattern
// spanned the whole 4KB body. The agent did the right thing -- wrote the
// findings to disk and reported the gate rather than paraphrasing until it
// passed -- but that is the failure mode that matters here: a gate whose
// false-positive mode is silent content loss TEACHES EVASION, and an agent who
// learns to reword around it has disabled the gate for everyone.
//
// The discriminator is the DESTINATION, not the vocabulary: a POST to the
// internal message bus cannot be an outbound email whatever words it carries.
// We get that by stripping provably-inert payloads before matching, which is
// strictly safer than allow-listing a URL -- the skeleton keeps the executable
// name AND the target URL, so `curl -d '<inert>' https://api.resend.com/emails`
// still denies on the URL, and `swaks --data '<inert>'` still denies on `swaks`.
//
// "Provably inert" means bash cannot execute anything inside it:
//   - single-quoted: always inert (no expansion of any kind inside '...')
//   - double-quoted: inert only with no $(...), no backtick and no ${...}
// Anything else is left in place and scanned, so the gate fails toward blocking.
const INERT_SINGLE = /'[^']*'/
const INERT_DOUBLE = /"(?:[^"\\]|\\.)*"/
const EXPANDS = /\$\(|`|\$\{/

// Long-form data flags are unambiguous on any tool. Bare `-d` is only honoured
// for HTTP clients, because `-d` is a boolean on other tools (e.g. `docker run
// -d`) and blindly stripping the token after it could swallow a real argument.
const LONG_DATA_FLAG = /(--data-urlencode|--data-binary|--data-raw|--data|--json)(\s+)/
const SHORT_DATA_FLAG = /(^|\s)(-d)(\s+)/
const HTTP_CLIENT = /\b(curl|wget|http|https|httpie)\b/i

// Replace every data-flag payload with an inert placeholder. Exported so the
// stripping is testable on its own, independent of the pattern set.
export function commandSkeleton(command) {
  let out = String(command ?? '')
  const strip = (flagRe, allowed) => {
    if (!allowed) return
    for (let guard = 0; guard < 64; guard++) {
      const m = flagRe.exec(out)
      if (!m) return
      const rest = out.slice(m.index + m[0].length)
      let q = null
      if (rest.startsWith("'")) {
        const s = INERT_SINGLE.exec(rest)
        if (s && s.index === 0) q = s[0]
      } else if (rest.startsWith('"')) {
        const s = INERT_DOUBLE.exec(rest)
        if (s && s.index === 0 && !EXPANDS.test(s[0])) q = s[0]
      }
      // Not a quoted literal (bare word, -d @file, or an expanding payload):
      // leave it alone and stop, rather than risk swallowing a real token.
      if (!q) return
      const at = m.index + m[0].length
      out = out.slice(0, at) + 'PAYLOAD' + out.slice(at + q.length)
    }
  }
  strip(LONG_DATA_FLAG, true)
  strip(SHORT_DATA_FLAG, HTTP_CLIENT.test(out))
  return out
}

// Pure decision: does this tool call send (or attempt to send) email?
export function gateDecision(toolName, toolInput) {
  const name = String(toolName ?? '')
  // Any MCP send_email tool, name-agnostic (gmail or a differently-named
  // server in a customer install -> the matcher + this both key on send_email).
  if (/send_email/i.test(name)) return { deny: true }
  if (name === 'Bash') {
    // Match against the SKELETON: the command with provably-inert transmitted
    // payloads removed. The executable name and the target URL both survive
    // stripping, so every real send still denies.
    const cmd = commandSkeleton(toolInput?.command)
    if (SEND_PATTERNS.some((re) => re.test(cmd))) return { deny: true }
  }
  return { deny: false }
}

// Pure builder for the deny message, so the brand/owner substitution is
// provable without spawning the hook. With the stock defaults (botName
// 'Marveen', ownerName 'Szabolcs') the wording is byte-identical to before.
export function buildGateMsg(botName, ownerName) {
  return (
    'Email-kuldes sub-agentkent tiltott (governance hard-gate). ' +
    `Kuldd a tervezett emailt (CIMZETT + TARGY + TELJES SZOVEG) ${botName}nek inter-agent uzenetben ` +
    `jovahagyasra; a kimeno emailt ${botName} kuldi. Csak VERIFIKALT cimre (soha nem nevbol talalt cim). ` +
    `Soha ne irj ala ${ownerName} nevevel, es soha ne kerj penzt senki neveben.`
  )
}

// Resolve the brand + owner display names for the deny message. The hook runs
// standalone (no config.ts), so read the install's .env directly, keyed off
// this file's own location (<root>/scripts/email-send-gate.mjs -> <root>/.env).
// Any failure falls back to the stock defaults, so the gate never breaks and a
// bare install keeps the original wording.
export function readBrandEnv(readFile = (p) => readFileSync(p, 'utf-8')) {
  const fallback = { botName: 'Marveen', ownerName: 'Szabolcs' }
  try {
    const envPath = join(dirname(fileURLToPath(import.meta.url)), '..', '.env')
    const raw = readFile(envPath)
    const pick = (key) => {
      const m = raw.match(new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`, 'm'))
      if (!m) return ''
      return m[1].trim().replace(/^["']|["']$/g, '').trim()
    }
    return {
      botName: pick('BOT_NAME') || fallback.botName,
      ownerName: pick('OWNER_NAME') || fallback.ownerName,
    }
  } catch {
    return fallback
  }
}

function allow() { process.exit(0) }

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }))
  process.exit(0)
}

// Run as the hook entrypoint only when invoked directly (not when imported by a
// test). Reads the PreToolUse payload from stdin and emits a deny decision for
// email-send tool calls. realpath both sides so a symlinked install path (the
// hook command is an absolute path that may traverse a symlink, e.g. /tmp ->
// /private/tmp on macOS, or a symlinked /home on Linux) still matches -- a raw
// url-vs-argv compare would silently no-op the gate (a security bypass).
function isInvokedDirectly() {
  try {
    const self = realpathSync(fileURLToPath(import.meta.url))
    const entry = process.argv[1] ? realpathSync(process.argv[1]) : ''
    return self === entry
  } catch {
    return false
  }
}
if (isInvokedDirectly()) {
  let payload
  try {
    payload = JSON.parse(readFileSync(0, 'utf-8'))
  } catch {
    allow() // malformed/empty input must never break the agent's tool calls
  }
  const { deny: shouldDeny } = gateDecision(payload?.tool_name, payload?.tool_input)
  if (shouldDeny) {
    const { botName, ownerName } = readBrandEnv()
    deny(buildGateMsg(botName, ownerName))
  }
  allow()
}

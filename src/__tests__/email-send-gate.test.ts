import { describe, it, expect } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision, commandSkeleton } from '../../scripts/email-send-gate.mjs'
import { injectEmailSendGate, agentGetsEmailGate } from '../web/agent-scaffold.js'
import { MAIN_AGENT_ID } from '../config.js'

// The PreToolUse gate decision: which tool calls count as outbound email-send.
describe('gateDecision', () => {
  it('blocks any MCP send_email tool (name-agnostic)', () => {
    expect(gateDecision('mcp__server-gmail-autoauth-mcp__send_email', {}).deny).toBe(true)
    // a differently-named gmail server in a customer install is still gated
    expect(gateDecision('mcp__some_other_gmail__send_email', {}).deny).toBe(true)
  })

  it('allows email READ/draft tools (only sending is gated)', () => {
    expect(gateDecision('mcp__server-gmail-autoauth-mcp__search_emails', {}).deny).toBe(false)
    expect(gateDecision('mcp__server-gmail-autoauth-mcp__read_email', {}).deny).toBe(false)
    expect(gateDecision('mcp__server-gmail-autoauth-mcp__draft_email', {}).deny).toBe(false)
  })

  it('blocks Bash mail-send commands', () => {
    const bash = (command: string) => gateDecision('Bash', { command })
    expect(bash('python3 scripts/support-mail/send.py --to x@y.hu').deny).toBe(true)
    expect(bash('curl -s -X POST https://api.resend.com/emails -d @body.json').deny).toBe(true)
    expect(bash('echo hi | sendmail user@host').deny).toBe(true)
    expect(bash('swaks --to a@b.c --server smtp').deny).toBe(true)
  })

  it('blocks the graph-mail.ts CLI send path (PR #668) and direct sendMail() calls', () => {
    const bash = (command: string) => gateDecision('Bash', { command })
    expect(bash('tsx scripts/graph-mail.ts send --to a@b.hu --subject x --body y').deny).toBe(true)
    expect(bash('npx tsx scripts/graph-mail.ts send --to a@b.hu --subject x --body y').deny).toBe(true)
    expect(bash(`node -e "require('./src/graph-mail.js').sendMail({to:'a@b.hu'})"`).deny).toBe(true)
    // read-only graph-mail subcommands are NOT send-shaped, so they pass through
    // this gate untouched (they still can't do anything a sub-agent shouldn't:
    // verify/list only read the scoped mailbox)
    expect(bash('tsx scripts/graph-mail.ts verify').deny).toBe(false)
    expect(bash('tsx scripts/graph-mail.ts list --unread').deny).toBe(false)
  })

  it('allows ordinary Bash that does not send mail', () => {
    const bash = (command: string) => gateDecision('Bash', { command })
    expect(bash('git status').deny).toBe(false)
    expect(bash('npm run build').deny).toBe(false)
    expect(bash('curl -s http://localhost:3420/api/messages').deny).toBe(false)
    // mentioning "resend" without an email/send verb nearby is not gated
    expect(bash('grep resend src/foo.ts').deny).toBe(false)
  })

  // 2026-07-31: the security agent's inter-agent findings report on
  // /api/subscribe was denied as "outbound email" because reviewing a
  // subscription endpoint necessarily says `resend` and `sendEmail`. The
  // payload is DATA on its way to the internal bus, never a command.
  it('does not gate an inter-agent bus POST whose PAYLOAD merely discusses email', () => {
    const bash = (command: string) => gateDecision('Bash', { command })
    const body = JSON.stringify({
      from: 'security',
      to: 'po',
      content:
        '[SECURITY] /api/subscribe review. The endpoint uses Resend as the provider and ' +
        'returns an identical 200 for an already-subscribed address, preventing enumeration. ' +
        'No resend of the confirmation email fires on a duplicate, so there is no message ' +
        'amplification path. sendEmail() is never reached without a validated address.',
    })
    expect(bash(`curl -s -X POST http://localhost:3420/api/messages -d '${body}'`).deny).toBe(false)
    expect(bash(`curl -s -X POST http://localhost:3420/api/messages --json '${body}'`).deny).toBe(false)
    // the same prose in a double-quoted payload with nothing expandable in it
    expect(bash('curl -X POST http://localhost:3420/api/messages -d "a resend of the email"').deny).toBe(false)
  })

  // The stripping must never become a bypass. Each of these carries an inert
  // payload AND a real send, and the real send is what the gate must see.
  it('still blocks a real send that hides behind an inert payload', () => {
    const bash = (command: string) => gateDecision('Bash', { command })
    // the target URL survives stripping
    expect(bash(`curl -X POST https://api.resend.com/emails -d '{"to":"a@b.c"}'`).deny).toBe(true)
    // the executable name survives stripping
    expect(bash(`swaks --data 'Subject: hi' --to a@b.c`).deny).toBe(true)
    expect(bash(`python3 scripts/support-mail/send.py --data '{"x":1}'`).deny).toBe(true)
    // a payload that CAN expand is not inert, so it is scanned in full
    expect(bash(`curl -X POST http://localhost:3420/api/messages -d "$(cat mail | sendmail a@b.c)"`).deny).toBe(true)
    expect(bash('curl -X POST http://localhost:3420/api/messages -d "`swaks --to a@b.c`"').deny).toBe(true)
    // a command chained after the bus POST is still in the skeleton
    expect(bash(`curl -X POST http://localhost:3420/api/messages -d '{"a":1}' ; sendmail a@b.c`).deny).toBe(true)
    // -d is only treated as a data flag for HTTP clients, so this is not stripped
    expect(bash(`runner -d 'scripts/support-mail/send.py'`).deny).toBe(true)
    // single quotes that are NOT a data-flag payload are left alone (they execute)
    expect(bash(`bash -c 'python3 scripts/support-mail/send.py --to a@b.c'`).deny).toBe(true)
  })
})

// The skeleton itself, independent of the pattern set.
describe('commandSkeleton', () => {
  it('replaces inert data-flag payloads and keeps everything else', () => {
    expect(commandSkeleton(`curl -d '{"a":1}' https://x.test/y`)).toBe('curl -d PAYLOAD https://x.test/y')
    expect(commandSkeleton(`curl --data "plain text" https://x.test/y`)).toBe('curl --data PAYLOAD https://x.test/y')
  })

  it('leaves an expandable payload in place (it can execute)', () => {
    const cmd = 'curl -d "$(whoami)" https://x.test/y'
    expect(commandSkeleton(cmd)).toBe(cmd)
  })

  it('leaves -d alone when the command is not an HTTP client', () => {
    const cmd = `docker run -d 'sendmail'`
    expect(commandSkeleton(cmd)).toBe(cmd)
  })

  it('leaves -d @file alone (there is no literal payload to strip)', () => {
    const cmd = 'curl -d @body.json https://x.test/y'
    expect(commandSkeleton(cmd)).toBe(cmd)
  })
})

// The main-exempt guard: every sub-agent is gated, the main agent never is.
// Mirrors security-profile-resolution.test.ts -- pure, keyed on the configured
// MAIN_AGENT_ID (not a hardcoded name), so a customer install exempts its own owner.
describe('agentGetsEmailGate', () => {
  it('gates every sub-agent', () => {
    expect(agentGetsEmailGate('samu')).toBe(true)
    expect(agentGetsEmailGate('boni')).toBe(true)
    expect(agentGetsEmailGate('zara')).toBe(true)
  })

  it('NEVER gates the main agent (it retains email-send)', () => {
    expect(agentGetsEmailGate(MAIN_AGENT_ID)).toBe(false)
  })
})

// The settings.json wiring that installs the hook for a sub-agent.
describe('injectEmailSendGate', () => {
  it('adds the PreToolUse email-gate hook', () => {
    const s: Record<string, unknown> = {}
    injectEmailSendGate(s)
    const hooks = (s.hooks as Record<string, unknown>).PreToolUse as Array<Record<string, unknown>>
    expect(hooks).toHaveLength(1)
    expect(hooks[0].matcher).toBe('Bash|send_email')
    const inner = (hooks[0].hooks as Array<{ command: string }>)[0]
    expect(inner.command).toContain('email-send-gate.mjs')
  })

  it('is idempotent (no duplicate entries on re-apply / respawn)', () => {
    const s: Record<string, unknown> = {}
    injectEmailSendGate(s)
    injectEmailSendGate(s)
    injectEmailSendGate(s)
    const hooks = (s.hooks as Record<string, unknown>).PreToolUse as unknown[]
    expect(hooks).toHaveLength(1)
  })

  it('preserves existing hooks (e.g. PreCompact) and other PreToolUse entries', () => {
    const s: Record<string, unknown> = {
      hooks: {
        PreCompact: [{ matcher: 'auto', hooks: [{ type: 'agent', prompt: 'x' }] }],
        PreToolUse: [{ matcher: 'WebFetch', hooks: [{ type: 'command', command: 'other.sh' }] }],
      },
    }
    injectEmailSendGate(s)
    const hooks = s.hooks as Record<string, unknown>
    expect((hooks.PreCompact as unknown[]).length).toBe(1)
    const pre = hooks.PreToolUse as Array<Record<string, unknown>>
    // the unrelated WebFetch entry is kept, the email-gate is appended
    expect(pre).toHaveLength(2)
    expect(pre.some((e) => JSON.stringify(e).includes('email-send-gate.mjs'))).toBe(true)
    expect(pre.some((e) => e.matcher === 'WebFetch')).toBe(true)
  })
})

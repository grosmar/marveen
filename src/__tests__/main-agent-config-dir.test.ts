import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// MAIN_AGENT_CONFIG_DIR: an EXPLICIT CLAUDE_CONFIG_DIR for the main channels
// agent, for the operator whose bot has its own Claude login (separate from the
// fleet's). Distinct from MAIN_AGENT_ISOLATED_CONFIG, which authenticates from
// the fleet setup-token and therefore cannot keep the two identities apart.
let SANDBOX = ''
let SETTING = ''

vi.mock('node:os', async (orig) => {
  const actual = await orig<typeof import('node:os')>()
  return { ...actual, homedir: () => join(SANDBOX, 'home') }
})
vi.mock('../settings-store.js', async (orig) => {
  const actual = await orig<typeof import('../settings-store.js')>()
  return {
    ...actual,
    getEffectiveSettingValue: (key: string) =>
      key === 'MAIN_AGENT_CONFIG_DIR' ? SETTING : actual.getEffectiveSettingValue(key),
  }
})

const { resolveMainAgentConfigDir } = await import('../web/agent-process.js')

beforeEach(() => {
  SANDBOX = mkdtempSync(join(tmpdir(), 'maincfg-'))
  mkdirSync(join(SANDBOX, 'home', '.claude-bot'), { recursive: true })
  SETTING = ''
})
afterEach(() => {
  rmSync(SANDBOX, { recursive: true, force: true })
})

describe('resolveMainAgentConfigDir', () => {
  it('returns null when the setting is unset (shared ~/.claude, unchanged default)', () => {
    expect(resolveMainAgentConfigDir()).toBeNull()
  })

  it('resolves an absolute path that exists', () => {
    SETTING = join(SANDBOX, 'home', '.claude-bot')
    expect(resolveMainAgentConfigDir()).toBe(join(SANDBOX, 'home', '.claude-bot'))
  })

  it('expands a leading ~ against the home dir', () => {
    SETTING = '~/.claude-bot'
    expect(resolveMainAgentConfigDir()).toBe(join(SANDBOX, 'home', '.claude-bot'))
  })

  it('returns null (not the unresolved path) when the dir does not exist', () => {
    // Falling back to the shared root is the safe failure: launching with a
    // non-existent CLAUDE_CONFIG_DIR would start the bot logged-out.
    SETTING = join(SANDBOX, 'home', '.claude-nope')
    expect(resolveMainAgentConfigDir()).toBeNull()
  })

  it('trims surrounding whitespace from a hand-edited .env value', () => {
    SETTING = `  ${join(SANDBOX, 'home', '.claude-bot')}  `
    expect(resolveMainAgentConfigDir()).toBe(join(SANDBOX, 'home', '.claude-bot'))
  })
})

describe('launcher wiring', () => {
  const HELPER = readFileSync(join(__dirname, '../../scripts/main-agent-isolated-config.mjs'), 'utf-8')
  const CHANNELS = readFileSync(join(__dirname, '../../scripts/channels.sh'), 'utf-8')

  it('the helper prefers the explicit dir over the isolated one', () => {
    expect(HELPER).toMatch(/const explicit = resolveMainAgentConfigDir\(\)[\s\S]*if \(explicit\)/)
  })

  it('the helper tags each path with its mode so the caller knows how to authenticate', () => {
    expect(HELPER).toMatch(/explicit\\t/)
    expect(HELPER).toMatch(/isolated\\t/)
  })

  it('channels.sh injects the fleet token for an explicit dir ONLY when it has no creds of its own', () => {
    // Original contract: an explicit dir carries its OWN .credentials.json, so exporting the
    // fleet token would silently authenticate the bot AS THE FLEET.
    // Refined since: a freshly provisioned explicit dir (install --isolate) has no
    // credentials yet, and without a token the agent parks on the OAuth sign-in screen and
    // the channel never attaches. The seed IS therefore allowed -- but ONLY behind an
    // explicit "this dir has no .credentials.json" guard, which is what preserves the
    // invariant. (This test asserted the absolute form and had been red ever since.)
    const explicitBranch = CHANNELS.match(/if \[ "\$_cfg_mode" = "explicit" \]; then\n([\s\S]*?)\n\s*else/)
    expect(explicitBranch).not.toBeNull()
    const body = explicitBranch![1]
    expect(body).toMatch(/CLAUDE_CONFIG_DIR/)
    if (/CLAUDE_CODE_OAUTH_TOKEN/.test(body)) {
      const guard = /\[ ! -f "\$_cfg_dir\/\.credentials\.json" \]/
      expect(body).toMatch(guard)
      expect(body.indexOf('CLAUDE_CODE_OAUTH_TOKEN')).toBeGreaterThan(body.search(guard))
    }
  })

  it('credential publication keys on CONFIG isolation only, and the fallback never overrides a real login', () => {
    // Regression guard (2026-07-29): CHANNEL_STATE_DIR used to flip the credential-
    // publication gate too. An install with no MAIN_AGENT_CONFIG_DIR builds no CFG_ENV, so
    // the tmux global env was its ONLY token path -- setting CHANNEL_STATE_DIR (for the
    // shared-bot-token fix) silently cut it off and the main agent ran with NO credentials:
    // every prompt returned "Not logged in - Please run /login". The launch command now
    // seeds the token itself, but must never override a deliberate interactive login.
    expect(CHANNELS).toMatch(/if \[ -n "\$\{MAIN_AGENT_CONFIG_DIR:-\$_main_cfg_env\}" \]; then _iso_install=1; fi/)
    expect(CHANNELS).not.toMatch(/\|\| \[ -n "\$\{CHANNEL_STATE_DIR:-\}" \]; then _iso_install=1/)
    const fb = CHANNELS.match(/if \[ -z "\$CFG_ENV" \][\s\S]*?\n  fi/)
    expect(fb).not.toBeNull()
    expect(fb![0]).toMatch(/\.claude-oauth-token/)
    expect(fb![0]).toMatch(/! -f "\$\{HOME\}\/\.claude\/\.credentials\.json"/)
  })
})

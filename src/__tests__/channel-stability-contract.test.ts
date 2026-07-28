import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Contract tests for the durable Telegram-channel stabilization (source-fix +
// contract-test per Bug-Discipline). These lock the shell/systemd invariants
// that have no other test surface: they read the REAL files and assert the
// fix is present, so a future edit that regresses one of them fails CI.

const ROOT = join(__dirname, '..', '..')
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8')

// Helper: extract a systemd INI section body ([Unit], [Service], ...). Only a
// line that is EXACTLY `[Header]` is a section boundary, so `[Unit]`/`[Service]`
// appearing inside a comment does not confuse it.
function section(content: string, name: string): string {
  let inSection = false
  const body: string[] = []
  for (const line of content.split('\n')) {
    const m = line.match(/^\[([A-Za-z]+)\]\s*$/)
    if (m) { inSection = m[1] === name; continue }
    if (inSection) body.push(line)
  }
  return body.join('\n')
}

// Strip comments so a contract assertion checks actual code, not the prose that
// explains it (e.g. a comment saying "NEVER systemctl restart").
const stripBashComments = (s: string) => s.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')
const stripTsComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n')

describe('P1#1 — channels.sh puts the OAuth token into the tmux SERVER global env', () => {
  const sh = read('scripts/channels.sh')

  it('calls tmux set-environment -g CLAUDE_CODE_OAUTH_TOKEN', () => {
    expect(sh).toMatch(/set-environment -g CLAUDE_CODE_OAUTH_TOKEN/)
  })

  it('does so BEFORE the new-session (launch-order independent)', () => {
    const setIdx = sh.indexOf('set-environment -g CLAUDE_CODE_OAUTH_TOKEN')
    const newSessionIdx = sh.indexOf('new-session -d')
    expect(setIdx).toBeGreaterThan(-1)
    expect(newSessionIdx).toBeGreaterThan(-1)
    expect(setIdx).toBeLessThan(newSessionIdx)
  })
})

describe('P1#2 — marveen-channels.service Restart=always + StartLimit in [Unit]', () => {
  const unit = read('scripts/systemd/marveen-channels.service')

  it('Restart=always (not on-failure)', () => {
    expect(section(unit, 'Service')).toMatch(/^\s*Restart=always\s*$/m)
    expect(unit).not.toMatch(/Restart=on-failure/)
  })

  it('StartLimitIntervalSec + StartLimitBurst are in [Unit], not [Service]', () => {
    const u = section(unit, 'Unit')
    const s = section(unit, 'Service')
    expect(u).toMatch(/StartLimitIntervalSec=/)
    expect(u).toMatch(/StartLimitBurst=/)
    expect(s).not.toMatch(/StartLimitIntervalSec=/)
    expect(s).not.toMatch(/StartLimitBurst=/)
  })
})

describe('P1#3 — .bun/bin PATH on every claude (re)spawn path', () => {
  it('channels.sh exports a PATH containing .bun/bin', () => {
    expect(read('scripts/channels.sh')).toMatch(/export PATH="[^"]*\.bun\/bin/)
  })
  // SUPERSEDED (asserted a design channel-watchdog.sh deliberately abandoned): it no
  // longer (re)spawns claude at all, so it has no spawn PATH to get .bun/bin onto. The
  // requirement only binds a script that STARTS a claude; assert that property instead of
  // an export that would now be dead code.
  it('the channel watchdog does not spawn claude, so it needs no .bun/bin spawn PATH', () => {
    const sh = stripBashComments(read('scripts/channel-watchdog.sh'))
    expect(sh).not.toMatch(/respawn-pane/)
    expect(sh).not.toMatch(/new-session/)
    // If it ever regains a spawn path, it must carry the PATH export again.
    if (/respawn-pane|new-session/.test(sh)) {
      expect(sh).toMatch(/export PATH=\\?"[^"]*\.bun\/bin/)
    }
  })
  // buildMainSessionRespawnCmd (dashboard respawn) is locked in
  // channel-deafness-recovery.test.ts; agent-process.ts startAgentProcess is
  // a runtime template -- assert its source carries the export here too.
  it('agent-process.ts sub-agent launch exports .bun/bin', () => {
    expect(read('src/web/agent-process.ts')).toMatch(/export PATH=[^\n]*\.bun\/bin/)
  })
})

describe('P2#4 — independent systemd-timer watchdog', () => {
  const sh = read('scripts/channel-watchdog.sh')
  const timer = read('scripts/systemd/channel-watchdog.timer')

  it('NEVER uses systemctl restart (would kill the shared tmux server / all agents)', () => {
    expect(stripBashComments(sh)).not.toMatch(/systemctl\s+(--user\s+)?restart/)
  })
  it('runs every 5 minutes', () => {
    expect(timer).toMatch(/OnUnitActiveSec=5min/)
  })

  // The three cases below replace assertions on a design this watchdog deliberately
  // abandoned (respawn-pane + GRACE_SECONDS/MAX_CONSECUTIVE + the .channel-last-respawn
  // stamp). Respawning destroys the session's conversation context, so it now FLAGS and
  // ESCALATES instead -- the house rule that a watchdog never blindly resets a live
  // session. They had been red ever since, i.e. guarding nothing; these guard the rule
  // that actually holds now.
  it('never destroys a live session: no respawn-pane, no kill-session, no systemctl stop', () => {
    const code = stripBashComments(sh)
    expect(code).not.toMatch(/respawn-pane/)
    expect(code).not.toMatch(/kill-session/)
    expect(code).not.toMatch(/systemctl\s+(--user\s+)?stop/)
  })

  it('recovers only by STARTING a dead unit, rate-limited so it cannot storm', () => {
    const code = stripBashComments(sh)
    // Starting an inactive unit is the one safe action (restart/stop would kill the
    // shared tmux server in that cgroup, taking every agent session with it).
    expect(code).toMatch(/systemctl\s+(--user\s+)?start|sctl\s+start/)
    // Every escalation/action path is cooldown-guarded.
    expect(code).toMatch(/SVC_START_GRACE=/)
    expect(code).toMatch(/ESCALATE_COOLDOWN=/)
  })

  it('escalates to a human rather than acting when the evidence is ambiguous', () => {
    const code = stripBashComments(sh)
    expect(code).toMatch(/page_\w+\(\)|page_\w+ /)          // a direct-page path exists
    expect(code).toMatch(/_PAGE_COOLDOWN=|PAGE_COOLDOWN=/)  // and it is rate-limited
  })

  // The dashboard still honours the shared respawn stamp for ITS own respawn path; that
  // side of the contract is unchanged even though this watchdog no longer writes it.
  it('the dashboard side still honours the shared respawn stamp', () => {
    expect(read('src/web/channel-monitor.ts')).toMatch(/\.channel-last-respawn/)
  })
})

describe('P2#5 — dashboard restart routes the main agent through respawn-pane (no /remote-control, no systemctl)', () => {
  const agents = read('src/web/routes/agents.ts')
  it('the restart route delegates the main agent to hardRestartMarveenChannels', () => {
    expect(agents).toMatch(/isMainChannelsAgent\(name\)/)
    expect(agents).toMatch(/hardRestartMarveenChannels\(\)/)
  })
  it('hardRestartMarveenChannels never systemctl-restarts (respawn-pane only on Linux)', () => {
    const cm = stripTsComments(read('src/web/channel-monitor.ts'))
    // The function must not shell out to `systemctl --user restart` for the unit.
    expect(cm).not.toMatch(/systemctl[^\n]*restart/)
  })
})

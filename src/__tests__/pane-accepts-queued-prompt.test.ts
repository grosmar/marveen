import { describe, it, expect } from 'vitest'
import { paneLooksIdle, paneAcceptsQueuedPrompt, detectPaneState } from '../pane-state.js'

// Unit tests for paneAcceptsQueuedPrompt -- the readiness predicate used by the
// INTER-AGENT MESSAGE ROUTER (and nothing else).
//
// The premise, checked on a live pane before this was written (2026-07-31):
// Claude Code QUEUES a prompt typed during a running turn and replays it at the
// turn boundary. A busy pane renders "Press up to edit queued messages" in the
// input box while the `bypass permissions` footer keeps rendering right next to
// `esc to interrupt`. So "the agent is mid-turn" was never a reason delivery
// had to wait -- and making it one is what let an inbox drain only as fast as
// its OWNER finished turns. The po hub, which takes the longest turns in the
// fleet, sat on a 31-deep queue for that reason alone.
//
// What this predicate must still REFUSE is unchanged and is the point of the
// second half of these tests: a dead/undrawn TUI, and real half-typed text in
// the box (a delivery would concatenate into it and garble both).
//
// Deterministic string->bool only; no tmux, no timers, no LLM behaviour.
// Fixtures reproduce real `tmux capture-pane -p` bytes (U+2500 ─ separators,
// U+276F ❯ prompt, U+23F5 ⏵ footer chevrons, U+00B7 · footer dot).

const SEP = '─'.repeat(80)
const IDLE_FOOTER = '  ⏵⏵ bypass permissions on (shift+tab to cycle)'
// The real busy footer: the idle marker and the busy marker on ONE line. This
// exact shape is why the old gate could never deliver mid-turn.
const BUSY_FOOTER = '  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt · ctrl+t to…'

const pane = (boxLine: string, footer: string): string =>
  ['  ⏺ some earlier tool output', '', SEP, boxLine, SEP, footer].join('\n')

// A busy pane with an EMPTY input box.
const BUSY_EMPTY_BOX = pane('❯ ', BUSY_FOOTER)

// A busy pane showing the queued-messages hint. Plain capture-pane renders this
// as ❯ followed by text, i.e. indistinguishable from parked input without the
// dim-stripped read -- the trap this predicate has to walk past.
const BUSY_QUEUED_HINT = pane('❯  Press up to edit queued messages', BUSY_FOOTER)
// ...and the dim-stripped (-e) view of the same pane, where the hint is gone
// because it renders faint.
const BUSY_QUEUED_HINT_DIMSTRIPPED = pane('❯ ', BUSY_FOOTER)

// A busy pane with REAL typed text parked in the box: present in BOTH views.
const BUSY_REAL_PARKED = pane('❯ half a sentence the operator was typing', BUSY_FOOTER)

const IDLE_EMPTY_BOX = pane('❯ ', IDLE_FOOTER)

// No footer at all: a session whose TUI has not drawn (or has died). There is
// nothing to confirm the pane can receive anything.
const NO_FOOTER = ['  Welcome', '', SEP, '❯ ', SEP].join('\n')

describe('paneAcceptsQueuedPrompt', () => {
  it('accepts a BUSY pane with an empty input box (the whole point)', () => {
    expect(detectPaneState(BUSY_EMPTY_BOX)).toBe('busy')
    expect(paneLooksIdle(BUSY_EMPTY_BOX)).toBe(false) // old gate refused it
    expect(paneAcceptsQueuedPrompt(BUSY_EMPTY_BOX, null)).toBe(true)
  })

  it('accepts a busy pane whose box holds only the dim queued-messages hint', () => {
    // Plain view alone looks like parked text, so the plain-only answer is no...
    expect(paneAcceptsQueuedPrompt(BUSY_QUEUED_HINT, null)).toBe(false)
    // ...and the dim-stripped read is what rescues it. Without this, the router
    // would refuse precisely the sessions that already have a queue.
    expect(paneAcceptsQueuedPrompt(BUSY_QUEUED_HINT, BUSY_QUEUED_HINT_DIMSTRIPPED)).toBe(true)
  })

  it('still accepts an ordinary idle pane', () => {
    expect(paneAcceptsQueuedPrompt(IDLE_EMPTY_BOX, null)).toBe(true)
  })

  it('REFUSES a pane with real parked text, busy or not', () => {
    // Present in the dim-stripped view too, so it is genuine input, not chrome.
    expect(paneAcceptsQueuedPrompt(BUSY_REAL_PARKED, BUSY_REAL_PARKED)).toBe(false)
  })

  it('REFUSES a pane with no footer (TUI dead or not yet drawn)', () => {
    expect(paneAcceptsQueuedPrompt(NO_FOOTER, null)).toBe(false)
  })

  it('REFUSES an empty capture', () => {
    expect(paneAcceptsQueuedPrompt('', null)).toBe(false)
  })
})

describe('detectPaneState ignoreBusy option', () => {
  it('is opt-in: the default classification is untouched', () => {
    // Every existing caller keeps the strict gate. If this ever flips, the
    // scheduler and keepalive start piling work onto mid-turn agents.
    expect(detectPaneState(BUSY_EMPTY_BOX)).toBe('busy')
    expect(detectPaneState(BUSY_EMPTY_BOX, {})).toBe('busy')
  })

  it('reports what the pane would be if it were not mid-turn', () => {
    expect(detectPaneState(BUSY_EMPTY_BOX, { ignoreBusy: true })).toBe('idle')
    expect(detectPaneState(BUSY_REAL_PARKED, { ignoreBusy: true })).toBe('typing')
  })

  it('does not resurrect a pane that is broken for other reasons', () => {
    expect(detectPaneState(NO_FOOTER, { ignoreBusy: true })).not.toBe('idle')
  })
})

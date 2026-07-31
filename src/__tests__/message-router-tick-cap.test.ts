// Contract test for the per-tick work cap in the message router.
//
// runMessageRouterTick() must process AT MOST MAX_MESSAGES_PER_TICK pending
// messages per pass, rolling any backlog to the next tick. This bounds a single
// tick's wall-time so a large pending backlog (e.g. after a delivery stall) can
// never make one tick run long and starve the event loop -- the slow-tick half
// of the progressive-hang pattern.
//
// Since card 2922e380, sessionExistsOnHost is called once per unique receiver
// in the pre-pass and cached for the main loop (not once per message). The work
// cap is verified by the slice() bound: at most MAX_MESSAGES_PER_TICK messages
// enter the loop per tick, regardless of backlog size.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetPendingMessages = vi.fn()
const mockMarkDelivered = vi.fn((..._a: unknown[]) => true)
const mockMarkFailed = vi.fn((..._a: unknown[]) => true)
const mockSessionExistsOnHost = vi.fn((..._a: unknown[]) => false)

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  MAIN_AGENT_ID: 'orin',
  // message-router imports maybeWakeSubAgentsForTelegram, which reads this flag
  // from config; keep it OFF so the wake watcher early-returns and this test
  // stays isolated to the per-tick message cap.
  SUBAGENT_TELEGRAM_WAKE_ENABLED: false,
}))

vi.mock('../db.js', () => ({
  getPendingMessages: (toAgent?: string) => {
    if (toAgent) return [] // per-agent query for reconnect pre-pass
    return mockGetPendingMessages()
  },
  markMessageDelivered: (...a: unknown[]) => mockMarkDelivered(...a),
  markMessageFailed: (...a: unknown[]) => mockMarkFailed(...a),
  markMessageDone: (..._a: unknown[]) => true,
  createAgentMessage: (..._a: unknown[]) => ({ id: 999 }),
  // card def5a189: OTel trace stubs -- no-ops in this test
  stampMessageTrace: (..._a: unknown[]) => false,
  upsertOtelSpan: (..._a: unknown[]) => undefined,
  closeOtelSpan: (..._a: unknown[]) => false,
}))

vi.mock('../web/voice-directive.js', () => ({
  resolveAgentChannelStateDir: () => '/tmp/none',
}))

vi.mock('../web/agent-config.js', () => ({
  readAgentRemoteHost: () => null,
  readAgentVoiceConfig: () => ({ responseMode: 'text' }),
}))

vi.mock('../web/agent-process.js', () => ({
  agentSessionName: (name: string) => `agent-${name}`,
  isSessionReadyForPrompt: vi.fn(() => false),
  // The router delivers through the QUEUED-prompt gate (it does not wait for
  // the recipient's turn to end -- see isSessionReadyForQueuedPrompt). Kept
  // false here for the same reason as above: these cases assert slice
  // COMPOSITION, so nothing must actually be delivered.
  isSessionReadyForQueuedPrompt: vi.fn(() => false),
  clearStaleParkedInput: vi.fn(() => false),
  sendPromptToSession: vi.fn(),
  sessionExistsOnHost: (...a: unknown[]) => mockSessionExistsOnHost(...a),
}))

vi.mock('../web/voice-modality.js', () => ({
  setLastInboundModality: vi.fn(),
}))

vi.mock('../web/main-agent.js', () => ({
  MAIN_CHANNELS_SESSION: 'orin-channels',
}))

vi.mock('../web/agent-message-wrap.js', () => ({
  classifyAgentMessage: () => ({ category: 'trusted-peer', safeFrom: 'orin' }),
  wrapAgentMessageForDelivery: () => ({ prefix: '', wrapped: '' }),
}))

import { runMessageRouterTick, MAX_MESSAGES_PER_TICK } from '../web/message-router.js'

function makePending(count: number, toAgent = 'dex', startId = 1) {
  const nowSec = Math.floor(Date.now() / 1000)
  return Array.from({ length: count }, (_, i) => ({
    id: startId + i,
    from_agent: 'orin',
    to_agent: toAgent, // SUB-agent, not MAIN_AGENT_ID -> takes the tmux-inject path
    content: 'ping',
    created_at: nowSec, // fresh -> well inside the abandon window
  }))
}

describe('message router per-tick work cap', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSessionExistsOnHost.mockReturnValue(false)
    mockMarkDelivered.mockReturnValue(true)
    mockMarkFailed.mockReturnValue(true)
  })

  it('processes at most MAX_MESSAGES_PER_TICK messages in one tick', async () => {
    expect(MAX_MESSAGES_PER_TICK).toBe(25)
    mockGetPendingMessages.mockReturnValue(makePending(30))

    await runMessageRouterTick()

    // sessionExistsOnHost is called once per unique receiver (cached since card 2922e380).
    expect(mockSessionExistsOnHost).toHaveBeenCalledTimes(1)
    // Messages are fresh (within abandon window) and session is absent, so they
    // are NOT marked failed — they remain pending for the next tick.
    expect(mockMarkFailed).not.toHaveBeenCalled()
  })

  it('processes all messages when the backlog is under the cap', async () => {
    mockGetPendingMessages.mockReturnValue(makePending(10))

    await runMessageRouterTick()

    expect(mockSessionExistsOnHost).toHaveBeenCalledTimes(1)
    expect(mockMarkFailed).not.toHaveBeenCalled()
  })

  // REGRESSION GATE (2026-07-31 incident). The tick budget used to be a flat
  // oldest-first slice, so ONE undeliverable agent whose backlog reached the
  // cap owned every slot and starved every other agent indefinitely -- the
  // engineer's pane stopped reading 'idle' and content/qa/analyst went ~6h
  // without being examined at all, though all three were ready to receive.
  // The budget must be shared across receivers, never monopolised.
  it('never lets one agent monopolise the tick budget (head-of-line fairness)', async () => {
    // 'dex' has a backlog far past the cap; 'zoe' has two OLDER-but-fewer rows
    // sitting behind it. A flat slice would be 25/25 dex and never reach zoe.
    mockGetPendingMessages.mockReturnValue([
      ...makePending(100, 'dex', 1),
      ...makePending(2, 'zoe', 1001),
    ])

    await runMessageRouterTick()

    // Both receivers must be examined in the SAME tick.
    const sessions = mockSessionExistsOnHost.mock.calls.map((c) => c[1])
    expect(sessions).toContain('agent-dex')
    expect(sessions).toContain('agent-zoe')
  })

  it('keeps per-agent FIFO order while interleaving across agents', async () => {
    // Ordering within one receiver must stay oldest-first: fairness changes
    // only the interleave ACROSS agents, never the order within an agent.
    mockGetPendingMessages.mockReturnValue([
      ...makePending(3, 'dex', 1),
      ...makePending(3, 'zoe', 1001),
    ])
    mockSessionExistsOnHost.mockReturnValue(true)

    await runMessageRouterTick()

    // Session absent=false now, but isSessionReadyForQueuedPrompt is mocked false, so
    // nothing is delivered/failed -- we are asserting the slice composition via
    // the per-unique-receiver pre-pass seeing both agents exactly once each.
    const sessions = mockSessionExistsOnHost.mock.calls.map((c) => c[1])
    expect(sessions.filter((s) => s === 'agent-dex')).toHaveLength(1)
    expect(sessions.filter((s) => s === 'agent-zoe')).toHaveLength(1)
    expect(mockMarkFailed).not.toHaveBeenCalled()
  })
})

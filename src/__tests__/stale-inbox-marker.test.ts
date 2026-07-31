// The STALE-INBOX marker on bus delivery.
//
// qa measured on 2026-07-31 that a lane which falls behind is served an OLD id
// band and cannot tell from the inside: silence, a stale premise and a current
// inbox are indistinguishable to the agent receiving them. Both affected agents
// reasoned confidently from hours-old state. The PO escalated that the engineer
// had gone silent while nine of the engineer's replies sat undelivered, and the
// engineer spent an entire build implementing a PO ruling that had been
// WITHDRAWN before they started (+154 uncommitted lines in a deploy-affecting
// gate script, built correctly to an instruction that no longer existed).
//
// So the router now states the lag in the prefix. These tests pin the two
// properties that decide whether it helps or becomes noise: it must be SILENT
// on a healthy fleet, and when it fires it must carry the number that changes
// behaviour (newer messages from the SAME sender, where a withdrawal lives).
import { describe, it, expect, beforeAll } from 'vitest'
import { formatInboundLag, wrapAgentMessageForDelivery } from '../web/agent-message-wrap.js'
import { initDatabase, createAgentMessage, getInboundLag } from '../db.js'

beforeAll(() => { initDatabase(':memory:') })

describe('stale-inbox marker', () => {
  it('is silent on a healthy fleet: fresh message, quiet bus', () => {
    expect(formatInboundLag({ ageSeconds: 12, newerTotal: 3, newerFromSender: 0 })).toBe('')
    expect(formatInboundLag({ ageSeconds: 599, newerTotal: 99, newerFromSender: 4 })).toBe('')
    expect(formatInboundLag(null)).toBe('')
    expect(formatInboundLag(undefined)).toBe('')
  })

  it('fires on age alone, even when the bus is quiet', () => {
    const s = formatInboundLag({ ageSeconds: 3600, newerTotal: 2, newerFromSender: 0 })
    expect(s).toMatch(/STALE-INBOX/)
    expect(s).toMatch(/60m ago/)
    expect(s).toMatch(/No newer message from this sender/)
  })

  it('fires on id gap alone, even when the message is recent', () => {
    // The qa case: delivery was live and stamping, the lane was just ~250 ids
    // behind. Nothing about the age of one row reveals that.
    const s = formatInboundLag({ ageSeconds: 30, newerTotal: 250, newerFromSender: 9 })
    expect(s).toMatch(/250 bus rows newer/)
  })

  it('leads with the actionable number: newer messages from the SAME sender', () => {
    const s = formatInboundLag({ ageSeconds: 7200, newerTotal: 400, newerFromSender: 9 })
    expect(s).toMatch(/9 newer message\(s\) from THIS SENDER/)
    expect(s).toMatch(/withdrawal or correction lives there/)
    // Exactly the engineer's case: hours old, and the instruction was withdrawn
    // in a later message from the same sender.
    expect(s).toMatch(/2h ago/)
  })

  it('rounds to hours past 2h so a very old message does not read as "480m"', () => {
    expect(formatInboundLag({ ageSeconds: 28800, newerTotal: 500, newerFromSender: 1 })).toMatch(/8h ago/)
    expect(formatInboundLag({ ageSeconds: 5400, newerTotal: 500, newerFromSender: 1 })).toMatch(/90m ago/)
  })

  it('rides in the prefix, never inside the sender-controlled frame', () => {
    const lag = { ageSeconds: 4000, newerTotal: 300, newerFromSender: 2 }
    const { prefix, wrapped } = wrapAgentMessageForDelivery(
      'trusted-peer', 'po', 'po', 'body text', 4242, null, lag,
    )
    // The receiver must not be able to be lied to about its own lag by a sender
    // who writes "STALE-INBOX" into a message body, so the marker lives with
    // the router's metadata and the frame stays exactly the sender's content.
    expect(prefix).toMatch(/STALE-INBOX/)
    expect(prefix).toMatch(/msg_id:4242/)
    expect(wrapped).not.toMatch(/STALE-INBOX/)
    expect(wrapped).toContain('body text')
  })

  it('marks a stale channel-inbound message too', () => {
    const { prefix } = wrapAgentMessageForDelivery(
      'channel-inbound', 'telegram-coordinator', 'telegram-coordinator', '<channel>hi</channel>',
      1, null, { ageSeconds: 5000, newerTotal: 400, newerFromSender: 0 },
    )
    expect(prefix).toMatch(/STALE-INBOX/)
  })

  it('adds nothing to a healthy delivery (byte-identical to the no-lag wrap)', () => {
    const healthy = { ageSeconds: 5, newerTotal: 1, newerFromSender: 0 }
    const withLag = wrapAgentMessageForDelivery('trusted-peer', 'qa', 'qa', 'x', 7, null, healthy)
    const without = wrapAgentMessageForDelivery('trusted-peer', 'qa', 'qa', 'x', 7, null)
    expect(withLag.prefix).toBe(without.prefix)
    expect(withLag.wrapped).toBe(without.wrapped)
    const chanWith = wrapAgentMessageForDelivery('channel-inbound', 'c', 'c', 'x', 1, null, healthy)
    const chanWithout = wrapAgentMessageForDelivery('channel-inbound', 'c', 'c', 'x', 1, null)
    expect(chanWith.prefix).toBe(chanWithout.prefix)
  })

  it('getInboundLag counts only rows newer than the message, split by sender', () => {
    const target = createAgentMessage('zz-lag-po', 'zz-lag-eng', 'the ruling')
    createAgentMessage('zz-lag-po', 'zz-lag-eng', 'the WITHDRAWAL')
    createAgentMessage('zz-lag-po', 'zz-lag-eng', 'more from po')
    createAgentMessage('zz-lag-qa', 'zz-lag-eng', 'unrelated, different sender')
    createAgentMessage('zz-lag-po', 'zz-lag-other', 'unrelated, different recipient')

    const lag = getInboundLag(target)
    expect(lag.newerTotal).toBe(4)
    // Only the same sender->recipient pair: not the qa row, not the other-recipient row.
    expect(lag.newerFromSender).toBe(2)
    expect(lag.ageSeconds).toBeLessThan(5)
  })
})

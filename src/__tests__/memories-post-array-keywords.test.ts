/**
 * Regression test for POST /api/memories 500 on array-shaped `keywords`.
 *
 * Root cause: agents legitimately send `keywords` either as a comma-string
 * ("a, b") or as a JSON array (["a","b"]). The array reached SQLite as a raw
 * bind value; better-sqlite3 rejects a non-string bind and the throw bubbled to
 * the top-level catch as an opaque 500 "Szerver hiba" — which reads as a
 * fleet-wide memory outage and silently dropped agent learnings (content agent
 * + PO, 2026-07-26). Length and spaces were red herrings; the array was the only
 * trigger.
 *
 * Fix: normalizeKeywords() coerces an array to a comma-string at the route
 * boundary (POST + PUT), plus a defensive string-or-null bind in
 * saveAgentMemory so no caller can ever crash a memory write on a bad type.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { Readable } from 'node:stream'
import { initDatabase, getAgentMemories } from '../db.js'
import { tryHandleMemories } from '../web/routes/memories.js'
import type { RouteContext } from '../web/routes/types.js'

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, MAIN_AGENT_ID: 'agent-a', ALLOWED_CHAT_ID: 'test-chat', OLLAMA_URL: '' }
})

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

function makePost(body: unknown): { ctx: RouteContext; getStatus: () => number; getBody: () => any } {
  const payload = JSON.stringify(body)
  const req = Readable.from([Buffer.from(payload)]) as any
  let status = 200
  let responseBody = ''
  const res = {
    writeHead: (code: number) => { status = code },
    end: (b?: string) => { responseBody = b || '' },
  }
  return {
    ctx: { req, res: res as any, path: '/api/memories', method: 'POST', url: new URL('http://localhost:3420/api/memories') },
    getStatus: () => status,
    getBody: () => (responseBody ? JSON.parse(responseBody) : null),
  }
}

beforeAll(() => {
  initDatabase(':memory:')
})

describe('POST /api/memories keywords normalization', () => {
  it('accepts array keywords (does not 500) and stores them as a comma-string', async () => {
    const { ctx, getStatus, getBody } = makePost({
      agent_id: 'agent-kw',
      category: 'warm',
      content: 'array-keyword regression row',
      keywords: ['AI crawler', 'organic clicks'],
    })
    const handled = await tryHandleMemories(ctx)
    expect(handled).toBe(true)
    expect(getStatus()).toBe(200)
    expect(getBody()?.ok).toBe(true)

    const rows = getAgentMemories('agent-kw', 50)
    const row = rows.find(r => r.content === 'array-keyword regression row')
    expect(row).toBeTruthy()
    // array joined to a comma-string, not dropped, not crashed
    expect(row!.keywords).toBe('AI crawler, organic clicks')
  })

  it('still accepts a plain string and an empty array without error', async () => {
    const strCase = makePost({ agent_id: 'agent-kw', category: 'warm', content: 'string-kw row', keywords: 'a, b' })
    expect(await tryHandleMemories(strCase.ctx)).toBe(true)
    expect(strCase.getStatus()).toBe(200)

    const emptyCase = makePost({ agent_id: 'agent-kw', category: 'warm', content: 'empty-array-kw row', keywords: [] })
    expect(await tryHandleMemories(emptyCase.ctx)).toBe(true)
    expect(emptyCase.getStatus()).toBe(200)

    const rows = getAgentMemories('agent-kw', 50)
    expect(rows.find(r => r.content === 'string-kw row')!.keywords).toBe('a, b')
    // empty array normalizes to undefined -> stored NULL, not a crash
    expect(rows.find(r => r.content === 'empty-array-kw row')!.keywords).toBeNull()
  })
})

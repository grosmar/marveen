// The GET /api/messages query contract.
//
// Every assertion here fails against the PREVIOUS handler, which is the point:
// that handler accepted any parameter, implemented only `agent`/`status`/
// `limit`/`before`, and silently ignored the rest while returning a well-formed
// 200. On 2026-07-31 that produced two live faults in one night -- an agent
// audited a routing complaint over a window that could not contain the disputed
// rows and escalated a transport fault that did not exist, and watchdog.sh's
// restart-replay asked for "?to=<agent>&limit=200" and was handed the GLOBAL
// last 200 rows instead. Both read as correct results.
//
// So these tests pin the discriminating behaviour, not the happy path:
// an unimplemented parameter must be an ERROR, an implemented one must actually
// filter, and a clamp must be visible in the response.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import type { RouteContext } from '../web/routes/types.js'
import { initDatabase, createAgentMessage, queryAgentMessages, AGENT_MESSAGE_LIMIT_CAP } from '../db.js'
import { tryHandleMessages } from '../web/routes/messages.js'

beforeAll(() => { initDatabase(':memory:') })

function fakeCtx(query: string): { ctx: RouteContext; out: { status: number; body: any; headers: Record<string, string> } } {
  const out = { status: 200, body: null as any, headers: {} as Record<string, string> }
  const res: any = {
    setHeader(k: string, v: string) { out.headers[k.toLowerCase()] = v },
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string | Buffer) {
      if (chunk) { try { out.body = JSON.parse(chunk.toString()) } catch { out.body = chunk.toString() } }
    },
  }
  const url = new URL(`http://localhost:3420/api/messages${query}`)
  const ctx = { req: { headers: {} } as any, res, path: url.pathname, method: 'GET', url } as RouteContext
  return { ctx, out }
}

const A = 'zz-query-alpha'
const B = 'zz-query-bravo'
const C = 'zz-query-charlie'

describe('GET /api/messages query contract', () => {
  let ids: number[] = []

  beforeAll(() => {
    // alpha->bravo, bravo->alpha, alpha->charlie, repeated: a mixed corpus in
    // which a to= filter and a no-op both return rows, so only a filter that
    // WORKS can be told apart from one that is ignored.
    for (let i = 0; i < 6; i++) {
      ids.push(createAgentMessage(A, B, `a2b ${i}`).id)
      ids.push(createAgentMessage(B, A, `b2a ${i}`).id)
      ids.push(createAgentMessage(A, C, `a2c ${i}`).id)
    }
  })
  beforeEach(() => { vi.restoreAllMocks() })

  it('rejects a parameter it does not implement instead of ignoring it', async () => {
    // The exact shape that misled the audit: an unsupported cursor that the old
    // handler dropped, answering a much narrower question with a 200.
    for (const q of ['?since=14620', '?id=14622', '?after_id=1', '?to_agent=' + A]) {
      const { ctx, out } = fakeCtx(q)
      expect(await tryHandleMessages(ctx)).toBe(true)
      expect(out.status).toBe(400)
      expect(out.body.error).toMatch(/unknown query parameter/)
      expect(out.body.allowed).toContain('since_id')
    }
  })

  it('to= actually filters (the old handler returned the global window)', async () => {
    const { ctx, out } = fakeCtx(`?to=${C}&limit=200`)
    await tryHandleMessages(ctx)
    expect(out.status).toBe(200)
    expect(out.body.length).toBeGreaterThan(0)
    // Discriminator: the corpus contains rows to A and to B. An ignored `to=`
    // returns them; a working one cannot.
    expect(out.body.every((m: any) => m.to_agent === C)).toBe(true)
    expect(out.body.some((m: any) => m.to_agent === B)).toBe(false)
  })

  it('from= filters on the sender independently of to=', async () => {
    const { ctx, out } = fakeCtx(`?from=${B}&limit=200`)
    await tryHandleMessages(ctx)
    expect(out.body.every((m: any) => m.from_agent === B)).toBe(true)
    const both = fakeCtx(`?from=${A}&to=${C}&limit=200`)
    await tryHandleMessages(both.ctx)
    expect(both.out.body.every((m: any) => m.from_agent === A && m.to_agent === C)).toBe(true)
    expect(both.out.body.length).toBe(6)
  })

  it('since_id pages FORWARD from an exclusive lower bound, ascending', async () => {
    const pivot = ids[5]
    const { ctx, out } = fakeCtx(`?since_id=${pivot}&limit=200`)
    await tryHandleMessages(ctx)
    expect(out.body.length).toBeGreaterThan(0)
    expect(out.body.every((m: any) => m.id > pivot)).toBe(true)
    const returned = out.body.map((m: any) => m.id)
    expect(returned).toEqual([...returned].sort((a, b) => a - b))
    expect(out.headers['x-result-order']).toBe('id-asc')
  })

  it('since_id + limit is a usable cursor: two pages cover the whole range', async () => {
    const start = ids[0] - 1
    const page1 = fakeCtx(`?since_id=${start}&limit=10`)
    await tryHandleMessages(page1.ctx)
    expect(page1.out.body.length).toBe(10)
    expect(page1.out.headers['x-result-truncated']).toBe('true')
    const last = page1.out.body[page1.out.body.length - 1].id
    const page2 = fakeCtx(`?since_id=${last}&limit=10`)
    await tryHandleMessages(page2.ctx)
    // No gap and no overlap between the pages.
    expect(page2.out.body[0].id).toBeGreaterThan(last)
    const all = [...page1.out.body, ...page2.out.body].map((m: any) => m.id)
    expect(new Set(all).size).toBe(all.length)
    expect(all.length).toBeGreaterThanOrEqual(ids.length)
  })

  it('announces the clamp instead of applying it silently', async () => {
    const { ctx, out } = fakeCtx('?limit=5000')
    await tryHandleMessages(ctx)
    expect(out.status).toBe(200)
    // The precise failure content hit: limit=5000 answered with 200 rows and
    // nothing in the response said so.
    expect(out.headers['x-result-limit-clamped']).toBe(`5000->${AGENT_MESSAGE_LIMIT_CAP}`)
    expect(out.headers['x-result-limit']).toBe(String(AGENT_MESSAGE_LIMIT_CAP))
    expect(out.body.length).toBeLessThanOrEqual(AGENT_MESSAGE_LIMIT_CAP)
  })

  it('does not set the clamp header when the request fits under the cap', async () => {
    const { ctx, out } = fakeCtx('?limit=5')
    await tryHandleMessages(ctx)
    expect(out.headers['x-result-limit-clamped']).toBeUndefined()
    expect(out.headers['x-result-limit']).toBe('5')
    expect(out.body.length).toBe(5)
    expect(out.headers['x-result-truncated']).toBe('true')
  })

  it('rejects a non-integer or absurd limit rather than coercing to NaN', async () => {
    for (const q of ['?limit=abc', '?before=xyz', '?since_id=nope']) {
      const { ctx, out } = fakeCtx(q)
      await tryHandleMessages(ctx)
      expect(out.status).toBe(400)
      expect(out.body.error).toMatch(/must be an integer/)
    }
    const zero = fakeCtx('?limit=0')
    await tryHandleMessages(zero.ctx)
    expect(zero.out.status).toBe(400)
  })

  it('leaves the two paths the dashboard and the router depend on unchanged', async () => {
    // agent= keeps its conversation semantics (both directions).
    const conv = fakeCtx(`?agent=${C}&limit=200`)
    await tryHandleMessages(conv.ctx)
    expect(conv.out.body.every((m: any) => m.from_agent === C || m.to_agent === C)).toBe(true)

    // status=pending stays UNCAPPED: the router and the depth watchdogs need
    // the true queue, so a page of it would silently under-report depth. Every
    // seeded row is still pending, so the full corpus must come back even
    // though no limit was given (the default limit is 50).
    const pending = fakeCtx('?status=pending')
    await tryHandleMessages(pending.ctx)
    expect(pending.out.status).toBe(200)
    expect(pending.out.body.length).toBe(ids.length)
  })

  it('queryAgentMessages caps at the shared constant the header advertises', () => {
    const rows = queryAgentMessages({ limit: 100000 })
    expect(rows.length).toBeLessThanOrEqual(AGENT_MESSAGE_LIMIT_CAP)
  })
})

import { json } from '../http-helpers.js'
import { queryAuditLog, countAuditLog, type AuditSource } from '../../db.js'
import { getEffectiveSettingValue } from '../../settings-store.js'
import type { RouteContext } from './types.js'

const VALID_SOURCES = new Set<AuditSource>(['config', 'idea', 'store', 'diary'])

export async function tryHandleAuditLog(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  if (path !== '/api/audit-log' || method !== 'GET') return false

  const url = new URL(req.url ?? '/', `http://localhost`)
  const params = url.searchParams

  // Source filter: comma-separated, defaults to all sources.
  const sourceParam = params.get('source') ?? ''
  const sources: AuditSource[] = sourceParam
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is AuditSource => VALID_SOURCES.has(s as AuditSource))

  // Time range (unix seconds).
  const fromParam = params.get('from')
  const toParam = params.get('to')
  const from = fromParam ? parseInt(fromParam, 10) : undefined
  const to = toParam ? parseInt(toParam, 10) : undefined

  if (from !== undefined && isNaN(from)) {
    json(res, { error: 'Invalid "from" parameter' }, 400)
    return true
  }
  if (to !== undefined && isNaN(to)) {
    json(res, { error: 'Invalid "to" parameter' }, 400)
    return true
  }

  // Free-text search.
  const q = (params.get('q') ?? '').trim() || undefined

  // Agent filter (meaningful for diary source; silently ignored for others).
  const agent = (params.get('agent') ?? '').trim() || undefined

  // Per-request limit, capped at registry max.
  const maxEntries = Number(getEffectiveSettingValue('AUDIT_LOG_MAX_ENTRIES'))
  const limitParam = params.get('limit')
  const limit = limitParam ? Math.min(parseInt(limitParam, 10), maxEntries) : Math.min(200, maxEntries)

  if (isNaN(limit) || limit < 1) {
    json(res, { error: 'Invalid "limit" parameter' }, 400)
    return true
  }

  const entries = queryAuditLog({ sources, from, to, q, agent, limit })
  // `total` is the count of MATCHING entries, not of returned ones. It used to be
  // entries.length, which made every truncated read look complete -- and the default limit
  // here is 200, so an audit question ("did this key ever change", "did that agent touch the
  // store") could be answered no by a page that was silently cut. `truncated` states it
  // outright so a caller does not have to compare two numbers to notice.
  const total = countAuditLog({ sources, from, to, q, agent })
  json(res, { entries, total, returned: entries.length, limit, truncated: total > entries.length })
  return true
}

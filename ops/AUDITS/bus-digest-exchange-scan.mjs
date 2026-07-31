#!/usr/bin/env node
// Did a per-item digest exchange actually happen on the fleet bus, and between whom?
//
// WHY THIS EXISTS. On 2026-07-31 I asked eight desks "did you run the pulled control-0 form".
// Six answered no, one answered yes. That is a ROSTER ASSEMBLED FROM WHAT DESKS REMEMBER
// DISCLOSING, which is a recollection and not a population (analyst, msg 15732). The bus is the
// instrument the exchange would have crossed, I hold the token, and nobody had queried it once.
// This queries it.
//
// THE HARD PART IS THE CONFOUNDER, and it is why the two earlier scans could not answer this.
// A digest exchange looks like a list of 8-hex tokens in one message. So does ordinary fleet
// traffic: kanban card ids are 8 hex, and git shas are quoted constantly. Content's scan
// (msg 15728) said so itself -- "git shas dominate this bus and it cannot separate a digest list
// from ordinary commit traffic. It did not find a leak and was never capable of finding one."
//
// This one can, because the confounders are both RESOLVABLE from here:
//   - a kanban card id resolves against kanban_cards.id in the local store
//   - a git sha resolves against the two repos the fleet quotes from
// Anything that resolves to neither is UNEXPLAINED, and an unexplained 8-hex token appearing
// several times in one message is the shape of a digest list.
//
// It never prints an unexplained token's VALUE. Publishing the digests again, in the artefact
// that reports them, would be the same act it exists to measure. Ids, senders and counts only.
//
// Run: cd /home/zubi/marveen && NODE_PATH=$(npm root) node ops/AUDITS/bus-digest-exchange-scan.mjs
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3')

const HEX8 = /\b[0-9a-f]{8}\b/g
const REPOS = ['/home/zubi/marveen', '/home/zubi/git-repos/mandalion']

const token = readFileSync('/home/zubi/marveen/store/.dashboard-token', 'utf-8').trim()

// ---- 1. the corpus, and its bounds, so a zero can be read -------------------------------------
const rows = []
let sinceId = 0
for (;;) {
  const res = await fetch(`http://localhost:3420/api/messages?limit=200&since_id=${sinceId}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const body = await res.json()
  const page = Array.isArray(body) ? body : body.messages ?? body.rows ?? []
  if (page.length === 0) break
  rows.push(...page)
  const maxId = Math.max(...page.map((r) => r.id))
  if (maxId <= sinceId) break
  sinceId = maxId
}
const ids = rows.map((r) => r.id)
console.log(`corpus: ${rows.length} bus messages, id ${Math.min(...ids)}..${Math.max(...ids)}`)

// ---- 2. classify every 8-hex token: card id, git sha, or unexplained --------------------------
const db = new Database('/home/zubi/marveen/store/claudeclaw.db', { readonly: true })
const cardIds = new Set(db.prepare('SELECT id FROM kanban_cards').all().map((r) => String(r.id)))
const ideaIds = new Set(db.prepare('SELECT id FROM idea_box').all().map((r) => String(r.id)))
console.log(`classifiers: ${cardIds.size} kanban card ids, ${ideaIds.size} idea ids, ${REPOS.length} git repos`)

const seen = new Map() // token -> [{id, from, to}]
for (const r of rows) {
  const body = String(r.content ?? '')
  for (const t of new Set(body.match(HEX8) ?? [])) {
    if (!seen.has(t)) seen.set(t, [])
    seen.get(t).push({ id: r.id, from: r.from_agent, to: r.to_agent })
  }
}
const allTokens = [...seen.keys()]

// Resolve git shas in one pass per repo rather than one process per token.
const gitKnown = new Set()
for (const repo of REPOS) {
  try {
    const out = execFileSync('git', ['-C', repo, 'cat-file', '--batch-check'], {
      input: allTokens.join('\n'),
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024,
    })
    out.split('\n').forEach((line, i) => {
      if (line && !/missing|ambiguous/.test(line)) gitKnown.add(allTokens[i])
    })
  } catch {
    console.log(`  (git resolution failed for ${repo})`)
  }
}

const classOf = (t) =>
  cardIds.has(t) ? 'card' : ideaIds.has(t) ? 'idea' : gitKnown.has(t) ? 'gitsha' : 'unexplained'

const tally = { card: 0, idea: 0, gitsha: 0, unexplained: 0 }
for (const t of allTokens) tally[classOf(t)]++
console.log(`\nMATCHER LIVE? ${allTokens.length} distinct 8-hex tokens found:`, tally)
console.log('(a zero in every class would mean a dead pattern, not a clean bus)')

// ---- 3. the finding: messages carrying several UNEXPLAINED tokens -----------------------------
// SWEEP 1 is the negative classifier alone (not a card id, not a resolvable sha). It is DIRTY,
// and naming how is the point of keeping it: inspecting its hits showed two false-positive
// sources, neither of which is a digest.
//   - 8-DIGIT NUMERIC IDS. [0-9a-f]{8} matches decimal, so Pexels photo ids (msg 4422: 34416165,
//     14085346) and Resend draft ids land in the unexplained class as whole populations.
//   - GIT SHAS THAT NO LONGER RESOLVE. msg 5816 is mine, quoting mandalion shas from a history
//     that has since moved; the classifier reads "unexplained" and means "unresolvable today".
// So sweep 1's 12 implicated pairs are mostly artefact, and reporting them as a finding would be
// the wrong-population error the fleet spent tonight on.
const THRESHOLD = 4
const perMsg = new Map()
for (const [t, hits] of seen) {
  if (classOf(t) !== 'unexplained') continue
  for (const h of hits) {
    const k = h.id
    if (!perMsg.has(k)) perMsg.set(k, { ...h, n: 0, mixed: 0 })
    perMsg.get(k).n++
    if (!/^\d{8}$/.test(t)) perMsg.get(k).mixed++
  }
}
const suspects = [...perMsg.values()].filter((m) => m.n >= THRESHOLD).sort((a, b) => a.id - b.id)
console.log(`\n=== SWEEP 1 (dirty): messages with >= ${THRESHOLD} unexplained 8-hex tokens ===`)
console.log(`  ${suspects.length} messages, ${new Set(suspects.map((s) => `${s.from}->${s.to}`)).size} pairs -- see the note above, mostly artefact`)

// SWEEP 2 adds a POSITIVE discriminator instead of chasing a perfect negative one. A digest
// exchange does not merely contain hex; it SAYS what the hex is. Requiring digest vocabulary in
// the same message separates it from every confounder above, none of which talk about hashing.
// Cost, stated rather than hidden: an all-digit sha256 prefix is (10/16)^8 ~ 2.3% likely, so the
// numeric exclusion drops about one true token in forty. It cannot drop a whole six-token list.
const DIGEST_VOCAB = /sha-?256|hmac|digest|preimage|first 8 hex|truncat\w* (?:to )?(?:8|eight)|salted/i
const byMsg = new Map(rows.map((r) => [r.id, r]))
const confirmed = suspects.filter((s) => {
  const body = String(byMsg.get(s.id)?.content ?? '')
  return s.mixed >= THRESHOLD && DIGEST_VOCAB.test(body)
})
console.log(`\n=== SWEEP 2 (discriminated): >= ${THRESHOLD} non-numeric unexplained tokens AND digest vocabulary ===`)
if (confirmed.length === 0) console.log('  none')
for (const s of confirmed) console.log(`  msg ${s.id}  ${s.from} -> ${s.to}  ${s.mixed} tokens`)

// The vocabulary matcher must be shown live, or sweep 2's shortness reads as cleanliness when it
// could just be a dead regex. Tonight the fleet DISCUSSED this mechanism at length, so the
// vocabulary alone should hit many messages that carry no token list at all.
const vocabOnly = rows.filter((r) => DIGEST_VOCAB.test(String(r.content ?? '')))
console.log(`\nVOCAB MATCHER LIVE? ${vocabOnly.length} messages mention digests at all (discussion + exchange)`)
console.log(`  of those, ${confirmed.length} also carry a token list -- the rest are talk, which is the expected shape`)

// ---- 4. controls ------------------------------------------------------------------------------
// POSITIVE CONTROL, and it is a state the fleet actually occupied rather than one I generated:
// QA disclosed (msg 15725) that they and the PO completed a six-token exchange, both directions.
// If this scan does not surface a qa<->po pair, the scan is broken and its zero means nothing.
const pairs = new Set(confirmed.map((s) => `${s.from}->${s.to}`))
const positive = [...pairs].some((p) => /^(qa->po|po->qa)$/.test(p))
console.log(`\nPOSITIVE CONTROL (a disclosed qa<->po exchange must appear): ${positive ? 'PASS' : 'FAIL -- scan is not measuring what it claims'}`)
console.log(`distinct sender->recipient pairs implicated: ${pairs.size}`)
for (const p of [...pairs].sort()) console.log(`   ${p}`)

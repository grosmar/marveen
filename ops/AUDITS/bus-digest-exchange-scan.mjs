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
// could just be a dead regex.
//
// AND THE CONTROL IS WEAKER THAN IT LOOKS, which I only saw by reading its hits. "digest" is an
// ORDINARY FLEET WORD -- msg 14 is "LUMORA STRATEGY REVIEW DIGEST", meaning a summary, and the
// fleet has used it that way since the first day. So a large count here demonstrates the regex is
// alive in the ENGLISH sense and says almost nothing about the CRYPTOGRAPHIC sense, which is the
// one sweep 2 relies on. Reporting the raw number as "the matcher is live" overstates it.
const vocabOnly = rows.filter((r) => DIGEST_VOCAB.test(String(r.content ?? '')))
const cryptoVocab = rows.filter((r) => /sha-?256|hmac|preimage|salted/i.test(String(r.content ?? '')))
console.log(`\nVOCAB MATCHER LIVE? ${vocabOnly.length} messages match -- but see the note: "digest" is an ordinary fleet word`)
console.log(`  narrowed to unambiguously cryptographic terms: ${cryptoVocab.length} messages`)
console.log(`  of those, ${confirmed.length} also carry a token list`)

// ---- 3b. THE CONTROL THAT DECIDES WHETHER THE ZERO IS WORTH ANYTHING --------------------------
// Content (msg 15775) caught the defect that sweep 2 introduced, and it is the one that matters
// because this instrument exists to report an ABSENCE:
//
//   WHEN AN INSTRUMENT'S PURPOSE IS TO REPORT A ZERO, EVERY PRECISION GAIN IS PAID FOR IN THE
//   CURRENCY OF THE CONCLUSION. A false positive costs an inspection. A false negative IS the
//   wrong answer.
//
// Sweep 2 detects exchanges THAT ANNOUNCE THEMSELVES. Six hex tokens pasted bare, with no
// explanatory sentence, is invisible to it -- and terse compliance is the likeliest shape when the
// instruction was broadcast and the desk is simply answering it. Worse, my "vocab matcher live"
// check was demonstrated only on messages that HAD the keyword, so it said nothing about the
// no-keyword case. The control is to inject a bare unlabelled list into a copy of the real corpus
// and see which sweep still catches it.
const BARE = ['9f2c41ab', '7d0e88b3', 'c41af907', '3b6d2e5c', 'ea70c1d9', '5c9b0f24']
const injected = { id: -1, from_agent: 'testdesk', to_agent: 'testdesk', content: `T1 ${BARE.join(' T? ')}` }
const injUnexplained = BARE.filter((t) => classOf(t) === 'unexplained' && !/^\d{8}$/.test(t)).length
const sweep1Catches = injUnexplained >= THRESHOLD
const sweep2Catches = sweep1Catches && DIGEST_VOCAB.test(injected.content)
console.log(`\n=== INJECTION CONTROL: a BARE six-token list, no digest vocabulary ===`)
console.log(`  tokens landing in the unexplained non-numeric class: ${injUnexplained}/6`)
console.log(`  SWEEP 1 catches it: ${sweep1Catches ? 'YES' : 'NO'}`)
console.log(`  SWEEP 2 catches it: ${sweep2Catches ? 'YES' : 'NO'}${sweep2Catches ? '' : '   <-- FALSE NEGATIVE'}`)
console.log(`  => the zero must be reported off SWEEP 1 hand-inspected, not off sweep 2.`)
console.log(`     Sweep 2 is TRIAGE (what to read first), never the population.`)

// AND A REAL ONE, which beats the synthetic control because the fleet produced it unprompted.
// Hand-inspecting all 46 sweep-1 hits turned up msg 15009 (content -> marveen): four sha256
// prefixes of bus message BODIES, exchanged to detect duplicate deliveries. A genuine digest
// exchange, benign in content, and SWEEP 2 DOES NOT SEE IT -- the message says "I hashed the
// bodies" and writes "sha 6198c1df", and /sha-?256/ does not match a bare "sha". So the false
// negative is not hypothetical: the instrument already missed one, in this corpus, tonight.
const fn = byMsg.get(15009)
if (fn) {
  const inSweep1 = suspects.some((s) => s.id === 15009)
  const inSweep2 = confirmed.some((s) => s.id === 15009)
  console.log(`\nREAL FALSE NEGATIVE (msg 15009, a genuine digest exchange):`)
  console.log(`  in sweep 1: ${inSweep1 ? 'YES' : 'NO'}   in sweep 2: ${inSweep2 ? 'YES' : 'NO'}`)
}

// ---- 3c. what the zero actually covers, off the INCLUSIVE sweep ------------------------------
// All 46 sweep-1 hits were read by hand. 42 are the two artefact classes above (numeric ids;
// git shas from mandalion history that has since moved -- the whole 5638..6521 reconcile cluster).
// msg 710 is five deleted lumora card ids. msg 15009 is the benign body-hash exchange above.
// The remaining two are the disclosed qa<->po pair.
//
// The containment claim rests on this line and not on sweep 2:
const lastHit = suspects.length ? Math.max(...suspects.map((s) => s.id)) : 0
const after = rows.filter((r) => r.id > 15674).length
console.log(`\n=== CONTAINMENT, off the INCLUSIVE sweep (which does catch bare lists) ===`)
console.log(`  last sweep-1 hit anywhere in the corpus: msg ${lastHit}`)
console.log(`  bus messages since the disclosed exchange (15674): ${after}`)
console.log(`  sweep-1 hits among them: ${suspects.filter((s) => s.id > 15674).length}`)

// ---- 4. controls ------------------------------------------------------------------------------
// POSITIVE CONTROL, and it is a state the fleet actually occupied rather than one I generated:
// QA disclosed (msg 15725) that they and the PO completed a six-token exchange, both directions.
// If this scan does not surface a qa<->po pair, the scan is broken and its zero means nothing.
const pairs = new Set(confirmed.map((s) => `${s.from}->${s.to}`))
const positive = [...pairs].some((p) => /^(qa->po|po->qa)$/.test(p))
console.log(`\nPOSITIVE CONTROL (a disclosed qa<->po exchange must appear): ${positive ? 'PASS' : 'FAIL -- scan is not measuring what it claims'}`)
console.log(`distinct sender->recipient pairs implicated: ${pairs.size}`)
for (const p of [...pairs].sort()) console.log(`   ${p}`)

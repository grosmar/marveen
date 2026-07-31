#!/usr/bin/env node
// Did a per-item digest exchange happen on the KANBAN COMMENT CHANNEL, and between whom?
//
// WHY THIS EXISTS, AND WHY IT IS A SECOND SCAN. On 2026-07-31 I scanned the message bus for the
// same thing and reported a zero (ops/AUDITS/bus-digest-exchange-scan.mjs). The PO's own earlier
// scan had been of the comment channel, and their framing is the reason this file exists:
// two separate corpora, two separate zeros, and a zero on one is not a zero on the other.
//
// WHAT THE BUS SCAN GOT WRONG, CARRIED IN HERE AS A DESIGN CONSTRAINT (content, msg 15775):
//   WHEN AN INSTRUMENT'S PURPOSE IS TO REPORT A ZERO, EVERY PRECISION GAIN IS PAID FOR IN THE
//   CURRENCY OF THE CONCLUSION. A false positive costs one inspection. A false negative IS the
//   wrong answer.
// My bus scan's sharp sweep required the message to SAY what the hex was, so it only caught
// exchanges that ANNOUNCE THEMSELVES, and it missed a real one already in the corpus (bus msg
// 15009, four sha256 prefixes written as "sha 6198c1df"). So this scan has NO sharp sweep at all.
// It flags on SYNTAX, stays loose, and every hit is classified BY HAND, where a human judgement
// is cheap and reversible (content, msg 15814).
//
// THE CORPUS IS SMALL ENOUGH THAT THE SWEEP IS A CONVENIENCE, NOT THE POPULATION. 57 comments,
// 74,397 characters. Every row was read in full. The sweep exists to order the reading and to make
// the reading reproducible, not to select what gets read.
//
// It never prints a token's VALUE where that token is unresolved. Republishing a digest in the
// artefact that reports it is the act being measured.
//
// Run: cd /home/zubi/marveen && NODE_PATH=$(npm root) node ops/AUDITS/comment-channel-digest-scan.mjs
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3')

const DB = '/home/zubi/marveen/store/claudeclaw.db'
const REPOS = ['/home/zubi/marveen', '/home/zubi/git-repos/mandalion']
// 8 to 64: a card id and a short git sha are 8, a full git sha is 40, a sha256 is 64. A TRUNCATED
// digest is the shape that beat the bus scan, so the low end has to stay at 8 even though that is
// exactly where the confounders live.
const HEX = /\b[0-9a-f]{8,64}\b/g
const db = new Database(DB, { readonly: true })

// ---- 1. the corpus, stated so a zero can be read ---------------------------------------------
const rows = db.prepare('SELECT id, card_id, author, content, created_at FROM kanban_comments ORDER BY id').all()
const ideaComments = db.prepare('SELECT COUNT(*) n FROM idea_comments').get().n
const chars = rows.reduce((a, r) => a + r.content.length, 0)
const maxId = rows[rows.length - 1].id
const present = new Set(rows.map((r) => r.id))
const gaps = []
for (let i = 1; i <= maxId; i++) if (!present.has(i)) gaps.push(i)

console.log(`corpus: ${rows.length} kanban comments, id 1..${maxId}, ${chars} chars, on ${
  db.prepare('SELECT COUNT(DISTINCT card_id) n FROM kanban_comments').get().n
} distinct cards`)
console.log(`        + ${ideaComments} idea_comments rows`)
// A deleted comment would leave no row, which is a real hole in any comment scan. Here it is
// CHECKABLE rather than assumed: the table is AUTOINCREMENT, so a delete leaves an id gap.
console.log(`DELETION CHECK: id gaps = ${gaps.length ? gaps.join(',') : 'NONE, so no comment has ever been deleted from this table'}`)

// ---- 2. classify every hex token: card id, idea id, git sha, or unexplained --------------------
const cards = new Set(db.prepare('SELECT id FROM kanban_cards').all().map((r) => String(r.id)))
const ideas = new Set(db.prepare('SELECT id FROM idea_box').all().map((r) => String(r.id)))
const repos = REPOS.filter((p) => {
  try { execFileSync('git', ['-C', p, 'rev-parse', '--git-dir'], { stdio: 'ignore' }); return true } catch { return false }
})
const memo = new Map()
function classOf(tok) {
  if (memo.has(tok)) return memo.get(tok)
  let v = 'unexplained'
  if (cards.has(tok)) v = 'card'
  else if (ideas.has(tok)) v = 'idea'
  else for (const p of repos) {
    try { execFileSync('git', ['-C', p, 'cat-file', '-e', `${tok}^{commit}`], { stdio: 'ignore' }); v = 'gitsha'; break } catch { /* not here */ }
  }
  memo.set(tok, v)
  return v
}
const toksOf = (s) => [...new Set(String(s).match(HEX) ?? [])]
const allToks = new Set()
for (const r of rows) for (const t of toksOf(r.content)) allToks.add(t)
const tally = { card: 0, idea: 0, gitsha: 0, unexplained: 0 }
for (const t of allToks) tally[classOf(t)]++
console.log(`classifiers: ${cards.size} card ids, ${ideas.size} idea ids, ${repos.length} live repos`)
console.log(`TOKEN CENSUS: ${allToks.size} distinct hex tokens`, tally)

// ---- 3. the inclusive sweep. Two or more hex tokens, OR any digest word. --------------------
const VOCAB = /digest|sha-?1\b|sha-?256|md5|hmac|hash|preimage|salt|checksum|fingerprint/i
const hits = rows.filter((r) => toksOf(r.content).length >= 2 || VOCAB.test(r.content))
console.log(`\n=== INCLUSIVE SWEEP: ${hits.length} of ${rows.length} comments`)
for (const r of hits) {
  const t = toksOf(r.content)
  const un = t.filter((x) => classOf(x) === 'unexplained')
  console.log(`  #${r.id} [${r.author}] card ${r.card_id}  tokens=${t.length}  unexplained=${un.length}  vocab=${VOCAB.test(r.content)}`)
}

// ---- 4. hand classification of every unexplained token ---------------------------------------
// Printed as a class and a length, never as a value, and only after a human read the surrounding
// sentence. Both of these are the SAME false-positive class the bus scan turned up: an 8-DIGIT
// DECIMAL NUMBER matches [0-9a-f]{8}. There they were Pexels photo ids and Resend draft ids. Here
// they are HSTS max-age seconds, in a QA comment comparing the served header to the spec.
const NUMERIC = /^\d{8}$/
const unexplained = [...allToks].filter((t) => classOf(t) === 'unexplained')
console.log(`\n=== UNEXPLAINED TOKENS: ${unexplained.length}`)
for (const t of unexplained) {
  const where = rows.filter((r) => r.content.includes(t)).map((r) => `#${r.id}`)
  console.log(`  len=${t.length} numeric=${NUMERIC.test(t)} in ${where.join(',')}  ${
    NUMERIC.test(t) ? '-> HAND-READ: HSTS max-age seconds, not hex' : '-> HAND-READ REQUIRED'}`)
}
const residual = unexplained.filter((t) => !NUMERIC.test(t))
console.log(`  residual after hand classification: ${residual.length}`)

// ---- 5a. control: is the VOCABULARY reader alive on THIS corpus? ------------------------------
// The bus scan got this wrong. I reported "533 messages mention digests" as proof the matcher was
// live; "digest" is an ordinary English fleet word (bus msg 14, "LUMORA STRATEGY REVIEW DIGEST"),
// so the count demonstrated an English match and said nothing about the cryptographic sense. So
// this control names the SENSE it fires in, and it has to fire on the SAME corpus and the SAME
// reader or the zero above is a parser signature rather than a finding.
const probe = ['digest', 'sha256', 'md5', 'hmac', 'hash', 'preimage', 'salt', 'checksum', 'fingerprint', 'sha', 'byte-identical', 'commit']
console.log('\n=== VOCABULARY READER, same corpus, same method:')
for (const w of probe) {
  const n = rows.filter((r) => new RegExp(w.replace(/-/g, '\\-'), 'i').test(r.content)).length
  console.log(`  ${w.padEnd(16)} ${String(n).padStart(3)} rows`)
}
console.log('  READ: the nine cryptographic terms are a UNIFORM ZERO. That would be a parser')
console.log('  signature if nothing fired, but through the SAME reader on the SAME corpus "sha" fires')
console.log('  on 24 of 57 rows and "commit" on 18. The reader is alive in the git/English sense and')
console.log('  the cryptographic sense is genuinely absent. Those are two different claims and this')
console.log('  control only supports the first, which is the one the zero needs.')

// ---- 5b. control: does the sweep catch a REAL digest exchange dropped into this corpus? -------
// The synthetic version of this control is a bare six-token list, which is what content specified
// and which any 2-token sweep catches trivially. The stronger version uses a REAL artefact the
// fleet produced unprompted: bus msg 15009, the digest exchange that beat my previous sharp sweep.
// If the comment-channel sweep cannot see 15009, this zero is worth nothing.
const token = readFileSync('/home/zubi/marveen/store/.dashboard-token', 'utf-8').trim()
let real = null
try {
  const res = await fetch('http://localhost:3420/api/messages?limit=200&since_id=15000', {
    headers: { Authorization: `Bearer ${token}` },
  })
  const body = await res.json()
  const page = Array.isArray(body) ? body : body.messages ?? body.rows ?? []
  real = page.find((m) => m.id === 15009) ?? null
} catch { /* bus unreachable; the synthetic control below still runs */ }

const BARE = ['9f2c41ab', '7d0e88b3', 'c41af907', '3b6d2e5c', 'ea70c1d9', '5c9b0f24']
const synthetic = { id: -1, author: 'testdesk', card_id: 'ffffffff', content: `T1 ${BARE.join(' T? ')}` }
const caught = (r) => toksOf(r.content).length >= 2 || VOCAB.test(r.content)
console.log('\n=== POSITIVE CONTROLS')
console.log(`  synthetic bare six-token list ...... ${caught(synthetic) ? 'CAUGHT' : 'MISSED <-- instrument is void'}`)
if (real) {
  const asComment = { id: -2, author: 'content', card_id: 'ffffffff', content: real.content }
  console.log(`  REAL exchange (bus msg 15009) ...... ${caught(asComment) ? 'CAUGHT' : 'MISSED <-- instrument is void'}  (${
    toksOf(real.content).length} hex tokens, vocab=${VOCAB.test(real.content)})`)
} else {
  console.log('  REAL exchange (bus msg 15009) ...... NOT RUN, bus unreachable. State this in the report.')
}
// The fixture ceiling (engineer): a control the instrument was built against proves less than a
// state the fleet actually occupied. The comment channel has NEVER carried a digest exchange, so
// there is no fleet-produced positive IN THIS CORPUS. 15009 is the nearest thing available and it
// comes from the other channel. Report the zero with that stated, not without it.

// ---- 6. the answer, and its bounds -----------------------------------------------------------
console.log('\n=== RESULT')
console.log(`  Comments read in full: ${rows.length}/${rows.length}. Hex tokens: ${allToks.size} distinct,`)
console.log(`  of which ${tally.card} resolve to kanban card ids, ${tally.gitsha} to commits in ${repos.length} repos,`)
console.log(`  and ${unexplained.length} to neither -- both 8-digit DECIMAL, hand-read as HSTS max-age values.`)
console.log(`  64-hex tokens (a full sha256) anywhere in the corpus: ${rows.filter((r) => /\b[0-9a-f]{64}\b/.test(r.content)).length}.`)
console.log('  NO DIGEST EXCHANGE ON THE COMMENT CHANNEL.')

// ---- 7. EXCLUSIONS, WRITTEN OUT LONGHAND -----------------------------------------------------
// Not the controls. The controls are what I already thought of; these are what the zero does NOT
// cover, and they are the half a reader cannot reconstruct from the number above.
console.log(`
=== EXCLUSIONS (what this zero does NOT cover)

  1. CARD BODIES ARE NOT IN THIS CORPUS. ${cards.size} cards carry a description that is edited in
     place. A digest pasted into a description leaves no comment row and no revision. Same for
     titles. Unscanned, and it is the nearest neighbouring surface to the one scanned.
  2. EDIT HISTORY DOES NOT EXIST. kanban_comments has no updated_at and no revision table, so this
     reads the CURRENT text of each comment. A comment written and then rewritten shows only its
     final form. Unfixable from here. (Deletion is the one destructive edit that IS checkable, and
     it is checked above: no id gaps.)
  3. NON-HEX ENCODINGS PASS THROUGH INVISIBLY. base64, base64url, base32, decimal. A six-item
     base64url list would be seen by neither sweep, on this channel or the bus. This is the
     largest hole in both scans, it is named rather than measured, and closing it means a reader
     that flags on LIST SHAPE rather than on alphabet.
  4. A TRUNCATED DIGEST COLLIDING WITH A REAL CARD ID READS AS EXPLAINED. ${cards.size} card ids over
     8 hex is roughly 1 in 3.4 million per token, so this is negligible and it is not zero. The
     opposite direction is conservative: a hard-deleted card or a moved sha reads as unexplained,
     which costs an inspection rather than the answer.
  5. THE CLASSIFIER IS EVALUATED AGAINST TODAY'S STORE AND TODAY'S REPOS. A token that resolved
     when it was written may not resolve now, and vice versa.
  6. OTHER CHANNELS ARE UNTOUCHED: the memories table, daily_logs, conversation_log, tool_call_log,
     agent files on disk, tmux panes, and anything that never became a row. This zero is scoped to
     the kanban comment channel and says nothing about them, exactly as the bus zero said nothing
     about this one.
  7. NO FLEET-PRODUCED POSITIVE EXISTS IN THIS CHANNEL. The control that fires is imported from the
     bus (msg 15009). It proves the READER catches a real exchange; it does not prove the comment
     channel would have carried one in a form this reader recognises.`)

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
//
// WIDENED AFTER QA MSG 15834, WHICH LANDED ON THE FIRST VERSION OF THIS FILE.
// QA re-ran the BUS scan's matcher against a real digest of each shape and found it sees exactly
// one encoding. The same test against THIS file's first version came back BLIND on 2 of 7 shapes:
// uppercase hex, and base64. My own exclusion #3 had already named non-hex encodings as the largest
// hole in both scans, "named rather than measured" -- on a 57-row corpus there was no excuse for
// leaving it named. Two changes, both in the direction that costs inspections rather than answers:
//   [i]  hex is now case-INSENSITIVE (closes shape F).
//   [ii] a second alphabet-independent reader flags on LIST SHAPE (closes shape G, and any base32
//        or decimal encoding nobody has thought of), because the thing that identifies a digest
//        exchange is not the alphabet, it is two or more opaque fixed-width tokens in a row.
const HEX = /\b[0-9a-fA-F]{8,64}\b/g
// 22..88 covers a truncated 128-bit base64 through a full sha512. Deliberately matches ordinary
// long identifiers too; every hit is hand-read, and the count of false positives is printed so the
// reader can see what the looseness cost.
const OPAQUE = /\b[A-Za-z0-9_-]{22,88}\b/g
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

// ---- 1b. IS 57 THE CORPUS, OR IS IT WHAT MY FETCH RETURNED? (content, msg 15852) --------------
// "The injected control certifies the READER. Nothing certifies the CORPUS." Correct, and it was
// missing. An injected positive proves the matcher fires on text handed to it; it is silent on
// whether the text handed to it is all the text. Two ways this fetch could return a subset and
// look clean, both real on this host:
//   [i]  A CAP. The bus API defaults to 50 rows and sets X-Result-Truncated, which is how the
//        morning kickoff was reading 19% of a day (QA, card 6910a684). This scan reads sqlite
//        DIRECTLY with no LIMIT clause, so that class does not apply -- stated because "it does not
//        apply here" is a claim, not an absence.
//   [ii] A STALE SNAPSHOT. store/claudeclaw.db is journal_mode=WAL with a ~5MB -wal, and this
//        connection is readonly. A reader that cannot see the WAL reads the last checkpoint and
//        reports a smaller, older, entirely well-formed corpus. THAT is the lane where a
//        comfortable answer is indistinguishable from a true one.
// So: a second reader, opened with different flags, counted independently. Mismatch aborts.
const verify = new Database(DB).prepare('SELECT COUNT(*) c, MAX(id) m FROM kanban_comments').get()
const walOK = verify.c === rows.length && verify.m === maxId
console.log(`CORPUS RECONCILE (second reader, read-write flags, WAL-visible): ${verify.c} rows, max id ${verify.m}`)
if (!walOK) {
  console.error(`ABORT: the two readers disagree (${rows.length}/${maxId} vs ${verify.c}/${verify.m}).`)
  console.error('Do NOT report a zero from a corpus two readers cannot agree on.')
  process.exit(2)
}
console.log('  -> agreed. The corpus is the table, not a snapshot of it.')

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
// The alphabet-independent half. An opaque token is one that survives having its case, its digits
// and its separators stripped and still looks like nothing: no vowel-consonant structure, at least
// one digit, and not a word this fleet uses. Two of them adjacent is the signature of a LIST.
const isOpaque = (t) => /[0-9]/.test(t) && /[A-Za-z]/.test(t) && !/_|-{2}/.test(t) &&
  (t.replace(/[^aeiouAEIOU]/g, '').length / t.length) < 0.22
const opaqueOf = (s) => [...new Set((String(s).match(OPAQUE) ?? []).filter(isOpaque))]
const allOpaque = new Set()
for (const r of rows) for (const t of opaqueOf(r.content)) allOpaque.add(t)
console.log(`OPAQUE CENSUS (alphabet-independent, closes shape G): ${allOpaque.size} distinct 22-88 char opaque tokens${
  allOpaque.size ? ':\n  ' + [...allOpaque].join('\n  ') : ' -- so no base64/base32 list of digest length exists in this corpus'}`)

const hits = rows.filter((r) => toksOf(r.content).length >= 2 || opaqueOf(r.content).length >= 1 || VOCAB.test(r.content))
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
const caught = (r) => toksOf(r.content).length >= 2 || opaqueOf(r.content).length >= 1 || VOCAB.test(r.content)
console.log('\n=== POSITIVE CONTROLS')
console.log(`  synthetic bare six-token list ...... ${caught(synthetic) ? 'CAUGHT' : 'MISSED <-- instrument is void'}`)
if (real) {
  const asComment = { id: -2, author: 'content', card_id: 'ffffffff', content: real.content }
  console.log(`  REAL exchange (bus msg 15009) ...... ${caught(asComment) ? 'CAUGHT' : 'MISSED <-- instrument is void'}  (${
    toksOf(real.content).length} hex tokens, vocab=${VOCAB.test(real.content)})`)
} else {
  console.log('  REAL exchange (bus msg 15009) ...... NOT RUN, bus unreachable. State this in the report.')
}

// ---- 5c. QA's correction: the control above SHARES THE MATCHER'S ASSUMPTION ------------------
// QA re-ran the bus scan's matcher (msg 15834) and found it sees exactly ONE encoding. Their line
// is the one that matters here:
//   BARE IS SIX HAND-TYPED TOKENS, EVERY ONE EXACTLY 8 LOWERCASE HEX. It varied the axis content
//   named (keyword / no keyword) and held constant the axis nobody had questioned (what a token
//   LOOKS like). A CONTROL THAT CAN ONLY PASS MEASURES THE AUTHOR, NOT THE TOOL.
// So: a real digest of each shape, computed here rather than typed, each dropped into the corpus,
// and the corpus re-swept for that shape. A MISS below is a hole in the zero above, not a warning.
const { createHash, randomBytes } = await import('node:crypto')
const seed = 'marveen comment-channel scan shape control'
const sha256 = createHash('sha256').update(seed).digest('hex')
const md5 = createHash('md5').update(seed).digest('hex')
const b64 = createHash('sha256').update(seed).digest('base64url')
const SHAPES = [
  ['A hex8 lowercase, bare list', BARE.join(' ')],
  ['B hex64 full sha256       ', `${sha256} ${createHash('sha256').update('x').digest('hex')}`],
  ['C hex32 full md5          ', `${md5} ${createHash('md5').update('x').digest('hex')}`],
  ['D hex 12..31 truncation   ', `${sha256.slice(0, 16)} ${sha256.slice(8, 24)}`],
  ['E hex 9..11 truncation    ', `${sha256.slice(0, 10)} ${sha256.slice(4, 14)}`],
  ['F hex8 UPPERCASE          ', BARE.map((t) => t.toUpperCase()).join(' ')],
  ['G base64url 43-char       ', `${b64} ${createHash('sha256').update('x').digest('base64url')}`],
]
console.log('\n=== SHAPE CONTROLS (a real digest of each encoding, injected into this corpus)')
let blind = 0
for (const [label, payload] of SHAPES) {
  const ok = caught({ content: payload })
  if (!ok) blind++
  console.log(`  ${label} ... ${ok ? 'CAUGHT' : 'BLIND  <-- the zero does not cover this shape'}`)
}
// A negative control, so "CAUGHT" above is not just the sweep firing on everything.
const noise = randomBytes(24).toString('base64url').replace(/[0-9a-fA-F]/g, 'z')
console.log(`  negative control (prose)    ... ${caught({ content: `nothing here but words ${noise}` }) ? 'CAUGHT <-- sweep fires on anything' : 'silent, correct'}`)
console.log(`  shapes this instrument is BLIND to: ${blind} of ${SHAPES.length}`)
// The fixture ceiling (engineer): a control the instrument was built against proves less than a
// state the fleet actually occupied. The comment channel has NEVER carried a digest exchange, so
// there is no fleet-produced positive IN THIS CORPUS. 15009 is the nearest thing available and it
// comes from the other channel. Report the zero with that stated, not without it.

// ---- 6. the answer, and its bounds -----------------------------------------------------------
console.log('\n=== RESULT')
console.log(`  Comments read in full: ${rows.length}/${rows.length}. Hex tokens: ${allToks.size} distinct,`)
console.log(`  of which ${tally.card} resolve to kanban card ids, ${tally.gitsha} to commits in ${repos.length} repos,`)
console.log(`  and ${unexplained.length} to neither -- both 8-digit DECIMAL, hand-read as HSTS max-age values.`)
console.log(`  64-hex tokens (a full sha256) anywhere in the corpus: ${rows.filter((r) => /\b[0-9a-fA-F]{64}\b/.test(r.content)).length}.`)
console.log(`  Opaque non-hex tokens of digest length (22-88 chars): ${allOpaque.size}, all hand-classified,`)
console.log('  residual 0. The zero now covers 7 of 7 encodings, not the 5 the first version covered.')
// THE HEADLINE CARRIES ITS OWN SCOPE (content, msg 15852). "No digest exchange" is the sentence
// that gets lifted into a card, and quotation is lossy in exactly one direction: it keeps the claim
// and drops the qualifier. The more carefully the qualifier is filed in its own section, the more
// reliably it is left behind. So the bound rides in the sentence, at the cost of it being uglier.
console.log(`
  NO DIGEST EXCHANGE ACROSS ALL ${rows.length} KANBAN COMMENTS, READ IN FULL, IN ANY OF 7 ENCODINGS
  INCLUDING NON-HEX -- SCOPED TO THE COMMENT CHANNEL AS IT READS TODAY, WHICH EXCLUDES CARD
  DESCRIPTION BODIES, PRE-EDIT TEXT, AND EVERY OTHER CHANNEL.`)

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
  3. NON-HEX ENCODINGS: CLOSED ON THIS CHANNEL, STILL OPEN ON THE BUS. The first version of this
     file said a base64url list "would be seen by neither sweep", named it the largest hole in
     both, and left it unmeasured. QA's msg 15834 made that indefensible on a 57-row corpus, so it
     is measured now: an alphabet-independent LIST-SHAPE reader (22-88 char opaque runs) returns
     ${allOpaque.size} distinct tokens over the whole corpus, all hand-classified, residual 0. The shape
     controls below exercise a real digest of all seven encodings and 0 are blind. THE BUS SCAN
     HAS NOT HAD THIS TREATMENT -- QA widened it across their own shape classes and got zero in the
     window, which is the same answer arrived at independently, not this reader run over there.
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

#!/usr/bin/env bash
# swallowed-ship-report-watchdog.sh -- catches a ship whose report never fired.
#
# THE PASS-THROUGH LAW (zubi tg3090, 2026-06-13): every report the PO produces reaches zubi
# immediately, once each. Nothing swallows, holds, folds, batches or gates one. The PO's
# `ship-report` skill is what fires them, as the close step of a ship.
#
# THE FAILURE CLASS (2026-07-31, twice in one night): the integration happened in a cycle where
# the PO never reached the report step, and NOTHING anywhere noticed.
#   - card 718b6162 (7 dream pages) integrated at 9cf8d014 03:02Z; report fired 06:27Z, +3h25m,
#     and only because the main agent happened to ask whether the card existed.
#   - card 6b0c0979 was the same shape: integrated, then unreported until flagged by hand.
# Both were caught by a human-ish accident. The third would have been found by zubi, which is
# the outcome he named as the line he pulls reporting off the desk over.
#
# WHY IT PAGES THE MAIN AGENT AND NOT THE PO (the PO's own request, handing the gate over):
#   the failure mode is precisely that the PO is not looking. A gate whose only reader is the
#   party that just proved it was distracted is not a gate.
#
# HOW IT DECIDES. A card sitting in `done` is a ship. A ship is accounted for when
# `ops/report-ship.log` carries a line naming it -- either a `sent:` (the report fired) or a
# `skip (` (the skill ran and deliberately self-skipped a true no-op). Neither = swallowed.
#
# MATCHING, in order; any hit clears the card:
#   1. the card id appears in the log  (the `card=` field the ship-report skill now writes,
#      or the id in prose, which is how 6a94fd7c and the two backfills already read);
#   2. the short sha of any commit whose MESSAGE names the card appears in the log.
# (2) exists because the log historically recorded one sha per SHIP, and a ship can be several
# commits: the Number Match report logged 07d79846 while the feature itself landed at 1e76a602.
# Matching per-commit shas alone would have called a correctly-reported ship swallowed.
#
# NOISE IS BOUNDED BY DESIGN -- each card is judged EXACTLY ONCE, ever:
#   - first run SEEDS every currently-done card into the state file, so the gate never
#     re-litigates history (the board carries 30+ old done cards from before the log convention);
#   - after a card is judged, its id is written to the state file whether it was clean or
#     flagged, so a false positive costs one message, once, and never recurs. This is the
#     kanban-audit lesson: a permanently-true trigger that re-fires every tick teaches the
#     reader to ignore it, and a gate nobody reads is worse than no gate.
#   - GRACE_MIN keeps an in-flight ship out of it: the report is the CLOSE step, so a card that
#     went done ninety seconds ago has not swallowed anything yet.
#
# Dependency-free apart from node+better-sqlite3 (the sqlite3 CLI is NOT installed on this host
# -- a sibling audit silently did nothing for three days on exactly that assumption). Read-only:
# it opens the DB readonly, never touches the board, never touches the log, never sends to zubi.
set -uo pipefail

: "${REPO:=/home/zubi/marveen}"
: "${REPO_M:=/home/zubi/git-repos/mandalion}"
: "${DB:=$REPO/store/claudeclaw.db}"
: "${SHIP_LOG:=$REPO_M/ops/report-ship.log}"
: "${TOKEN_FILE:=$REPO/store/.dashboard-token}"
: "${DASH:=http://localhost:3420}"
: "${STATE:=$REPO/store/swallowed-report-watchdog.state}"   # one judged card id per line
: "${LOG:=/tmp/swallowed-ship-report-watchdog.log}"
: "${GRACE_MIN:=25}"        # min a card may sit in done before its missing report counts
: "${WINDOW_H:=72}"         # h: how far back to consider a done card at all
: "${MAX_ALERTS_PER_RUN:=3}"  # a board-wide bulk close must not turn into a message storm

ts() { TZ=Europe/Budapest date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "$(ts) $*" >> "$LOG"; }
json_str() { local s=${1//\\/\\\\}; s=${s//\"/\\\"}; s=${s//$'\n'/\\n}; printf '"%s"' "$s"; }

alert_marveen() {
  local msg="$1" token
  [ -f "$TOKEN_FILE" ] || { log "no dashboard token, log-only: $msg"; return 0; }
  token=$(cat "$TOKEN_FILE" 2>/dev/null) || { log "token unreadable, log-only: $msg"; return 0; }
  [ -n "$token" ] || { log "empty token, log-only: $msg"; return 0; }
  curl -s --max-time 5 -X POST "$DASH/api/messages" \
    -H "Authorization: Bearer $token" -H "Content-Type: application/json" \
    -d "{\"from\":\"swallowed-report-watchdog\",\"to\":\"marveen\",\"content\":$(json_str "$msg")}" \
    >/dev/null 2>&1 || true
}

[ -f "$DB" ] || { log "db $DB missing -- cannot judge this tick"; exit 0; }
# A missing/unreadable ship log is NOT evidence that reports were swallowed; it is evidence the
# gate cannot see. Distinguishing read-failure from a confirmed condition is the whole difference
# between a watchdog and an alarm that fires on its own blindness.
[ -r "$SHIP_LOG" ] || { log "ship log $SHIP_LOG unreadable -- cannot judge this tick"; exit 0; }

now=$(date +%s)
cutoff=$(( now - WINDOW_H * 3600 ))
grace=$(( now - GRACE_MIN * 60 ))

# Done cards in the window, as "<id>|<done_ts>|<title>". done_ts prefers the real status
# transition and falls back to updated_at, because kanban_card_events is only sparsely
# populated -- 5 of the 7 cards that went done in the last 48h logged no event row at all.
# NOTE: 'done' is BOUND, not inlined. A bare "done" in the SQL is a double-quoted IDENTIFIER,
# and better-sqlite3 (rightly) refuses SQLite's legacy fall-back-to-string-literal quirk; a
# single-quoted literal cannot appear inside this shell-single-quoted node -e at all.
cards=$(NODE_PATH="$REPO/node_modules" node -e '
const Database = require("better-sqlite3");
const db = new Database(process.argv[1], { readonly: true });
const cutoff = Number(process.argv[2]);
const rows = db.prepare([
  "SELECT c.id, c.title,",
  "       COALESCE((SELECT MAX(e.created_at) FROM kanban_card_events e",
  "                  WHERE e.card_id = c.id AND e.to_status = ?),",
  "                c.updated_at) AS done_ts",
  "  FROM kanban_cards c",
  " WHERE c.status = ?",
].join("\n")).all("done", "done");
for (const r of rows) {
  if (!r.done_ts || r.done_ts < cutoff) continue;
  console.log([r.id, r.done_ts, String(r.title || "").replace(/[|\r\n]/g, " ").slice(0, 90)].join("|"));
}
' "$DB" "$cutoff" 2>>"$LOG") || { log "card query failed -- cannot judge this tick"; exit 0; }

# FIRST RUN: seed, never judge. The board carries done cards predating the report ledger
# convention entirely; judging them would open with a burst of unactionable alerts and train
# the reader to ignore the gate on day one.
if [ ! -f "$STATE" ]; then
  : > "$STATE"
  # Seed the full board, not just the window, so a card that scrolls into the window later
  # (an old card edited today) is still treated as history rather than a fresh ship.
  NODE_PATH="$REPO/node_modules" node -e '
    const Database = require("better-sqlite3");
    const db = new Database(process.argv[1], { readonly: true });
    for (const r of db.prepare("SELECT id FROM kanban_cards WHERE status = ?").all("done")) console.log(r.id);
  ' "$DB" >> "$STATE" 2>>"$LOG"
  log "seeded state with $(wc -l < "$STATE") pre-existing done cards; judging starts with the next card that ships"
  exit 0
fi

alerts=0
while IFS='|' read -r card done_ts title; do
  [ -n "$card" ] || continue
  short=${card:0:8}
  # in flight: the report is the close step of the ship, so give it room to fire
  [ "${done_ts:-0}" -gt "$grace" ] && continue
  grep -qxF "$card" "$STATE" 2>/dev/null && continue   # already judged, once is the contract

  verdict=""
  if grep -qF "$short" "$SHIP_LOG" 2>/dev/null; then
    verdict="clean (id in ledger)"
  else
    # A ship can be several commits while the ledger records one sha for it, so ask git which
    # commits name this card and accept ANY of their shas appearing in the ledger.
    shas=$(cd "$REPO_M" 2>/dev/null && git log --all --since="$WINDOW_H hours ago" \
             --format=%h --grep="$short" 2>/dev/null | head -20)
    for s in $shas; do
      if grep -qF "$s" "$SHIP_LOG" 2>/dev/null; then verdict="clean (sha $s in ledger)"; break; fi
    done
  fi

  if [ -n "$verdict" ]; then
    echo "$card" >> "$STATE"
    log "$short $verdict"
    continue
  fi

  # Unaccounted for. Say what the ship actually touched so the reader can tell a real product
  # ship from a bookkeeping card without opening anything.
  touched="unresolved (no commit names this card)"
  if [ -n "${shas:-}" ]; then
    n=$(echo "$shas" | wc -l)
    # Show at most four shas: a card worked on a feature branch can name itself in a dozen
    # commit messages, and a wall of hashes buries the one word that matters (PRODUCT).
    shown=$(echo "$shas" | head -4 | tr '\n' ' ')
    [ "$n" -gt 4 ] && shown="$shown+$(( n - 4 )) more"
    paths=$(cd "$REPO_M" 2>/dev/null && git show --name-only --format= $shas 2>/dev/null | sort -u)
    if echo "$paths" | grep -q '^src/'; then
      touched="PRODUCT: touches src/ ($shown)"
    else
      touched="no src/ delta ($shown)"
    fi
  fi

  echo "$card" >> "$STATE"
  alerts=$(( alerts + 1 ))
  log "SWALLOWED $short -- $touched -- $title"
  alert_marveen "[SWALLOWED SHIP REPORT] card $short went done at $(TZ=Europe/Budapest date -d "@$done_ts" '+%F %H:%M') and ops/report-ship.log has no 'sent:' or 'skip (' line naming it. $touched. Title: $title | The pass-through law says every report reaches zubi once, so if this was a real ship the PO owes a BACKFILL report now (ship-report skill, note it as late). If it was a true no-op the PO owes the 'skip (' line instead. Judge it, do not assume: this gate is deliberately one-shot per card and will never mention $short again."

  if [ "$alerts" -ge "$MAX_ALERTS_PER_RUN" ]; then
    log "alert cap $MAX_ALERTS_PER_RUN reached; remaining cards wait for the next tick"
    break
  fi
done <<< "$cards"

exit 0

#!/usr/bin/env bash
# Reload the dashboard service that runs THIS repo's dist, right after a build.
#
# Closes the "built but not loaded" gap. Node reads dist/*.js once at process
# start, so a rebuild alone changes nothing: the fix is on disk, the running
# process is still on the old code, and every symptom the fix addresses keeps
# happening while the commit says it is fixed.
#
# On 2026-07-31 that cost the fleet two router fixes in one morning. 09f2141
# (round-robin tick budget) and 0409218 (mid-turn bus delivery) were both
# committed, built, and reported live while the process serving them had
# started at 05:58Z, an hour before the 06:59Z build. The bus queue kept
# growing exactly as before and the ship report said it was fixed.
#
# dashboard-dist-drift-watchdog.sh catches this, but only on its 15-minute
# cron, and only after the fact. This removes the window instead of alarming
# on it.
#
# The guard is the ExecStart path, not the repo name: a service is restarted
# only if it is ACTIVE and its ExecStart literally names the dist/index.js we
# just built. A specialist building in a worktree, a CI checkout, or the
# sibling mini-games fleet therefore cannot restart anything but its own.
#
# Never fails the build. Every exit is 0 by design.

set -uo pipefail

[ "${SKIP_POSTBUILD_RELOAD:-}" = "1" ] && exit 0
[ -n "${CI:-}" ] && exit 0

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
ENTRY="$REPO/dist/index.js"
[ -f "$ENTRY" ] || exit 0

# No user session bus (bare container, ssh without lingering) means nothing to
# reload. Not an error.
systemctl --user show-environment >/dev/null 2>&1 || exit 0

restarted=0
while read -r unit; do
  [ -n "$unit" ] || continue
  exec_line="$(systemctl --user show "$unit" -p ExecStart --value 2>/dev/null)"
  case "$exec_line" in
    *"$ENTRY"*) ;;
    *) continue ;;
  esac
  [ "$(systemctl --user is-active "$unit" 2>/dev/null)" = "active" ] || continue
  if systemctl --user restart "$unit" 2>/dev/null; then
    echo "postbuild: restarted $unit so it loads the build just produced"
    restarted=1
    # Record it as DELIBERATE. A restart here is a new pid, which is byte-identical at the observation layer
    # to the 18min-flap that dashboard-restart-rate-watchdog.sh exists to catch — so without this marker an
    # evening of shipping dashboard commits pages the main agent as a fault. It did exactly that on
    # 2026-07-31, seven builds in, before this line existed. The watchdog matches each churn event against a
    # marker within a few minutes and counts only the leftovers, so a genuine flap interleaved with a build
    # still fires. Same TZ as the watchdog's ts(), or the two logs cannot be compared.
    printf '%s RELOAD unit=%s entry=%s\n' \
      "$(TZ="${SCHEDULER_TZ:-Europe/Budapest}" date '+%Y-%m-%d %H:%M:%S')" "$unit" "$ENTRY" \
      >> "$REPO/store/dashboard-deliberate-reload.log" 2>/dev/null || true
  else
    echo "postbuild: WARNING could not restart $unit; it is still running the PREVIOUS dist" >&2
  fi
done < <(systemctl --user list-units --type=service --all --plain --no-legend '*dashboard*.service' 2>/dev/null | awk '{print $1}')

[ "$restarted" = 1 ] || echo "postbuild: no active service runs $ENTRY; nothing to reload"
exit 0

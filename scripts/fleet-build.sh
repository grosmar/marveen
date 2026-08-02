#!/usr/bin/env bash
# fleet-build.sh — serialize any dist-touching build / e2e across the fleet.
#
# WHY THIS EXISTS
#   The fleet shares ONE working tree + ONE dist/ for mandalion on the /mnt/d 9p mount.
#   `npm run build` = prebuild (rm -rf node_modules/.vite) -> astro build -> postbuild (pagefind).
#   Two failure modes when two agents do this at once on /mnt/d:
#     1. Agent A's build wipes+rewrites dist WHILE agent B's e2e serves/reads dist
#        (playwright serves dist/server/entry.mjs on :4322) -> transient 404s -> FALSE e2e fail
#        (S76-6 cost ~10min + a PO reclaim; this is a recurring time-sink).
#     2. Two concurrent builds saturate the slow 9p mount -> Vite fetchModule 60s deadlock
#        on the watchdog-owned astro dev (:4321) -> dev.mandalion.com goes 000 (~1h once).
#   This wrapper takes ONE EXCLUSIVE host lock around the whole critical section so only one
#   agent builds-or-reads-dist at a time. Hold it around the FULL e2e run (build + serve + assert),
#   not just the build, or a third agent's build can still wipe dist mid-read.
#
# RAILWAY-SAFE BY CONSTRUCTION
#   The prod deploy builds inside an alpine Docker image in GitLab CI (`RUN npm run build`), and
#   alpine has NO flock. So this lock must NEVER be embedded in package.json's `build` script.
#   Keep `build` pristine (Docker uses it); route the HOST callers (build:locked / test:e2e /
#   build-and-verify) through THIS wrapper, which Docker never invokes. flock is on the host.
#
# WATCHDOG-SAFE
#   A queued agent blocks here; the heartbeat lines below keep its pane emitting output so the
#   loop-watchdog's wedged-turn (token-flat) and crashed-idle checks don't false-positive on a
#   legitimately-waiting agent.
#
# USAGE
#   scripts/fleet-build.sh                         # default: `npm run build` in mandalion
#   scripts/fleet-build.sh npm run build           # explicit
#   scripts/fleet-build.sh sh -c 'npm run e2e:build && npx playwright test tests/e2e/'
#   FLEET_BUILD_DIR=/path scripts/fleet-build.sh ... # override repo dir
#
# EXIT CODES
#   passes through the wrapped command's exit code; 75 = gave up waiting for a stuck lock holder
#   (we abort rather than run a concurrent build that would wipe dist mid-read).

set -uo pipefail

LOCK="${FLEET_BUILD_LOCK:-/tmp/mandalion-build.lock}"   # local fs (ext4), NOT the /mnt/d 9p mount
# DIR defaults to the INVOKING git worktree/checkout, so a WORKTREE gate tests ITSELF, not main.
# (2026-06-12, failure mode 283c786: hardcoding the fallback to main meant a worktree's
# `npm run typecheck:locked`/`build:locked` silently ran against MAIN — the engineer burned ~6
# cycles on a false-RED from main's uncommitted Stars.astro WIP while its own worktree was GREEN.)
# Resolution: explicit FLEET_BUILD_DIR wins; else the git toplevel of $PWD IF it's a mandalion
# checkout (has astro.config.mjs); else fall back to the main checkout (covers cron/non-checkout cwds).
if [ -n "${FLEET_BUILD_DIR:-}" ]; then
  DIR="$FLEET_BUILD_DIR"
else
  _top="$(git -C "$PWD" rev-parse --show-toplevel 2>/dev/null || true)"
  if [ -n "$_top" ] && [ -f "$_top/astro.config.mjs" ]; then
    DIR="$_top"
  else
    DIR="/home/zubi/git-repos/mandalion"
  fi
fi
POLL="${FLEET_BUILD_POLL:-30}"                          # heartbeat cadence while queued (s)
MAX_WAIT="${FLEET_BUILD_MAXWAIT:-900}"                  # give up after this long (s); a build is ~95-155s

# Default command if none given.
if [ "$#" -eq 0 ]; then
  set -- npm run build
fi

ts() { date '+%H:%M:%S'; }
log() { echo "[fleet-build $(ts)] $*"; }

# REENTRANCY GUARD (card a8f337c8): if an ANCESTOR fleet-build.sh already holds the build lock,
# a nested :locked call must NOT try to re-acquire it — `flock -n 9` would fail, the until-loop
# would queue up to MAX_WAIT (900s), then exit 75 and the whole flow self-deadlocks. That is exactly
# the foot-gun the `.husky/pre-push -> npm run typecheck:locked` repoint (engineer half of a8f337c8)
# introduces if a `git push` ever fires the hook from inside a held lock. The ancestor's lock already
# serializes us, so just run the command lock-free. Mirrors the engineer's ATOMIC_COMMIT_LOCKED marker.
# The marker is set ONLY for the wrapped command's environment (see the run line below), never
# exported into fleet-build's own shell, so it cannot leak into the detached dev-server-watchdog.
if [ -n "${MANDALION_BUILD_LOCK_HELD:-}" ]; then
  log "reentrant call inside an already-held build lock (MANDALION_BUILD_LOCK_HELD set) — running lock-free in $DIR: $*"
  ( cd "$DIR" && exec "$@" )
  exit $?
fi

# Graceful degrade: if flock is missing (e.g. a stripped env), run WITHOUT the lock but warn loudly
# rather than hard-fail. On the real host flock is present (util-linux).
if ! command -v flock >/dev/null 2>&1; then
  log "WARNING: flock not found on PATH — running WITHOUT the fleet build lock (concurrency hazard UNGUARDED)." 1>&2
  ( cd "$DIR" && exec "$@" )
  exit $?
fi

exec 9>"$LOCK" || { log "FATAL: cannot open lockfile $LOCK" 1>&2; exit 1; }

if flock -n 9; then
  : # acquired immediately, no contention
else
  holder="$(cat "$LOCK" 2>/dev/null || true)"
  log "build lock held by another agent${holder:+ (pid ${holder})}; queuing so we don't wipe dist mid-build/e2e..."
  waited=0
  until flock -w "$POLL" 9; do
    waited=$(( waited + POLL ))
    log "still waiting for the build lock... ${waited}s elapsed (heartbeat — pane is alive, not wedged)"
    if [ "$waited" -ge "$MAX_WAIT" ]; then
      log "FATAL: waited ${waited}s for the build lock and never got it." 1>&2
      log "Refusing to run a concurrent build (it would wipe dist mid-e2e). Check for a stuck holder:" 1>&2
      log "  lsof $LOCK   # or: cat $LOCK" 1>&2
      exit 75
    fi
  done
fi

# We hold the exclusive lock. Stamp our pid so a later waiter can see who's building.
echo "$$" >&9 2>/dev/null || true
log "acquired build lock (pid $$) — running in $DIR: $*"

# DEFENSE-IN-DEPTH: reap any stray listener squatting the e2e preview port (:4322)
# BEFORE we run the wrapped build/e2e. WHY this is here and provably safe:
#   astro.config.mjs has port:4321 but (pre-strictPort) NO strictPort, so a watchdog
#   relaunch-race sibling `astro dev` that finds :4321 held AUTO-INCREMENTS onto :4322,
#   the @astrojs/node preview port playwright binds (PORT=4322, see
#   mandalion/playwright.config.ts). A leaked playwright preview can also linger there.
#   Either one makes the next e2e run against on-demand SSR (phantom 404s -> the S76-7
#   sentinel aborts QAEXIT=1) or fail to bind. We hold the EXCLUSIVE build lock right
#   now, so NO peer can legitimately be mid-build/e2e on :4322 -> anything listening on
#   it is a stray and is safe to kill. (strictPort:true in astro.config is the ROOT
#   fix that stops the wander; this backstops the pre-strictPort window + leaked
#   previews, and re-arms automatically if strictPort is ever dropped.)
#   See docs/marveen/known-failure-modes.md ':4322 reused by Playwright'.
#   Disable with FLEET_BUILD_REAP_PORTS="" ; extend the guarded set by adding ports.
# PORT-MOVE 2026-06-12: canonical dev port moved 4321 -> 4330 (host-local workaround for
# the WSL2/winnat :4321 phantom reservation; watchdog launches `astro dev --port 4330`).
# So a relaunch-race sibling now AUTO-INCREMENTS onto :4331+ (not :4322), accreting a stray
# per build until reaped. We reap 4331-4335 (strays ABOVE the 4330 canonical) and keep 4322
# (the legacy 4321-default-path stray, still possible for any `astro dev` launched WITHOUT
# --port, which tries the 4321 phantom then wanders to 4322). NEVER include 4330 (live server).
REAP_PORTS="${FLEET_BUILD_REAP_PORTS:-4322 4331 4332 4333 4334 4335 4336 4337 4338 4339 4340}"
reap_stray_port() {
  local port="$1" pids pid cmd
  # Only ONE process can hold a LISTEN socket on a port, so fall through the
  # PID-yielding tools in order and stop at the first hit. (A brace-group union here
  # would concatenate a non-newline-terminated tool's output with the next tool's
  # into a garbage PID.) ss is last because it is blind to bound ports in some
  # WSL2/sandbox netns; lsof/fuser read /proc and are reliable on the host.
  pids="$(lsof -ti "tcp:${port}" -sTCP:LISTEN 2>/dev/null || true)"
  [ -z "$pids" ] && pids="$(fuser "${port}/tcp" 2>/dev/null | tr -s ' ' '\n' || true)"
  [ -z "$pids" ] && pids="$(ss -ltnpH "sport = :${port}" 2>/dev/null | grep -oE 'pid=[0-9]+' | cut -d= -f2 || true)"
  pids="$(printf '%s\n' $pids | grep -E '^[0-9]+$' | sort -u || true)"
  [ -z "$pids" ] && return 0
  for pid in $pids; do
    cmd="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
    # SAFETY: only reap a dev/preview-shaped process. The lock guarantees no legit e2e
    # is running, but never SIGKILL an unrelated process that happens to hold the port.
    case "$cmd" in
      *astro*|*vite*|*playwright*|*entry.mjs*)
        log "REAP: pid $pid squatting preview port :${port} (stray under the build lock) -> SIGTERM [${cmd# }]"
        kill -TERM "$pid" 2>/dev/null || true ;;
      *)
        log "WARNING: :${port} held by pid $pid but cmdline is not dev/preview-shaped -> NOT killing [${cmd# }]" 1>&2 ;;
    esac
  done
  sleep 1
  for pid in $pids; do
    kill -0 "$pid" 2>/dev/null || continue
    cmd="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
    case "$cmd" in
      *astro*|*vite*|*playwright*|*entry.mjs*)
        log "REAP: pid $pid survived SIGTERM on :${port} -> SIGKILL"
        kill -KILL "$pid" 2>/dev/null || true ;;
    esac
  done
}
for _reap_port in $REAP_PORTS; do reap_stray_port "$_reap_port"; done

# 9>&- closes the lock fd for the wrapped command + everything it spawns. bash's
# `exec 9>` is NOT close-on-exec, so without this a child that outlives us would
# inherit the OFD and keep the build lock held after we exit.
# MANDALION_BUILD_LOCK_HELD=1 is set INLINE (scoped to the wrapped command's environment, not
# exported into fleet-build's own shell) so any nested fleet-build.sh the command spawns — e.g. a
# `git push` firing .husky/pre-push -> typecheck:locked — sees the marker and runs lock-free via the
# reentrancy guard above instead of deadlocking on our lock. Inline scope = it cannot leak into the
# detached dev-server-watchdog restart below (which runs in fleet-build's shell, marker-unset). (a8f337c8)
( cd "$DIR" && MANDALION_BUILD_LOCK_HELD=1 "$@" ) 9>&-
status=$?

log "command finished (exit $status) — releasing build lock"

# A dist-touching build/e2e in this SHARED worktree regenerates .astro/ — the
# content-layer store + generated content config the watchdog-owned `astro dev`
# (:4321) is watching — so the dev server reloads with an EMPTY content config and
# every /blog route 404s until it is restarted. That is the dev.mandalion.com
# "flap" zubi sees, and it's what made the watchdog thrash (it discovered the
# corruption minutes later and relaunched into the next build's I/O storm). Now
# that the build is done and the mount is going quiet, trigger ONE clean restart
# through the watchdog (single source of dev-server lifecycle; it holds its own
# lock + warm-up grace). Fire-and-forget so we don't block the caller; the
# watchdog's autonomous canary path still backstops a lost trigger.
WATCHDOG="$DIR/scripts/dev-server-watchdog.sh"
if [ -f "$WATCHDOG" ]; then
  log "triggering a clean dev-server (:4330) restart — this build disconnected its content layer"
  # 9>&- is LOAD-BEARING: --force-restart's relaunch() starts a long-lived `npm run
  # dev`. Without closing our lock fd here, that daemon inherits the OFD and holds
  # the build lock for its whole life -> EVERY later build:locked deadlocks
  # fleet-wide (2026-06-07 incident: dev server held /tmp/mandalion-build.lock via
  # leaked fd 9; see docs/marveen/known-failure-modes.md 'build-lock fd leak').
  setsid nohup bash "$WATCHDOG" --force-restart >/dev/null 2>&1 </dev/null 9>&- &
fi

exit "$status"

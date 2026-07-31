#!/usr/bin/env bash
# effort-level-watchdog.sh -- catches a running agent whose EFFECTIVE effortLevel is not a
# vetted value, before that agent silently loses a capability and burns turns discovering it.
#
# Failure class this prevents (2026-07-31): `effortLevel: xhigh` makes EVERY WebSearch call
# fail with a deterministic 400 --
#   output_config.effort 'xhigh' is not supported when thinking is disabled on this model.
#   Use effort 'high' or below, or enable thinking.
# WebSearch issues a sub-request with thinking disabled, xhigh requires thinking, so search is
# dead for the whole session. The analyst burned 8 calls before reporting it, because the
# instinct on a failed search is to retry. Nothing aggregated it: the failure is per-call and
# inside the agent's own session, so there was NO fleet-level signal at all. Meanwhile the
# marveen main session and marveen-channels inherited the same value from ~/.claude and nobody
# knew the agent zubi talks to for everything had no working search.
#
# WHY AN ALLOWLIST AND NOT A DENYLIST. A gate keyed on the literal string "xhigh" is keyed on
# the instance that was measured, not on the mechanism -- the exact scope error logged three
# times in two days (memory: remedy-must-fit-the-mechanism). Any future value, or a typo, would
# pass such a gate silently. So: anything not explicitly vetted is flagged, including a typo.
#
# WHY IT PRINTS ITS OWN CONTROLS ON EVERY RUN (memory: wire-the-control-into-the-instrument).
# A resolver that quietly stops resolving looks exactly like a clean fleet: an empty bad-list.
# So every run drives two synthetic fixtures through the SAME resolver -- one that must be
# flagged and one that must not -- and reports a resolver fault if either verdict is wrong.
# The control is inside the output being read, not behind a --verbose flag nobody passes.
#
# Deliberately dependency-light; python3 is required for JSON and its ABSENCE is an alert, never
# a silent skip (memory: bumblebee-scan-inert-binary-never-built -- a task that silently skips
# every run is zero coverage that reads as green). Alerts marveen's inbox (NOT zubi -- Marveen
# decides whether a value is deliberate), cooldown-guarded; NEVER mutates a settings file, a
# repo or a running process. Foreign fleets on this host are REPORTED, never acted on.
set -uo pipefail

REPO=/home/zubi/marveen
TOKEN_FILE="$REPO/store/.dashboard-token"
LOG=/tmp/effort-level-watchdog.log
COOLDOWN_FILE=/tmp/effort-level-watchdog.last
COOLDOWN=21600          # s: config drift is slow and only changes at restart; at most one alert / 6h
PY=/usr/bin/python3     # absolute: cron PATH is not a login PATH

# Vetted values. The API says "use effort 'high' or below", so these three are the known-good set.
# An empty resolution (nothing sets it anywhere) is the model default and is treated as OK.
ALLOWED="high medium low"

# Sessions this fleet owns. Anything else running claude on this host is reported under FOREIGN
# and never acted on -- a silent exclusion and a checked non-applicability look identical later.
OWNED_RE='^(agent-[a-z]+|marveen-channels|marveen-worker(-fast)?)$'

MODE=run
case "${1:-}" in
  --dry) MODE=dry ;;
  --self-test) MODE=selftest ;;
esac

ts(){ TZ=Europe/Budapest date '+%Y-%m-%d %H:%M:%S'; }
log(){ printf '[%s] %s\n' "$(ts)" "$1" >>"$LOG"; }
json_str(){ local s=${1//\\/\\\\}; s=${s//\"/\\\"}; s=${s//$'\n'/\\n}; printf '"%s"' "$s"; }

alert_marveen() {
  local msg="$1" token
  if [ ! -f "$TOKEN_FILE" ]; then
    log "CANNOT ALERT: token file missing at $TOKEN_FILE. Message follows:"; log "$msg"; return 0
  fi
  token=$(cat "$TOKEN_FILE" 2>/dev/null) || { log "CANNOT ALERT: token unreadable"; return 0; }
  curl -s --max-time 5 -X POST http://localhost:3420/api/messages \
    -H "Authorization: Bearer $token" -H "Content-Type: application/json" \
    -d "{\"from\":\"effort-level-watchdog\",\"to\":\"marveen\",\"content\":$(json_str "$msg")}" \
    >/dev/null 2>&1 || log "CANNOT ALERT: POST to /api/messages failed"
}

# --- the anti-inert control: a missing interpreter is a REPORTED fault, not a quiet exit -------
if [ ! -x "$PY" ]; then
  M="[effort-level-watchdog] INERT: $PY missing or not executable, so NO agent was checked this run.
This is not a clean result. Zero coverage reading as green is the bumblebee failure class.
Fix the interpreter path or the watchdog stays blind."
  log "INERT: $PY missing"; [ "$MODE" = run ] && alert_marveen "$M"; printf '%s\n' "$M"; exit 1
fi

# --- collect (session, pid, cwd) for every live claude process under tmux ----------------------
# The pane pid IS the claude process for fleet sessions (verified 2026-07-31); fall back to a
# one-level child walk for any session that wraps it in a shell.
collect_sessions() {
  local s pp k comm cwd
  command -v tmux >/dev/null 2>&1 || return 0
  for s in $(TMUX= tmux ls -F '#{session_name}' 2>/dev/null); do
    pp=$(TMUX= tmux list-panes -t "$s" -F '#{pane_pid}' 2>/dev/null | head -1) || continue
    [ -n "${pp:-}" ] || continue
    comm=$(cat "/proc/$pp/comm" 2>/dev/null || true)
    if [ "$comm" != "claude" ]; then
      for k in $(pgrep -P "$pp" 2>/dev/null); do
        if [ "$(cat "/proc/$k/comm" 2>/dev/null || true)" = "claude" ]; then pp=$k; comm=claude; break; fi
      done
    fi
    [ "$comm" = "claude" ] || continue
    cwd=$(readlink "/proc/$pp/cwd" 2>/dev/null) || continue
    printf '%s\t%s\t%s\n' "$s" "$pp" "$cwd"
  done
}

# --- resolve + report -------------------------------------------------------------------------
# The resolver walks cwd upward taking the NEAREST .claude that defines effortLevel (local before
# shared), then falls back to ~/.claude. Nearest-wins is not assumed: it is the empirically proven
# behaviour -- editing agents/analyst/.claude/settings.json + restart fixed the analyst's search
# on 2026-07-31 while /home/zubi/marveen/.claude and ~/.claude both still said otherwise.
run_report() {
  # The resolver program goes to a temp FILE, not to python's stdin. A `<<HEREDOC` on the python
  # command replaces stdin and silently swallows the piped session rows -- caught on this gate's
  # own first run by the controls below, which is the whole argument for having them.
  local prog; prog=$(mktemp /tmp/effort-level-watchdog.XXXXXX.py) || return 3
  cat >"$prog" <<'PYEOF'
import json, os, re, sys

allowed = set(sys.argv[1].split())
owned_re = re.compile(sys.argv[2])
mode = sys.argv[3]
HOME = os.path.expanduser("~")

def resolve(cwd):
    """Return (value, deciding_file). value None => nothing sets it anywhere."""
    chain, d = [], os.path.abspath(cwd)
    while True:
        chain.append(os.path.join(d, ".claude", "settings.local.json"))
        chain.append(os.path.join(d, ".claude", "settings.json"))
        parent = os.path.dirname(d)
        if parent == d:
            break
        d = parent
    chain.append(os.path.join(HOME, ".claude", "settings.local.json"))
    chain.append(os.path.join(HOME, ".claude", "settings.json"))
    seen = set()
    for p in chain:
        if p in seen or not os.path.isfile(p):
            continue
        seen.add(p)
        try:
            with open(p) as f:
                v = json.load(f).get("effortLevel")
        except Exception as e:
            return ("<unreadable: %s>" % type(e).__name__, p)
        if v is not None:
            return (v, p)
    return (None, None)

def verdict(value):
    if value is None:
        return "OK"                      # nothing sets it: model default
    return "OK" if value in allowed else "FLAG"

# ---- the controls, driven through the SAME resolver on every run -------------------------
import tempfile
ctl_lines, resolver_fault = [], []
with tempfile.TemporaryDirectory() as td:
    for name, val, want in (("must-FLAG", "xhigh", "FLAG"), ("must-pass", "high", "OK")):
        sub = os.path.join(td, name, ".claude")
        os.makedirs(sub)
        with open(os.path.join(sub, "settings.json"), "w") as f:
            json.dump({"effortLevel": val}, f)
        got_v, _ = resolve(os.path.join(td, name))
        got = verdict(got_v)
        ok = (got == want and got_v == val)
        ctl_lines.append("  control %-10s value=%-6s verdict=%-4s expected=%-4s %s"
                         % (name, got_v, got, want, "ok" if ok else "<-- RESOLVER FAULT"))
        if not ok:
            resolver_fault.append(name)

rows = []
for line in sys.stdin:
    line = line.rstrip("\n")
    if not line:
        continue
    sess, pid, cwd = line.split("\t", 2)
    v, src = resolve(cwd)
    rows.append({"sess": sess, "pid": pid, "cwd": cwd, "val": v, "src": src,
                 "verdict": verdict(v), "owned": bool(owned_re.match(sess))})

rows.sort(key=lambda r: (not r["owned"], r["sess"]))
owned = [r for r in rows if r["owned"]]
foreign = [r for r in rows if not r["owned"]]
bad = [r for r in owned if r["verdict"] == "FLAG"]

out = []
out.append("allowlist: %s   (anything else is flagged, including a typo)" % " ".join(sorted(allowed)))
out.append("controls, run through the same resolver as the fleet:")
out.extend(ctl_lines)
out.append("")
out.append("OWNED (%d):" % len(owned))
for r in owned:
    out.append("  %-4s %-22s pid=%-8s %s" % (r["verdict"], r["sess"], r["pid"],
               ("%s  <- %s" % (r["val"], r["src"].replace(HOME, "~"))) if r["val"] is not None
               else "unset everywhere (model default)"))
if foreign:
    out.append("FOREIGN, reported only, never acted on (%d):" % len(foreign))
    for r in foreign:
        out.append("  %-4s %-22s pid=%-8s %s" % ("--", r["sess"], r["pid"],
                   r["val"] if r["val"] is not None else "unset"))

body = "\n".join(out)
print(body)

if resolver_fault:
    print("\nRESOLVER FAULT: %s. An empty bad-list this run means nothing." % ",".join(resolver_fault))
    sys.exit(2)
if not owned:
    print("\nNO OWNED SESSIONS FOUND. Not a clean fleet -- the collector returned nothing.")
    sys.exit(3)
sys.exit(1 if bad else 0)
PYEOF
  collect_sessions | "$PY" "$prog" "$ALLOWED" "$OWNED_RE" "$MODE"
  local rc=$?
  rm -f "$prog"
  return $rc
}

# --- self-test: prove the decision boundary, then stop ----------------------------------------
if [ "$MODE" = selftest ]; then
  echo "== effort-level-watchdog --self-test =="
  out=$(run_report); rc=$?
  printf '%s\n' "$out"
  echo
  case $rc in
    0) echo "self-test: resolver OK, no owned session flagged." ;;
    1) echo "self-test: resolver OK, and it is currently flagging at least one owned session." ;;
    2) echo "self-test: FAILED -- the resolver mis-verdicts its own fixtures."; exit 1 ;;
    3) echo "self-test: FAILED -- collector found no owned claude session."; exit 1 ;;
  esac
  echo "self-test: PASS"
  exit 0
fi

REPORT=$(run_report); RC=$?
log "rc=$RC"

if [ "$MODE" = dry ]; then
  echo "== effort-level-watchdog --dry (no alert will be sent) =="
  printf '%s\n' "$REPORT"; echo; echo "rc=$RC"
  exit 0
fi

[ "$RC" -eq 0 ] && { log "clean"; exit 0; }

now=$(date +%s)
if [ -f "$COOLDOWN_FILE" ]; then
  last=$(cat "$COOLDOWN_FILE" 2>/dev/null || echo 0)
  [ $((now - last)) -lt "$COOLDOWN" ] && { log "cooling down"; exit 0; }
fi

case $RC in
  1) HEAD="[effort-level-watchdog] An owned agent is running an unvetted effortLevel." ;;
  2) HEAD="[effort-level-watchdog] RESOLVER FAULT -- the gate mis-verdicted its own control fixtures. It is not currently checking anything." ;;
  3) HEAD="[effort-level-watchdog] Collector found no owned claude session. Either the fleet is down or the collector broke." ;;
  *) HEAD="[effort-level-watchdog] Unexpected rc=$RC." ;;
esac

alert_marveen "$HEAD

$REPORT

Known instance: xhigh kills EVERY WebSearch call with a deterministic 400 (thinking is disabled
in the sub-request). Settings are read once at process start, so an edit fixes nothing live --
the instrument is a restart, and the proof is one probe call afterwards, not the file contents.
This gate never edits a settings file and never restarts anything; both are yours."
printf '%s\n' "$now" >"$COOLDOWN_FILE"
log "alerted rc=$RC"

#!/bin/bash
# Resolve THIS install's channel state dir. SOURCE this; do not execute it.
#
# WHY: one Unix user can run several fleets, but $HOME/.claude/channels/<provider>
# is a SHARED path. A script that hardcodes it reads whichever fleet last wrote
# that dir -- so a second fleet's guards alerted through fleet #1's bot token, and
# fleet-memory-gate.sh made its authorization decision from fleet #1's access.json.
# Nothing logged an error: the chat id came from each install's own .env, so the
# messages reached the same human and looked correct.
#
# It is also stale-prone in the OTHER direction: once an install sets
# CHANNEL_STATE_DIR, its dashboard and plugin move, and the legacy dir keeps a
# frozen copy of the token. A script still reading the legacy path would keep
# using the old token after a rotation.
#
# Precedence: an already-exported CHANNEL_STATE_DIR (cron / systemd injection)
#   > the install's own .env
#   > the legacy shared path (byte-identical behaviour on a single-fleet host).
#
# Defines: CHANNEL_STATE_DIR, CHANNEL_ENV_FILE, CHANNEL_ACCESS_JSON, CHANNEL_PROVIDER.
# Safe under `set -u`.

_lcs_install="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd)" || _lcs_install=""

_lcs_env_val() {
  # $1 = key. Reads the install's .env the same way channels.sh does
  # (cut -d= -f2- + quote strip), so all consumers agree on the value.
  [ -n "$_lcs_install" ] && [ -f "$_lcs_install/.env" ] || return 0
  grep -E "^$1=" "$_lcs_install/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d "\"'"
}

CHANNEL_PROVIDER="${CHANNEL_PROVIDER:-$(_lcs_env_val CHANNEL_PROVIDER)}"
CHANNEL_PROVIDER="${CHANNEL_PROVIDER:-telegram}"

CHANNEL_STATE_DIR="${CHANNEL_STATE_DIR:-$(_lcs_env_val CHANNEL_STATE_DIR)}"
CHANNEL_STATE_DIR="${CHANNEL_STATE_DIR:-$HOME/.claude/channels/$CHANNEL_PROVIDER}"
# Expand a leading ~ so consumers can use the value as a literal path.
case "$CHANNEL_STATE_DIR" in "~/"*) CHANNEL_STATE_DIR="$HOME/${CHANNEL_STATE_DIR#\~/}" ;; esac

CHANNEL_ENV_FILE="$CHANNEL_STATE_DIR/.env"
CHANNEL_ACCESS_JSON="$CHANNEL_STATE_DIR/access.json"

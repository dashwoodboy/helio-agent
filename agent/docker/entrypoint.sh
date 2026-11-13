#!/bin/sh
# Pair on first start (the code shows in the container logs), then run.
# The token lives in /config (mount a volume there to survive re-creates).
set -e

CLI="node /app/helio-agent-cli.cjs"
CONFIG="${XDG_CONFIG_HOME:-/config}/helio-agent/config.json"

# Any arguments go straight to the CLI (e.g. `docker run … add-stick --ip …`).
if [ $# -gt 0 ]; then
  exec $CLI "$@"
fi

paired() {
  # "token": "hat_..." present means paired; "token": null means not.
  [ -f "$CONFIG" ] && grep -q '"token": *"' "$CONFIG"
}

if ! paired; then
  echo "Not paired yet — starting the pairing. Approve the code below on the website."
  # A code lasts 10 minutes. If it expires unapproved, pair exits non-zero,
  # the container stops and the restart policy brings a fresh code here.
  $CLI pair \
    ${HELIO_SERVER_URL:+--server "$HELIO_SERVER_URL"} \
    --name "${HELIO_AGENT_NAME:-Docker agent}"
fi

exec $CLI run

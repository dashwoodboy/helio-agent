# Helio Agent

A small desktop app (Windows / macOS / Linux) that finds Solarman logger
sticks on your network and streams their data to your Helio server over one
outbound TLS connection — nothing to configure on the stick or router. Sign-in
is a browser-approved pairing code; no password ever enters the app. A
headless CLI build (`helio-agent-cli.cjs`, node >= 20) covers servers without
a screen.

The app lives in `agent/`; `backend/` mirrors the Helio monorepo's backend,
which the agent shares its Solarman V5 protocol code and test fixtures with.

Build: `npm ci` in `backend/` and `agent/`, then in `agent/`:
`npm run dist` (installers) and `npm run dist:cli` (server CLI).

Publishing a GitHub release builds everything and attaches the artifacts:
point the website's `AGENT_DOWNLOAD_BASE_URL` at
`https://github.com/dashwoodboy/helio-agent/releases/latest/download`.

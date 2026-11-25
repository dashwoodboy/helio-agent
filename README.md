# Helio Agent — live monitoring for Deye & Sunsynk inverters

The desktop companion of **[Helio](https://helio-power.eu)**, a free,
self-hosted solar monitoring and inverter-control platform for **Deye** and
**Sunsynk** hybrid inverters (and other Deye-based brands).

[![The Helio live dashboard](https://helio-power.eu/og.png)](https://helio-power.eu)

The agent is a small app for **Windows, macOS and Linux** that finds the
Solarman WiFi logger stick on your network and streams inverter data to your
Helio server over one outbound TLS connection — nothing to configure on the
stick or the router. Sign-in is a browser-approved pairing code; no password
ever enters the app. A headless CLI build (`helio-agent-cli.cjs`, Node 20+)
covers servers and Raspberry Pis, and there is a Docker image and a ready
Raspberry Pi SD image too.

**What Helio gives you** ([live demo](https://helio-power.eu/demo)):

- A live dashboard that updates every few seconds: solar, battery, grid and
  home in an animated energy-flow diagram
- Day / month / year / lifetime history, battery analytics, grid quality and
  outage tracking
- Alerts as push notifications: grid lost and restored, low battery, high
  temperature, PV underperformance, storm warnings
- Safe control of the inverter's own settings: energy priority, export
  limits, battery limits, time-of-use schedule

**Supported hardware:** Deye hybrid inverters, single- and three-phase
(SG04LP3 / SG01HP3 families), and Deye-based brands such as Sunsynk — through
the Solarman WiFi logger stick they ship with.

Get started: [helio-power.eu](https://helio-power.eu) ·
[docs](https://helio-power.eu/docs) ·
[downloads](https://helio-power.eu/downloads) ·
[Discord community](https://discord.gg/dQkq8JMQ4)

## Repository layout & building

The app lives in `agent/`; `backend/` mirrors the Helio monorepo's backend,
which the agent shares its Solarman V5 protocol code and test fixtures with.

Build: `npm ci` in `backend/` and `agent/`, then in `agent/`:
`npm run dist` (installers) and `npm run dist:cli` (server CLI).

Publishing a GitHub release builds everything and attaches the artifacts:
point the website's `AGENT_DOWNLOAD_BASE_URL` at
`https://github.com/dashwoodboy/helio-agent/releases/latest/download`.

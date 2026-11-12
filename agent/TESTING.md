# Agent manual test matrix

The automated suites (`npm test` in `agent/`, `backend/`) cover the
protocol, the race conditions and the verification logic. The scenarios
below involve real operating systems, networks and hardware, so they are
checked by hand before tagging a release (`agent-v*`).

## Connection resilience (desktop app)

| # | Scenario | Steps | Expected |
|---|----------|-------|----------|
| 1 | Sleep/resume | Pair, stream data, sleep the computer 5+ minutes, wake | Status goes online within seconds of waking (powerMonitor triggers reconnect + rescan); no "connected but no data" |
| 2 | Wi-Fi switch | Move the computer to another Wi-Fi / hotspot and back | Interface watcher reconnects on each change; sticks rediscovered when back on the LAN |
| 3 | Half-open socket | `kill -STOP` the backend process (or pull the server's network) for 2+ minutes, then resume | Server side: session terminated after ~65 s of missed pongs. Agent side: watchdog kills the dead socket ≤ 75 s and reconnects with backoff + jitter |
| 4 | Server restart | Restart the backend while agents stream | All agents reconnect (jitter spreads them out); environments heal via stick reconciliation without touching the UI |
| 5 | Double start | Launch the agent twice (second instance via CLI with the same token) | Old instance shows "Another agent instance took over"; data flows through the new one; no polling stops |

## TLS, proxy, antivirus

| # | Scenario | Steps | Expected |
|---|----------|-------|----------|
| 6 | TLS-inspecting middlebox | Install a local CA (e.g. mitmproxy) into the OS trust store, route the agent through it | Electron app connects (Chromium fetch + system CAs for ws). CLI works with `NODE_USE_SYSTEM_CA=1` |
| 7 | HTTPS proxy | Set a system proxy (macOS/Windows) and `HTTPS_PROXY` for the CLI | Pairing and the WebSocket both go through the proxy; `NO_PROXY` exempts hosts |
| 8 | Broken TLS | Point the agent at a host with a self-signed cert (no `--ca`) | Clear certificate error naming antivirus/proxy as likely causes — never a bare "fetch failed"; "Check connection" pinpoints the TLS step |

## Discovery permissions

| # | Scenario | Steps | Expected |
|---|----------|-------|----------|
| 9 | macOS Local Network denied | Deny the Local Network prompt, scan | Empty state explains and offers the "Open Local Network settings" button; allowing fixes discovery on the next scan |
| 10 | Windows Firewall | Block the agent on private networks | Empty state shows the firewall hint; allowing fixes discovery |
| 11 | UDP-deaf stick | Stick that ignores the discovery probe | Found by TCP fallback as "Serial unknown"; typing the label serial adopts it; remembered (knownSticks) across restarts |

## Pairing and identity

| # | Scenario | Steps | Expected |
|---|----------|-------|----------|
| 12 | First run | Install, open the app | Pairing starts by itself; after approval the "choose your stick on the website" screen appears; autostart is ON |
| 13 | Reinstall | Uninstall (keep config) or revoke-and-repair | Re-pairing keeps the agent id; the environment resumes without edits; no duplicate agent on Account → My agents |
| 14 | Agent limit | Pair a 6th agent | Clear message pointing at Account → My agents to revoke one |

## Always-on options

| # | Scenario | Steps | Expected |
|---|----------|-------|----------|
| 15 | Linux installer | One-liner on a clean Debian/Ubuntu VM | Service runs as `helio`, pairs interactively, survives reboot; `--uninstall` removes everything |
| 16 | Docker | Compose example on a Linux host with `network_mode: host` | Code appears in `docker logs`; discovery sees LAN sticks; token survives container re-create (volume) |
| 17 | **Pi image on real hardware** | Flash `HelioAgent-Pi.img.xz` with the Raspberry Pi Imager (set Wi-Fi + hostname), boot on the inverter's LAN | Boots headless; `http://helio-agent.local` serves the status page; pairing code approves; stick found; survives power cycle; self-update applies a newer release within 6 h and the service restarts on the new version |
| 18 | Pi + Imager repo | Add `os-list.json` release URL to the Imager | "Helio Agent" appears with icon/description; download + verify + flash works end to end |

Record the date, agent version and OS versions tested alongside the release
notes when running the matrix.

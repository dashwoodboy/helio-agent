import { useEffect, useRef, useState } from "react";

interface Stick {
  serial: number | null;
  ip: string;
  mac: string | null;
  reachable: boolean;
  manual: boolean;
}

interface StatusDetail {
  status: string;
  code: number | null;
  message: string;
  nextRetryAt: number | null;
}

interface PreflightStep {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
}

interface UiState {
  view: "signin" | "status";
  status: string;
  statusDetail: StatusDetail;
  discoveryIssue: string | null;
  platform: string;
  justPaired: boolean;
  serverUrl: string;
  agentName: string;
  sticks: Stick[];
  pairing: { userCode: string; verificationUrl: string } | null;
  pairingError: string | null;
  autostart: boolean;
  secureStorage: boolean;
  version: string;
  updateAvailable: string | null;
  updateDownload: { received: number; total: number | null } | null;
}

interface Bridge {
  getState: () => Promise<UiState>;
  onState: (cb: (state: UiState) => void) => () => void;
  startPairing: (serverUrl: string) => Promise<void>;
  cancelPairing: () => Promise<void>;
  openVerification: () => Promise<void>;
  signOut: () => Promise<void>;
  setAutostart: (enabled: boolean) => Promise<void>;
  rescan: () => Promise<void>;
  addManualStick: (ip: string, port: number, serial: number | null) => Promise<string | null>;
  removeManualStick: (ip: string) => Promise<void>;
  setStickSerial: (ip: string, serial: number) => Promise<string | null>;
  installUpdate: () => Promise<string | null>;
  copyDiagnostics: () => Promise<string | null>;
  reconnectNow: () => Promise<void>;
  checkConnection: () => Promise<PreflightStep[]>;
  dismissJustPaired: () => Promise<void>;
  openWizard: () => Promise<void>;
  openNetworkSettings: () => Promise<void>;
}

const helio = (window as unknown as { helio: Bridge }).helio;

/** Mirror of core/discovery.ts (the renderer cannot import node modules). */
function isPrivateIp(ip: string): boolean {
  if (/^127(\.\d{1,3}){3}$/.test(ip)) return true;
  if (/^10(\.\d{1,3}){3}$/.test(ip)) return true;
  if (/^192\.168(\.\d{1,3}){2}$/.test(ip)) return true;
  if (/^169\.254(\.\d{1,3}){2}$/.test(ip)) return true;
  const m = ip.match(/^172\.(\d{1,3})(\.\d{1,3}){2}$/);
  return !!m && Number(m[1]) >= 16 && Number(m[1]) <= 31;
}

function isValidIpv4(ip: string): boolean {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  return !!m && m.slice(1).every((octet) => Number(octet) <= 255);
}

const STATUS_LABEL: Record<string, string> = {
  idle: "Not connected",
  connecting: "Connecting…",
  online: "Connected to Helio",
  offline: "Reconnecting…",
  unauthorized: "Signed out",
  replaced: "Another agent instance took over",
  update_required: "Update required",
};

export function App(): React.JSX.Element {
  const [state, setState] = useState<UiState | null>(null);

  useEffect(() => {
    void helio.getState().then(setState);
    return helio.onState(setState);
  }, []);

  if (!state) return <div className="shell" />;
  return (
    <div className="shell">
      <header className="head">
        <span className="logo">☀</span>
        <div>
          <h1>Helio Agent</h1>
          <p className="muted">v{state.version}</p>
        </div>
      </header>
      {state.statusDetail.status === "update_required" && !state.updateAvailable && (
        <p className="warn">
          {state.statusDetail.message ||
            "The server requires a newer agent version. Please update the app."}
        </p>
      )}
      {state.updateAvailable && (
        <UpdateBanner version={state.updateAvailable} download={state.updateDownload} />
      )}
      {state.view === "signin" ? (
        <SignIn state={state} />
      ) : state.justPaired ? (
        <JustPaired />
      ) : (
        <Status state={state} />
      )}
      {!state.secureStorage && (
        <p className="warn">
          No OS keyring was found — the agent token is stored in a protected file instead.
        </p>
      )}
    </div>
  );
}

function SignIn({ state }: { state: UiState }): React.JSX.Element {
  const [serverUrl, setServerUrl] = useState(state.serverUrl);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const autoStarted = useRef(false);

  const start = async (): Promise<void> => {
    setBusy(true);
    try {
      await helio.startPairing(serverUrl);
    } finally {
      setBusy(false);
    }
  };

  // First open: begin pairing by itself — one less click. Never repeats
  // after an error or a cancel (the user decides from there).
  useEffect(() => {
    if (autoStarted.current || state.pairing || state.pairingError) return;
    autoStarted.current = true;
    void helio.startPairing(state.serverUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (state.pairing) {
    return (
      <main className="card">
        <h2>Approve this computer</h2>
        <p>
          A browser window opened on the Helio website. Check that it shows this code and approve:
        </p>
        <div className="code">{state.pairing.userCode}</div>
        <p className="muted">
          Only approve if you just started the Helio Agent on your own computer.
        </p>
        <div className="row">
          <button onClick={() => void helio.openVerification()}>Open browser again</button>
          <button className="ghost" onClick={() => void helio.cancelPairing()}>
            Cancel
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="card">
      <h2>Sign in</h2>
      <p>
        Link this computer ({state.agentName}) to your Helio account. Your browser opens and shows
        a code to approve — no password is typed here.
      </p>
      {state.pairingError && <p className="error">{state.pairingError}</p>}
      <button disabled={busy} onClick={() => void start()}>
        {busy ? "Starting…" : "Sign in with the browser"}
      </button>
      <button className="link" onClick={() => setShowAdvanced((v) => !v)}>
        Advanced
      </button>
      {showAdvanced && (
        <label className="field">
          Helio server
          <input
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
            placeholder="https://helio-power.eu"
            spellCheck={false}
          />
          <span className="muted">Only https:// servers are accepted.</span>
        </label>
      )}
    </main>
  );
}

/** "Paired — now pick the stick on the website" hand-off screen. */
function JustPaired(): React.JSX.Element {
  return (
    <main className="card">
      <h2>This computer is linked ✓</h2>
      <p>
        One step left: open Helio and create your environment — that's where you pick the stick
        this agent found and give your installation a name.
      </p>
      <div className="row">
        <button onClick={() => void helio.openWizard()}>Open Helio</button>
        <button className="ghost" onClick={() => void helio.dismissJustPaired()}>
          I'll do it later
        </button>
      </div>
      <p className="muted">The agent keeps running in the background (look for the tray icon).</p>
    </main>
  );
}

/**
 * Status with the reason and the next retry, plus "Try now" and a
 * step-by-step connection check for when retrying doesn't help.
 */
function StatusCard({ state }: { state: UiState }): React.JSX.Element {
  const { statusDetail } = state;
  const online = statusDetail.status === "online";
  const [, forceTick] = useState(0);
  const [checking, setChecking] = useState(false);
  const [steps, setSteps] = useState<PreflightStep[] | null>(null);

  // Tick every second while a retry countdown is showing.
  useEffect(() => {
    if (!statusDetail.nextRetryAt) return;
    const t = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [statusDetail.nextRetryAt]);

  const retryInS = statusDetail.nextRetryAt
    ? Math.max(0, Math.ceil((statusDetail.nextRetryAt - Date.now()) / 1000))
    : null;

  const check = async (): Promise<void> => {
    setChecking(true);
    setSteps(null);
    try {
      setSteps(await helio.checkConnection());
    } finally {
      setChecking(false);
    }
  };

  return (
    <>
      <div className="statusRow">
        <span className={`dot ${online ? "ok" : "bad"}`} />
        <div>
          <strong>{STATUS_LABEL[statusDetail.status] ?? statusDetail.status}</strong>
          <p className="muted">
            {state.serverUrl}
            {statusDetail.message ? ` — ${statusDetail.message}` : ""}
            {retryInS !== null && !online ? ` · retrying in ${retryInS}s` : ""}
          </p>
        </div>
      </div>
      {!online && statusDetail.status !== "unauthorized" && (
        <div className="row">
          <button className="ghost small" onClick={() => void helio.reconnectNow()}>
            Try now
          </button>
          <button className="ghost small" disabled={checking} onClick={() => void check()}>
            {checking ? "Checking…" : "Check connection"}
          </button>
        </div>
      )}
      {steps && (
        <ul className="sticks">
          {steps.map((s) => (
            <li key={s.id}>
              <span className={`dot ${s.ok ? "ok" : "bad"}`} />
              <div className="stickInfo">
                <strong>{s.label}</strong>
                <p className="muted">{s.detail}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** Guided empty state: say WHY nothing was found, not just "no sticks". */
function NoSticksHelp({ state }: { state: UiState }): React.JSX.Element {
  if (state.discoveryIssue === "no-private-interface") {
    return (
      <p className="muted">
        No local network detected — this computer has no LAN or Wi-Fi connection (a VPN-only
        connection doesn't count). Connect it to the same network as the inverter.
      </p>
    );
  }
  if (state.discoveryIssue === "local-network-blocked" && state.platform === "macos") {
    return (
      <div>
        <p className="muted">
          macOS is blocking this app from talking to your local network. Allow Helio Agent under
          Local Network and scanning starts working immediately.
        </p>
        <button className="outline" onClick={() => void helio.openNetworkSettings()}>
          Open Local Network settings
        </button>
      </div>
    );
  }
  if (state.discoveryIssue === "udp-blocked" || state.discoveryIssue === "local-network-blocked") {
    return (
      <p className="muted">
        A firewall is blocking the network scan.
        {state.platform === "windows"
          ? " In Windows Security → Firewall, allow Helio Agent on private networks."
          : " Allow this app through the firewall."}{" "}
        You can also add the stick by IP below.
      </p>
    );
  }
  return (
    <p className="muted">
      No Solarman sticks found yet. Make sure this computer is on the same network as the
      inverter — scanning repeats every 30 seconds. If the stick is on another network or ignores
      the scan, add it by IP below.
    </p>
  );
}

function Status({ state }: { state: UiState }): React.JSX.Element {
  const [showAdd, setShowAdd] = useState(false);
  const [addIp, setAddIp] = useState("");
  const [addPort, setAddPort] = useState("8899");
  const [addSerial, setAddSerial] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const addStick = async (): Promise<void> => {
    setAdding(true);
    setAddError(null);
    try {
      const serial = addSerial.trim() ? Number(addSerial.trim()) : null;
      const error = await helio.addManualStick(addIp.trim(), Number(addPort) || 8899, serial);
      if (error) {
        setAddError(error);
      } else {
        setAddIp("");
        setAddSerial("");
        setShowAdd(false);
      }
    } finally {
      setAdding(false);
    }
  };

  return (
    <main className="card">
      <StatusCard state={state} />

      <h2>
        Sticks on your network
        <button className="ghost small" onClick={() => void helio.rescan()}>
          Rescan
        </button>
      </h2>
      {state.sticks.length === 0 ? (
        <NoSticksHelp state={state} />
      ) : (
        <ul className="sticks">
          {state.sticks.map((s) => (
            <li key={`${s.ip}-${s.serial ?? "x"}`}>
              <span className={`dot ${s.reachable ? "ok" : "bad"}`} />
              <div className="stickInfo">
                <strong>{s.serial ?? "Serial unknown"}</strong>
                <p className="muted">
                  {s.ip}
                  {s.mac ? ` · ${s.mac}` : ""}
                  {s.manual ? " · added by IP" : ""}
                  {s.manual && !isPrivateIp(s.ip) ? " · public IP" : ""}
                </p>
                {s.serial === null && <SerialPrompt ip={s.ip} />}
              </div>
              {s.manual && (
                <button
                  className="ghost small"
                  title="Forget this stick"
                  onClick={() => void helio.removeManualStick(s.ip)}
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {showAdd ? (
        <div className="addStick">
          <div className="row">
            <label className="field grow">
              Stick IP address
              <input
                value={addIp}
                onChange={(e) => setAddIp(e.target.value)}
                placeholder="192.168.1.137"
                spellCheck={false}
                autoFocus
              />
            </label>
            <label className="field portField">
              Port
              <input
                value={addPort}
                onChange={(e) => setAddPort(e.target.value)}
                placeholder="8899"
                spellCheck={false}
              />
            </label>
          </div>
          <label className="field">
            Serial (printed on the stick's label — optional)
            <input
              value={addSerial}
              onChange={(e) => setAddSerial(e.target.value.replace(/\D/g, ""))}
              placeholder="2712345678"
              spellCheck={false}
              inputMode="numeric"
            />
          </label>
          {addError && <p className="error">{addError}</p>}
          {isValidIpv4(addIp.trim()) && !isPrivateIp(addIp.trim()) && (
            <p className="warn">
              This is not a private LAN address — the agent will connect out to it over the
              internet. Only add a device you own (e.g. a port-forwarded stick).
            </p>
          )}
          <div className="row">
            <button disabled={adding || !addIp.trim()} onClick={() => void addStick()}>
              {adding ? "Checking…" : "Add stick"}
            </button>
            <button className="ghost" onClick={() => setShowAdd(false)}>
              Cancel
            </button>
          </div>
          <p className="muted">
            Leave the serial empty and it is picked up automatically when the stick answers the
            scan; Solarman sticks listen on port 8899.
          </p>
        </div>
      ) : (
        <button className="outline" onClick={() => setShowAdd(true)}>
          Add a stick by IP…
        </button>
      )}

      <h2>Settings</h2>
      <label className="toggle">
        <input
          type="checkbox"
          checked={state.autostart}
          onChange={(e) => void helio.setAutostart(e.target.checked)}
        />
        Start when I log in to this computer
      </label>
      <CopyDiagnostics />
      <button className="ghost" onClick={() => void helio.signOut()}>
        Sign out of Helio
      </button>
    </main>
  );
}

/**
 * Runs a connection check and copies a token-free report (version, OS,
 * status history, sticks, recent log) — what support asks for first.
 */
function CopyDiagnostics(): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const copy = async (): Promise<void> => {
    setBusy(true);
    setDone(false);
    setError(null);
    try {
      const err = await helio.copyDiagnostics();
      if (err) setError(err);
      else {
        setDone(true);
        setTimeout(() => setDone(false), 4000);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <button className="ghost" disabled={busy} onClick={() => void copy()}>
        {busy ? "Checking the connection…" : done ? "Copied — paste it anywhere" : "Copy diagnostics"}
      </button>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

/**
 * Banner shown when a newer release is published. On Windows and Linux the
 * update runs through by itself; on macOS the downloaded disk image opens so
 * the user drags the new app into Applications (unsigned builds can't swap
 * themselves there).
 */
const fmtMb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

function UpdateBanner({
  version,
  download,
}: {
  version: string;
  download: { received: number; total: number | null } | null;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isMac = navigator.platform.toLowerCase().includes("mac");

  const update = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const err = await helio.installUpdate();
    if (err) {
      setError(err);
      setBusy(false);
    }
  };

  const pct =
    download?.total != null
      ? Math.min(100, Math.round((download.received / download.total) * 100))
      : null;
  const done = pct === 100;

  return (
    <div className="updateBanner">
      <div className="row">
        <span>
          Version {version} is out.
          {isMac ? " The installer opens after download — drag the app into Applications." : ""}
        </span>
        <button disabled={busy} onClick={() => void update()}>
          {busy ? "Downloading…" : "Update now"}
        </button>
      </div>
      {busy && download && !error && (
        <div className="progress">
          <div className="progressTrack">
            <div
              className={pct == null ? "progressFill indeterminate" : "progressFill"}
              style={pct == null ? undefined : { width: `${pct}%` }}
            />
          </div>
          <p className="progressLabel">
            {done
              ? "Download complete — starting the installer…"
              : download.total != null
                ? `Downloading… ${pct}% (${fmtMb(download.received)} of ${fmtMb(download.total)})`
                : `Downloading… ${fmtMb(download.received)}`}
          </p>
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

/** Inline "type the label serial" form for sticks the scan couldn't identify. */
function SerialPrompt({ ip }: { ip: string }): React.JSX.Element {
  const [serial, setSerial] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const err = await helio.setStickSerial(ip, Number(serial.trim()));
      if (err) setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="serialPrompt">
      <div className="row">
        <input
          value={serial}
          onChange={(e) => setSerial(e.target.value.replace(/\D/g, ""))}
          placeholder="Serial on the stick's label"
          spellCheck={false}
          inputMode="numeric"
          aria-label={`Serial for ${ip}`}
        />
        <button className="ghost small" disabled={busy || !serial.trim()} onClick={() => void save()}>
          {busy ? "Saving…" : "Set serial"}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

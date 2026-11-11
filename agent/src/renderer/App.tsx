import { useEffect, useState } from "react";

interface Stick {
  serial: number | null;
  ip: string;
  mac: string | null;
  reachable: boolean;
  manual: boolean;
}

interface UiState {
  view: "signin" | "status";
  status: string;
  serverUrl: string;
  agentName: string;
  sticks: Stick[];
  pairing: { userCode: string; verificationUrl: string } | null;
  pairingError: string | null;
  autostart: boolean;
  secureStorage: boolean;
  version: string;
  updateAvailable: string | null;
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
      {state.updateAvailable && <UpdateBanner version={state.updateAvailable} />}
      {state.view === "signin" ? <SignIn state={state} /> : <Status state={state} />}
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

  const start = async (): Promise<void> => {
    setBusy(true);
    try {
      await helio.startPairing(serverUrl);
    } finally {
      setBusy(false);
    }
  };

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

function Status({ state }: { state: UiState }): React.JSX.Element {
  const online = state.status === "online";
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
      <div className="statusRow">
        <span className={`dot ${online ? "ok" : "bad"}`} />
        <div>
          <strong>{STATUS_LABEL[state.status] ?? state.status}</strong>
          <p className="muted">{state.serverUrl}</p>
        </div>
      </div>

      <h2>
        Sticks on your network
        <button className="ghost small" onClick={() => void helio.rescan()}>
          Rescan
        </button>
      </h2>
      {state.sticks.length === 0 ? (
        <p className="muted">
          No Solarman sticks found yet. Make sure this computer is on the same network as the
          inverter — scanning repeats every 30 seconds. If the stick is on another network or
          ignores the scan, add it by IP below.
        </p>
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
        <button className="link" onClick={() => setShowAdd(true)}>
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
      <button className="ghost" onClick={() => void helio.signOut()}>
        Sign out of Helio
      </button>
    </main>
  );
}

/**
 * Banner shown when a newer release is published. On Windows and Linux the
 * update runs through by itself; on macOS the downloaded disk image opens so
 * the user drags the new app into Applications (unsigned builds can't swap
 * themselves there).
 */
function UpdateBanner({ version }: { version: string }): React.JSX.Element {
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

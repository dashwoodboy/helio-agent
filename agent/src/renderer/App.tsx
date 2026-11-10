import { useEffect, useState } from "react";

interface Stick {
  serial: number | null;
  ip: string;
  mac: string | null;
  reachable: boolean;
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
}

const helio = (window as unknown as { helio: Bridge }).helio;

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
          inverter — scanning repeats every 30 seconds.
        </p>
      ) : (
        <ul className="sticks">
          {state.sticks.map((s) => (
            <li key={`${s.ip}-${s.serial ?? "x"}`}>
              <span className={`dot ${s.reachable ? "ok" : "bad"}`} />
              <div>
                <strong>{s.serial ?? "Serial unknown"}</strong>
                <p className="muted">
                  {s.ip}
                  {s.mac ? ` · ${s.mac}` : ""}
                </p>
              </div>
            </li>
          ))}
        </ul>
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

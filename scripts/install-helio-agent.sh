#!/usr/bin/env bash
# Helio Agent installer for Linux servers and Raspberry Pi.
#
#   curl -fsSL https://github.com/dashwoodboy/helio-agent/releases/latest/download/install-helio-agent.sh | sudo bash
#
# What it does, in order:
#   1. Downloads the single-file agent CLI to /opt/helio.
#   2. Makes sure a Node.js >= 20 exists (downloads Node 24 into /opt/helio
#      if the system one is missing or too old — nothing global changes).
#   3. Creates a dedicated "helio" system user.
#   4. Installs a systemd unit (helio-agent.service, Restart=always).
#   5. Runs the interactive pairing (a code to approve on the website).
#   6. Starts the service and enables it at boot.
#
# Options (pass after `bash -s --` when piping from curl):
#   --server <url>    Helio server (default: the build's default)
#   --name <name>     Agent name shown on the website (default: hostname)
#   --uninstall       Remove the service, the user and /opt/helio
#
# Environment: HELIO_DOWNLOAD_BASE_URL overrides where the CLI comes from.
set -euo pipefail

BASE_URL="${HELIO_DOWNLOAD_BASE_URL:-https://github.com/dashwoodboy/helio-agent/releases/latest/download}"
INSTALL_DIR=/opt/helio
CLI="$INSTALL_DIR/helio-agent-cli.cjs"
UNIT_FILE=/etc/systemd/system/helio-agent.service
HELIO_USER=helio
NODE_DIST_BASE="https://nodejs.org/dist/latest-v24.x"

SERVER_FLAG=""
NAME_FLAG=""
UNINSTALL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --server) SERVER_FLAG="$2"; shift 2 ;;
    --name) NAME_FLAG="$2"; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this with sudo: curl -fsSL .../install-helio-agent.sh | sudo bash" >&2
  exit 1
fi

if ! command -v systemctl >/dev/null 2>&1; then
  echo "This installer needs systemd. For containers, use the Docker image" >&2
  echo "dashwoodboy/helio-agent instead." >&2
  exit 1
fi

if [ "$UNINSTALL" -eq 1 ]; then
  echo "==> Removing the Helio Agent service"
  systemctl disable --now helio-agent 2>/dev/null || true
  rm -f "$UNIT_FILE"
  systemctl daemon-reload
  rm -rf "$INSTALL_DIR"
  userdel "$HELIO_USER" 2>/dev/null || true
  echo "Removed. Also revoke this agent on the website (Account → My agents)."
  exit 0
fi

echo "==> Installing the Helio Agent CLI to $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
curl -fsSL "$BASE_URL/helio-agent-cli.cjs" -o "$CLI.tmp"
mv "$CLI.tmp" "$CLI"
chmod 755 "$CLI"

# ---------------------------------------------------------------- Node >= 20
NODE_BIN=""
if command -v node >/dev/null 2>&1; then
  MAJOR="$(node -v | sed 's/^v\([0-9]*\).*/\1/')"
  if [ "$MAJOR" -ge 20 ] 2>/dev/null; then
    NODE_BIN="$(command -v node)"
    echo "==> Using the system Node.js $(node -v)"
  fi
fi
if [ -z "$NODE_BIN" ]; then
  case "$(uname -m)" in
    x86_64) NODE_ARCH=x64 ;;
    aarch64 | arm64) NODE_ARCH=arm64 ;;
    armv7l) NODE_ARCH=armv7l ;;
    *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
  esac
  # Resolve the exact tarball name from the checksum list (the version
  # number inside latest-v24.x changes with every Node release).
  TARBALL="$(curl -fsSL "$NODE_DIST_BASE/SHASUMS256.txt" | grep -o "node-v[0-9.]*-linux-$NODE_ARCH.tar.xz" | head -1)"
  if [ -z "$TARBALL" ]; then
    echo "Could not find a Node 24 build for linux-$NODE_ARCH" >&2
    exit 1
  fi
  echo "==> Downloading $TARBALL into $INSTALL_DIR/node (the system Node is missing or older than 20)"
  curl -fsSL "$NODE_DIST_BASE/$TARBALL" -o /tmp/helio-node.tar.xz
  rm -rf "$INSTALL_DIR/node"
  mkdir -p "$INSTALL_DIR/node"
  tar -xJf /tmp/helio-node.tar.xz -C "$INSTALL_DIR/node" --strip-components=1
  rm -f /tmp/helio-node.tar.xz
  NODE_BIN="$INSTALL_DIR/node/bin/node"
fi

# ------------------------------------------------------------- user + unit
if ! id "$HELIO_USER" >/dev/null 2>&1; then
  echo "==> Creating the $HELIO_USER system user"
  useradd --system --home-dir "$INSTALL_DIR" --shell /usr/sbin/nologin "$HELIO_USER"
fi
# The pairing token lives here (0600, owned by helio).
mkdir -p "$INSTALL_DIR/config"
chown -R "$HELIO_USER" "$INSTALL_DIR/config"

echo "==> Installing $UNIT_FILE"
cat > "$UNIT_FILE" <<EOF
[Unit]
Description=Helio Agent (relays Solarman sticks to Helio)
Wants=network-online.target
After=network-online.target

[Service]
ExecStart=$NODE_BIN $CLI run
Restart=always
RestartSec=5
User=$HELIO_USER
Environment=XDG_CONFIG_HOME=$INSTALL_DIR/config
# The agent needs nothing else from the system: lock it down.
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$INSTALL_DIR/config
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload

# ------------------------------------------------------------------ pairing
PAIR_ARGS=()
[ -n "$SERVER_FLAG" ] && PAIR_ARGS+=(--server "$SERVER_FLAG")
PAIR_ARGS+=(--name "${NAME_FLAG:-$(hostname)}")

if sudo -u "$HELIO_USER" XDG_CONFIG_HOME="$INSTALL_DIR/config" "$NODE_BIN" "$CLI" status | grep -q "Paired: *yes"; then
  echo "==> Already paired — keeping the existing pairing"
else
  echo "==> Pairing this machine with your Helio account"
  sudo -u "$HELIO_USER" XDG_CONFIG_HOME="$INSTALL_DIR/config" "$NODE_BIN" "$CLI" pair "${PAIR_ARGS[@]}"
fi

echo "==> Starting the service"
systemctl enable --now helio-agent

echo ""
echo "Done. Useful commands:"
echo "  systemctl status helio-agent          service state"
echo "  journalctl -u helio-agent -f          live logs (sticks, link status)"
echo "  sudo -u $HELIO_USER XDG_CONFIG_HOME=$INSTALL_DIR/config $NODE_BIN $CLI doctor"
echo "                                        step-by-step connection check"
echo "  curl -fsSL .../install-helio-agent.sh | sudo bash -s -- --uninstall"

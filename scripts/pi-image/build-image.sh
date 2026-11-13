#!/usr/bin/env bash
# Build the "Helio Agent for Raspberry Pi" image: take the official
# Raspberry Pi OS Lite arm64 image and preinstall the agent, so the
# Raspberry Pi Imager (with its hostname/Wi-Fi/user customization) produces
# a device that pairs from http://helio-agent.local with zero SSH.
#
# Runs on an arm64 Linux host with root (the GitHub ubuntu-24.04-arm
# runner): native chroot, no qemu.
#
#   sudo scripts/pi-image/build-image.sh <helio-agent-cli.cjs> <outdir>
#
# Produces in <outdir>:
#   HelioAgent-Pi.img.xz        the image for the Imager / dd
#   image-meta.json             sizes + sha256 for os-list.json
set -euo pipefail

CLI_BUNDLE="${1:?usage: build-image.sh <helio-agent-cli.cjs> <outdir>}"
OUTDIR="${2:?usage: build-image.sh <helio-agent-cli.cjs> <outdir>}"
BASE_URL="${PI_BASE_IMAGE_URL:-https://downloads.raspberrypi.com/raspios_lite_arm64_latest}"
NODE_DIST_BASE="https://nodejs.org/dist/latest-v24.x"
WORK="$(mktemp -d)"
MNT="$WORK/mnt"

[ "$(id -u)" -eq 0 ] || { echo "run as root (losetup/chroot)"; exit 1; }
[ "$(uname -m)" = "aarch64" ] || { echo "arm64 host required (native chroot)"; exit 1; }
mkdir -p "$OUTDIR" "$MNT"

cleanup() {
  set +e
  umount -R "$MNT" 2>/dev/null
  [ -n "${LOOP:-}" ] && losetup -d "$LOOP" 2>/dev/null
  rm -rf "$WORK"
}
trap cleanup EXIT

# ------------------------------------------------- 1. base image, verified
echo "==> Downloading the official Raspberry Pi OS Lite arm64 image"
# The _latest URL redirects to the dated release file; keep the real name.
REAL_URL="$(curl -fsSLI -o /dev/null -w '%{url_effective}' "$BASE_URL")"
echo "    base: $REAL_URL"
curl -fsSL "$REAL_URL" -o "$WORK/base.img.xz"
curl -fsSL "$REAL_URL.sha256" -o "$WORK/base.img.xz.sha256"
# The published file reads "<sha256>  <original name>"; our copy is base.img.xz.
PUBLISHED_SHA="$(awk '{print $1}' "$WORK/base.img.xz.sha256")"
echo "$PUBLISHED_SHA  $WORK/base.img.xz" | sha256sum -c -

echo "==> Decompressing"
xz -d -T0 "$WORK/base.img.xz"
IMG="$WORK/base.img"

# ------------------------------------------- 2. room for Node (~250 MB)
echo "==> Growing the image by 768 MiB for Node.js + the agent"
truncate -s +768M "$IMG"
# Partition 2 is the rootfs on Raspberry Pi OS images.
sfdisk --no-reread -N 2 "$IMG" <<< ", +" >/dev/null
LOOP="$(losetup --show -fP "$IMG")"
e2fsck -pf "${LOOP}p2" >/dev/null || true
resize2fs "${LOOP}p2" >/dev/null

# --------------------------------------------------------- 3. mount + files
echo "==> Mounting"
mount "${LOOP}p2" "$MNT"
mount "${LOOP}p1" "$MNT/boot/firmware"

echo "==> Installing Node 24 (arm64) and the agent CLI"
TARBALL="$(curl -fsSL "$NODE_DIST_BASE/SHASUMS256.txt" | grep -o 'node-v[0-9.]*-linux-arm64.tar.xz' | head -1)"
curl -fsSL "$NODE_DIST_BASE/$TARBALL" -o "$WORK/node.tar.xz"
mkdir -p "$MNT/opt/helio/node"
tar -xJf "$WORK/node.tar.xz" -C "$MNT/opt/helio/node" --strip-components=1
install -m 755 "$CLI_BUNDLE" "$MNT/opt/helio/helio-agent-cli.cjs"

echo "==> Writing the systemd units"
cat > "$MNT/etc/systemd/system/helio-agent.service" <<'EOF'
[Unit]
Description=Helio Agent (relays Solarman sticks to Helio)
Wants=network-online.target
After=network-online.target

[Service]
# run auto-pairs when no token is stored; the local page on port 80 shows
# the code. Self-update swaps the bundle and exits; Restart=always reloads.
ExecStart=/opt/helio/node/bin/node /opt/helio/helio-agent-cli.cjs run
Restart=always
RestartSec=5
User=helio
Environment=XDG_CONFIG_HOME=/var/lib/helio-agent
# Port 80 for the local status page without running as root.
AmbientCapabilities=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
# Config/token state + the bundle itself (self-update rewrites it).
ReadWritePaths=/var/lib/helio-agent /opt/helio
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

# helio-agent.local works even when the Imager set a custom hostname.
cat > "$MNT/opt/helio/mdns-alias.sh" <<'EOF'
#!/bin/sh
# Publish the extra mDNS name "helio-agent.local" for this device's address.
while true; do
  ADDR="$(hostname -I 2>/dev/null | awk '{print $1}')"
  if [ -n "$ADDR" ]; then
    avahi-publish -a -R helio-agent.local "$ADDR" || true
  fi
  sleep 10
done
EOF
chmod 755 "$MNT/opt/helio/mdns-alias.sh"

cat > "$MNT/etc/systemd/system/helio-agent-mdns.service" <<'EOF'
[Unit]
Description=Publish helio-agent.local (mDNS alias)
After=avahi-daemon.service network-online.target
Wants=avahi-daemon.service

[Service]
ExecStart=/opt/helio/mdns-alias.sh
Restart=always
RestartSec=10
User=helio
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

# -------------------------------------------------------------- 4. chroot
echo "==> Configuring inside the image (chroot)"
mount -t proc proc "$MNT/proc"
mount -t sysfs sys "$MNT/sys"
mount --bind /dev "$MNT/dev"
mount --bind /dev/pts "$MNT/dev/pts"
# Network for apt inside the chroot.
mv "$MNT/etc/resolv.conf" "$WORK/resolv.conf.orig" 2>/dev/null || true
cp /etc/resolv.conf "$MNT/etc/resolv.conf"

chroot "$MNT" /bin/bash -eux <<'EOF'
export DEBIAN_FRONTEND=noninteractive
apt-get update
# avahi-daemon ships with Raspberry Pi OS; avahi-utils brings avahi-publish.
apt-get install -y --no-install-recommends avahi-utils unattended-upgrades
apt-get clean
rm -rf /var/lib/apt/lists/*

# Security updates install themselves (the card is never re-flashed).
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'CONF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
CONF

# Dedicated service user + writable state dir for the token.
useradd --system --home-dir /var/lib/helio-agent --shell /usr/sbin/nologin helio
mkdir -p /var/lib/helio-agent
chown helio:helio /var/lib/helio-agent
chmod 700 /var/lib/helio-agent
# Self-update rewrites the bundle: the service user owns it.
chown -R helio:helio /opt/helio

systemctl enable helio-agent.service helio-agent-mdns.service

# Default hostname (the Imager's customization may override it; the mDNS
# alias service keeps helio-agent.local working either way).
echo helio-agent > /etc/hostname
sed -i 's/127.0.1.1.*/127.0.1.1\thelio-agent/' /etc/hosts
EOF

# ------------------------------------------------------------ 5. validate
echo "==> Validating"
systemd-analyze verify --root="$MNT" helio-agent.service
systemd-analyze verify --root="$MNT" helio-agent-mdns.service
chroot "$MNT" /opt/helio/node/bin/node /opt/helio/helio-agent-cli.cjs --version
[ -L "$MNT/etc/systemd/system/multi-user.target.wants/helio-agent.service" ]

# ------------------------------------------------------------- 6. package
[ -f "$WORK/resolv.conf.orig" ] && mv "$WORK/resolv.conf.orig" "$MNT/etc/resolv.conf"
umount -R "$MNT"
losetup -d "$LOOP"; LOOP=""

echo "==> Compressing (xz)"
EXTRACT_SIZE="$(stat -c %s "$IMG")"
EXTRACT_SHA256="$(sha256sum "$IMG" | awk '{print $1}')"
xz -T0 -6 "$IMG"
mv "$WORK/base.img.xz" "$OUTDIR/HelioAgent-Pi.img.xz"
DOWNLOAD_SIZE="$(stat -c %s "$OUTDIR/HelioAgent-Pi.img.xz")"
DOWNLOAD_SHA256="$(sha256sum "$OUTDIR/HelioAgent-Pi.img.xz" | awk '{print $1}')"

cat > "$OUTDIR/image-meta.json" <<EOF
{
  "base_image": "$REAL_URL",
  "extract_size": $EXTRACT_SIZE,
  "extract_sha256": "$EXTRACT_SHA256",
  "image_download_size": $DOWNLOAD_SIZE,
  "image_download_sha256": "$DOWNLOAD_SHA256",
  "release_date": "$(date -u +%F)"
}
EOF

echo "==> Done: $OUTDIR/HelioAgent-Pi.img.xz"
cat "$OUTDIR/image-meta.json"

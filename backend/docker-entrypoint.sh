#!/bin/sh
# Starts as root only to make the (root-owned) TLS cert mount readable, then
# drops to the unprivileged "node" user before running the app.
set -e

if [ "$(id -u)" = "0" ]; then
  if [ -n "$GATEWAY_TLS_CERT_FILE" ] && [ -f "$GATEWAY_TLS_CERT_FILE" ] && [ -f "$GATEWAY_TLS_KEY_FILE" ]; then
    mkdir -p /run/gateway-tls
    cp "$GATEWAY_TLS_CERT_FILE" /run/gateway-tls/fullchain.pem
    cp "$GATEWAY_TLS_KEY_FILE" /run/gateway-tls/privkey.pem
    chown -R node:node /run/gateway-tls
    chmod 400 /run/gateway-tls/privkey.pem
    export GATEWAY_TLS_CERT_FILE=/run/gateway-tls/fullchain.pem
    export GATEWAY_TLS_KEY_FILE=/run/gateway-tls/privkey.pem
  fi
  exec su-exec node "$@"
fi

exec "$@"

#!/bin/bash
# Keep cloudflare tunnel alive — restarts if down, re-registers with cloud
# Runs as a loop — checks every 5 minutes

LOCAL_PORT="${PORT:-3700}"
RAILWAY_PROJECT_DIR="/Users/oakhome/קלוד עבודות/voice-agent"
RAILWAY_WEBHOOK_DIR="/Users/oakhome/קלוד עבודות/evolution-api"
ALONBOT_CLOUD_URL="https://chic-forgiveness-production.up.railway.app"
ALONBOT_SECRET="alonbot-secret-2026"
CHECK_INTERVAL=300  # 5 minutes
TUNNEL_LOG="/tmp/cf-tunnel-keepalive.log"
export PATH="/opt/homebrew/bin:/Users/oakhome/.nvm/versions/node/v24.14.0/bin:$PATH"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

start_tunnel() {
  pkill -f "cloudflared.*$LOCAL_PORT" 2>/dev/null
  sleep 2

  cloudflared tunnel --url "http://localhost:$LOCAL_PORT" --no-autoupdate > "$TUNNEL_LOG" 2>&1 &
  TUNNEL_PID=$!

  # Wait for URL (up to 15s)
  TUNNEL_URL=""
  for i in $(seq 1 15); do
    TUNNEL_URL=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$TUNNEL_LOG" | head -1)
    [ -n "$TUNNEL_URL" ] && break
    sleep 1
  done

  if [ -z "$TUNNEL_URL" ]; then
    log "ERROR: Failed to get tunnel URL"
    return 1
  fi

  log "Tunnel URL: $TUNNEL_URL (PID: $TUNNEL_PID)"
  echo "$TUNNEL_URL" > /tmp/alonbot-tunnel-url.txt

  # Update Railway voice-agent
  log "Updating Railway voice-agent..."
  cd "$RAILWAY_PROJECT_DIR" && railway variables --set "AALONBOT_URL=$TUNNEL_URL" 2>&1

  # Update Railway wa-webhook FORWARD_URL
  log "Updating Railway wa-webhook..."
  cd "$RAILWAY_WEBHOOK_DIR" && railway variables --set "FORWARD_URL=$TUNNEL_URL/whatsapp-cloud-webhook" 2>&1

  # Register with AalonBot cloud (in-memory update, no redeploy needed)
  log "Registering with AalonBot cloud..."
  curl -s -X POST "$ALONBOT_CLOUD_URL/api/register-local" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $ALONBOT_SECRET" \
    -d "{\"url\":\"$TUNNEL_URL\"}" 2>&1
  log "Cloud registered"
  return 0
}

# Initial start
log "Starting tunnel keepalive loop"
start_tunnel

while true; do
  sleep $CHECK_INTERVAL

  # Check 1: Is cloudflared still running?
  if ! pgrep -f "cloudflared.*$LOCAL_PORT" > /dev/null; then
    log "cloudflared not running — restarting"
    start_tunnel
    continue
  fi

  # Check 2: Is the local server responding?
  LOCAL_OK=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$LOCAL_PORT/health" 2>/dev/null)
  if [ "$LOCAL_OK" != "200" ]; then
    log "Local server not responding ($LOCAL_OK) — skipping"
    continue
  fi

  # Check 3: Can the tunnel reach us?
  SAVED_URL=$(cat /tmp/alonbot-tunnel-url.txt 2>/dev/null)
  if [ -n "$SAVED_URL" ]; then
    TUNNEL_OK=$(curl -s -o /dev/null -w "%{http_code}" "$SAVED_URL/health" --max-time 10 2>/dev/null)
    if [ "$TUNNEL_OK" != "200" ]; then
      log "Tunnel unreachable ($TUNNEL_OK) — restarting"
      start_tunnel
    fi
  fi
done

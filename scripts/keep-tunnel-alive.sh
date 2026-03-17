#!/bin/bash
# Keep cloudflare tunnel alive and registered with Render
# Runs as a loop — checks every 5 minutes, restarts tunnel if needed

CLOUD_URL="${ALONBOT_CLOUD_URL:-https://alonbot.onrender.com}"
SECRET="${LOCAL_API_SECRET:-alonbot-secret-2026}"
LOCAL_PORT="${PORT:-3700}"
CHECK_INTERVAL=300  # 5 minutes
TUNNEL_LOG="/tmp/cf-tunnel-keepalive.log"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

start_tunnel() {
  pkill -f "cloudflared.*$LOCAL_PORT" 2>/dev/null
  sleep 2

  cloudflared tunnel --url "http://localhost:$LOCAL_PORT" --no-autoupdate > "$TUNNEL_LOG" 2>&1 &
  TUNNEL_PID=$!

  # Wait for URL (up to 15s)
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

  # Register with cloud
  RESPONSE=$(curl -s -X POST "$CLOUD_URL/api/register-local" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $SECRET" \
    -d "{\"url\": \"$TUNNEL_URL\"}")
  log "Registered: $RESPONSE"
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
    log "Local server not responding ($LOCAL_OK) — skipping tunnel check"
    continue
  fi

  # Check 3: Can Render reach us? (check localConnected from cloud health)
  CLOUD_HEALTH=$(curl -s "$CLOUD_URL/health" 2>/dev/null)
  LOCAL_CONNECTED=$(echo "$CLOUD_HEALTH" | grep -o '"localConnected":[a-z]*' | cut -d: -f2)

  if [ "$LOCAL_CONNECTED" != "true" ]; then
    log "Cloud reports localConnected=$LOCAL_CONNECTED — restarting tunnel"
    start_tunnel
  fi
done

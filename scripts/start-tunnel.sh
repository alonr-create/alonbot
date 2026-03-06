#!/bin/bash
# Start Cloudflare tunnel and register with cloud AlonBot
# Usage: ./scripts/start-tunnel.sh

CLOUD_URL="${ALONBOT_CLOUD_URL:-https://alonbot.onrender.com}"
SECRET="${LOCAL_API_SECRET:-alonbot-secret-2026}"
LOCAL_PORT="${PORT:-3700}"

echo "[Tunnel] Starting cloudflared tunnel for localhost:$LOCAL_PORT..."

# Kill any existing tunnels for our port
pkill -f "cloudflared.*$LOCAL_PORT" 2>/dev/null
sleep 1

# Start tunnel and capture URL
TMPLOG=$(mktemp)
cloudflared tunnel --url "http://localhost:$LOCAL_PORT" --no-autoupdate > "$TMPLOG" 2>&1 &
TUNNEL_PID=$!

# Wait for URL to appear
for i in $(seq 1 20); do
  TUNNEL_URL=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$TMPLOG" | head -1)
  if [ -n "$TUNNEL_URL" ]; then
    break
  fi
  sleep 1
done

if [ -z "$TUNNEL_URL" ]; then
  echo "[Tunnel] ERROR: Failed to get tunnel URL after 20s"
  cat "$TMPLOG"
  kill $TUNNEL_PID 2>/dev/null
  rm -f "$TMPLOG"
  exit 1
fi

echo "[Tunnel] URL: $TUNNEL_URL"

# Register with cloud
echo "[Tunnel] Registering with cloud ($CLOUD_URL)..."
RESPONSE=$(curl -s -X POST "$CLOUD_URL/api/register-local" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $SECRET" \
  -d "{\"url\": \"$TUNNEL_URL\"}")

echo "[Tunnel] Cloud response: $RESPONSE"
rm -f "$TMPLOG"

# Keep running (tunnel stays alive as background process)
echo "[Tunnel] Tunnel running (PID: $TUNNEL_PID). Press Ctrl+C to stop."
wait $TUNNEL_PID

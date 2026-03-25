#!/bin/bash
# Start Cloudflare quick tunnel and update Railway voice-agent with new URL
# Usage: ./scripts/start-tunnel.sh

LOCAL_PORT="${PORT:-3700}"
RAILWAY_PROJECT_DIR="/Users/oakhome/קלוד עבודות/voice-agent"
export PATH="/opt/homebrew/bin:/Users/oakhome/.nvm/versions/node/v24.14.0/bin:$PATH"

echo "[Tunnel] Starting cloudflared tunnel for localhost:$LOCAL_PORT..."

# Kill any existing tunnels for our port
pkill -f "cloudflared.*$LOCAL_PORT" 2>/dev/null
sleep 1

# Start tunnel and capture URL
TMPLOG=$(mktemp)
cloudflared tunnel --url "http://localhost:$LOCAL_PORT" --no-autoupdate > "$TMPLOG" 2>&1 &
TUNNEL_PID=$!

# Wait for URL to appear (up to 20s)
TUNNEL_URL=""
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

# Save URL to file for other scripts to read
echo "$TUNNEL_URL" > /tmp/alonbot-tunnel-url.txt

# Update Railway voice-agent env var
echo "[Tunnel] Updating Railway voice-agent ALONBOT_URL..."
cd "$RAILWAY_PROJECT_DIR" && railway variables --set "ALONBOT_URL=$TUNNEL_URL" 2>&1
echo "[Tunnel] Railway updated"

# Verify tunnel works
sleep 2
HEALTH=$(curl -s "$TUNNEL_URL/health" 2>/dev/null)
if echo "$HEALTH" | grep -q '"status":"ok"'; then
  echo "[Tunnel] ✅ Health check passed"
else
  echo "[Tunnel] ⚠️ Health check failed (bot may still be starting)"
fi

rm -f "$TMPLOG"

echo "[Tunnel] Tunnel running (PID: $TUNNEL_PID). Press Ctrl+C to stop."
wait $TUNNEL_PID

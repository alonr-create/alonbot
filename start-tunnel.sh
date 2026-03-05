#!/bin/bash
# Start cloudflared tunnel for AlonBot local API
# This exposes localhost:3700 to the internet so the cloud bot can reach local tools

cloudflared tunnel --url http://localhost:3700 --no-autoupdate 2>&1 | while read line; do
  echo "$line"
  # Extract the tunnel URL and save it
  if echo "$line" | grep -q "https://.*trycloudflare.com"; then
    URL=$(echo "$line" | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com')
    if [ -n "$URL" ]; then
      echo "$URL" > /tmp/alonbot-tunnel-url.txt
      echo "[Tunnel] URL saved: $URL"
      echo "[Tunnel] Add this to Render env vars as LOCAL_API_URL"
    fi
  fi
done

#!/bin/bash
cd "/Users/oakhome/קלוד עבודות/alonbot" || exit 1
export PATH="/opt/homebrew/bin:/Users/oakhome/.nvm/versions/node/v24.14.0/bin:$PATH"

# Limit Node memory to prevent OOM kills on 8GB Mac
export NODE_OPTIONS="--max-old-space-size=512"

PIDFILE="/tmp/alonbot.pid"

# Kill previous instance by PID file (most reliable)
if [ -f "$PIDFILE" ]; then
  OLD_PID=$(cat "$PIDFILE")
  kill -9 -$(ps -o pgid= -p "$OLD_PID" 2>/dev/null | tr -d ' ') 2>/dev/null
  kill -9 "$OLD_PID" 2>/dev/null
fi

# Also kill by port — catches orphans
kill -9 $(lsof -ti :3700) 2>/dev/null

# Kill any leftover processes by name
pkill -9 -f "tsx src/index.ts" 2>/dev/null
sleep 2

# Save PID and exec
echo $$ > "$PIDFILE"
exec npx tsx src/index.ts

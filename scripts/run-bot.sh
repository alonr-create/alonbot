#!/bin/bash
cd "/Users/oakhome/קלוד עבודות/alonbot" || exit 1
export PATH="/opt/homebrew/bin:/Users/oakhome/.nvm/versions/node/v24.14.0/bin:$PATH"

# Limit Node memory to prevent OOM kills on 8GB Mac
export NODE_OPTIONS="--max-old-space-size=512"

# Kill any leftover bot processes before starting (SIGKILL to ensure they die)
pkill -9 -f "tsx src/index.ts" 2>/dev/null
pkill -9 -f "Google Chrome for Testing" 2>/dev/null
sleep 2

# Clean Chrome lock files
rm -f data/whatsapp-wwjs-session/session/SingletonLock 2>/dev/null
rm -f data/whatsapp-wwjs-session/session/SingletonCookie 2>/dev/null
rm -f data/whatsapp-wwjs-session/session/SingletonSocket 2>/dev/null

exec npx tsx src/index.ts

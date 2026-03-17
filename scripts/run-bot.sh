#!/bin/bash
cd "/Users/oakhome/קלוד עבודות/alonbot" || exit 1
export PATH="/Users/oakhome/.nvm/versions/node/v24.14.0/bin:$PATH"

# Clean Chrome lock files
rm -f data/whatsapp-wwjs-session/session/SingletonLock 2>/dev/null
rm -f data/whatsapp-wwjs-session/session/SingletonCookie 2>/dev/null
rm -f data/whatsapp-wwjs-session/session/SingletonSocket 2>/dev/null

exec npx tsx src/index.ts

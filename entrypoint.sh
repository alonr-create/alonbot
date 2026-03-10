#!/bin/sh
echo "Cleaning stale Chromium locks..."
rm -rf /data/whatsapp-session/.wwebjs_auth/session/SingletonLock 2>/dev/null
rm -rf /data/whatsapp-session/.wwebjs_auth/session/SingletonSocket 2>/dev/null
rm -rf /data/whatsapp-session/.wwebjs_auth/session/SingletonCookie 2>/dev/null
# Also try common LocalAuth patterns
find /data -name "SingletonLock" -exec rm -f {} + 2>/dev/null
find /data -name "SingletonSocket" -exec rm -f {} + 2>/dev/null
find /data -name "SingletonCookie" -exec rm -f {} + 2>/dev/null
# Remove any leftover lock files (symlinks)
find /data -name "Singleton*" -type l -exec rm -f {} + 2>/dev/null
find /data -name "Singleton*" -type f -exec rm -f {} + 2>/dev/null
echo "Lock cleanup done, starting bot..."
exec node dist/index.js

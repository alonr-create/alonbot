import { resolve } from 'path';
import { realpathSync } from 'fs';

// --- Security: file path restrictions ---
export const ALLOWED_FILE_DIRS = ['/Users/oakhome/\u05e7\u05dc\u05d5\u05d3 \u05e2\u05d1\u05d5\u05d3\u05d5\u05ea/', '/tmp/alonbot-', '/app/workspace/', '/tmp/'];
// Only block sensitive config files -- git operations go through shell tool anyway
export const BLOCKED_FILE_PATTERNS = ['.env', '.ssh/', 'credentials', '.zshrc', '.bashrc'];

export function isPathAllowed(filePath: string): boolean {
  const resolved = resolve(filePath);
  if (BLOCKED_FILE_PATTERNS.some(p => resolved.includes(p))) return false;
  // Use realpathSync to follow symlinks and prevent symlink escape
  try {
    const real = realpathSync(resolved);
    return ALLOWED_FILE_DIRS.some(d => real.startsWith(d));
  } catch {
    // File doesn't exist yet (write_file) -- check resolved path
    return ALLOWED_FILE_DIRS.some(d => resolved.startsWith(d));
  }
}

// --- Security: URL validation for SSRF prevention ---
export function isUrlAllowed(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    const host = parsed.hostname.toLowerCase();
    // Block internal/private IPs (IPv4 + IPv6)
    if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0') return false;
    if (host === '::1' || host.startsWith('[')) return false; // IPv6 loopback/brackets
    if (/^(10\.|192\.168\.|169\.254\.|0\.)/.test(host)) return false;
    if (host.startsWith('172.') && parseInt(host.split('.')[1]) >= 16 && parseInt(host.split('.')[1]) <= 31) return false;
    if (/^\d+$/.test(host)) return false; // Decimal IP encoding
    if (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')) return false; // Private IPv6
    return true;
  } catch {
    return false;
  }
}

// --- Security: email recipient whitelist ---
export const ALLOWED_EMAIL_DOMAINS = ['dprisha.co.il', 'gmail.com'];
export const ALLOWED_EMAIL_ADDRESSES = ['alon12@gmail.com', 'dekel@dprisha.co.il', 'alonr@dprisha.co.il', 'servicedprisha@gmail.com'];

export function isEmailAllowed(to: string): boolean {
  const email = to.trim().toLowerCase();
  if (ALLOWED_EMAIL_ADDRESSES.includes(email)) return true;
  const domain = email.split('@')[1];
  return ALLOWED_EMAIL_DOMAINS.includes(domain);
}

// --- Local-only tools (proxied to Mac in cloud mode) ---
// shell, read_file, write_file work in both modes (cloud has /app/workspace/)
export const LOCAL_ONLY_TOOLS = ['screenshot', 'camera', 'manage_project', 'send_file'];

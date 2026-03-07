/**
 * Shell command blocklist — blocks dangerous commands in both the shell tool
 * and cron script execution. Pure function, no side effects.
 */

interface ShellCheckResult {
  safe: boolean;
  reason?: string;
}

const BLOCKED_SHELL_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  // Filesystem destruction
  { pattern: /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?(-[a-zA-Z]*r[a-zA-Z]*\s+)?\/($|\s)/, reason: 'Recursive delete of root filesystem' },
  { pattern: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*\s+)?(-[a-zA-Z]*f[a-zA-Z]*\s+)?\/($|\s)/, reason: 'Recursive delete of root filesystem' },
  { pattern: /\bmkfs\b/, reason: 'Filesystem format command' },
  { pattern: /\bdd\b.*\bof=\/dev\//, reason: 'Direct device write' },

  // Fork bombs
  { pattern: /:\(\)\s*\{.*\};\s*:/, reason: 'Fork bomb detected' },
  { pattern: /\.\(\)\s*\{.*\};\s*\./, reason: 'Fork bomb detected' },

  // Remote code execution (pipe to shell)
  { pattern: /\bcurl\b.*\|\s*(ba)?sh\b/, reason: 'Remote code execution via curl pipe to shell' },
  { pattern: /\bwget\b.*\|\s*(ba)?sh\b/, reason: 'Remote code execution via wget pipe to shell' },
  { pattern: /\bcurl\b.*\|\s*zsh\b/, reason: 'Remote code execution via curl pipe to shell' },
  { pattern: /\bwget\b.*\|\s*zsh\b/, reason: 'Remote code execution via wget pipe to shell' },

  // Privilege escalation
  { pattern: /\bchmod\s+777\s+\//, reason: 'Dangerous chmod on root paths' },
  { pattern: /\bchmod\s+-R\s+777\b/, reason: 'Recursive chmod 777' },

  // System manipulation
  { pattern: /\bshutdown\b/, reason: 'System shutdown command' },
  { pattern: /\breboot\b/, reason: 'System reboot command' },
  { pattern: /\biptables\s+-F\b/, reason: 'Firewall flush command' },

  // Credential theft
  { pattern: /\/etc\/shadow/, reason: 'Access to shadow password file' },
  { pattern: /\bcat\b.*\.ssh\/id_/, reason: 'SSH key access' },
  { pattern: /\bcat\b.*\.env\b/, reason: 'Environment file access' },

  // Reverse shells
  { pattern: /\bnc\s+-[a-zA-Z]*e\b/, reason: 'Netcat reverse shell' },
  { pattern: /\/dev\/tcp\//, reason: 'Bash reverse shell via /dev/tcp' },
  { pattern: /\bmkfifo\b.*\bnc\b/, reason: 'Named pipe reverse shell' },

  // Eval injection
  { pattern: /\beval\s+\$\(/, reason: 'Eval injection via command substitution' },
  { pattern: /\bpython[23]?\s+-c\b.*\bsocket\b/, reason: 'Python socket injection' },
  { pattern: /\bnode\s+-e\b.*\bchild_process\b/, reason: 'Node.js child_process injection' },

  // History/log wiping
  { pattern: /\bhistory\s+-c\b/, reason: 'History clearing' },
  { pattern: />\s*\/var\/log\//, reason: 'Log file wiping' },

  // Disk fill attacks
  { pattern: /\/dev\/zero.*\/dev\/null/, reason: 'Resource exhaustion' },
  { pattern: /\byes\b.*\|/, reason: 'Potential resource exhaustion via yes pipe' },

  // Process/system info exfiltration
  { pattern: /\bkillall\b/, reason: 'Mass process kill' },
  { pattern: /\bpkill\s+-9\b/, reason: 'Force kill processes' },
];

export function isShellCommandSafe(command: string): ShellCheckResult {
  for (const { pattern, reason } of BLOCKED_SHELL_PATTERNS) {
    if (pattern.test(command)) {
      return { safe: false, reason };
    }
  }
  return { safe: true };
}

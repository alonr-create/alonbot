import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import type Anthropic from '@anthropic-ai/sdk';

const ALLOWED_COMMANDS = ['date', 'cal', 'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'find', 'echo', 'pwd', 'whoami', 'uptime', 'df', 'curl', 'node', 'python3', 'npm'];

function isCommandAllowed(cmd: string): boolean {
  const base = cmd.trim().split(/\s+/)[0];
  return ALLOWED_COMMANDS.some(a => base === a || base.endsWith(`/${a}`));
}

export const toolDefinitions: Anthropic.Tool[] = [
  {
    name: 'shell',
    description: 'Run a shell command on the local machine. Only whitelisted commands are allowed.',
    input_schema: {
      type: 'object' as const,
      properties: {
        command: { type: 'string', description: 'The shell command to run' },
      },
      required: ['command'],
    },
  },
  {
    name: 'read_file',
    description: 'Read the contents of a file.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Absolute file path' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write content to a file.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Absolute file path' },
        content: { type: 'string', description: 'File content to write' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'set_reminder',
    description: 'Set a reminder that will be sent at a specific time. Use cron expression format.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Reminder name' },
        cron_expr: { type: 'string', description: 'Cron expression (e.g. "0 18 * * *" for 18:00 daily)' },
        message: { type: 'string', description: 'Message to send when reminder triggers' },
      },
      required: ['name', 'cron_expr', 'message'],
    },
  },
  {
    name: 'remember',
    description: 'Save a fact about the user for future reference.',
    input_schema: {
      type: 'object' as const,
      properties: {
        key: { type: 'string', description: 'Fact key (e.g. "birthday", "favorite_food")' },
        value: { type: 'string', description: 'Fact value' },
      },
      required: ['key', 'value'],
    },
  },
];

export function executeTool(name: string, input: Record<string, string>): string {
  switch (name) {
    case 'shell': {
      if (!isCommandAllowed(input.command)) {
        return `Error: Command not allowed. Allowed: ${ALLOWED_COMMANDS.join(', ')}`;
      }
      try {
        return execSync(input.command, { timeout: 10000, encoding: 'utf-8', maxBuffer: 50000 }).trim();
      } catch (e: any) {
        return `Error: ${e.message}`;
      }
    }
    case 'read_file': {
      try {
        return readFileSync(input.path, 'utf-8');
      } catch (e: any) {
        return `Error: ${e.message}`;
      }
    }
    case 'write_file': {
      try {
        writeFileSync(input.path, input.content);
        return `File written: ${input.path}`;
      } catch (e: any) {
        return `Error: ${e.message}`;
      }
    }
    case 'remember': {
      const { setFact } = require('../agent/memory.js');
      setFact(input.key, input.value);
      return `Remembered: ${input.key} = ${input.value}`;
    }
    case 'set_reminder': {
      // Will be handled by cron scheduler
      return `__REMINDER__:${JSON.stringify(input)}`;
    }
    default:
      return `Unknown tool: ${name}`;
  }
}

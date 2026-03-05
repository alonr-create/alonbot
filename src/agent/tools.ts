import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { createTransport } from 'nodemailer';
import type Anthropic from '@anthropic-ai/sdk';
import { config } from '../utils/config.js';
import { setFact } from './memory.js';
import { db } from '../utils/db.js';
import { addCronJob } from '../cron/scheduler.js';

// --- Media side-channel: tools can attach media to be sent with the reply ---
let pendingMedia: Array<{ type: 'image' | 'voice'; data: Buffer }> = [];

export function collectMedia(): Array<{ type: 'image' | 'voice'; data: Buffer }> {
  const media = [...pendingMedia];
  pendingMedia = [];
  return media;
}

// --- Whitelisted shell commands ---
const ALLOWED_COMMANDS = [
  'date', 'cal', 'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'find', 'echo',
  'pwd', 'whoami', 'uptime', 'df', 'curl', 'node', 'python3', 'npm', 'git',
  'screencapture', 'open', 'which', 'hostname', 'sw_vers',
];

function isCommandAllowed(cmd: string): boolean {
  const base = cmd.trim().split(/\s+/)[0];
  return ALLOWED_COMMANDS.some(a => base === a || base.endsWith(`/${a}`));
}

// --- Tool definitions ---
export const toolDefinitions: Anthropic.Tool[] = [
  {
    name: 'shell',
    description: 'Run a shell command on the local Mac. Whitelisted commands only.',
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
    name: 'web_search',
    description: 'Search the web using DuckDuckGo. Returns top results with titles and snippets.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search query' },
      },
      required: ['query'],
    },
  },
  {
    name: 'browse_url',
    description: 'Fetch and read the text content of a web page.',
    input_schema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'URL to fetch' },
      },
      required: ['url'],
    },
  },
  {
    name: 'generate_image',
    description: 'Generate an image using Gemini AI. Returns the image and sends it in the chat.',
    input_schema: {
      type: 'object' as const,
      properties: {
        prompt: { type: 'string', description: 'Detailed image description in English' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'set_reminder',
    description: 'Set a reminder that will be sent at a specific time.',
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
    name: 'list_reminders',
    description: 'List all active reminders/cron jobs.',
    input_schema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'delete_reminder',
    description: 'Delete a reminder by its ID.',
    input_schema: {
      type: 'object' as const,
      properties: {
        id: { type: 'number', description: 'Reminder ID to delete' },
      },
      required: ['id'],
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
  {
    name: 'monday_api',
    description: 'Query Monday.com API (GraphQL). Use for leads, meetings, tasks from דקל לפרישה boards.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'GraphQL query string' },
      },
      required: ['query'],
    },
  },
  {
    name: 'send_voice',
    description: 'Convert text to speech and send as a voice message. Supports Hebrew and English.',
    input_schema: {
      type: 'object' as const,
      properties: {
        text: { type: 'string', description: 'Text to convert to speech' },
      },
      required: ['text'],
    },
  },
  {
    name: 'send_email',
    description: 'Send an email via Gmail.',
    input_schema: {
      type: 'object' as const,
      properties: {
        to: { type: 'string', description: 'Recipient email address' },
        subject: { type: 'string', description: 'Email subject' },
        body: { type: 'string', description: 'Email body (plain text or HTML)' },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  {
    name: 'screenshot',
    description: 'Take a screenshot of the Mac screen and send it.',
    input_schema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'manage_project',
    description: 'Run git commands or check status of a project. Projects are in /Users/oakhome/קלוד עבודות/.',
    input_schema: {
      type: 'object' as const,
      properties: {
        project: { type: 'string', description: 'Project folder name (e.g. "alonbot", "alon-dev", "עליזה-המפרסמת")' },
        action: { type: 'string', enum: ['status', 'log', 'pull', 'diff'], description: 'Git action to perform' },
      },
      required: ['project', 'action'],
    },
  },
];

// --- Tool execution ---
export async function executeTool(name: string, input: Record<string, any>): Promise<string> {
  switch (name) {
    case 'shell': {
      if (!isCommandAllowed(input.command)) {
        return `Error: Command not allowed. Allowed: ${ALLOWED_COMMANDS.join(', ')}`;
      }
      try {
        return execSync(input.command, { timeout: 15000, encoding: 'utf-8', maxBuffer: 100000 }).trim();
      } catch (e: any) {
        return `Error: ${e.stderr || e.message}`;
      }
    }

    case 'read_file': {
      try {
        return readFileSync(input.path, 'utf-8').slice(0, 10000);
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

    case 'web_search': {
      try {
        const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(input.query)}`;
        const res = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
        });
        const html = await res.text();
        const results: string[] = [];
        const regex = /<a rel="nofollow" class="result__a" href="([^"]+)"[^>]*>(.+?)<\/a>[\s\S]*?<a class="result__snippet"[^>]*>(.+?)<\/a>/g;
        let match;
        let count = 0;
        while ((match = regex.exec(html)) && count < 8) {
          const title = match[2].replace(/<[^>]+>/g, '').trim();
          const snippet = match[3].replace(/<[^>]+>/g, '').trim();
          const href = match[1];
          results.push(`${count + 1}. ${title}\n   ${snippet}\n   ${href}`);
          count++;
        }
        return results.length > 0 ? results.join('\n\n') : 'No results found.';
      } catch (e: any) {
        return `Error: ${e.message}`;
      }
    }

    case 'browse_url': {
      try {
        const res = await fetch(input.url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AlonBot/1.0)' },
          signal: AbortSignal.timeout(10000),
        });
        const html = await res.text();
        // Strip tags, scripts, styles — extract text
        const text = html
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 8000);
        return text || 'Empty page.';
      } catch (e: any) {
        return `Error: ${e.message}`;
      }
    }

    case 'generate_image': {
      if (!config.geminiApiKey) return 'Error: GEMINI_API_KEY not configured.';
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${config.geminiApiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: input.prompt }] }],
              generationConfig: { responseModalities: ['IMAGE', 'TEXT'] },
            }),
          },
        );
        const data = await res.json() as any;
        const parts = data?.candidates?.[0]?.content?.parts || [];
        for (const part of parts) {
          if (part.inlineData?.mimeType?.startsWith('image/')) {
            const buf = Buffer.from(part.inlineData.data, 'base64');
            pendingMedia.push({ type: 'image', data: buf });
            return 'Image generated and sent.';
          }
        }
        return 'Image generation failed — no image in response.';
      } catch (e: any) {
        return `Error: ${e.message}`;
      }
    }

    case 'set_reminder': {
      try {
        const id = addCronJob(input.name, input.cron_expr, 'telegram', config.allowedTelegram[0] || '', input.message);
        return `Reminder set: "${input.name}" (ID: ${id}) — ${input.cron_expr}`;
      } catch (e: any) {
        return `Error: ${e.message}`;
      }
    }

    case 'list_reminders': {
      const jobs = db.prepare('SELECT id, name, cron_expr, message, enabled FROM cron_jobs ORDER BY id').all() as any[];
      if (jobs.length === 0) return 'No reminders set.';
      return jobs.map(j => `#${j.id} ${j.enabled ? '✓' : '✗'} "${j.name}" — ${j.cron_expr} — ${j.message}`).join('\n');
    }

    case 'delete_reminder': {
      const result = db.prepare('DELETE FROM cron_jobs WHERE id = ?').run(input.id);
      return result.changes > 0 ? `Reminder #${input.id} deleted.` : `Reminder #${input.id} not found.`;
    }

    case 'remember': {
      setFact(input.key, input.value);
      return `Remembered: ${input.key} = ${input.value}`;
    }

    case 'monday_api': {
      if (!config.mondayApiKey) return 'Error: MONDAY_API_KEY not configured.';
      try {
        const res = await fetch('https://api.monday.com/v2', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': config.mondayApiKey,
          },
          body: JSON.stringify({ query: input.query }),
        });
        const data = await res.json();
        return JSON.stringify(data, null, 2).slice(0, 8000);
      } catch (e: any) {
        return `Error: ${e.message}`;
      }
    }

    case 'send_voice': {
      if (!config.elevenlabsApiKey) return 'Error: ELEVENLABS_API_KEY not configured.';
      try {
        const res = await fetch(
          `https://api.elevenlabs.io/v1/text-to-speech/${config.elevenlabsVoiceId}`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'xi-api-key': config.elevenlabsApiKey,
            },
            body: JSON.stringify({
              text: input.text,
              model_id: 'eleven_multilingual_v2',
              voice_settings: { stability: 0.5, similarity_boost: 0.75 },
            }),
          },
        );
        if (!res.ok) return `Error: ElevenLabs returned ${res.status}`;
        const buf = Buffer.from(await res.arrayBuffer());
        pendingMedia.push({ type: 'voice', data: buf });
        return 'Voice message generated and sent.';
      } catch (e: any) {
        return `Error: ${e.message}`;
      }
    }

    case 'send_email': {
      if (!config.gmailUser || !config.gmailAppPassword) return 'Error: Gmail credentials not configured.';
      try {
        const transport = createTransport({
          service: 'gmail',
          auth: { user: config.gmailUser, pass: config.gmailAppPassword },
        });
        await transport.sendMail({
          from: config.gmailUser,
          to: input.to,
          subject: input.subject,
          html: input.body,
        });
        return `Email sent to ${input.to}`;
      } catch (e: any) {
        return `Error: ${e.message}`;
      }
    }

    case 'screenshot': {
      try {
        const tmpPath = '/tmp/alonbot-screenshot.png';
        execSync(`screencapture -x ${tmpPath}`, { timeout: 5000 });
        const buf = readFileSync(tmpPath);
        pendingMedia.push({ type: 'image', data: buf });
        return 'Screenshot taken and sent.';
      } catch (e: any) {
        return `Error: ${e.message}`;
      }
    }

    case 'manage_project': {
      const projectDir = `/Users/oakhome/קלוד עבודות/${input.project}`;
      const actions: Record<string, string> = {
        status: 'git status --short',
        log: 'git log --oneline -10',
        pull: 'git pull',
        diff: 'git diff --stat',
      };
      const cmd = actions[input.action];
      if (!cmd) return `Unknown action: ${input.action}`;
      try {
        return execSync(cmd, { cwd: projectDir, timeout: 15000, encoding: 'utf-8', maxBuffer: 50000 }).trim() || 'Clean — no changes.';
      } catch (e: any) {
        return `Error: ${e.stderr || e.message}`;
      }
    }

    default:
      return `Unknown tool: ${name}`;
  }
}

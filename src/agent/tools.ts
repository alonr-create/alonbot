import { execSync } from 'child_process';
import { readFileSync, writeFileSync, realpathSync } from 'fs';
import { resolve } from 'path';
import { createTransport } from 'nodemailer';
import type Anthropic from '@anthropic-ai/sdk';
import { config } from '../utils/config.js';
import { saveMemory } from './memory.js';
import { db } from '../utils/db.js';
import { addCronJob } from '../cron/scheduler.js';
import { ingestUrl, ingestText, searchKnowledge, listDocs, deleteDoc } from './knowledge.js';
import { addWorkflow, listWorkflows, deleteWorkflow, toggleWorkflow, matchKeywordWorkflows, type WorkflowAction } from './workflows.js';

// --- Media side-channel: tools can attach media to be sent with the reply ---
let pendingMedia: Array<{ type: 'image' | 'voice'; data: Buffer }> = [];

export function collectMedia(): Array<{ type: 'image' | 'voice'; data: Buffer }> {
  const media = [...pendingMedia];
  pendingMedia = [];
  return media;
}

// --- Security: shell command whitelist ---
const ALLOWED_COMMANDS = [
  'date', 'cal', 'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'find', 'echo',
  'pwd', 'whoami', 'uptime', 'df', 'which', 'hostname', 'sw_vers',
];

// Block shell metacharacters that enable command chaining/injection
const SHELL_INJECTION_PATTERN = /[;|&`$(){}!<>]/;

function isCommandAllowed(cmd: string): boolean {
  const trimmed = cmd.trim();
  if (SHELL_INJECTION_PATTERN.test(trimmed)) return false;
  const base = trimmed.split(/\s+/)[0];
  return ALLOWED_COMMANDS.some(a => base === a || base.endsWith(`/${a}`));
}

// --- Security: file path restrictions ---
const ALLOWED_FILE_DIRS = ['/Users/oakhome/קלוד עבודות/', '/tmp/alonbot-'];
const BLOCKED_FILE_PATTERNS = ['.env', '.git/', '.ssh/', '.claude/', 'credentials', '.zshrc', '.bashrc'];

function isPathAllowed(filePath: string): boolean {
  const resolved = resolve(filePath);
  // Block dotfiles and sensitive patterns
  if (BLOCKED_FILE_PATTERNS.some(p => resolved.includes(p))) return false;
  // Must be under allowed directories
  return ALLOWED_FILE_DIRS.some(d => resolved.startsWith(d));
}

// --- Security: URL validation for SSRF prevention ---
function isUrlAllowed(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    const host = parsed.hostname.toLowerCase();
    // Block internal/private IPs
    if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0') return false;
    if (host.startsWith('10.') || host.startsWith('192.168.') || host.startsWith('169.254.')) return false;
    if (host.startsWith('172.') && parseInt(host.split('.')[1]) >= 16 && parseInt(host.split('.')[1]) <= 31) return false;
    return true;
  } catch {
    return false;
  }
}

// --- Security: email recipient whitelist ---
const ALLOWED_EMAIL_DOMAINS = ['dprisha.co.il', 'gmail.com'];
const ALLOWED_EMAIL_ADDRESSES = ['alon12@gmail.com', 'dekel@dprisha.co.il', 'alonr@dprisha.co.il', 'servicedprisha@gmail.com'];

function isEmailAllowed(to: string): boolean {
  const email = to.trim().toLowerCase();
  if (ALLOWED_EMAIL_ADDRESSES.includes(email)) return true;
  const domain = email.split('@')[1];
  return ALLOWED_EMAIL_DOMAINS.includes(domain);
}

// --- Local-only tools (disabled in cloud mode) ---
const LOCAL_ONLY_TOOLS = ['shell', 'read_file', 'write_file', 'screenshot', 'manage_project', 'send_file'];

const allToolDefinitions: Anthropic.Tool[] = [
  { name: 'shell', description: 'Run whitelisted shell command on Mac', input_schema: { type: 'object' as const, properties: { command: { type: 'string' } }, required: ['command'] } },
  { name: 'read_file', description: 'Read file from project dir', input_schema: { type: 'object' as const, properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'write_file', description: 'Write file to project dir', input_schema: { type: 'object' as const, properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'web_search', description: 'DuckDuckGo search', input_schema: { type: 'object' as const, properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'web_research', description: 'Deep research via Gemini+Google Search with sources. Best for complex/Hebrew queries.', input_schema: { type: 'object' as const, properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'browse_url', description: 'Fetch web page text', input_schema: { type: 'object' as const, properties: { url: { type: 'string' } }, required: ['url'] } },
  { name: 'analyze_image', description: 'Analyze image from URL (OCR, describe, Hebrew)', input_schema: { type: 'object' as const, properties: { image_url: { type: 'string' }, question: { type: 'string' } }, required: ['image_url'] } },
  { name: 'generate_image', description: 'Generate image from prompt', input_schema: { type: 'object' as const, properties: { prompt: { type: 'string', description: 'English prompt' } }, required: ['prompt'] } },
  { name: 'set_reminder', description: 'Set cron reminder', input_schema: { type: 'object' as const, properties: { name: { type: 'string' }, cron_expr: { type: 'string', description: 'e.g. "0 18 * * *"' }, message: { type: 'string' } }, required: ['name', 'cron_expr', 'message'] } },
  { name: 'list_reminders', description: 'List reminders', input_schema: { type: 'object' as const, properties: {} } },
  { name: 'delete_reminder', description: 'Delete reminder', input_schema: { type: 'object' as const, properties: { id: { type: 'number' } }, required: ['id'] } },
  { name: 'remember', description: 'Save memory about user', input_schema: { type: 'object' as const, properties: { content: { type: 'string' }, type: { type: 'string', enum: ['fact', 'preference', 'event', 'pattern', 'relationship'] }, category: { type: 'string', enum: ['personal', 'work_dekel', 'work_mazpen', 'work_alon_dev', 'work_aliza', 'health', 'finance'] }, importance: { type: 'number', description: '1-10' } }, required: ['content', 'type'] } },
  { name: 'monday_api', description: 'Monday.com GraphQL query', input_schema: { type: 'object' as const, properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'send_voice', description: 'TTS voice message (Hebrew/English)', input_schema: { type: 'object' as const, properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'send_email', description: 'Send Gmail to whitelisted address', input_schema: { type: 'object' as const, properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } }, required: ['to', 'subject', 'body'] } },
  { name: 'screenshot', description: 'Screenshot Mac screen', input_schema: { type: 'object' as const, properties: {} } },
  { name: 'api_costs', description: 'Show API usage costs (today/week/month/all)', input_schema: { type: 'object' as const, properties: { period: { type: 'string', enum: ['today', 'week', 'month', 'all'], description: 'Time period' } }, required: ['period'] } },
  { name: 'add_task', description: 'Add task to todo list', input_schema: { type: 'object' as const, properties: { title: { type: 'string' }, priority: { type: 'number', description: '1-10' }, due_date: { type: 'string', description: 'YYYY-MM-DD' } }, required: ['title'] } },
  { name: 'list_tasks', description: 'List pending tasks', input_schema: { type: 'object' as const, properties: {} } },
  { name: 'complete_task', description: 'Mark task as done', input_schema: { type: 'object' as const, properties: { id: { type: 'number' } }, required: ['id'] } },
  { name: 'send_file', description: 'Send file from Mac to user', input_schema: { type: 'object' as const, properties: { path: { type: 'string' } }, required: ['path'] } },
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
  { name: 'schedule_message', description: 'Schedule a one-time message to be sent at a specific date/time (ISO 8601 or "YYYY-MM-DD HH:mm"). Auto-deletes after sending.', input_schema: { type: 'object' as const, properties: { message: { type: 'string', description: 'Message to send' }, send_at: { type: 'string', description: 'When to send (e.g. "2026-03-07 09:00")' }, label: { type: 'string', description: 'Short label for this scheduled message' } }, required: ['message', 'send_at'] } },
  // Knowledge Base tools
  { name: 'learn_url', description: 'Ingest a web page into knowledge base for later retrieval', input_schema: { type: 'object' as const, properties: { url: { type: 'string' }, title: { type: 'string' } }, required: ['url'] } },
  { name: 'learn_text', description: 'Ingest text content into knowledge base', input_schema: { type: 'object' as const, properties: { text: { type: 'string' }, title: { type: 'string' } }, required: ['text', 'title'] } },
  { name: 'search_knowledge', description: 'Search knowledge base (ingested docs) by semantic query', input_schema: { type: 'object' as const, properties: { query: { type: 'string' }, top_k: { type: 'number' } }, required: ['query'] } },
  { name: 'list_knowledge', description: 'List all documents in knowledge base', input_schema: { type: 'object' as const, properties: {} } },
  { name: 'delete_knowledge', description: 'Delete document from knowledge base', input_schema: { type: 'object' as const, properties: { doc_id: { type: 'number' } }, required: ['doc_id'] } },
  // Workflow tools
  { name: 'create_workflow', description: 'Create automated workflow (trigger → actions). Trigger types: keyword, cron, event. Action types: send_message, add_task, send_email, remember, set_reminder', input_schema: { type: 'object' as const, properties: { name: { type: 'string' }, trigger_type: { type: 'string', enum: ['keyword', 'cron', 'event'] }, trigger_value: { type: 'string', description: 'Keywords (comma-separated), cron expr, or event name' }, actions: { type: 'array', items: { type: 'object', properties: { type: { type: 'string' }, params: { type: 'object' } }, required: ['type', 'params'] } } }, required: ['name', 'trigger_type', 'trigger_value', 'actions'] } },
  { name: 'list_workflows', description: 'List all automated workflows', input_schema: { type: 'object' as const, properties: {} } },
  { name: 'delete_workflow', description: 'Delete a workflow', input_schema: { type: 'object' as const, properties: { id: { type: 'number' } }, required: ['id'] } },
  { name: 'toggle_workflow', description: 'Enable/disable a workflow', input_schema: { type: 'object' as const, properties: { id: { type: 'number' }, enabled: { type: 'boolean' } }, required: ['id', 'enabled'] } },
];

// In cloud mode: keep all tools, but proxy local-only ones to Mac
export const toolDefinitions = allToolDefinitions;

// --- Proxy local tools from cloud to Mac ---
async function proxyToLocal(name: string, input: Record<string, any>): Promise<{ result: string; media?: Array<{ type: string; data: string }> } | null> {
  if (!config.localApiUrl) return null;
  try {
    const res = await fetch(`${config.localApiUrl}/api/tool`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.localApiSecret}`,
      },
      body: JSON.stringify({ name, input }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    return await res.json() as any;
  } catch {
    return null;
  }
}

// --- Tool execution ---
export async function executeTool(name: string, input: Record<string, any>): Promise<string> {
  // In cloud mode, proxy local-only tools to Mac
  if (config.mode === 'cloud' && LOCAL_ONLY_TOOLS.includes(name)) {
    const proxy = await proxyToLocal(name, input);
    if (!proxy) return 'Error: Mac is offline. This tool requires the local Mac to be running.';
    // Collect proxied media
    if (proxy.media) {
      for (const m of proxy.media) {
        pendingMedia.push({ type: m.type as any, data: Buffer.from(m.data, 'base64') });
      }
    }
    return proxy.result;
  }

  switch (name) {
    case 'shell': {
      if (!isCommandAllowed(input.command)) {
        return `Error: Command not allowed. Only simple commands permitted (no pipes, semicolons, or chaining). Allowed: ${ALLOWED_COMMANDS.join(', ')}`;
      }
      try {
        return execSync(input.command, { timeout: 15000, encoding: 'utf-8', maxBuffer: 100000 }).trim();
      } catch (e: any) {
        return `Error: ${(e.stderr || e.message || '').slice(0, 500)}`;
      }
    }

    case 'read_file': {
      if (!isPathAllowed(input.path)) {
        return 'Error: Access denied. Can only read files under project directories.';
      }
      try {
        return readFileSync(input.path, 'utf-8').slice(0, 10000);
      } catch (e: any) {
        return `Error: File not found or unreadable.`;
      }
    }

    case 'write_file': {
      if (!isPathAllowed(input.path)) {
        return 'Error: Access denied. Can only write files under project directories.';
      }
      try {
        writeFileSync(input.path, input.content);
        return `File written: ${input.path}`;
      } catch (e: any) {
        return `Error: Could not write file.`;
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
        return `Error: Search failed.`;
      }
    }

    case 'web_research': {
      if (!config.geminiApiKey) return 'Error: GEMINI_API_KEY not configured.';
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${config.geminiApiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: input.query }] }],
              tools: [{ google_search: {} }],
            }),
          },
        );
        if (!res.ok) {
          const errText = await res.text();
          return `Error: Gemini Search returned ${res.status}: ${errText.slice(0, 200)}`;
        }
        const data = await res.json() as any;
        const parts = data?.candidates?.[0]?.content?.parts || [];
        let answer = parts.map((p: any) => p.text || '').join('\n').trim();
        // Extract grounding sources if available
        const grounding = data?.candidates?.[0]?.groundingMetadata;
        if (grounding?.groundingChunks?.length) {
          const sources = grounding.groundingChunks
            .filter((c: any) => c.web?.uri)
            .slice(0, 5)
            .map((c: any, i: number) => `${i + 1}. ${c.web.title || ''} — ${c.web.uri}`)
            .join('\n');
          if (sources) answer += `\n\nSources:\n${sources}`;
        }
        return answer || 'No results found.';
      } catch (e: any) {
        return `Error: Web research failed.`;
      }
    }

    case 'browse_url': {
      if (!isUrlAllowed(input.url)) {
        return 'Error: URL not allowed. Only public http/https URLs permitted.';
      }
      try {
        const res = await fetch(input.url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AlonBot/1.0)' },
          signal: AbortSignal.timeout(10000),
        });
        const html = await res.text();
        const text = html
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 8000);
        return text || 'Empty page.';
      } catch (e: any) {
        return `Error: Could not fetch URL.`;
      }
    }

    case 'analyze_image': {
      if (!config.geminiApiKey) return 'Error: GEMINI_API_KEY not configured.';
      if (!isUrlAllowed(input.image_url)) return 'Error: URL not allowed.';
      try {
        // Download image
        const imgRes = await fetch(input.image_url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AlonBot/1.0)' },
          signal: AbortSignal.timeout(15000),
        });
        if (!imgRes.ok) return `Error: Could not download image (${imgRes.status}).`;
        const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
        const imgBuf = Buffer.from(await imgRes.arrayBuffer());
        const base64 = imgBuf.toString('base64');
        const question = input.question || 'Describe this image in detail. If there is text, extract it (OCR). Answer in Hebrew.';

        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${config.geminiApiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{
                parts: [
                  { inline_data: { mime_type: contentType, data: base64 } },
                  { text: question },
                ],
              }],
            }),
          },
        );
        if (!res.ok) {
          const errText = await res.text();
          return `Error: Gemini Vision returned ${res.status}: ${errText.slice(0, 200)}`;
        }
        const data = await res.json() as any;
        const parts = data?.candidates?.[0]?.content?.parts || [];
        return parts.map((p: any) => p.text || '').join('\n').trim() || 'Could not analyze image.';
      } catch (e: any) {
        return `Error: Image analysis failed.`;
      }
    }

    case 'generate_image': {
      if (!config.geminiApiKey) return 'Error: GEMINI_API_KEY not configured.';
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent?key=${config.geminiApiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: input.prompt }] }],
              generationConfig: { responseModalities: ['IMAGE', 'TEXT'] },
            }),
          },
        );
        if (!res.ok) {
          const errText = await res.text();
          return `Error: Gemini API returned ${res.status}: ${errText.slice(0, 200)}`;
        }
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
        return `Error: Image generation failed.`;
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
      const id = saveMemory(
        input.type || 'fact',
        input.category || null,
        input.content,
        input.importance || 5,
        'user_told'
      );
      return `Remembered (id=${id}, type=${input.type}): ${input.content}`;
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
        return `Error: Monday.com API call failed.`;
      }
    }

    case 'send_voice': {
      if (!config.elevenlabsApiKey) return 'Error: ELEVENLABS_API_KEY not configured.';
      try {
        // Detect language: Hebrew or English voice
        const isHebrew = /[\u0590-\u05FF]/.test(input.text);
        const voiceId = isHebrew ? config.elevenlabsVoiceId : 'nPczCjzI2devNBz1zQrb';
        const res = await fetch(
          `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'xi-api-key': config.elevenlabsApiKey,
            },
            body: JSON.stringify({
              text: input.text,
              model_id: 'eleven_v3',
              voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.3 },
            }),
          },
        );
        if (!res.ok) return `Error: ElevenLabs returned ${res.status}`;
        const buf = Buffer.from(await res.arrayBuffer());
        pendingMedia.push({ type: 'voice', data: buf });
        return 'Voice message generated and sent.';
      } catch (e: any) {
        return `Error: Voice generation failed.`;
      }
    }

    case 'send_email': {
      if (!config.gmailUser || !config.gmailAppPassword) return 'Error: Gmail credentials not configured.';
      if (!isEmailAllowed(input.to)) {
        return `Error: Recipient not allowed. Can only send to known addresses.`;
      }
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
        transport.close();
        return `Email sent to ${input.to}`;
      } catch (e: any) {
        return `Error: Email sending failed.`;
      }
    }

    case 'screenshot': {
      try {
        const tmpPath = `/tmp/alonbot-screenshot-${Date.now()}.png`;
        execSync(`screencapture -x ${tmpPath}`, { timeout: 5000 });
        const buf = readFileSync(tmpPath);
        pendingMedia.push({ type: 'image', data: buf });
        return 'Screenshot taken and sent.';
      } catch (e: any) {
        return `Error: Screenshot failed.`;
      }
    }

    case 'api_costs': {
      const periods: Record<string, string> = {
        today: "date(created_at) = date('now')",
        week: "created_at >= datetime('now', '-7 days')",
        month: "created_at >= datetime('now', '-30 days')",
        all: '1=1',
      };
      const where = periods[input.period] || periods.all;
      const rows = db.prepare(`
        SELECT model, COUNT(*) as calls, SUM(input_tokens) as input_t, SUM(output_tokens) as output_t,
               ROUND(SUM(cost_usd), 4) as total_cost
        FROM api_usage WHERE ${where} GROUP BY model
      `).all() as any[];
      if (rows.length === 0) return `No API usage for period: ${input.period}`;
      const total = rows.reduce((s, r) => s + (r.total_cost || 0), 0);
      const lines = rows.map(r => `${r.model}: ${r.calls} calls, ${r.input_t?.toLocaleString()}↓ ${r.output_t?.toLocaleString()}↑, $${r.total_cost}`);
      lines.push(`\nTotal: $${total.toFixed(4)}`);
      return lines.join('\n');
    }

    case 'add_task': {
      const stmt = db.prepare('INSERT INTO tasks (title, priority, due_date) VALUES (?, ?, ?)');
      const result = stmt.run(input.title, input.priority || 5, input.due_date || null);
      return `Task #${result.lastInsertRowid} added: "${input.title}"`;
    }

    case 'list_tasks': {
      const tasks = db.prepare("SELECT id, title, priority, due_date, created_at FROM tasks WHERE status = 'pending' ORDER BY priority DESC, created_at").all() as any[];
      if (tasks.length === 0) return 'No pending tasks.';
      return tasks.map(t => `#${t.id} [${t.priority}] ${t.title}${t.due_date ? ` (עד ${t.due_date})` : ''}`).join('\n');
    }

    case 'complete_task': {
      const result = db.prepare("UPDATE tasks SET status = 'done', completed_at = datetime('now') WHERE id = ? AND status = 'pending'").run(input.id);
      return result.changes > 0 ? `Task #${input.id} completed!` : `Task #${input.id} not found or already done.`;
    }

    case 'send_file': {
      if (!isPathAllowed(input.path)) return 'Error: Access denied.';
      try {
        const buf = readFileSync(input.path);
        const ext = input.path.split('.').pop()?.toLowerCase();
        if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext || '')) {
          pendingMedia.push({ type: 'image', data: buf });
        } else {
          // For non-image files, send as text if small enough
          const text = buf.toString('utf-8').slice(0, 10000);
          return `File content (${input.path}):\n${text}`;
        }
        return `File sent: ${input.path}`;
      } catch {
        return 'Error: File not found.';
      }
    }

    case 'manage_project': {
      // Validate project name — no path traversal
      if (input.project.includes('/') || input.project.includes('..') || input.project.includes('\\')) {
        return 'Error: Invalid project name.';
      }
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
        return `Error: Git command failed.`;
      }
    }

    case 'schedule_message': {
      try {
        const sendAt = input.send_at;
        const targetId = config.allowedTelegram[0] || '';
        const result = db.prepare(
          'INSERT INTO scheduled_messages (label, message, send_at, channel, target_id) VALUES (?, ?, ?, ?, ?)'
        ).run(input.label || null, input.message, sendAt, 'telegram', targetId);
        return `Scheduled message #${result.lastInsertRowid} for ${sendAt}: "${(input.label || input.message).slice(0, 50)}"`;
      } catch (e: any) {
        return `Error: ${e.message}`;
      }
    }

    // --- Knowledge Base ---
    case 'learn_url': {
      if (!config.geminiApiKey) return 'Error: GEMINI_API_KEY needed for embeddings.';
      try {
        const result = await ingestUrl(input.url, input.title);
        return `Ingested "${input.title || input.url}": ${result.chunks} chunks saved to knowledge base (doc #${result.docId})`;
      } catch (e: any) {
        return `Error: ${e.message}`;
      }
    }

    case 'learn_text': {
      if (!config.geminiApiKey) return 'Error: GEMINI_API_KEY needed for embeddings.';
      try {
        const result = await ingestText(input.text, input.title);
        return `Ingested "${input.title}": ${result.chunks} chunks saved to knowledge base (doc #${result.docId})`;
      } catch (e: any) {
        return `Error: ${e.message}`;
      }
    }

    case 'search_knowledge': {
      if (!config.geminiApiKey) return 'Error: GEMINI_API_KEY needed for search.';
      try {
        const results = await searchKnowledge(input.query, input.top_k || 5);
        if (results.length === 0) return 'No relevant knowledge found.';
        return results.map((r, i) => `[${i + 1}] (${r.title}) ${r.content}`).join('\n\n');
      } catch (e: any) {
        return `Error: ${e.message}`;
      }
    }

    case 'list_knowledge': {
      const docs = listDocs();
      if (docs.length === 0) return 'Knowledge base is empty.';
      return docs.map(d => `#${d.id} "${d.title}" (${d.source_type}, ${d.chunk_count} chunks, ${d.created_at})`).join('\n');
    }

    case 'delete_knowledge': {
      const success = deleteDoc(input.doc_id);
      return success ? `Document #${input.doc_id} deleted from knowledge base.` : `Document #${input.doc_id} not found.`;
    }

    // --- Workflows ---
    case 'create_workflow': {
      try {
        const id = addWorkflow(input.name, input.trigger_type, input.trigger_value, input.actions);
        return `Workflow #${id} created: "${input.name}" (${input.trigger_type}: ${input.trigger_value}) → ${input.actions.length} actions`;
      } catch (e: any) {
        return `Error: ${e.message}`;
      }
    }

    case 'list_workflows': {
      const workflows = listWorkflows();
      if (workflows.length === 0) return 'No workflows configured.';
      return workflows.map(w => {
        const status = w.enabled ? 'ON' : 'OFF';
        const actions = w.actions.map((a: WorkflowAction) => a.type).join(', ');
        return `#${w.id} [${status}] "${w.name}" — ${w.trigger_type}:${w.trigger_value} → ${actions}`;
      }).join('\n');
    }

    case 'delete_workflow': {
      const success = deleteWorkflow(input.id);
      return success ? `Workflow #${input.id} deleted.` : `Workflow #${input.id} not found.`;
    }

    case 'toggle_workflow': {
      const success = toggleWorkflow(input.id, input.enabled);
      return success ? `Workflow #${input.id} ${input.enabled ? 'enabled' : 'disabled'}.` : `Workflow #${input.id} not found.`;
    }

    default:
      return `Unknown tool: ${name}`;
  }
}

// --- Workflow Execution (called from router) ---
export async function executeWorkflowActions(actions: WorkflowAction[], context: { channel: string; targetId: string }): Promise<string[]> {
  const results: string[] = [];
  for (const action of actions) {
    try {
      switch (action.type) {
        case 'add_task': {
          const r = await executeTool('add_task', action.params);
          results.push(r);
          break;
        }
        case 'send_email': {
          const r = await executeTool('send_email', action.params);
          results.push(r);
          break;
        }
        case 'remember': {
          const r = await executeTool('remember', action.params);
          results.push(r);
          break;
        }
        case 'set_reminder': {
          const r = await executeTool('set_reminder', action.params);
          results.push(r);
          break;
        }
        case 'send_message': {
          results.push(`Message: ${action.params.text || action.params.message}`);
          break;
        }
        default:
          results.push(`Unknown action type: ${action.type}`);
      }
    } catch (e: any) {
      results.push(`Action ${action.type} failed: ${e.message}`);
    }
  }
  return results;
}

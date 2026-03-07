import { execSync, spawn } from 'child_process';
import { readFileSync, writeFileSync, realpathSync, unlinkSync, mkdirSync, existsSync } from 'fs';
import { resolve } from 'path';
import { createTransport } from 'nodemailer';
import type Anthropic from '@anthropic-ai/sdk';
import { config } from '../utils/config.js';
import { gitEnv, redactSecrets } from '../utils/git-auth.js';
import { saveMemory } from './memory.js';
import { db } from '../utils/db.js';
import { addCronJob } from '../cron/scheduler.js';
import { ingestUrl, ingestText, searchKnowledge, listDocs, deleteDoc } from './knowledge.js';
import { addWorkflow, listWorkflows, deleteWorkflow, toggleWorkflow, matchKeywordWorkflows, type WorkflowAction } from './workflows.js';

// --- Media side-channel: per-request to prevent cross-user leakage ---
const pendingMediaMap = new Map<string, Array<{ type: 'image' | 'voice'; data: Buffer }>>();
let currentRequestId = 'default';

export function setCurrentRequestId(id: string) { currentRequestId = id; }

function addPendingMedia(item: { type: 'image' | 'voice'; data: Buffer }) {
  if (!pendingMediaMap.has(currentRequestId)) pendingMediaMap.set(currentRequestId, []);
  pendingMediaMap.get(currentRequestId)!.push(item);
}

export function collectMedia(requestId?: string): Array<{ type: 'image' | 'voice'; data: Buffer }> {
  const id = requestId || currentRequestId;
  const media = pendingMediaMap.get(id) || [];
  pendingMediaMap.delete(id);
  return media;
}

// Shell: no restrictions — runs only on local Mac via LOCAL_ONLY_TOOLS

// --- Security: file path restrictions ---
const ALLOWED_FILE_DIRS = ['/Users/oakhome/קלוד עבודות/', '/tmp/alonbot-', '/app/workspace/', '/tmp/'];
// Only block sensitive config files — git operations go through shell tool anyway
const BLOCKED_FILE_PATTERNS = ['.env', '.ssh/', 'credentials', '.zshrc', '.bashrc'];

function isPathAllowed(filePath: string): boolean {
  const resolved = resolve(filePath);
  if (BLOCKED_FILE_PATTERNS.some(p => resolved.includes(p))) return false;
  // Use realpathSync to follow symlinks and prevent symlink escape
  try {
    const real = realpathSync(resolved);
    return ALLOWED_FILE_DIRS.some(d => real.startsWith(d));
  } catch {
    // File doesn't exist yet (write_file) — check resolved path
    return ALLOWED_FILE_DIRS.some(d => resolved.startsWith(d));
  }
}

// --- Security: URL validation for SSRF prevention ---
function isUrlAllowed(url: string): boolean {
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
const ALLOWED_EMAIL_DOMAINS = ['dprisha.co.il', 'gmail.com'];
const ALLOWED_EMAIL_ADDRESSES = ['alon12@gmail.com', 'dekel@dprisha.co.il', 'alonr@dprisha.co.il', 'servicedprisha@gmail.com'];

function isEmailAllowed(to: string): boolean {
  const email = to.trim().toLowerCase();
  if (ALLOWED_EMAIL_ADDRESSES.includes(email)) return true;
  const domain = email.split('@')[1];
  return ALLOWED_EMAIL_DOMAINS.includes(domain);
}

// --- Local-only tools (proxied to Mac in cloud mode) ---
// shell, read_file, write_file work in both modes (cloud has /app/workspace/)
const LOCAL_ONLY_TOOLS = ['screenshot', 'manage_project', 'send_file'];

const allToolDefinitions: Anthropic.Tool[] = [
  { name: 'shell', description: 'Run any shell command on Mac (pipes, chaining, curl — all allowed)', input_schema: { type: 'object' as const, properties: { command: { type: 'string' } }, required: ['command'] } },
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
  { name: 'schedule_message', description: 'Schedule a one-time reminder/message at a specific Israel time ("YYYY-MM-DD HH:mm"). Use for "remind me in X minutes/hours" or "remind me at HH:mm". Calculate the target time based on current Israel time.', input_schema: { type: 'object' as const, properties: { message: { type: 'string', description: 'Message to send' }, send_at: { type: 'string', description: 'Israel time to send (e.g. "2026-03-07 09:00")' }, label: { type: 'string', description: 'Short label for this scheduled message' } }, required: ['message', 'send_at'] } },
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
  // GitHub
  {
    name: 'create_github_repo',
    description: 'Create a new GitHub repo, optionally push local code from workspace. Uses GITHUB_TOKEN.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Repo name (e.g. "my-cool-app")' },
        description: { type: 'string', description: 'Repo description' },
        private: { type: 'boolean', description: 'Private repo? (default: false)' },
        push_dir: { type: 'string', description: 'Optional: local dir to push (e.g. "/app/workspace/my-app")' },
      },
      required: ['name'],
    },
  },
  // Deploy
  {
    name: 'deploy_app',
    description: 'Deploy an app to Vercel (static/serverless) or Railway (Docker/Node). Pushes code and triggers deploy.',
    input_schema: {
      type: 'object' as const,
      properties: {
        platform: { type: 'string', enum: ['vercel', 'railway'], description: 'Deploy target' },
        project_dir: { type: 'string', description: 'Local dir with the code (e.g. "/app/workspace/my-app")' },
        project_name: { type: 'string', description: 'Project name on the platform' },
      },
      required: ['platform', 'project_dir'],
    },
  },
  // Cron Script
  {
    name: 'cron_script',
    description: 'Schedule a script to run periodically in the cloud. The script runs as a shell command on cron schedule.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Script name' },
        cron_expr: { type: 'string', description: 'Cron expression (e.g. "0 */6 * * *" = every 6 hours)' },
        script: { type: 'string', description: 'Shell command or script to run' },
        notify: { type: 'boolean', description: 'Send output to Telegram? (default: true)' },
      },
      required: ['name', 'cron_expr', 'script'],
    },
  },
  // Auto-improve — bot modifies its own code
  {
    name: 'auto_improve',
    description: 'Read and modify AlonBot source code. Use to add features, fix bugs, or improve yourself. Changes take effect after next deploy.',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['read', 'edit', 'list'], description: 'read: read a source file, edit: modify a file, list: list source files' },
        file: { type: 'string', description: 'File path relative to project root (e.g. "src/agent/tools.ts")' },
        search: { type: 'string', description: 'For edit: exact text to find and replace' },
        replace: { type: 'string', description: 'For edit: replacement text' },
      },
      required: ['action'],
    },
  },
  // Build website — full site from prompt to live URL
  {
    name: 'build_website',
    description: 'Build a complete website from a description, push to GitHub, and deploy to Vercel. Returns live URL.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Project name (used for repo + URL, e.g. "pizza-shop")' },
        description: { type: 'string', description: 'What the website should be — detailed description' },
        html: { type: 'string', description: 'Full HTML content for index.html' },
        css: { type: 'string', description: 'Optional CSS (if not inline in HTML)' },
        js: { type: 'string', description: 'Optional JavaScript (if not inline in HTML)' },
      },
      required: ['name', 'description', 'html'],
    },
  },
  // Scrape site — crawl entire website
  {
    name: 'scrape_site',
    description: 'Crawl an entire website (up to 20 pages). Returns text content from all pages. Great for competitor research.',
    input_schema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'Starting URL to crawl' },
        max_pages: { type: 'number', description: 'Max pages to crawl (default 10, max 20)' },
      },
      required: ['url'],
    },
  },
  // Code Agent — Claude Code CLI as sub-agent
  {
    name: 'code_agent',
    description: 'Launch Claude Code to build a real project with full dev loop (write, run, debug, fix, iterate). Use for programming tasks that need quality code.',
    input_schema: {
      type: 'object' as const,
      properties: {
        task: { type: 'string', description: 'Detailed description of what to build' },
        working_dir: { type: 'string', description: 'Working directory name (default: auto-generated from task)' },
        max_budget: { type: 'number', description: 'Max USD to spend (default: 2)' },
        model: { type: 'string', enum: ['sonnet', 'opus'], description: 'Model (default: sonnet)' },
      },
      required: ['task'],
    },
  },
  // Google Calendar
  { name: 'calendar_list', description: 'List upcoming calendar events (next 7 days)', input_schema: { type: 'object' as const, properties: { days: { type: 'number', description: 'Number of days to look ahead (default 7)' } } } },
  { name: 'calendar_add', description: 'Add a new event to Google Calendar', input_schema: { type: 'object' as const, properties: { title: { type: 'string' }, date: { type: 'string', description: 'YYYY-MM-DD' }, time: { type: 'string', description: 'HH:mm (24h format)' }, duration_minutes: { type: 'number', description: 'Duration in minutes (default 60)' }, description: { type: 'string' } }, required: ['title', 'date'] } },
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
        addPendingMedia({ type: m.type as any, data: Buffer.from(m.data, 'base64') });
      }
    }
    return proxy.result;
  }

  switch (name) {
    case 'shell': {
      try {
        const output = execSync(input.command, { shell: '/bin/zsh', timeout: 30000, encoding: 'utf-8', maxBuffer: 1_000_000 }).trim();
        return redactSecrets(output);
      } catch (e: any) {
        return `Error: ${redactSecrets((e.stderr || e.message || '').slice(0, 1000))}`;
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
            addPendingMedia({ type: 'image', data: buf });
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
        addPendingMedia({ type: 'voice', data: buf });
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
        try { unlinkSync(tmpPath); } catch {}
        addPendingMedia({ type: 'image', data: buf });
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
      const where = periods[input.period];
      if (!where) return `Invalid period. Use: today, week, month, all`;
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
          addPendingMedia({ type: 'image', data: buf });
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
      if (!isUrlAllowed(input.url)) return 'Error: URL not allowed (private/internal addresses blocked).';
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

    // --- Google Calendar ---
    case 'calendar_list': {
      if (!config.googleCalendarScriptUrl) return 'Error: Google Calendar not configured. Set GOOGLE_CALENDAR_SCRIPT_URL env var.';
      try {
        const days = input.days || 7;
        const res = await fetch(`${config.googleCalendarScriptUrl}?action=list&days=${days}`, {
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) return `Error: Calendar API returned ${res.status}`;
        const data = await res.json() as any;
        if (!data.events || data.events.length === 0) return `אין אירועים בקלנדר ב-${days} הימים הקרובים.`;
        return data.events.map((e: any, i: number) =>
          `${i + 1}. ${e.title} — ${e.date}${e.time ? ' ' + e.time : ''} ${e.description ? '(' + e.description + ')' : ''}`
        ).join('\n');
      } catch (e: any) {
        return `Error: Calendar request failed.`;
      }
    }

    case 'calendar_add': {
      if (!config.googleCalendarScriptUrl) return 'Error: Google Calendar not configured. Set GOOGLE_CALENDAR_SCRIPT_URL env var.';
      try {
        const res = await fetch(config.googleCalendarScriptUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'add',
            title: input.title,
            date: input.date,
            time: input.time || null,
            duration_minutes: input.duration_minutes || 60,
            description: input.description || '',
          }),
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) return `Error: Calendar API returned ${res.status}`;
        const data = await res.json() as any;
        return data.success ? `אירוע נוצר: "${input.title}" ב-${input.date}${input.time ? ' ' + input.time : ''}` : `Error: ${data.error || 'Unknown'}`;
      } catch (e: any) {
        return `Error: Calendar request failed.`;
      }
    }

    // --- GitHub ---
    case 'create_github_repo': {
      const token = process.env.GITHUB_TOKEN;
      if (!token) return 'Error: GITHUB_TOKEN not configured.';
      try {
        // Create repo via GitHub API
        const res = await fetch('https://api.github.com/user/repos', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Accept': 'application/vnd.github+json',
          },
          body: JSON.stringify({
            name: input.name,
            description: input.description || '',
            private: input.private || false,
            auto_init: !input.push_dir,
          }),
        });
        const data = await res.json() as any;
        if (!res.ok) return `Error: GitHub API ${res.status} — ${data.message || JSON.stringify(data.errors)}`;
        const repoUrl = data.html_url;
        const cloneUrl = data.clone_url;

        // If push_dir specified, init and push
        if (input.push_dir) {
          const dir = input.push_dir;
          const pushUrl = cloneUrl.replace('https://', `https://${token}@`);
          execSync(`cd "${dir}" && git init && git add -A && git commit -m "Initial commit" && git branch -M main && git remote add origin "${pushUrl}" && git push -u origin main`, {
            shell: '/bin/bash',
            timeout: 30000,
            encoding: 'utf-8',
          });
          return `Repo created and code pushed!\n${repoUrl}`;
        }

        return `Repo created: ${repoUrl}`;
      } catch (e: any) {
        return `Error: ${(e.stderr || e.message || '').slice(0, 500)}`;
      }
    }

    // --- Deploy ---
    case 'deploy_app': {
      const token = process.env.GITHUB_TOKEN;
      if (!token) return 'Error: GITHUB_TOKEN not configured (needed for git push).';
      const dir = input.project_dir;
      const projectName = input.project_name || dir.split('/').pop() || 'app';

      try {
        if (input.platform === 'vercel') {
          // Push to GitHub first, then use Vercel deploy hook or CLI
          // Check if repo exists, if not create it
          const checkRes = await fetch(`https://api.github.com/repos/alonr-create/${projectName}`, {
            headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json' },
          });

          if (checkRes.status === 404) {
            // Create repo
            await fetch('https://api.github.com/user/repos', {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Accept': 'application/vnd.github+json' },
              body: JSON.stringify({ name: projectName, private: false }),
            });
          }

          const pushUrl = `https://github.com/alonr-create/${projectName}.git`;
          execSync(`cd "${dir}" && git init && git add -A && git commit -m "Deploy" --allow-empty && git branch -M main && git remote remove origin 2>/dev/null; git remote add origin "${pushUrl}" && git push -u origin main --force`, {
            shell: '/bin/bash', timeout: 30000, encoding: 'utf-8',
            env: gitEnv(),
          });
          return `Code pushed to github.com/alonr-create/${projectName}\nConnect this repo to Vercel at https://vercel.com/new to deploy.\nIf already connected, deploy will start automatically.`;

        } else if (input.platform === 'railway') {
          // Same pattern — push to GitHub, Railway auto-deploys
          const checkRes = await fetch(`https://api.github.com/repos/alonr-create/${projectName}`, {
            headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json' },
          });

          if (checkRes.status === 404) {
            await fetch('https://api.github.com/user/repos', {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Accept': 'application/vnd.github+json' },
              body: JSON.stringify({ name: projectName, private: false }),
            });
          }

          const pushUrl = `https://github.com/alonr-create/${projectName}.git`;
          execSync(`cd "${dir}" && git init && git add -A && git commit -m "Deploy" --allow-empty && git branch -M main && git remote remove origin 2>/dev/null; git remote add origin "${pushUrl}" && git push -u origin main --force`, {
            shell: '/bin/bash', timeout: 30000, encoding: 'utf-8',
            env: gitEnv(),
          });
          return `Code pushed to github.com/alonr-create/${projectName}\nConnect this repo to Railway at https://railway.com/new to deploy.\nIf already connected, deploy will start automatically.`;

        } else {
          return `Error: Unknown platform "${input.platform}". Use "vercel" or "railway".`;
        }
      } catch (e: any) {
        return `Error: ${redactSecrets((e.stderr || e.message || '').slice(0, 500))}`;
      }
    }

    // --- Cron Script ---
    case 'cron_script': {
      try {
        // Store the script as a cron job — reuse cron_jobs table with script type
        const notify = input.notify !== false;
        const targetId = config.allowedTelegram[0] || '';
        const message = JSON.stringify({ type: 'script', script: input.script, notify });
        const id = addCronJob(input.name, input.cron_expr, 'telegram', targetId, message);
        return `Cron script #${id} created: "${input.name}" — ${input.cron_expr}\nScript: ${input.script}\nNotify: ${notify ? 'yes' : 'no'}`;
      } catch (e: any) {
        return `Error: ${e.message}`;
      }
    }

    // --- Auto-improve ---
    case 'auto_improve': {
      const projectRoot = config.mode === 'cloud' ? '/app' : process.cwd();
      switch (input.action) {
        case 'list': {
          try {
            const output = execSync(`find src -name "*.ts" | sort`, {
              cwd: projectRoot, encoding: 'utf-8', timeout: 5000,
            }).trim();
            return output || 'No source files found.';
          } catch (e: any) {
            return `Error: ${e.message}`;
          }
        }
        case 'read': {
          if (!input.file) return 'Error: file parameter required.';
          try {
            const filePath = resolve(projectRoot, input.file);
            return readFileSync(filePath, 'utf-8').slice(0, 15000);
          } catch (e: any) {
            return `Error: ${e.message}`;
          }
        }
        case 'edit': {
          if (!input.file || !input.search || !input.replace) return 'Error: file, search, and replace parameters required.';
          try {
            const filePath = resolve(projectRoot, input.file);
            const content = readFileSync(filePath, 'utf-8');
            if (!content.includes(input.search)) return 'Error: search text not found in file.';
            const newContent = content.replace(input.search, input.replace);
            writeFileSync(filePath, newContent);
            // Auto-commit and push if in cloud with git
            if (config.mode === 'cloud' && process.env.GITHUB_TOKEN) {
              try {
                const token = process.env.GITHUB_TOKEN;
                execSync(`cd "${projectRoot}" && git add "${input.file}" && git commit -m "Auto-improve: ${input.file}" && git push https://github.com/alonr-create/alonbot.git main`, {
                  shell: '/bin/bash', timeout: 30000, encoding: 'utf-8',
                  env: gitEnv(),
                });
                return `File edited and pushed to GitHub. Will auto-deploy shortly.\nChanged in ${input.file}: "${input.search.slice(0, 50)}..." → "${input.replace.slice(0, 50)}..."`;
              } catch (gitErr: any) {
                return `File edited locally but git push failed: ${redactSecrets((gitErr.stderr || gitErr.message || '').slice(0, 200))}\nChange saved in: ${input.file}`;
              }
            }
            return `File edited: ${input.file}\nChanged: "${input.search.slice(0, 50)}..." → "${input.replace.slice(0, 50)}..."`;
          } catch (e: any) {
            return `Error: ${e.message}`;
          }
        }
        default:
          return 'Error: action must be "list", "read", or "edit".';
      }
    }

    // --- Build Website ---
    case 'build_website': {
      const token = process.env.GITHUB_TOKEN;
      if (!token) return 'Error: GITHUB_TOKEN not configured.';
      const siteName = input.name.replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase();
      const siteDir = `/app/workspace/${siteName}`;

      try {
        // Create project directory
        execSync(`mkdir -p "${siteDir}"`, { shell: '/bin/bash' });

        // Write HTML
        writeFileSync(`${siteDir}/index.html`, input.html);
        if (input.css) writeFileSync(`${siteDir}/style.css`, input.css);
        if (input.js) writeFileSync(`${siteDir}/script.js`, input.js);

        // Create/push to GitHub
        const pushUrl = `https://github.com/alonr-create/${siteName}.git`;

        // Check if repo exists
        const checkRes = await fetch(`https://api.github.com/repos/alonr-create/${siteName}`, {
          headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json' },
        });

        if (checkRes.status === 404) {
          await fetch('https://api.github.com/user/repos', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Accept': 'application/vnd.github+json' },
            body: JSON.stringify({ name: siteName, description: input.description, private: false }),
          });
        }

        execSync(`cd "${siteDir}" && git init && git add -A && git commit -m "Build website: ${input.description.slice(0, 50)}" && git branch -M main && git remote remove origin 2>/dev/null; git remote add origin "${pushUrl}" && git push -u origin main --force`, {
          shell: '/bin/bash', timeout: 30000, encoding: 'utf-8',
          env: gitEnv(),
        });

        return `Website built and pushed!\n\nGitHub: https://github.com/alonr-create/${siteName}\n\nTo deploy:\n• Vercel: https://vercel.com/new → import ${siteName}\n• Or connect at vercel.com for auto-deploy\n\nExpected URL: https://${siteName}.vercel.app`;
      } catch (e: any) {
        return `Error: ${redactSecrets((e.stderr || e.message || '').slice(0, 500))}`;
      }
    }

    // --- Scrape Site ---
    case 'scrape_site': {
      if (!isUrlAllowed(input.url)) return 'Error: URL not allowed.';
      const maxPages = Math.min(input.max_pages || 10, 20);
      const visited = new Set<string>();
      const results: string[] = [];

      try {
        const baseUrl = new URL(input.url);
        const queue = [input.url];

        while (queue.length > 0 && visited.size < maxPages) {
          const currentUrl = queue.shift()!;
          if (visited.has(currentUrl)) continue;
          visited.add(currentUrl);

          try {
            const res = await fetch(currentUrl, {
              headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AlonBot/1.0)' },
              signal: AbortSignal.timeout(8000),
            });
            if (!res.ok) continue;
            const html = await res.text();

            // Extract text
            const text = html
              .replace(/<script[\s\S]*?<\/script>/gi, '')
              .replace(/<style[\s\S]*?<\/style>/gi, '')
              .replace(/<[^>]+>/g, ' ')
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, 3000);

            results.push(`=== ${currentUrl} ===\n${text}`);

            // Extract same-domain links
            const linkRegex = /href="([^"]+)"/gi;
            let linkMatch;
            while ((linkMatch = linkRegex.exec(html)) && queue.length < maxPages * 2) {
              try {
                const href = new URL(linkMatch[1], currentUrl);
                if (href.hostname === baseUrl.hostname && !visited.has(href.toString()) && !href.hash) {
                  queue.push(href.toString());
                }
              } catch {}
            }
          } catch {
            // Skip failed pages
          }
        }

        if (results.length === 0) return 'Error: Could not fetch any pages.';
        return `Scraped ${results.length} pages from ${baseUrl.hostname}:\n\n${results.join('\n\n').slice(0, 15000)}`;
      } catch (e: any) {
        return `Error: ${e.message}`;
      }
    }

    // --- Code Agent (Claude Code CLI) ---
    case 'code_agent': {
      const task = input.task;
      const maxBudget = input.max_budget || 2;
      const model = input.model || 'sonnet';
      const dirName = input.working_dir || task.slice(0, 30).replace(/[^a-zA-Z0-9א-ת\s-]/g, '').replace(/\s+/g, '-').toLowerCase() || 'project';
      const workDir = `/app/workspace/${dirName}`;

      // Create working directory
      if (!existsSync(workDir)) mkdirSync(workDir, { recursive: true });

      return new Promise<string>((resolveResult) => {
        const args = [
          '-p', task,
          '--output-format', 'stream-json',
          '--max-budget-usd', String(maxBudget),
          '--model', model,
          '--permission-mode', 'bypassPermissions',
          '--no-session-persistence',
        ];

        console.log(`[CodeAgent] Starting in ${workDir}: ${task.slice(0, 80)}`);

        const child = spawn('claude', args, {
          cwd: workDir,
          env: { ...process.env, ANTHROPIC_API_KEY: config.anthropicApiKey },
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 300000, // 5 minutes
        });

        let output = '';
        let lastResult = '';
        const toolActions: string[] = [];
        let totalCost = 0;

        child.stdout.on('data', (chunk: Buffer) => {
          const lines = chunk.toString().split('\n').filter(Boolean);
          for (const line of lines) {
            try {
              const event = JSON.parse(line);

              // Track tool usage for progress
              if (event.type === 'assistant' && event.message?.content) {
                for (const block of event.message.content) {
                  if (block.type === 'tool_use') {
                    const toolInfo = block.name === 'Write' ? `Write: ${(block.input as any)?.file_path || ''}` :
                                     block.name === 'Edit' ? `Edit: ${(block.input as any)?.file_path || ''}` :
                                     block.name === 'Bash' ? `Run: ${((block.input as any)?.command || '').slice(0, 60)}` :
                                     block.name;
                    toolActions.push(toolInfo);
                    console.log(`[CodeAgent] ${toolInfo}`);
                  }
                  if (block.type === 'text') {
                    lastResult = block.text;
                  }
                }
              }

              // Track result
              if (event.type === 'result') {
                lastResult = typeof event.result === 'string' ? event.result : JSON.stringify(event.result);
                if (event.cost_usd) totalCost = event.cost_usd;
              }
            } catch {
              // Non-JSON line, skip
            }
          }
        });

        child.stderr.on('data', (chunk: Buffer) => {
          output += chunk.toString();
        });

        child.on('close', (code) => {
          console.log(`[CodeAgent] Finished (exit ${code}), ${toolActions.length} tool calls, $${totalCost.toFixed(2)}`);

          // List files created
          let fileList = '';
          try {
            fileList = execSync(`find . -type f -not -path './.git/*' | head -30`, {
              cwd: workDir, encoding: 'utf-8', timeout: 5000,
            }).trim();
          } catch {}

          const summary = [
            `Claude Code finished (${model}, $${totalCost.toFixed(2)})`,
            '',
            `Actions (${toolActions.length}):`,
            ...toolActions.slice(-15).map(a => `  ${a}`),
            '',
            fileList ? `Files in ${workDir}:\n${fileList}` : 'No files created.',
            '',
            lastResult ? `Summary:\n${lastResult.slice(0, 2000)}` : '',
          ].join('\n');

          resolveResult(summary);
        });

        child.on('error', (err) => {
          console.error(`[CodeAgent] Error:`, err.message);
          resolveResult(`Error: Claude Code failed to start — ${err.message}\nMake sure @anthropic-ai/claude-code is installed globally.`);
        });

        // Safety timeout
        setTimeout(() => {
          try { child.kill(); } catch {}
          resolveResult('Error: Claude Code timed out after 5 minutes.');
        }, 300000);
      });
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

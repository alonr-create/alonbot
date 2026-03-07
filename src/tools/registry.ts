import type Anthropic from '@anthropic-ai/sdk';
import type { ToolHandler, ToolContext } from './types.js';
import { readdirSync } from 'fs';
import { pathToFileURL } from 'url';
import { join } from 'path';
import { z } from 'zod';
import { config } from '../utils/config.js';
import { addPendingMedia } from './media.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('registry');

const handlers = new Map<string, ToolHandler>();

/** Auto-discover and load all tool handlers from handlers/ directory */
export async function loadTools(): Promise<void> {
  const handlersDir = join(import.meta.dirname, 'handlers');
  const files = readdirSync(handlersDir).filter(f => f.endsWith('.js'));

  for (const file of files) {
    const mod = await import(pathToFileURL(join(handlersDir, file)).href);
    const exported = mod.default;
    const tools: ToolHandler[] = Array.isArray(exported) ? exported : [exported];
    for (const tool of tools) {
      if (!tool.name || !tool.definition || !tool.execute) {
        log.warn({ file }, 'skipping invalid tool');
        continue;
      }
      handlers.set(tool.name, tool);
    }
  }

  log.info({ toolCount: handlers.size, fileCount: files.length }, 'tools loaded');
}

/** Get all tool definitions for Claude API */
export function getToolDefinitions(): Anthropic.Tool[] {
  return Array.from(handlers.values()).map(h => h.definition);
}

/** Get local-only tool names */
export function getLocalOnlyTools(): string[] {
  return Array.from(handlers.values())
    .filter(h => h.localOnly)
    .map(h => h.name);
}

/** Execute a tool by name */
export async function executeTool(
  name: string,
  input: Record<string, any>
): Promise<string> {
  const handler = handlers.get(name);
  if (!handler) return `Unknown tool: ${name}`;

  // Zod validation
  if (handler.schema) {
    const result = handler.schema.safeParse(input);
    if (!result.success) {
      const errors = result.error.issues
        .map((i: z.ZodIssue) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      return `Validation error: ${errors}`;
    }
    input = result.data;
  }

  // Proxy local-only tools in cloud mode
  if (config.mode === 'cloud' && handler.localOnly) {
    const proxy = await proxyToLocal(name, input);
    if (!proxy) return 'Error: Mac is offline. This tool requires the local Mac to be running.';
    if (proxy.media) {
      for (const m of proxy.media) {
        addPendingMedia({ type: m.type as any, data: Buffer.from(m.data, 'base64') });
      }
    }
    return proxy.result;
  }

  // Build context and execute
  const { db } = await import('../utils/db.js');
  const ctx: ToolContext = { config, db, addPendingMedia };
  return handler.execute(input, ctx);
}

/** Proxy tool execution to local Mac */
async function proxyToLocal(
  name: string,
  input: Record<string, any>
): Promise<{ result: string; media?: Array<{ type: string; data: string }> } | null> {
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

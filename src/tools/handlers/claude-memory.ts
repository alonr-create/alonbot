import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import type { ToolHandler } from '../types.js';

const CLAUDE_MEMORY_DIR = '/Users/oakhome/.claude/projects/-Users-oakhome------------/memory';

interface MemoryFile {
  filename: string;
  name: string;
  description: string;
  type: string;
  importance: number;
  body: string;
}

function parseMemoryFile(filepath: string): MemoryFile | null {
  try {
    const content = readFileSync(filepath, 'utf-8');
    const meta: Partial<MemoryFile> = { filename: filepath.split('/').pop()! };

    if (content.startsWith('---')) {
      const parts = content.split('---');
      if (parts.length >= 3) {
        const yaml = parts[1].trim();
        const body = parts.slice(2).join('---').trim();
        for (const line of yaml.split('\n')) {
          const idx = line.indexOf(':');
          if (idx === -1) continue;
          const key = line.slice(0, idx).trim();
          const val = line.slice(idx + 1).trim();
          if (key === 'name') meta.name = val;
          if (key === 'description') meta.description = val;
          if (key === 'type') meta.type = val;
          if (key === 'importance') meta.importance = parseInt(val) || 5;
        }
        meta.body = body;
      }
    }

    return {
      filename: meta.filename!,
      name: meta.name || meta.filename!,
      description: meta.description || '',
      type: meta.type || 'unknown',
      importance: meta.importance || 5,
      body: meta.body || content,
    };
  } catch {
    return null;
  }
}

function searchMemories(query: string): MemoryFile[] {
  const files = readdirSync(CLAUDE_MEMORY_DIR).filter(f => f.endsWith('.md') && f !== 'MEMORY.md');
  const queryLower = query.toLowerCase();
  const queryWords = queryLower.split(/\s+/).filter(w => w.length > 2);

  const results: { file: MemoryFile; score: number }[] = [];

  for (const f of files) {
    const mem = parseMemoryFile(join(CLAUDE_MEMORY_DIR, f));
    if (!mem) continue;

    // Keyword matching score
    const searchText = `${mem.name} ${mem.description} ${mem.body}`.toLowerCase();
    let score = 0;
    for (const word of queryWords) {
      if (searchText.includes(word)) score += 1;
    }
    // Boost by importance
    score += mem.importance / 10;
    // Boost exact phrase match
    if (searchText.includes(queryLower)) score += 3;

    if (score > 0.5) {
      results.push({ file: mem, score });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, 5).map(r => r.file);
}

const handlers: ToolHandler[] = [
  {
    name: 'search_claude_memory',
    definition: {
      name: 'search_claude_memory',
      description:
        'Search Claude Code shared memory — contains project docs, feedback, preferences, SOPs, and operational knowledge. Use when you need context about projects, past decisions, or user preferences that might be stored in the shared memory system.',
      input_schema: {
        type: 'object' as const,
        properties: {
          query: {
            type: 'string',
            description: 'Search query — can be Hebrew or English',
          },
        },
        required: ['query'],
      },
    },
    async execute(input) {
      try {
        const results = searchMemories(input.query);
        if (results.length === 0) {
          return `No matching memories found for "${input.query}"`;
        }

        let output = `Found ${results.length} relevant memories:\n\n`;
        for (const mem of results) {
          const bodyPreview = mem.body.slice(0, 300).replace(/\n/g, ' ');
          output += `📄 **${mem.name}** (${mem.type}, importance: ${mem.importance})\n`;
          output += `   ${mem.description}\n`;
          output += `   ${bodyPreview}${mem.body.length > 300 ? '...' : ''}\n\n`;
        }
        return output;
      } catch (e: any) {
        return `Error searching Claude memory: ${e.message}`;
      }
    },
  },
  {
    name: 'read_claude_memory',
    definition: {
      name: 'read_claude_memory',
      description: 'Read a specific Claude Code memory file by filename. Use after search_claude_memory to get full content.',
      input_schema: {
        type: 'object' as const,
        properties: {
          filename: {
            type: 'string',
            description: 'Memory filename (e.g. "voice-agent.md", "feedback_elevenlabs_model.md")',
          },
        },
        required: ['filename'],
      },
    },
    async execute(input) {
      try {
        const filepath = join(CLAUDE_MEMORY_DIR, input.filename);
        const mem = parseMemoryFile(filepath);
        if (!mem) return `Memory file "${input.filename}" not found`;

        return `📄 **${mem.name}** (${mem.type}, importance: ${mem.importance})\n${mem.description}\n\n${mem.body}`;
      } catch (e: any) {
        return `Error: ${e.message}`;
      }
    },
  },
  {
    name: 'list_claude_memories',
    definition: {
      name: 'list_claude_memories',
      description: 'List all Claude Code memory files grouped by type. Shows what shared knowledge is available.',
      input_schema: {
        type: 'object' as const,
        properties: {},
      },
    },
    async execute() {
      try {
        const files = readdirSync(CLAUDE_MEMORY_DIR).filter(f => f.endsWith('.md') && f !== 'MEMORY.md');
        const grouped: Record<string, MemoryFile[]> = {};

        for (const f of files) {
          const mem = parseMemoryFile(join(CLAUDE_MEMORY_DIR, f));
          if (!mem) continue;
          const type = mem.type || 'other';
          if (!grouped[type]) grouped[type] = [];
          grouped[type].push(mem);
        }

        let output = `Claude Code Memory — ${files.length} files:\n\n`;
        for (const [type, mems] of Object.entries(grouped)) {
          output += `**${type}** (${mems.length}):\n`;
          for (const m of mems.sort((a, b) => b.importance - a.importance)) {
            output += `  • ${m.filename} — ${m.name} (imp: ${m.importance})\n`;
          }
          output += '\n';
        }
        return output;
      } catch (e: any) {
        return `Error: ${e.message}`;
      }
    },
  },
];

export default handlers;

import { z } from 'zod';
import { readFileSync, writeFileSync } from 'fs';
import { isPathAllowed } from '../../utils/security.js';
import type { ToolHandler } from '../types.js';

const writeFileSchema = z.object({
  path: z.string().min(1).max(500),
  content: z.string().max(500_000),
});

const handlers: ToolHandler[] = [
  {
    name: 'read_file',
    definition: {
      name: 'read_file',
      description: 'Read file from project dir',
      input_schema: {
        type: 'object' as const,
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
    async execute(input) {
      if (!isPathAllowed(input.path)) {
        return 'Error: Access denied. Can only read files under project directories.';
      }
      try {
        return readFileSync(input.path, 'utf-8').slice(0, 10000);
      } catch (e: any) {
        return `Error: File not found or unreadable.`;
      }
    },
  },
  {
    name: 'write_file',
    definition: {
      name: 'write_file',
      description: 'Write file to project dir',
      input_schema: {
        type: 'object' as const,
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
    },
    schema: writeFileSchema,
    async execute(input) {
      if (!isPathAllowed(input.path)) {
        return 'Error: Access denied. Can only write files under project directories.';
      }
      try {
        writeFileSync(input.path, input.content);
        return `File written: ${input.path}`;
      } catch (e: any) {
        return `Error: Could not write file.`;
      }
    },
  },
  {
    name: 'send_file',
    definition: {
      name: 'send_file',
      description: 'Send file from Mac to user',
      input_schema: {
        type: 'object' as const,
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
    localOnly: true,
    async execute(input, ctx) {
      if (!isPathAllowed(input.path)) return 'Error: Access denied.';
      try {
        const buf = readFileSync(input.path);
        const ext = input.path.split('.').pop()?.toLowerCase();
        if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext || '')) {
          ctx.addPendingMedia({ type: 'image', data: buf });
        } else {
          // For non-image files, send as text if small enough
          const text = buf.toString('utf-8').slice(0, 10000);
          return `File content (${input.path}):\n${text}`;
        }
        return `File sent: ${input.path}`;
      } catch {
        return 'Error: File not found.';
      }
    },
  },
];

export default handlers;

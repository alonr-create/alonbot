import { readFileSync, existsSync } from 'fs';
import { basename, extname } from 'path';
import type { ToolHandler } from '../types.js';

const MIME_MAP: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

const handler: ToolHandler = {
  name: 'send_file',
  definition: {
    name: 'send_file',
    description: 'Send a file to the user. Can send from a local path or from raw content (e.g. HTML you just generated).',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Local file path to send (e.g. "/tmp/report.html")' },
        content: { type: 'string', description: 'Raw file content to send (alternative to path)' },
        filename: { type: 'string', description: 'Filename for the recipient (e.g. "report.html")' },
      },
      required: ['filename'],
    },
  },
  async execute(input, ctx) {
    const filename = input.filename;
    const ext = extname(filename).toLowerCase();
    const mimetype = MIME_MAP[ext] || 'application/octet-stream';

    let data: Buffer;

    if (input.content) {
      data = Buffer.from(input.content, 'utf-8');
    } else if (input.path) {
      if (!existsSync(input.path)) {
        return `Error: File not found: ${input.path}`;
      }
      data = readFileSync(input.path);
    } else {
      return 'Error: Provide either path or content.';
    }

    if (data.length > 15 * 1024 * 1024) {
      return 'Error: File too large (max 15MB).';
    }

    ctx.addPendingMedia({ type: 'document', data, filename, mimetype });
    return `File "${filename}" sent (${(data.length / 1024).toFixed(1)} KB).`;
  },
};

export default handler;

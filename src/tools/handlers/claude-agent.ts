import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { execFile } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { extname, resolve } from 'path';

const WORKSPACE = '/Users/oakhome/קלוד עבודות';

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

const schema = z.object({
  prompt: z.string().min(1).max(5000),
  project: z.string().optional(),
});

const handler: ToolHandler = {
  name: 'claude_agent',
  localOnly: true,
  definition: {
    name: 'claude_agent',
    description: `Run Claude Code agent on the local Mac — full access to ~/קלוד עבודות/.
Can read/write files, run scripts, deploy, manage projects.
The agent is sandboxed to the workspace directory.
Has access to Monday.com MCP server for direct board queries.
Use 'project' to scope to a specific project folder (e.g. "דקל לפרישה", "alonbot", "voice-agent").
Examples:
- "בדוק את סטטוס הקמפיינים בפייסבוק" (project: "דקל לפרישה")
- "הרץ CAPI sync" (project: "דקל לפרישה")
- "בדוק את הלוגים של voice-agent" (project: "voice-agent")
- "תעדכן את הגרסה של alonbot" (project: "alonbot")
- "מה המצב של כל הפרויקטים"
- "תראה לי את הלידים החדשים מהיום במאנדיי"`,
    input_schema: {
      type: 'object' as const,
      properties: {
        prompt: {
          type: 'string',
          description: 'What to ask the agent to do',
        },
        project: {
          type: 'string',
          description: 'Project folder name within קלוד עבודות (optional, default: root)',
        },
      },
      required: ['prompt'],
    },
  },
  schema,

  async execute(input, ctx) {
    const { prompt, project } = input;

    // Resolve working directory — always within workspace
    let cwd = WORKSPACE;
    if (project) {
      // Prevent path traversal
      const safe = project.replace(/\.\./g, '').replace(/\//g, '');
      cwd = `${WORKSPACE}/${safe}`;
    }

    try {
      const result = await new Promise<string>((resolve, reject) => {
        const proc = execFile(
          'claude',
          [
            '-p', prompt,
            '--output-format', 'text',
            '--max-turns', '15',
            '--allowedTools', 'Read,Glob,Grep,Bash,Write,Edit,mcp__monday__*',
          ],
          {
            cwd,
            timeout: 300000, // 5 minutes
            maxBuffer: 2 * 1024 * 1024,
            env: {
              ...process.env,
              HOME: process.env.HOME,
              PATH: process.env.PATH,
            },
          },
          (err, stdout, stderr) => {
            if (err && !stdout) {
              reject(new Error(stderr || err.message));
            } else {
              resolve(stdout || stderr || 'Agent completed with no output.');
            }
          }
        );
      });

      // Detect file paths in output and send images back via media
      const filePathRegex = /(?:created|wrote|saved|generated|output)[:\s]+([^\n]+\.(?:png|jpg|jpeg|gif|webp))/gi;
      let match;
      while ((match = filePathRegex.exec(result)) !== null) {
        let filePath = match[1].trim().replace(/[`'"]/g, '');
        // Resolve relative paths against cwd
        if (!filePath.startsWith('/')) filePath = resolve(cwd, filePath);
        // Only send files within workspace
        if (filePath.startsWith(WORKSPACE) && existsSync(filePath)) {
          const ext = extname(filePath).toLowerCase();
          if (IMAGE_EXTS.has(ext)) {
            try {
              const buf = readFileSync(filePath);
              if (buf.length < 10 * 1024 * 1024) { // max 10MB
                ctx.addPendingMedia({ type: 'image', data: buf });
              }
            } catch { /* skip unreadable files */ }
          }
        }
      }

      // Trim to last 4000 chars to fit tool result limits
      return result.length > 4000 ? '...' + result.slice(-4000) : result;
    } catch (e: any) {
      return `Agent error: ${e.message}`.slice(0, 2000);
    }
  },
};

export default handler;

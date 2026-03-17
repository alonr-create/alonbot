import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { execFile } from 'child_process';

const WORKSPACE = '/Users/oakhome/קלוד עבודות';

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
Use 'project' to scope to a specific project folder (e.g. "דקל לפרישה", "alonbot", "voice-agent").
Examples:
- "בדוק את סטטוס הקמפיינים בפייסבוק" (project: "דקל לפרישה")
- "הרץ CAPI sync" (project: "דקל לפרישה")
- "בדוק את הלוגים של voice-agent" (project: "voice-agent")
- "תעדכן את הגרסה של alonbot" (project: "alonbot")
- "מה המצב של כל הפרויקטים"`,
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
            '--max-turns', '10',
            '--allowedTools', 'Read,Glob,Grep,Bash,Write,Edit',
          ],
          {
            cwd,
            timeout: 120000, // 2 minutes
            maxBuffer: 1024 * 1024,
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

      // Trim to last 4000 chars to fit tool result limits
      return result.length > 4000 ? '...' + result.slice(-4000) : result;
    } catch (e: any) {
      return `Agent error: ${e.message}`.slice(0, 2000);
    }
  },
};

export default handler;

import { execAsync } from '../../utils/shell.js';
import type { ToolHandler } from '../types.js';

const handler: ToolHandler = {
  name: 'manage_project',
  definition: {
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
  localOnly: true,
  async execute(input) {
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
      const output = await execAsync(cmd, { cwd: projectDir, timeout: 15000, maxBuffer: 50000 });
      return output || 'Clean — no changes.';
    } catch (e: any) {
      return `Error: Git command failed.`;
    }
  },
};

export default handler;

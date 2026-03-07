import { z } from 'zod';
import { redactSecrets } from '../../utils/git-auth.js';
import { ensureGitHubRepo, gitPushToRepo } from '../../utils/github.js';
import type { ToolHandler } from '../types.js';

const deployAppSchema = z.object({
  project_dir: z.string().min(1),
  project_name: z.string().regex(/^[a-zA-Z0-9-]+$/).max(100).optional(),
  platform: z.enum(['vercel', 'railway']),
});

const handler: ToolHandler = {
  name: 'deploy_app',
  definition: {
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
  schema: deployAppSchema,
  async execute(input) {
    const dir = input.project_dir;
    const projectName = input.project_name || dir.split('/').pop() || 'app';

    try {
      const { cloneUrl } = await ensureGitHubRepo(projectName);
      gitPushToRepo(dir, cloneUrl, 'Deploy');

      if (input.platform === 'vercel') {
        return `Code pushed to github.com/alonr-create/${projectName}\nConnect this repo to Vercel at https://vercel.com/new to deploy.\nIf already connected, deploy will start automatically.`;
      } else if (input.platform === 'railway') {
        return `Code pushed to github.com/alonr-create/${projectName}\nConnect this repo to Railway at https://railway.com/new to deploy.\nIf already connected, deploy will start automatically.`;
      } else {
        return `Error: Unknown platform "${input.platform}". Use "vercel" or "railway".`;
      }
    } catch (e: any) {
      return `Error: ${redactSecrets((e.stderr || e.message || '').slice(0, 500))}`;
    }
  },
};

export default handler;

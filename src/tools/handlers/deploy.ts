import { z } from 'zod';
import { execSync } from 'child_process';
import { gitEnv, redactSecrets } from '../../utils/git-auth.js';
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
  },
};

export default handler;

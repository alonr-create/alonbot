import { execSync } from 'child_process';
import { gitEnv, redactSecrets } from '../../utils/git-auth.js';
import type { ToolHandler } from '../types.js';

const handler: ToolHandler = {
  name: 'create_github_repo',
  definition: {
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
  async execute(input) {
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
        execSync(`cd "${dir}" && git init && git add -A && git commit -m "Initial commit" && git branch -M main && git remote add origin "${cloneUrl}" && git push -u origin main`, {
          shell: '/bin/bash',
          timeout: 30000,
          encoding: 'utf-8',
          env: gitEnv(),
        });
        return `Repo created and code pushed!\n${repoUrl}`;
      }

      return `Repo created: ${repoUrl}`;
    } catch (e: any) {
      return redactSecrets(`Error: ${(e.stderr || e.message || '').slice(0, 500)}`);
    }
  },
};

export default handler;

import { redactSecrets } from '../../utils/git-auth.js';
import { ensureGitHubRepo, gitPushToRepo } from '../../utils/github.js';
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
    try {
      const { htmlUrl, cloneUrl, created } = await ensureGitHubRepo(input.name, {
        description: input.description,
        private: input.private,
      });

      // If push_dir specified, init and push
      if (input.push_dir) {
        gitPushToRepo(input.push_dir, cloneUrl, 'Initial commit');
        return `Repo ${created ? 'created' : 'found'} and code pushed!\n${htmlUrl}`;
      }

      return created ? `Repo created: ${htmlUrl}` : `Repo already exists: ${htmlUrl}`;
    } catch (e: any) {
      return redactSecrets(`Error: ${(e.stderr || e.message || '').slice(0, 500)}`);
    }
  },
};

export default handler;

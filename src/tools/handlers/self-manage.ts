import { execAsync } from '../../utils/shell.js';
import type { ToolHandler } from '../types.js';

const handlers: ToolHandler[] = [
  {
    name: 'restart_self',
    definition: {
      name: 'restart_self',
      description: 'Restart the bot process to apply code changes. The bot will come back up automatically via LaunchAgent.',
      input_schema: {
        type: 'object' as const,
        properties: {
          reason: { type: 'string', description: 'Why restarting (shown in logs)' },
        },
        required: ['reason'],
      },
    },
    localOnly: true,
    async execute(input) {
      // Send reply before dying — use setTimeout to allow response to be sent
      setTimeout(() => {
        process.exit(0); // LaunchAgent KeepAlive will restart us
      }, 1500);
      return `Restarting bot (reason: ${input.reason}). I'll be back in ~10 seconds.`;
    },
  },
  {
    name: 'deploy_self',
    definition: {
      name: 'deploy_self',
      description: 'Commit all changes, push to git, and restart. Use after modifying own code to apply changes.',
      input_schema: {
        type: 'object' as const,
        properties: {
          message: { type: 'string', description: 'Commit message describing the changes' },
        },
        required: ['message'],
      },
    },
    localOnly: true,
    async execute(input) {
      try {
        // Stage all changes in the alonbot directory
        await execAsync('git add -A', { timeout: 10000 });

        // Check if there are changes to commit
        const status = await execAsync('git status --porcelain', { timeout: 5000 });
        if (!status.stdout.trim()) {
          return 'No changes to commit. Use restart_self if you just need to reload.';
        }

        // Commit
        const commitMsg = `${input.message}\n\nSelf-deployed by AalonBot`;
        await execAsync(`git commit -m ${JSON.stringify(commitMsg)}`, { timeout: 15000 });

        // Push
        await execAsync('git push', { timeout: 30000 });

        // Restart to apply changes
        setTimeout(() => {
          process.exit(0);
        }, 2000);

        return `Deployed! Committed "${input.message}", pushed to git, restarting now...`;
      } catch (e: any) {
        return `Deploy failed: ${e.message}`;
      }
    },
  },
];

export default handlers;

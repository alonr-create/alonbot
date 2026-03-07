import { z } from 'zod';
import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { gitEnv, redactSecrets } from '../../utils/git-auth.js';
import type { ToolHandler } from '../types.js';

const autoImproveSchema = z.object({
  action: z.enum(['list', 'read', 'edit']),
  file: z.string().max(500).optional(),
  search: z.string().max(10000).optional(),
  replace: z.string().max(50000).optional(),
});

const AUTO_IMPROVE_ALLOWED_PATHS = [
  /^src\/agent\/system-prompt\.ts$/,
  /^skills\//,
];
const AUTO_IMPROVE_BLOCKED_PATHS = [
  /^src\/agent\/tools\.ts$/,
  /^src\/gateway\/server\.ts$/,
  /^\.env/,
  /^package\.json$/,
  /security/i,
];

function isAutoImprovePathAllowed(file: string): boolean {
  if (AUTO_IMPROVE_BLOCKED_PATHS.some(p => p.test(file))) return false;
  return AUTO_IMPROVE_ALLOWED_PATHS.some(p => p.test(file));
}

const handler: ToolHandler = {
  name: 'auto_improve',
  definition: {
    name: 'auto_improve',
    description: 'Read and modify AlonBot source code. Use to add features, fix bugs, or improve yourself. Changes take effect after next deploy.',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['read', 'edit', 'list'], description: 'read: read a source file, edit: modify a file, list: list source files' },
        file: { type: 'string', description: 'File path relative to project root (e.g. "src/agent/tools.ts")' },
        search: { type: 'string', description: 'For edit: exact text to find and replace' },
        replace: { type: 'string', description: 'For edit: replacement text' },
      },
      required: ['action'],
    },
  },
  schema: autoImproveSchema,
  async execute(input, ctx) {
    const projectRoot = ctx.config.mode === 'cloud' ? '/app' : process.cwd();
    switch (input.action) {
      case 'list': {
        try {
          const output = execSync(`find src -name "*.ts" | sort`, {
            cwd: projectRoot, encoding: 'utf-8', timeout: 5000,
          }).trim();
          return output || 'No source files found.';
        } catch (e: any) {
          return `Error: ${e.message}`;
        }
      }
      case 'read': {
        if (!input.file) return 'Error: file parameter required.';
        if (!isAutoImprovePathAllowed(input.file)) {
          return `Error: auto_improve cannot read "${input.file}". Only system-prompt.ts and skills/ are allowed.`;
        }
        try {
          const filePath = resolve(projectRoot, input.file);
          return readFileSync(filePath, 'utf-8').slice(0, 15000);
        } catch (e: any) {
          return `Error: ${e.message}`;
        }
      }
      case 'edit': {
        if (!input.file || !input.search || !input.replace) return 'Error: file, search, and replace parameters required.';
        if (!isAutoImprovePathAllowed(input.file)) {
          return `Error: auto_improve cannot modify "${input.file}". Only system-prompt.ts and skills/ are allowed.`;
        }
        try {
          const filePath = resolve(projectRoot, input.file);
          const content = readFileSync(filePath, 'utf-8');
          if (!content.includes(input.search)) return 'Error: search text not found in file.';
          const newContent = content.replace(input.search, input.replace);
          writeFileSync(filePath, newContent);
          // Auto-commit and push if in cloud with git
          if (ctx.config.mode === 'cloud' && process.env.GITHUB_TOKEN) {
            try {
              execSync(`cd "${projectRoot}" && git add "${input.file}" && git commit -m "Auto-improve: ${input.file}" && git push https://github.com/alonr-create/alonbot.git main`, {
                shell: '/bin/bash', timeout: 30000, encoding: 'utf-8',
                env: gitEnv(),
              });
              return `File edited and pushed to GitHub. Will auto-deploy shortly.\nChanged in ${input.file}: "${input.search.slice(0, 50)}..." → "${input.replace.slice(0, 50)}..."`;
            } catch (gitErr: any) {
              return `File edited locally but git push failed: ${redactSecrets((gitErr.stderr || gitErr.message || '').slice(0, 200))}\nChange saved in: ${input.file}`;
            }
          }
          return `File edited: ${input.file}\nChanged: "${input.search.slice(0, 50)}..." → "${input.replace.slice(0, 50)}..."`;
        } catch (e: any) {
          return `Error: ${e.message}`;
        }
      }
      default:
        return 'Error: action must be "list", "read", or "edit".';
    }
  },
};

export default handler;

import { execSync } from 'child_process';
import { writeFileSync } from 'fs';
import { redactSecrets } from '../../utils/git-auth.js';
import { ensureGitHubRepo, gitPushToRepo } from '../../utils/github.js';
import type { ToolHandler } from '../types.js';

const handler: ToolHandler = {
  name: 'build_website',
  definition: {
    name: 'build_website',
    description: 'Build a complete website from a description, push to GitHub, and deploy to Vercel. Returns live URL.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Project name (used for repo + URL, e.g. "pizza-shop")' },
        description: { type: 'string', description: 'What the website should be — detailed description' },
        html: { type: 'string', description: 'Full HTML content for index.html' },
        css: { type: 'string', description: 'Optional CSS (if not inline in HTML)' },
        js: { type: 'string', description: 'Optional JavaScript (if not inline in HTML)' },
      },
      required: ['name', 'description', 'html'],
    },
  },
  async execute(input) {
    const siteName = input.name.replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase();
    const siteDir = `/app/workspace/${siteName}`;

    try {
      // Create project directory
      execSync(`mkdir -p "${siteDir}"`, { shell: '/bin/bash' });

      // Write HTML
      writeFileSync(`${siteDir}/index.html`, input.html);
      if (input.css) writeFileSync(`${siteDir}/style.css`, input.css);
      if (input.js) writeFileSync(`${siteDir}/script.js`, input.js);

      // Create/push to GitHub using shared helper
      const { cloneUrl } = await ensureGitHubRepo(siteName, { description: input.description });
      gitPushToRepo(siteDir, cloneUrl, `Build website: ${input.description.slice(0, 50)}`);

      return `Website built and pushed!\n\nGitHub: https://github.com/alonr-create/${siteName}\n\nTo deploy:\n• Vercel: https://vercel.com/new → import ${siteName}\n• Or connect at vercel.com for auto-deploy\n\nExpected URL: https://${siteName}.vercel.app`;
    } catch (e: any) {
      return `Error: ${redactSecrets((e.stderr || e.message || '').slice(0, 500))}`;
    }
  },
};

export default handler;

import { execSync } from 'child_process';
import { writeFileSync } from 'fs';
import { gitEnv, redactSecrets } from '../../utils/git-auth.js';
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
    const token = process.env.GITHUB_TOKEN;
    if (!token) return 'Error: GITHUB_TOKEN not configured.';
    const siteName = input.name.replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase();
    const siteDir = `/app/workspace/${siteName}`;

    try {
      // Create project directory
      execSync(`mkdir -p "${siteDir}"`, { shell: '/bin/bash' });

      // Write HTML
      writeFileSync(`${siteDir}/index.html`, input.html);
      if (input.css) writeFileSync(`${siteDir}/style.css`, input.css);
      if (input.js) writeFileSync(`${siteDir}/script.js`, input.js);

      // Create/push to GitHub
      const pushUrl = `https://github.com/alonr-create/${siteName}.git`;

      // Check if repo exists
      const checkRes = await fetch(`https://api.github.com/repos/alonr-create/${siteName}`, {
        headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json' },
      });

      if (checkRes.status === 404) {
        await fetch('https://api.github.com/user/repos', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Accept': 'application/vnd.github+json' },
          body: JSON.stringify({ name: siteName, description: input.description, private: false }),
        });
      }

      execSync(`cd "${siteDir}" && git init && git add -A && git commit -m "Build website: ${input.description.slice(0, 50)}" && git branch -M main && git remote remove origin 2>/dev/null; git remote add origin "${pushUrl}" && git push -u origin main --force`, {
        shell: '/bin/bash', timeout: 30000, encoding: 'utf-8',
        env: gitEnv(),
      });

      return `Website built and pushed!\n\nGitHub: https://github.com/alonr-create/${siteName}\n\nTo deploy:\n• Vercel: https://vercel.com/new → import ${siteName}\n• Or connect at vercel.com for auto-deploy\n\nExpected URL: https://${siteName}.vercel.app`;
    } catch (e: any) {
      return `Error: ${redactSecrets((e.stderr || e.message || '').slice(0, 500))}`;
    }
  },
};

export default handler;

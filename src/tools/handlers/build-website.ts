import { mkdirSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { redactSecrets } from '../../utils/git-auth.js';
import { ensureGitHubRepo, gitPushToRepo } from '../../utils/github.js';
import type { ToolHandler } from '../types.js';

const handler: ToolHandler = {
  name: 'build_website',
  definition: {
    name: 'build_website',
    description: 'Build a complete website from a description, push to GitHub, deploy to Vercel, and send the HTML file to the user. Returns live URL.',
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
  async execute(input, ctx) {
    const siteName = input.name.replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase();
    const siteDir = join(tmpdir(), 'alonbot-sites', siteName);

    try {
      // Create project directory
      mkdirSync(siteDir, { recursive: true });

      // Write HTML
      writeFileSync(`${siteDir}/index.html`, input.html);
      if (input.css) writeFileSync(`${siteDir}/style.css`, input.css);
      if (input.js) writeFileSync(`${siteDir}/script.js`, input.js);

      // Send the HTML file to the user via WhatsApp/Telegram
      const htmlBuffer = Buffer.from(input.html, 'utf-8');
      ctx.addPendingMedia({ type: 'document', data: htmlBuffer, filename: `${siteName}.html`, mimetype: 'text/html' });

      // Try to push to GitHub and deploy
      let deployInfo = '';
      try {
        const { cloneUrl } = await ensureGitHubRepo(siteName, { description: input.description });
        await gitPushToRepo(siteDir, cloneUrl, `Build website: ${input.description.slice(0, 50)}`);
        deployInfo = `\n\nGitHub: https://github.com/alonr-create/${siteName}\nURL: https://${siteName}.vercel.app`;
      } catch (e: any) {
        deployInfo = `\n\nGitHub push failed: ${redactSecrets((e.message || '').slice(0, 200))}`;
      }

      return `Website built! HTML file sent.${deployInfo}`;
    } catch (e: any) {
      return `Error: ${redactSecrets((e.stderr || e.message || '').slice(0, 500))}`;
    }
  },
};

export default handler;

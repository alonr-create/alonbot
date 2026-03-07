import { gitEnv, redactSecrets } from './git-auth.js';
import { withRetry } from './retry.js';
import { execAsync } from './shell.js';

/**
 * Ensure a GitHub repo exists under alonr-create.
 * Creates it if missing. Returns the clone URL.
 */
export async function ensureGitHubRepo(
  repoName: string,
  options?: { description?: string; private?: boolean }
): Promise<{ htmlUrl: string; cloneUrl: string; created: boolean }> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN not configured.');

  // Check if repo exists
  const checkRes = await withRetry(() => fetch(`https://api.github.com/repos/alonr-create/${repoName}`, {
    headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json', 'User-Agent': 'AlonBot' },
  }));

  if (checkRes.ok) {
    const data = await checkRes.json() as any;
    return { htmlUrl: data.html_url, cloneUrl: data.clone_url, created: false };
  }

  // Create repo
  const createRes = await withRetry(() => fetch('https://api.github.com/user/repos', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'AlonBot',
    },
    body: JSON.stringify({
      name: repoName,
      private: options?.private ?? false,
      description: options?.description || '',
    }),
  }));

  if (!createRes.ok) {
    const err = await createRes.text();
    throw new Error(`GitHub repo creation failed: ${createRes.status} ${err}`);
  }

  const data = await createRes.json() as any;
  return { htmlUrl: data.html_url, cloneUrl: data.clone_url, created: true };
}

/**
 * Push a local directory to a GitHub repo (force push).
 * Handles git init, add, commit, push.
 */
export async function gitPushToRepo(
  localDir: string,
  cloneUrl: string,
  commitMessage: string
): Promise<string> {
  const env = gitEnv();
  const cmd = `cd "${localDir}" && git init && git add -A && git commit -m "${commitMessage}" --allow-empty && git branch -M main && git remote remove origin 2>/dev/null; git remote add origin "${cloneUrl}" && git push -f origin main`;
  const output = await execAsync(cmd, { shell: '/bin/zsh', timeout: 60000, env });
  return redactSecrets(output);
}

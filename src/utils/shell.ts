import { spawn } from 'child_process';

interface ExecAsyncOptions {
  cwd?: string;
  timeout?: number;
  maxBuffer?: number;
  shell?: string;
  env?: NodeJS.ProcessEnv;
}

export function execAsync(
  command: string,
  options: ExecAsyncOptions = {}
): Promise<string> {
  const {
    cwd,
    timeout = 30000,
    maxBuffer = 1_000_000,
    shell = '/bin/zsh',
    env,
  } = options;

  return new Promise((resolve, reject) => {
    const child = spawn(shell, ['-c', command], {
      cwd,
      env: env || process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let killed = false;

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.length > maxBuffer) {
        child.kill();
        killed = true;
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > maxBuffer) {
        child.kill();
        killed = true;
      }
    });

    const timer = setTimeout(() => {
      child.kill();
      killed = true;
      reject(Object.assign(new Error('Command timed out'), { stderr, stdout }));
    }, timeout);

    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed && !stdout && !stderr) {
        reject(Object.assign(new Error('Command killed (buffer overflow)'), { stderr, stdout }));
        return;
      }
      if (code !== 0 && !killed) {
        reject(Object.assign(new Error(`Command failed with exit code ${code}`), { stderr, stdout, code }));
        return;
      }
      resolve(stdout.trim());
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(Object.assign(err, { stderr, stdout }));
    });
  });
}

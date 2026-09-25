import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export function remoteRepo(remote: string): string | undefined {
  const value = remote.trim();
  let path: string;
  if (/^https?:\/\//i.test(value) || /^ssh:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (!['https:', 'ssh:'].includes(url.protocol) || !url.hostname) return;
      path = url.pathname;
    } catch {
      return;
    }
  } else {
    const match = /^(?:[^@/:]+@)?[^@/:]+:(.+)$/.exec(value);
    if (!match) return;
    path = match[1]!;
  }
  const parts = path
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.git$/i, '')
    .split('/');
  if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9._-]+$/.test(part))) return;
  const repo = parts.join('/');
  return repo;
}

async function validDir(dir: string): Promise<string> {
  if (isAbsolute(dir) && !/\p{Cc}/u.test(dir)) {
    try {
      if ((await stat(dir)).isDirectory()) return dir;
    } catch {
      /* use process cwd */
    }
  }
  return process.cwd();
}

export async function gitContext(dir: string): Promise<{ repo?: string; branch?: string }> {
  const deadline = Date.now() + 3_000;
  let dirTimer: ReturnType<typeof setTimeout>;
  const cwd = await Promise.race([
    validDir(dir),
    new Promise<undefined>((resolve) => {
      dirTimer = setTimeout(() => resolve(undefined), 3_000);
    }),
  ]);
  clearTimeout(dirTimer!);
  if (!cwd) return {};
  const gitEnv: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  for (const name of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_CEILING_DIRECTORIES',
    'GIT_COMMON_DIR',
  ])
    delete gitEnv[name];
  const run = async (...args: string[]): Promise<string | undefined> => {
    const timeout = Math.min(1_500, deadline - Date.now());
    if (timeout <= 0) return;
    try {
      const { stdout } = await exec('git', ['-c', 'core.fsmonitor=false', '-C', cwd, ...args], {
        timeout,
        maxBuffer: 4_096,
        windowsHide: true,
        env: gitEnv,
      });
      return stdout.trim();
    } catch {
      return;
    }
  };
  const top = await run('rev-parse', '--show-toplevel');
  if (!top) return {};
  const fallback = basename(top);
  const remote = await run('remote', 'get-url', 'origin');
  const repo = (remote && remoteRepo(remote)) || fallback;
  const branchName = await run('symbolic-ref', '--quiet', '--short', 'HEAD');
  const sha = branchName ? undefined : await run('rev-parse', '--short', 'HEAD');
  const branch = branchName || (sha ? `(detached ${sha})` : undefined);
  return {
    ...(Array.from(repo).length <= 100 ? { repo } : {}),
    ...(branch && Array.from(branch).length <= 200 ? { branch } : {}),
  };
}

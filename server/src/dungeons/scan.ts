import { execFile } from 'node:child_process';
import { lstat, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface FoundRepo {
  name: string;
  path: string;
  githubRepo?: string;
}

const GITHUB_REMOTE = /^(?:git@github\.com:|(?:https?|ssh|git):\/\/(?:[^@/\s]+@)?github\.com\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/;

/** `git@github.com:o/r.git` / `https://github.com/o/r(.git)` -> `o/r`; anything else -> undefined. */
export function parseGithubRemote(url: string): string | undefined {
  const m = GITHUB_REMOTE.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : undefined;
}

async function git(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await run('git', args, { cwd, timeout: 10_000 });
    return stdout.trim();
  } catch {
    return undefined;
  }
}

export async function inspectRepo(path: string): Promise<{ githubRepo?: string; defaultBranch: string }> {
  const [remote, branch] = await Promise.all([
    git(path, ['remote', 'get-url', 'origin']),
    git(path, ['symbolic-ref', '--short', 'HEAD']),
  ]);
  const githubRepo = remote ? parseGithubRemote(remote) : undefined;
  return { ...(githubRepo ? { githubRepo } : {}), defaultBranch: branch || 'main' };
}

/** True when `dir` holds a `.git` entry (a directory, or a file for worktrees/submodules). Symlinks don't count. */
export async function isGitProject(dir: string): Promise<boolean> {
  try {
    const st = await lstat(join(dir, '.git'));
    return st.isDirectory() || st.isFile();
  } catch {
    return false;
  }
}

/** Find git projects under `root` (root itself counts), up to `maxDepth` levels down; never descends into a repo. */
export async function scanForRepos(root: string, maxDepth = 2): Promise<FoundRepo[]> {
  const paths: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (await isGitProject(dir)) {
      paths.push(dir);
      return;
    }
    if (depth >= maxDepth) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable or missing
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      // Dirent.isDirectory() is false for symlinks, so links are never followed.
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
      await walk(join(dir, e.name), depth + 1);
    }
  };
  await walk(root, 0);
  return Promise.all(
    paths.map(async (path) => {
      const { githubRepo } = await inspectRepo(path);
      return { name: basename(path), path, ...(githubRepo ? { githubRepo } : {}) };
    }),
  );
}

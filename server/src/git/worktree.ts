import { execFile } from 'node:child_process';
import { lstat, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Quest } from '@loc/shared';

const GIT_TIMEOUT_MS = 60_000;
const PUSH_TIMEOUT_MS = 120_000;
const FALLBACK_IDENTITY = ['-c', 'user.name=克勞德傳說', '-c', 'user.email=loc@localhost'];

export class BranchExistsError extends Error {
  constructor(public readonly branch: string) {
    super(`分支 ${branch} 已存在`);
    this.name = 'BranchExistsError';
  }
}

export class WorktreePathExistsError extends Error {
  constructor(public readonly path: string) {
    super(`工作目錄 ${path} 已存在`);
    this.name = 'WorktreePathExistsError';
  }
}

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** The git subcommand for messages, skipping leading `-c key=value` options. */
function subcommand(args: string[]): string | undefined {
  let i = 0;
  while (args[i] === '-c') i += 2;
  return args[i];
}

/** Runs git without a shell; never rejects on a non-zero exit (only on spawn failure/timeout, with stderr attached). */
function runGit(cwd: string, args: string[], timeout = GIT_TIMEOUT_MS, env?: NodeJS.ProcessEnv): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout, maxBuffer: 16 * 1024 * 1024, ...(env ? { env } : {}) }, (err, stdout, stderr) => {
      if (!err) return resolve({ code: 0, stdout, stderr });
      const e = err as Error & { code?: number | string };
      if (typeof e.code === 'number') return resolve({ code: e.code, stdout, stderr });
      reject(new Error(`git ${subcommand(args)} 執行失敗：${stderr.trim() || e.message}`));
    });
  });
}

/** Runs git and throws (including git's stderr) on a non-zero exit. */
async function git(cwd: string, args: string[], timeout = GIT_TIMEOUT_MS, env?: NodeJS.ProcessEnv): Promise<string> {
  const r = await runGit(cwd, args, timeout, env);
  if (r.code !== 0) throw new Error(`git ${subcommand(args)} 失敗：${r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`}`);
  return r.stdout;
}

export function branchName(quest: Quest): string {
  if (quest.source.kind === 'jira') return `loc/${quest.source.key}-${quest.id.slice(0, 6)}`;
  return `loc/${quest.id}`;
}

export async function createWorktree(
  repoPath: string,
  dataDir: string,
  branch: string,
): Promise<{ worktreePath: string; baseBranch: string }> {
  const valid = await runGit(repoPath, ['check-ref-format', `refs/heads/${branch}`]);
  if (valid.code !== 0 || branch.startsWith('-')) throw new Error(`分支名稱無效：${branch}`);

  // Checked before any mutation: an existing branch (checked out or not) is never touched.
  const exists = await runGit(repoPath, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
  if (exists.code === 0) throw new BranchExistsError(branch);

  const baseSha = (await git(repoPath, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
  const sym = await runGit(repoPath, ['symbolic-ref', '--short', 'HEAD']);
  const baseBranch = sym.code === 0 && sym.stdout.trim() ? sym.stdout.trim() : baseSha;

  const root = join(dataDir, 'worktrees');
  const worktreePath = join(root, branch.replaceAll('/', '-'));
  // Checked before any mutation: git would create the branch first and then fail on the occupied path.
  if (await pathExists(worktreePath)) throw new WorktreePathExistsError(worktreePath);

  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await mkdir(root, { recursive: true, mode: 0o700 });
  try {
    await git(repoPath, ['worktree', 'add', '-b', branch, worktreePath, baseSha]);
  } catch (err) {
    // `worktree add -b` may have created the branch before failing; it did not exist before, so remove it.
    await runGit(repoPath, ['branch', '-D', branch]).catch(() => undefined);
    throw err;
  }
  return { worktreePath, baseBranch };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function hasIdentity(cwd: string): Promise<boolean> {
  const [email, name] = await Promise.all([
    runGit(cwd, ['config', 'user.email']),
    runGit(cwd, ['config', 'user.name']),
  ]);
  return email.code === 0 && !!email.stdout.trim() && name.code === 0 && !!name.stdout.trim();
}

export async function commitIfDirty(worktreePath: string, message: string): Promise<boolean> {
  await git(worktreePath, ['add', '-A']);
  const staged = await runGit(worktreePath, ['diff', '--cached', '--quiet']);
  if (staged.code === 0) return false;
  if (staged.code !== 1) throw new Error(`git diff 失敗：${staged.stderr.trim()}`);
  const identity = (await hasIdentity(worktreePath)) ? [] : FALLBACK_IDENTITY;
  await git(worktreePath, [...identity, 'commit', '-m', message]);
  return true;
}

export async function diffStat(worktreePath: string, baseBranch: string): Promise<string> {
  return git(worktreePath, ['diff', '--stat', `${baseBranch}...HEAD`]);
}

const BATCH_MODE = '-o BatchMode=yes';
const withBatchMode = (sshCommand: string) => (/BatchMode/i.test(sshCommand) ? sshCommand : `${sshCommand} ${BATCH_MODE}`);

/**
 * Leading args and env for git commands that reach the network: the server has no terminal, so git
 * must fail instead of asking for a password or passphrase. The user's own ssh setup is kept: an
 * existing GIT_SSH_COMMAND or core.sshCommand (e.g. naming a key) gets batch mode appended; only when
 * neither (nor GIT_SSH) is set does this supply `ssh -o BatchMode=yes`.
 */
export async function nonInteractiveGit(cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<{ args: string[]; env: NodeJS.ProcessEnv }> {
  const out: NodeJS.ProcessEnv = { ...env, GIT_TERMINAL_PROMPT: '0' };
  const fromEnv = env['GIT_SSH_COMMAND'];
  if (fromEnv) return { args: [], env: { ...out, GIT_SSH_COMMAND: withBatchMode(fromEnv) } };
  const configured = await runGit(cwd, ['config', '--get', 'core.sshCommand'], GIT_TIMEOUT_MS, env);
  const sshCommand = configured.code === 0 ? configured.stdout.trim() : '';
  if (sshCommand) return { args: ['-c', `core.sshCommand=${withBatchMode(sshCommand)}`], env: out };
  if (!env['GIT_SSH']) out['GIT_SSH_COMMAND'] = `ssh ${BATCH_MODE}`;
  return { args: [], env: out };
}

export async function pushBranch(worktreePath: string, branch: string): Promise<void> {
  const { args, env } = await nonInteractiveGit(worktreePath);
  await git(worktreePath, [...args, 'push', '-u', 'origin', branch], PUSH_TIMEOUT_MS, env);
}

export async function worktreeExists(path: string): Promise<boolean> {
  try {
    await stat(join(path, '.git'));
    return true;
  } catch {
    return false;
  }
}

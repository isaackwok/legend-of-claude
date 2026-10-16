import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Quest } from '@loc/shared';
import {
  BranchExistsError,
  WorktreePathExistsError,
  branchName,
  commitIfDirty,
  createWorktree,
  diffStat,
  nonInteractiveGit,
  pushBranch,
  worktreeExists,
} from './worktree.js';

const run = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await run('git', args, { cwd })).stdout.trim();

let tmp: string;
let repo: string;
let dataDir: string;

beforeEach(async () => {
  tmp = await realpath(await mkdtemp(join(tmpdir(), 'loc-wt-')));
  repo = join(tmp, 'repo');
  dataDir = join(tmp, 'data');
  await run('git', ['init', '-q', '-b', 'main', repo]);
  await git(repo, 'config', 'user.email', 'test@example.com');
  await git(repo, 'config', 'user.name', 'Test');
  await writeFile(join(repo, 'a.txt'), 'one\n');
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-q', '-m', 'init');
});
afterEach(() => rm(tmp, { recursive: true, force: true }));

const quest = (over: Partial<Quest>): Quest => ({
  id: 'abcdef123456',
  title: 't',
  body: '',
  stars: 1,
  status: 'open',
  source: { kind: 'local' },
  rejections: 0,
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

describe('branchName', () => {
  it('uses loc/<id> for local quests', () => {
    expect(branchName(quest({}))).toBe('loc/abcdef123456');
  });
  it('uses loc/<KEY>-<first 6 of id> for jira quests', () => {
    const q = quest({ source: { kind: 'jira', key: 'PROJ-42', url: 'https://x/browse/PROJ-42' } });
    expect(branchName(q)).toBe('loc/PROJ-42-abcdef');
  });
});

describe('createWorktree', () => {
  it('creates the worktree on a new branch from HEAD', async () => {
    const { worktreePath, baseBranch } = await createWorktree(repo, dataDir, 'loc/q1');
    expect(worktreePath).toBe(join(dataDir, 'worktrees', 'loc-q1'));
    expect(baseBranch).toBe('main');
    expect(await worktreeExists(worktreePath)).toBe(true);
    expect(await git(worktreePath, 'branch', '--show-current')).toBe('loc/q1');
    expect(await git(worktreePath, 'rev-parse', 'HEAD')).toBe(await git(repo, 'rev-parse', 'main'));
    expect((await stat(join(dataDir, 'worktrees'))).mode & 0o777).toBe(0o700);
  });

  it('works with uncommitted changes in the main checkout and does not carry them over', async () => {
    await writeFile(join(repo, 'a.txt'), 'one\nDIRTY\n');
    await writeFile(join(repo, 'untracked.txt'), 'new\n');
    const { worktreePath } = await createWorktree(repo, dataDir, 'loc/q2');
    expect(await readFile(join(worktreePath, 'a.txt'), 'utf8')).toBe('one\n');
    await expect(stat(join(worktreePath, 'untracked.txt'))).rejects.toThrow();
    // the main checkout is untouched
    expect(await readFile(join(repo, 'a.txt'), 'utf8')).toBe('one\nDIRTY\n');
    expect(await git(repo, 'branch', '--show-current')).toBe('main');
  });

  it('throws BranchExistsError and leaves the existing branch untouched', async () => {
    const first = await createWorktree(repo, dataDir, 'loc/q3');
    await writeFile(join(first.worktreePath, 'b.txt'), 'work\n');
    expect(await commitIfDirty(first.worktreePath, 'work')).toBe(true);
    const before = await git(repo, 'rev-parse', 'loc/q3');
    expect(before).not.toBe(await git(repo, 'rev-parse', 'main'));

    await expect(createWorktree(repo, dataDir, 'loc/q3')).rejects.toBeInstanceOf(BranchExistsError);
    await expect(createWorktree(repo, dataDir, 'loc/q3')).rejects.toThrow('分支 loc/q3 已存在');
    expect(await git(repo, 'rev-parse', 'loc/q3')).toBe(before);
    expect(await readFile(join(first.worktreePath, 'b.txt'), 'utf8')).toBe('work\n');
  });

  it('throws BranchExistsError for a branch with no worktree, before creating any directory', async () => {
    await git(repo, 'branch', 'loc/q4');
    await expect(createWorktree(repo, dataDir, 'loc/q4')).rejects.toBeInstanceOf(BranchExistsError);
    await expect(stat(join(dataDir, 'worktrees'))).rejects.toThrow();
  });

  it('throws WorktreePathExistsError for an occupied path and creates no branch', async () => {
    const occupied = join(dataDir, 'worktrees', 'loc-q6');
    await mkdir(occupied, { recursive: true });
    await writeFile(join(occupied, 'keep.txt'), 'x');
    const err = await createWorktree(repo, dataDir, 'loc/q6').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorktreePathExistsError);
    expect((err as Error).message).toBe(`工作目錄 ${occupied} 已存在`);
    expect(await git(repo, 'branch', '--list', 'loc/q6')).toBe('');
    expect(await readFile(join(occupied, 'keep.txt'), 'utf8')).toBe('x');
    // retrying reports the path problem again, not a misleading BranchExistsError
    await expect(createWorktree(repo, dataDir, 'loc/q6')).rejects.toBeInstanceOf(WorktreePathExistsError);
  });

  it.skipIf(process.getuid?.() === 0)('removes the new branch when worktree add fails after creating it', async () => {
    await mkdir(join(dataDir, 'worktrees'), { recursive: true });
    await chmod(join(dataDir, 'worktrees'), 0o500); // git cannot create the worktree dir
    try {
      await expect(createWorktree(repo, dataDir, 'loc/q7')).rejects.toThrow(/worktree/);
    } finally {
      await chmod(join(dataDir, 'worktrees'), 0o700);
    }
    expect(await git(repo, 'branch', '--list', 'loc/q7')).toBe('');
    await expect(createWorktree(repo, dataDir, 'loc/q7')).resolves.toBeDefined();
  });

  it('uses the commit sha as baseBranch when HEAD is detached', async () => {
    const sha = await git(repo, 'rev-parse', 'HEAD');
    await git(repo, 'checkout', '-q', '--detach');
    const { baseBranch } = await createWorktree(repo, dataDir, 'loc/q5');
    expect(baseBranch).toBe(sha);
  });

  it('rejects invalid branch names without mutating anything', async () => {
    await expect(createWorktree(repo, dataDir, '--evil')).rejects.toThrow();
    await expect(createWorktree(repo, dataDir, 'a b')).rejects.toThrow();
    await expect(stat(join(dataDir, 'worktrees'))).rejects.toThrow();
  });
});

describe('commitIfDirty', () => {
  it('returns false when there is nothing to commit', async () => {
    const { worktreePath } = await createWorktree(repo, dataDir, 'loc/c1');
    const head = await git(worktreePath, 'rev-parse', 'HEAD');
    expect(await commitIfDirty(worktreePath, 'noop')).toBe(false);
    expect(await git(worktreePath, 'rev-parse', 'HEAD')).toBe(head);
  });

  it('commits new, modified and deleted files with the given message', async () => {
    const { worktreePath } = await createWorktree(repo, dataDir, 'loc/c2');
    await writeFile(join(worktreePath, 'a.txt'), 'two\n');
    await writeFile(join(worktreePath, 'new.txt'), 'x\n');
    expect(await commitIfDirty(worktreePath, 'feat: do the thing')).toBe(true);
    expect(await git(worktreePath, 'log', '-1', '--format=%s')).toBe('feat: do the thing');
    expect(await git(worktreePath, 'status', '--porcelain')).toBe('');
    expect(await git(worktreePath, 'log', '-1', '--format=%ae')).toBe('test@example.com');
  });

  it('falls back to the game identity only when the repo has none configured', async () => {
    const { worktreePath } = await createWorktree(repo, dataDir, 'loc/c3');
    // simulate "no identity" by making git unable to find one anywhere
    const saved = { HOME: process.env.HOME, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM };
    await git(repo, 'config', '--unset', 'user.email');
    await git(repo, 'config', '--unset', 'user.name');
    process.env.HOME = tmp;
    process.env.GIT_CONFIG_GLOBAL = join(tmp, 'empty-gitconfig');
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    try {
      await writeFile(join(worktreePath, 'f.txt'), 'f\n');
      expect(await commitIfDirty(worktreePath, 'msg')).toBe(true);
      expect(await git(worktreePath, 'log', '-1', '--format=%an <%ae>')).toBe('克勞德傳說 <loc@localhost>');
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

describe('diffStat', () => {
  it('lists files changed since the base branch', async () => {
    const { worktreePath, baseBranch } = await createWorktree(repo, dataDir, 'loc/d1');
    await writeFile(join(worktreePath, 'changed.txt'), 'hello\n');
    await commitIfDirty(worktreePath, 'add changed');
    expect(await diffStat(worktreePath, baseBranch)).toContain('changed.txt');
  });
});

describe('pushBranch', () => {
  it('pushes the branch to origin and sets upstream', async () => {
    const remote = join(tmp, 'remote.git');
    await run('git', ['init', '-q', '--bare', remote]);
    await git(repo, 'remote', 'add', 'origin', remote);
    const { worktreePath } = await createWorktree(repo, dataDir, 'loc/p1');
    await writeFile(join(worktreePath, 'p.txt'), 'p\n');
    await commitIfDirty(worktreePath, 'p');
    await pushBranch(worktreePath, 'loc/p1');
    expect(await git(remote, 'rev-parse', 'refs/heads/loc/p1')).toBe(await git(worktreePath, 'rev-parse', 'HEAD'));
    expect(await git(worktreePath, 'rev-parse', '--abbrev-ref', '@{u}')).toBe('origin/loc/p1');
  });

  it("surfaces git's stderr when the push fails", async () => {
    const { worktreePath } = await createWorktree(repo, dataDir, 'loc/p2'); // no origin configured
    await expect(pushBranch(worktreePath, 'loc/p2')).rejects.toThrow(/origin/);
  });
});

describe('nonInteractiveGit', () => {
  // Isolated from the developer's own git config (which may set core.sshCommand).
  const base = { PATH: process.env['PATH'], GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

  it('never prompts and uses ssh in batch mode when nothing configures ssh', async () => {
    const { args, env } = await nonInteractiveGit(repo, base);
    expect(args).toEqual([]);
    expect(env['GIT_TERMINAL_PROMPT']).toBe('0');
    expect(env['GIT_SSH_COMMAND']).toBe('ssh -o BatchMode=yes');
  });

  it('keeps an existing GIT_SSH_COMMAND and appends batch mode', async () => {
    const { args, env } = await nonInteractiveGit(repo, { ...base, GIT_SSH_COMMAND: 'ssh -i ~/.ssh/k' });
    expect(args).toEqual([]);
    expect(env['GIT_SSH_COMMAND']).toBe('ssh -i ~/.ssh/k -o BatchMode=yes');
    expect(env['GIT_TERMINAL_PROMPT']).toBe('0');
  });

  it('keeps a configured core.sshCommand (the key it names) and appends batch mode via -c', async () => {
    await git(repo, 'config', 'core.sshCommand', 'ssh -i ~/.ssh/me -o IdentitiesOnly=yes');
    const { args, env } = await nonInteractiveGit(repo, base);
    expect(args).toEqual(['-c', 'core.sshCommand=ssh -i ~/.ssh/me -o IdentitiesOnly=yes -o BatchMode=yes']);
    expect(env['GIT_SSH_COMMAND']).toBeUndefined();
    expect(env['GIT_TERMINAL_PROMPT']).toBe('0');
  });

  it('leaves GIT_SSH alone and does not repeat batch mode', async () => {
    expect((await nonInteractiveGit(repo, { ...base, GIT_SSH: '/usr/bin/my-ssh' })).env['GIT_SSH_COMMAND']).toBeUndefined();
    expect((await nonInteractiveGit(repo, { ...base, GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' })).env['GIT_SSH_COMMAND']).toBe('ssh -o BatchMode=yes');
  });
});

describe('worktreeExists', () => {
  it('is false for a missing path and for a plain directory', async () => {
    expect(await worktreeExists(join(tmp, 'nope'))).toBe(false);
    expect(await worktreeExists(tmp)).toBe(false);
  });
});

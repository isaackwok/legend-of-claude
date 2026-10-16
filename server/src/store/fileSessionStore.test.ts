import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runSessionStoreConformance } from '../../test/sessionStoreConformance.js';
import { FileSessionStore } from './fileSessionStore.js';

const dirs: string[] = [];
async function tmpDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'loc-sessions-'));
  dirs.push(d);
  return d;
}
afterAll(async () => { await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))); });

describe('FileSessionStore conformance', () => {
  runSessionStoreConformance(async () => new FileSessionStore(await tmpDir()));
});

const KEY = { projectKey: 'proj', sessionId: 'sess' };
const user = (uuid: string, text = 'hi') => ({
  type: 'user', uuid, timestamp: '2026-10-16T00:00:00.000Z', cwd: '/work', sessionId: 'sess',
  message: { role: 'user', content: text },
});

describe('FileSessionStore specifics', () => {
  it('ignores a re-sent entry with the same uuid', async () => {
    const store = new FileSessionStore(await tmpDir());
    await store.append(KEY, [user('u1'), user('u2')]);
    await store.append(KEY, [user('u2'), user('u3')]); // retry resends u2
    await store.append(KEY, [user('u3'), user('u3')]); // dup within a batch too
    const loaded = await store.load(KEY);
    expect(loaded?.map((e) => e.uuid)).toEqual(['u1', 'u2', 'u3']);
  });

  it('keeps entries without uuid (no dedupe)', async () => {
    const store = new FileSessionStore(await tmpDir());
    await store.append(KEY, [{ type: 'tag', tag: 'a' }]);
    await store.append(KEY, [{ type: 'tag', tag: 'a' }]);
    expect(await store.load(KEY)).toHaveLength(2);
  });

  it('survives concurrent appends and keeps every entry once', async () => {
    const store = new FileSessionStore(await tmpDir());
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.append(KEY, [user(`u${i}`)])));
    const loaded = await store.load(KEY);
    expect(new Set(loaded?.map((e) => e.uuid)).size).toBe(20);
    expect(loaded).toHaveLength(20);
  });

  it('maintains session summaries with the persist-time mtime and skips subpath batches', async () => {
    const store = new FileSessionStore(await tmpDir());
    await store.append(KEY, [user('u1', 'first prompt')]);
    await store.append({ ...KEY, subpath: 'subagents/a' }, [user('s1')]);
    await store.append({ projectKey: 'proj', sessionId: 'sub-only', subpath: 'subagents/a' }, [user('s2')]);
    const summaries = await store.listSessionSummaries('proj');
    expect(summaries.map((s) => s.sessionId)).toEqual(['sess']);
    const listed = await store.listSessions('proj');
    expect(summaries[0]?.mtime).toBe(listed.find((s) => s.sessionId === 'sess')?.mtime);
    expect(await store.listSessionSummaries('never-seen')).toEqual([]);
  });

  it('delete removes the summary too', async () => {
    const store = new FileSessionStore(await tmpDir());
    await store.append(KEY, [user('u1')]);
    await store.delete(KEY);
    expect(await store.listSessionSummaries('proj')).toEqual([]);
    expect(await store.listSessions('proj')).toEqual([]);
  });

  it('rejects keys that could escape the root', async () => {
    const root = await tmpDir();
    const store = new FileSessionStore(join(root, 'sessions'));
    const e = [user('u1')];
    await expect(store.append({ projectKey: '..', sessionId: 's' }, e)).rejects.toThrow();
    await expect(store.append({ projectKey: 'p/../..', sessionId: 's' }, e)).rejects.toThrow();
    await expect(store.append({ projectKey: '/abs', sessionId: 's' }, e)).rejects.toThrow();
    await expect(store.append({ projectKey: 'p', sessionId: '../s' }, e)).rejects.toThrow();
    await expect(store.append({ projectKey: 'p', sessionId: 's', subpath: '../../x' }, e)).rejects.toThrow();
    await expect(store.append({ projectKey: 'p', sessionId: 's', subpath: 'a/../../x' }, e)).rejects.toThrow();
    await expect(store.append({ projectKey: 'p', sessionId: 's', subpath: '/etc/x' }, e)).rejects.toThrow();
    await expect(store.load({ projectKey: '..', sessionId: 's' })).rejects.toThrow();
    await expect(store.delete({ projectKey: 'p', sessionId: '..' })).rejects.toThrow();
    // nothing was written next to the root
    expect(dirname(root)).not.toBe(root);
    const ok = { projectKey: 'p', sessionId: 's', subpath: 'subagents/agent-1' };
    await store.append(ok, e);
    expect(await store.listSubkeys(ok)).toEqual(['subagents/agent-1']);
  });
});

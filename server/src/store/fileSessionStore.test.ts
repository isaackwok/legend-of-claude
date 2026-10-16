import { appendFile, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
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

  it('concurrent appends re-sending the same uuids yield no duplicates and a complete summary', async () => {
    const store = new FileSessionStore(await tmpDir());
    // 10 batches, each overlapping its neighbour (retries), all racing.
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        store.append(KEY, [user(`u${i}`, `prompt ${i}`), user(`u${i + 1}`, `prompt ${i + 1}`)]),
      ),
    );
    const loaded = await store.load(KEY);
    expect(loaded).toHaveLength(11);
    expect(new Set(loaded?.map((e) => e.uuid)).size).toBe(11);
    const [summary] = await store.listSessionSummaries('proj');
    expect(summary?.sessionId).toBe('sess');
    expect(summary?.mtime).toBe((await store.listSessions('proj'))[0]?.mtime);
    // Summary was folded from every distinct entry: rebuilding from scratch gives the same data.
    const root2 = new FileSessionStore(await tmpDir());
    await root2.append(KEY, loaded ?? []);
    expect((await root2.listSessionSummaries('proj'))[0]?.data).toEqual(summary?.data);
  });

  it.skipIf(process.platform === 'win32')('creates directories 0700 and files 0600', async () => {
    const root = join(await tmpDir(), 'nested', 'sessions');
    const store = new FileSessionStore(root);
    await store.append(KEY, [user('u1')]);
    await store.append({ ...KEY, subpath: 'subagents/a' }, [user('s1')]);
    const mode = async (p: string) => (await stat(p)).mode & 0o777;
    expect(await mode(join(root, 'proj'))).toBe(0o700);
    expect(await mode(join(root, 'proj', 'sess'))).toBe(0o700);
    expect(await mode(join(root, 'proj', 'sess', 'subagents'))).toBe(0o700);
    expect(await mode(join(root, 'proj', 'sess.jsonl'))).toBe(0o600);
    expect(await mode(join(root, 'proj', 'sess.summary.json'))).toBe(0o600);
    expect(await mode(join(root, 'proj', 'sess', 'subagents', 'a.jsonl'))).toBe(0o600);
  });

  it('tolerates a torn trailing line: load, dedupe and later appends keep working', async () => {
    const root = await tmpDir();
    const store = new FileSessionStore(root);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await store.append(KEY, [user('u1'), user('u2')]);
    await appendFile(join(root, 'proj', 'sess.jsonl'), '{"type":"user","uuid":"u3","mess'); // crash mid-write
    expect((await store.load(KEY))?.map((e) => e.uuid)).toEqual(['u1', 'u2']);
    await store.append(KEY, [user('u2'), user('u4')]); // dedupe must still work; u4 must not glue onto the torn line
    expect((await store.load(KEY))?.map((e) => e.uuid)).toEqual(['u1', 'u2', 'u4']);
    expect(warn.mock.calls.length).toBe(1); // warned once per file
    warn.mockRestore();
  });

  it('treats a corrupt summary sidecar as absent and rebuilds it on the next append', async () => {
    const root = await tmpDir();
    const store = new FileSessionStore(root);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await store.append(KEY, [user('u1', 'first prompt')]);
    await store.append({ projectKey: 'proj', sessionId: 'other' }, [user('o1')]);
    const good = (await store.listSessionSummaries('proj')).find((s) => s.sessionId === 'sess');
    await writeFile(join(root, 'proj', 'sess.summary.json'), '{"sessionId":"se'); // torn sidecar
    const listed = await store.listSessionSummaries('proj');
    expect(listed.map((s) => s.sessionId)).toEqual(['other']); // others still listed
    await store.append(KEY, [user('u2', 'second prompt')]);
    const rebuilt = (await store.listSessionSummaries('proj')).find((s) => s.sessionId === 'sess');
    expect(rebuilt).toBeDefined();
    // set-once fields (e.g. firstPrompt) come from the whole transcript, not just the new batch
    expect(JSON.stringify(rebuilt?.data)).toContain('first prompt');
    expect(JSON.stringify(good?.data)).toContain('first prompt');
    warn.mockRestore();
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
    expect(await readdir(root)).toEqual([]);
    const ok = { projectKey: 'p', sessionId: 's', subpath: 'subagents/agent-1' };
    await store.append(ok, e);
    expect(await store.listSubkeys(ok)).toEqual(['subagents/agent-1']);
  });
});

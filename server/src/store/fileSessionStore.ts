import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { foldSessionSummary } from '@anthropic-ai/claude-agent-sdk';
import type {
  SessionKey,
  SessionStore,
  SessionStoreEntry,
  SessionSummaryEntry,
} from '@anthropic-ai/claude-agent-sdk';

const SUMMARY_SUFFIX = '.summary.json';

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === 'ENOENT';
}

/** A single path segment: not empty, not `.`/`..`, no separators or NUL. */
function checkSegment(label: string, seg: string): string {
  if (seg === '' || seg === '.' || seg === '..' || /[\/\\\0]/.test(seg)) {
    throw new Error(`invalid ${label}: ${JSON.stringify(seg)}`);
  }
  return seg;
}

/** A `/`-separated relative path where every segment is a safe segment. */
function checkSubpath(subpath: string): string {
  if (subpath.includes('\0') || subpath.includes('\\')) {
    throw new Error(`invalid subpath: ${JSON.stringify(subpath)}`);
  }
  for (const seg of subpath.split('/')) checkSegment('subpath', seg);
  return subpath;
}

/**
 * SessionStore backed by JSONL files:
 *   <root>/<projectKey>/<sessionId>.jsonl
 *   <root>/<projectKey>/<sessionId>/<subpath>.jsonl
 *   <root>/<projectKey>/<sessionId>.summary.json   (foldSessionSummary sidecar)
 */
export class FileSessionStore implements SessionStore {
  private readonly root: string;
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(root: string) {
    this.root = resolve(root);
  }

  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const file = this.fileFor(key);
    await this.withLock(key, async () => {
      const fresh = await this.dedupe(file, entries);
      if (fresh.length === 0) return;
      await mkdir(dirname(file), { recursive: true });
      await appendFile(file, fresh.map((e) => JSON.stringify(e) + '\n').join(''), 'utf8');
      // Subagent transcripts do not feed the session summary.
      if (key.subpath === undefined) {
        const mtime = Math.floor((await stat(file)).mtimeMs);
        await this.foldSummary(key, fresh, mtime);
      }
    });
  }

  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    const file = this.fileFor(key);
    return this.withLock(key, async () => {
      const text = await this.readText(file);
      return text === undefined ? null : parseLines(text);
    });
  }

  async listSessions(projectKey: string): Promise<Array<{ sessionId: string; mtime: number }>> {
    const dir = this.projectDir(projectKey);
    const out: Array<{ sessionId: string; mtime: number }> = [];
    for (const name of await this.readDir(dir)) {
      if (!name.endsWith('.jsonl')) continue;
      try {
        const st = await stat(join(dir, name));
        if (st.isFile()) out.push({ sessionId: name.slice(0, -'.jsonl'.length), mtime: Math.floor(st.mtimeMs) });
      } catch (err) {
        if (!isEnoent(err)) throw err;
      }
    }
    return out;
  }

  async listSessionSummaries(projectKey: string): Promise<SessionSummaryEntry[]> {
    const dir = this.projectDir(projectKey);
    const out: SessionSummaryEntry[] = [];
    for (const name of await this.readDir(dir)) {
      if (!name.endsWith(SUMMARY_SUFFIX)) continue;
      const text = await this.readText(join(dir, name));
      if (text !== undefined) out.push(JSON.parse(text) as SessionSummaryEntry);
    }
    return out;
  }

  async delete(key: SessionKey): Promise<void> {
    const file = this.fileFor(key);
    await this.withLock(key, async () => {
      await rm(file, { force: true });
      if (key.subpath === undefined) {
        await rm(this.sessionDir(key), { recursive: true, force: true });
        await rm(this.summaryFile(key), { force: true });
      }
    });
  }

  async listSubkeys(key: { projectKey: string; sessionId: string }): Promise<string[]> {
    const base = this.sessionDir(key);
    const out: string[] = [];
    const walk = async (dir: string, prefix: string): Promise<void> => {
      let dirents;
      try {
        dirents = await readdir(dir, { withFileTypes: true });
      } catch (err) {
        if (isEnoent(err)) return;
        throw err;
      }
      for (const d of dirents) {
        if (d.isDirectory()) await walk(join(dir, d.name), `${prefix}${d.name}/`);
        else if (d.isFile() && d.name.endsWith('.jsonl')) out.push(`${prefix}${d.name.slice(0, -'.jsonl'.length)}`);
      }
    };
    await walk(base, '');
    return out;
  }

  // --- paths (every key component is validated so nothing can escape `root`) ---

  private projectDir(projectKey: string): string {
    return this.inside(join(this.root, checkSegment('projectKey', projectKey)));
  }

  private sessionDir(key: { projectKey: string; sessionId: string }): string {
    return this.inside(join(this.projectDir(key.projectKey), checkSegment('sessionId', key.sessionId)));
  }

  private fileFor(key: SessionKey): string {
    if (key.subpath === undefined) {
      return this.inside(join(this.projectDir(key.projectKey), `${checkSegment('sessionId', key.sessionId)}.jsonl`));
    }
    return this.inside(join(this.sessionDir(key), `${checkSubpath(key.subpath)}.jsonl`));
  }

  private summaryFile(key: { projectKey: string; sessionId: string }): string {
    return this.inside(join(this.projectDir(key.projectKey), `${checkSegment('sessionId', key.sessionId)}${SUMMARY_SUFFIX}`));
  }

  private inside(p: string): string {
    const abs = resolve(p);
    if (abs !== this.root && !abs.startsWith(this.root + sep)) throw new Error(`path escapes store root: ${p}`);
    return abs;
  }

  // --- helpers ---

  /** One lock per session (main + subkeys share it) so read-fold-write sequences never interleave. */
  private withLock<R>(key: { projectKey: string; sessionId: string }, fn: () => Promise<R>): Promise<R> {
    const id = `${checkSegment('projectKey', key.projectKey)}\0${checkSegment('sessionId', key.sessionId)}`;
    const prev = this.locks.get(id) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.locks.set(id, tail);
    void tail.then(() => {
      if (this.locks.get(id) === tail) this.locks.delete(id);
    });
    return run;
  }

  /** Drop entries whose uuid is already stored (or repeated within the batch). Entries without uuid always pass. */
  private async dedupe(file: string, entries: SessionStoreEntry[]): Promise<SessionStoreEntry[]> {
    const seen = new Set<string>();
    if (entries.some((e) => typeof e.uuid === 'string')) {
      const text = await this.readText(file);
      if (text !== undefined) {
        for (const e of parseLines(text)) if (typeof e.uuid === 'string') seen.add(e.uuid);
      }
    }
    const fresh: SessionStoreEntry[] = [];
    for (const e of entries) {
      if (typeof e.uuid === 'string') {
        if (seen.has(e.uuid)) continue;
        seen.add(e.uuid);
      }
      fresh.push(e);
    }
    return fresh;
  }

  private async foldSummary(key: SessionKey, entries: SessionStoreEntry[], mtime: number): Promise<void> {
    const sidecar = this.summaryFile(key);
    const text = await this.readText(sidecar);
    const prev = text === undefined ? undefined : (JSON.parse(text) as SessionSummaryEntry);
    const next = foldSessionSummary(prev, key, entries, { mtime });
    const tmp = `${sidecar}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(next), 'utf8');
    await rename(tmp, sidecar);
  }

  private async readText(file: string): Promise<string | undefined> {
    try {
      return await readFile(file, 'utf8');
    } catch (err) {
      if (isEnoent(err)) return undefined;
      throw err;
    }
  }

  private async readDir(dir: string): Promise<string[]> {
    try {
      return await readdir(dir);
    } catch (err) {
      if (isEnoent(err)) return [];
      throw err;
    }
  }
}

function parseLines(text: string): SessionStoreEntry[] {
  const out: SessionStoreEntry[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() !== '') out.push(JSON.parse(line) as SessionStoreEntry);
  }
  return out;
}

import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
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
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      // A crash can leave a torn last line without '\n'; start on a fresh line so we don't glue onto it.
      const lead = (await endsMidLine(file)) ? '\n' : '';
      await appendFile(file, lead + fresh.map((e) => JSON.stringify(e) + '\n').join(''), {
        encoding: 'utf8',
        mode: 0o600,
      });
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
      return text === undefined ? null : parseLines(text, file);
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
      const summary = await this.readSummary(join(dir, name));
      if (summary) out.push(summary);
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
        for (const e of parseLines(text, file)) if (typeof e.uuid === 'string') seen.add(e.uuid);
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
    const prev = await this.readSummary(sidecar);
    let batch = entries;
    if (!prev) {
      // No usable sidecar (first append, or corrupt): rebuild from the whole transcript, which already includes `entries`.
      const file = this.fileFor(key);
      const text = await this.readText(file);
      if (text !== undefined) batch = parseLines(text, file);
    }
    const next = foldSessionSummary(prev, key, batch, { mtime });
    const tmp = `${sidecar}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(next), { encoding: 'utf8', mode: 0o600 });
    await rename(tmp, sidecar);
  }

  /** Read a summary sidecar; a missing or unparseable file counts as absent. */
  private async readSummary(file: string): Promise<SessionSummaryEntry | undefined> {
    const text = await this.readText(file);
    if (text === undefined) return undefined;
    try {
      const parsed = JSON.parse(text) as SessionSummaryEntry;
      return parsed && typeof parsed === 'object' && typeof parsed.sessionId === 'string' ? parsed : undefined;
    } catch {
      warnOnce(file, 'corrupt session summary ignored');
      return undefined;
    }
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

const warned = new Set<string>();
function warnOnce(file: string, msg: string): void {
  if (warned.has(file)) return;
  warned.add(file);
  console.warn(`[FileSessionStore] ${msg}: ${file}`);
}

/** True when the file exists, is non-empty and its last byte is not '\n' (torn write). */
async function endsMidLine(file: string): Promise<boolean> {
  let fh;
  try {
    fh = await open(file, 'r');
  } catch (err) {
    if (isEnoent(err)) return false;
    throw err;
  }
  try {
    const { size } = await fh.stat();
    if (size === 0) return false;
    const buf = Buffer.alloc(1);
    await fh.read(buf, 0, 1, size - 1);
    return buf[0] !== 0x0a;
  } finally {
    await fh.close();
  }
}

/** Parse JSONL; unparseable lines (e.g. a torn trailing write) are skipped with a one-time warning. */
function parseLines(text: string, file: string): SessionStoreEntry[] {
  const out: SessionStoreEntry[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      out.push(JSON.parse(line) as SessionStoreEntry);
    } catch {
      warnOnce(file, 'skipped unparseable transcript line');
    }
  }
  return out;
}

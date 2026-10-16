import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Dungeon, Npc, Quest, SessionIndexEntry, Settings } from '@loc/shared';

/** A JSON file `{ items: T[] }`; writes are queued per instance and atomic (tmp file + rename). */
export class JsonRepo<T extends { id: string }> {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {}

  async list(): Promise<T[]> {
    // Wait for in-flight writes so a read after an un-awaited put still sees it.
    await this.queue.catch(() => undefined);
    return this.read();
  }

  async get(id: string): Promise<T | undefined> {
    return (await this.list()).find((item) => item.id === id);
  }

  put(item: T): Promise<T> {
    return this.enqueue(async () => {
      const items = await this.read();
      const i = items.findIndex((x) => x.id === item.id);
      if (i >= 0) items[i] = item;
      else items.push(item);
      await this.write(items);
      return item;
    });
  }

  remove(id: string): Promise<void> {
    return this.enqueue(async () => {
      const items = await this.read();
      const next = items.filter((x) => x.id !== id);
      if (next.length !== items.length) await this.write(next);
    });
  }

  private enqueue<R>(fn: () => Promise<R>): Promise<R> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async read(): Promise<T[]> {
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const parsed = JSON.parse(text) as { items?: T[] };
    return parsed.items ?? [];
  }

  private async write(items: T[]): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify({ items }, null, 2), 'utf8');
    await rename(tmp, this.file);
  }
}

export interface Repos {
  quests: JsonRepo<Quest>;
  npcs: JsonRepo<Npc>;
  dungeons: JsonRepo<Dungeon>;
  sessions: JsonRepo<SessionIndexEntry>;
  settings: JsonRepo<Settings>;
}

export function repos(dataDir: string): Repos {
  return {
    quests: new JsonRepo<Quest>(join(dataDir, 'quests.json')),
    npcs: new JsonRepo<Npc>(join(dataDir, 'npcs.json')),
    dungeons: new JsonRepo<Dungeon>(join(dataDir, 'dungeons.json')),
    sessions: new JsonRepo<SessionIndexEntry>(join(dataDir, 'sessions.json')),
    settings: new JsonRepo<Settings>(join(dataDir, 'settings.json')),
  };
}

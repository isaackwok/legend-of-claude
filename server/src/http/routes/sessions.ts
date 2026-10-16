import { Hono } from 'hono';
import { getSessionMessages, type SessionStore } from '@anthropic-ai/claude-agent-sdk';
import type { SessionListItem, TranscriptMessage } from '@loc/shared';
import { toTranscript } from '../../chats/transcript.js';
import type { Repos } from '../../store/jsonRepo.js';
import { errorResponse } from './helpers.js';

export interface SessionRoutesDeps {
  repos: Repos;
  sessionStore: SessionStore;
  /** Where session ids of running adventures and chats come from. */
  liveSessionIds: () => string[];
}

export function sessionRoutes(deps: SessionRoutesDeps): Hono {
  const app = new Hono();

  // Live sessions first, then newest first.
  app.get('/', async (c) => {
    try {
      const npcId = c.req.query('npcId');
      const live = new Set(deps.liveSessionIds());
      const entries = (await deps.repos.sessions.list()).filter((e) => npcId === undefined || e.npcId === npcId);
      const items: SessionListItem[] = entries.map((e) => ({ ...e, live: live.has(e.id) }));
      items.sort((a, b) => Number(b.live) - Number(a.live) || b.updatedAt - a.updatedAt);
      return c.json(items);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.get('/:id/messages', async (c) => {
    try {
      const entry = await deps.repos.sessions.get(c.req.param('id'));
      if (!entry) return c.json({ error: '找不到這份冒險日誌' }, 404);
      const messages = await getSessionMessages(entry.id, { sessionStore: deps.sessionStore, dir: entry.cwd });
      const transcript: TranscriptMessage[] = toTranscript(messages);
      return c.json(transcript);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  return app;
}

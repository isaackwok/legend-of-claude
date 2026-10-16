import { Hono } from 'hono';
import type { QuestSource } from '@loc/shared';
import { ISSUE_KEY } from '../../clerk/clerk.js';
import type { CreateQuestInput, QuestService } from '../../quests/service.js';
import { BAD_REQUEST, errorResponse, jsonBody } from './helpers.js';

const isString = (v: unknown): v is string => typeof v === 'string';

function parseSource(v: unknown): QuestSource | undefined | 'invalid' {
  if (v === undefined) return undefined;
  const s = v as Partial<{ kind: unknown; key: unknown; url: unknown }> | null;
  if (s?.kind === 'local') return { kind: 'local' };
  // Same key rule as the clerk: the key later flows into clerk prompts at settlement.
  if (s?.kind === 'jira' && isString(s.key) && ISSUE_KEY.test(s.key) && isString(s.url)) return { kind: 'jira', key: s.key, url: s.url };
  return 'invalid';
}

export function questRoutes(quests: QuestService): Hono {
  const app = new Hono();

  app.get('/', async (c) => c.json(await quests.list()));

  app.post('/', async (c) => {
    const body = await jsonBody(c);
    if (!isString(body['title'])) return c.json({ error: '委託標題不能空白' }, 400);
    if (body['body'] !== undefined && !isString(body['body'])) return c.json({ error: BAD_REQUEST }, 400);
    const stars = body['stars'];
    // Type checks only; the service validates title and star range.
    if (stars !== undefined && typeof stars !== 'number') return c.json({ error: '星等必須是 1 到 5' }, 400);
    const source = parseSource(body['source']);
    if (source === 'invalid') return c.json({ error: BAD_REQUEST }, 400);
    const input: CreateQuestInput = { title: body['title'], body: (body['body'] as string | undefined) ?? '' };
    if (stars !== undefined) input.stars = stars as CreateQuestInput['stars'];
    if (source) input.source = source;
    try {
      return c.json(await quests.create(input), 201);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.post('/:id/start', async (c) => {
    const body = await jsonBody(c);
    const npcId = body['npcId'];
    const dungeonId = body['dungeonId'];
    if (!isString(npcId) || !npcId || !isString(dungeonId) || !dungeonId) return c.json({ error: '請選擇冒險者與地下城' }, 400);
    try {
      return c.json(await quests.start(c.req.param('id'), { npcId, dungeonId }));
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.post('/:id/message', async (c) => {
    const text = (await jsonBody(c))['text'];
    if (!isString(text)) return c.json({ error: '信的內容不能空白' }, 400);
    try {
      await quests.message(c.req.param('id'), text);
      return c.body(null, 204);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.post('/:id/recall', async (c) => {
    try {
      return c.json(await quests.recall(c.req.param('id')));
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.post('/:id/reject', async (c) => {
    const feedback = (await jsonBody(c))['feedback'];
    if (!isString(feedback)) return c.json({ error: '請寫下退回的理由' }, 400);
    try {
      return c.json(await quests.reject(c.req.param('id'), feedback));
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.post('/:id/abandon', async (c) => {
    try {
      return c.json(await quests.abandon(c.req.param('id')));
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  return app;
}

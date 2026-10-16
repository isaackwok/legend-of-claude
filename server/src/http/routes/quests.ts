import type { Context } from 'hono';
import { Hono } from 'hono';
import { InvalidTransitionError, STATUS_LABEL, type QuestAction, type QuestSource } from '@loc/shared';
import { BranchExistsError, WorktreePathExistsError } from '../../git/worktree.js';
import { QuestServiceError, type CreateQuestInput, type QuestService } from '../../quests/service.js';

const ACTION_LABEL: Record<QuestAction, string> = {
  start: '出發',
  finish: '完成',
  interrupt: '中斷',
  reject: '退回',
  accept: '驗收',
  abandon: '放棄',
};

const BAD_REQUEST = '請求內容不正確';

/** Maps service / state-machine / git errors to `{ error }` with a Chinese message. */
export function errorResponse(c: Context, err: unknown): Response {
  if (err instanceof QuestServiceError) return c.json({ error: err.message }, err.status);
  if (err instanceof InvalidTransitionError) {
    return c.json({ error: `委託目前是「${STATUS_LABEL[err.from]}」，不能${ACTION_LABEL[err.action]}` }, 409);
  }
  if (err instanceof BranchExistsError || err instanceof WorktreePathExistsError) return c.json({ error: err.message }, 409);
  console.error(err);
  return c.json({ error: `伺服器發生錯誤：${err instanceof Error ? err.message : String(err)}` }, 500);
}

async function jsonBody(c: Context): Promise<Record<string, unknown>> {
  const body: unknown = await c.req.json().catch(() => undefined);
  return body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

const isString = (v: unknown): v is string => typeof v === 'string';

function parseSource(v: unknown): QuestSource | undefined | 'invalid' {
  if (v === undefined) return undefined;
  const s = v as Partial<{ kind: unknown; key: unknown; url: unknown }> | null;
  if (s?.kind === 'local') return { kind: 'local' };
  if (s?.kind === 'jira' && isString(s.key) && s.key && isString(s.url)) return { kind: 'jira', key: s.key, url: s.url };
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

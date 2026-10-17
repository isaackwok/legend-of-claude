import { Hono } from 'hono';
import type { ChatService } from '../../chats/service.js';
import { errorResponse, jsonBody } from './helpers.js';

const isString = (v: unknown): v is string => typeof v === 'string';

export function chatRoutes(chats: ChatService): Hono {
  const app = new Hono();

  app.post('/', async (c) => {
    const body = await jsonBody(c);
    const { npcId, text, sessionId } = body;
    if (!isString(npcId) || !npcId) return c.json({ error: '請選擇要聊天的冒險者' }, 400);
    if (!isString(text) || !text.trim()) return c.json({ error: '請說點什麼' }, 400);
    if (sessionId !== undefined && (!isString(sessionId) || !sessionId)) return c.json({ error: '請求內容不正確' }, 400);
    try {
      return c.json(await chats.say({ npcId, text, ...(sessionId !== undefined ? { sessionId } : {}) }));
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  return app;
}

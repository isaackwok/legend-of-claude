import { Hono } from 'hono';
import type { ClerkService } from '../../clerk/clerk.js';
import { errorResponse, jsonBody } from './helpers.js';

/**
 * POST /api/jira/import `{ key }` -> 201 new Quest, 200 the key's existing live Quest (R28), or `{ error }`
 * (400 bad/unknown key, 502 clerk failure).
 */
export function jiraRoutes(clerk: ClerkService): Hono {
  const app = new Hono();

  app.post('/import', async (c) => {
    const key = (await jsonBody(c))['key'];
    if (typeof key !== 'string' || !key.trim()) return c.json({ error: '請輸入 Jira 票號' }, 400);
    try {
      const { quest, created } = await clerk.importJiraIssue(key);
      return c.json(quest, created ? 201 : 200);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  return app;
}

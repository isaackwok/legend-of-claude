import { Hono } from 'hono';
import type { ClerkService } from '../../clerk/clerk.js';
import { clerkErrorResponse, jsonBody } from './settlement.js';

/** POST /api/jira/import `{ key }` -> 201 Quest, or `{ error }` (400 bad/unknown key, 502 clerk failure). */
export function jiraRoutes(clerk: ClerkService): Hono {
  const app = new Hono();

  app.post('/import', async (c) => {
    const key = (await jsonBody(c))['key'];
    if (typeof key !== 'string' || !key.trim()) return c.json({ error: '請輸入 Jira 票號' }, 400);
    try {
      return c.json(await clerk.importJiraIssue(key), 201);
    } catch (err) {
      return clerkErrorResponse(c, err);
    }
  });

  return app;
}

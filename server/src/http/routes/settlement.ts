import type { Context } from 'hono';
import { Hono } from 'hono';
import type { SettlementChoices } from '@loc/shared';
import { ClerkError, type ClerkService } from '../../clerk/clerk.js';
import { errorResponse } from './quests.js';

export async function jsonBody(c: Context): Promise<Record<string, unknown>> {
  const body: unknown = await c.req.json().catch(() => undefined);
  return body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

/** ClerkError -> its status; everything else as the quest routes map it. */
export function clerkErrorResponse(c: Context, err: unknown): Response {
  if (err instanceof ClerkError) return c.json({ error: err.message }, err.status);
  return errorResponse(c, err);
}

function parseChoices(body: Record<string, unknown>): SettlementChoices | undefined {
  const { pushAndPr, linkPr, openTicket, jiraTransitionId, jiraComment } = body;
  if (typeof pushAndPr !== 'boolean' || typeof linkPr !== 'boolean' || typeof openTicket !== 'boolean') return undefined;
  if (jiraTransitionId !== undefined && typeof jiraTransitionId !== 'string') return undefined;
  if (jiraComment !== undefined && typeof jiraComment !== 'string') return undefined;
  const choices: SettlementChoices = { pushAndPr, linkPr, openTicket };
  if (jiraTransitionId) choices.jiraTransitionId = jiraTransitionId;
  if (jiraComment) choices.jiraComment = jiraComment;
  return choices;
}

/** Mounted under /api/quests: settlement options and 結算. */
export function settlementRoutes(clerk: ClerkService): Hono {
  const app = new Hono();

  app.get('/:id/settlement-options', async (c) => {
    try {
      return c.json(await clerk.settlementOptions(c.req.param('id')));
    } catch (err) {
      return clerkErrorResponse(c, err);
    }
  });

  app.post('/:id/settle', async (c) => {
    const choices = parseChoices(await jsonBody(c));
    if (!choices) return c.json({ error: '結算選項不正確' }, 400);
    try {
      return c.json(await clerk.settle(c.req.param('id'), choices));
    } catch (err) {
      return clerkErrorResponse(c, err);
    }
  });

  return app;
}

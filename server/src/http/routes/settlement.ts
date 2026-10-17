import { Hono } from 'hono';
import type { SettlementChoices } from '@loc/shared';
import type { ClerkService } from '../../clerk/clerk.js';
import { errorResponse, jsonBody } from './helpers.js';

function parseChoices(body: Record<string, unknown>): SettlementChoices | undefined {
  const { pushAndPr, linkPr, openTicket, jiraTransitionId, jiraComment } = body;
  if (typeof pushAndPr !== 'boolean' || typeof linkPr !== 'boolean' || typeof openTicket !== 'boolean') return undefined;
  // Jira transition ids are numeric; anything else never reaches the clerk prompt.
  if (jiraTransitionId !== undefined && (typeof jiraTransitionId !== 'string' || !/^\d*$/.test(jiraTransitionId))) return undefined;
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
      return errorResponse(c, err);
    }
  });

  app.post('/:id/settle', async (c) => {
    const choices = parseChoices(await jsonBody(c));
    if (!choices) return c.json({ error: '結算選項不正確' }, 400);
    try {
      return c.json(await clerk.settle(c.req.param('id'), choices));
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  return app;
}

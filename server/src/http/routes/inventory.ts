import { Hono } from 'hono';
import type { ClerkService } from '../../clerk/clerk.js';
import { clerkErrorResponse } from './settlement.js';

/** 倉庫盤點: GET the stored claude.ai connectors, POST /refresh to take inventory again. */
export function inventoryRoutes(clerk: ClerkService): Hono {
  const app = new Hono();

  app.get('/', async (c) => c.json(await clerk.inventory()));

  app.post('/refresh', async (c) => {
    try {
      return c.json(await clerk.refreshInventory());
    } catch (err) {
      return clerkErrorResponse(c, err);
    }
  });

  return app;
}

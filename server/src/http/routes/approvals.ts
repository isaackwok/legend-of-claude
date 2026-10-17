import { Hono } from 'hono';
import type { ApprovalBroker } from '../../agent/approvals.js';

/** 信鴿: list waiting permission requests and answer one. */
export function approvalRoutes(broker: ApprovalBroker): Hono {
  const app = new Hono();

  app.get('/', (c) => c.json(broker.list()));

  app.post('/:id', async (c) => {
    const body: unknown = await c.req.json().catch(() => undefined);
    const { allow, message } = (body ?? {}) as { allow?: unknown; message?: unknown };
    if (typeof allow !== 'boolean' || (message !== undefined && typeof message !== 'string')) {
      return c.json({ error: '請求內容不正確' }, 400);
    }
    const id = c.req.param('id');
    if (!broker.list().some((a) => a.id === id)) return c.json({ error: '這封信鴿已經處理過或不存在' }, 404);
    broker.resolve(id, message !== undefined ? { allow, message } : { allow });
    return c.body(null, 204);
  });

  return app;
}

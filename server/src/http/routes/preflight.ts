import { Hono } from 'hono';
import type { Preflight } from '@loc/shared';

export function preflightRoutes(getPreflight: () => Preflight): Hono {
  return new Hono().get('/', (c) => c.json(getPreflight()));
}

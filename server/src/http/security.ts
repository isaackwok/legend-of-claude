import { timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import type { Config } from '../config.js';

type AuthConfig = Pick<Config, 'token' | 'allowedOrigins'>;

/** Constant-time token comparison (length is not secret: tokens are fixed-length). */
export function tokenMatches(candidate: string | null | undefined, token: string): boolean {
  if (!candidate) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(token);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** A missing Origin is a non-browser client (server-side tool); browsers always send one. */
export function originAllowed(origin: string | null | undefined, config: AuthConfig): boolean {
  if (origin === undefined || origin === null) return true;
  return config.allowedOrigins.includes(origin);
}

export function bearerToken(header: string | null | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer (.+)$/.exec(header);
  return m?.[1] ?? null;
}

/** Hono middleware: valid `Authorization: Bearer <token>` (401) and, if present, an allowed Origin (403). */
export function requireAuth(config: AuthConfig): MiddlewareHandler {
  return async (c, next) => {
    if (!tokenMatches(bearerToken(c.req.header('Authorization')), config.token)) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    if (!originAllowed(c.req.header('Origin'), config)) {
      return c.json({ error: 'forbidden origin' }, 403);
    }
    await next();
  };
}

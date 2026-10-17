import { timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import type { Config } from '../config.js';

type AuthConfig = Pick<Config, 'token' | 'allowedOrigins'>;
type HostConfig = Pick<Config, 'port' | 'clientPort'>;

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

/** DNS-rebinding guard: Host must be loopback on one of our two ports (also covers a dev proxy rewriting Host). */
export function hostAllowed(host: string | null | undefined, config: HostConfig): boolean {
  if (!host) return false;
  return [config.port, config.clientPort].some((p) => host === `127.0.0.1:${p}` || host === `localhost:${p}`);
}

export function bearerToken(header: string | null | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer (.+)$/.exec(header);
  return m?.[1] ?? null;
}

/** Hono middleware: 403 unless the Host header is an allowed loopback host. */
export function requireHost(config: HostConfig): MiddlewareHandler {
  return async (c, next) => {
    if (!hostAllowed(c.req.header('Host'), config)) return c.json({ error: 'forbidden host' }, 403);
    await next();
  };
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

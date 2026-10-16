import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import type { MiddlewareHandler } from 'hono';
import type { Config } from '../config.js';
import { hostAllowed } from './security.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
};

/** Resolves a request path to a regular file strictly inside root, or null (traversal, NUL, directories, missing). */
async function resolveInside(root: string, rawPath: string): Promise<string | null> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  const file = resolve(root, `.${decoded}`);
  if (file !== root && !file.startsWith(root + sep)) return null;
  try {
    return (await stat(file)).isFile() ? file : null;
  } catch {
    return null;
  }
}

/**
 * Serves the built client from `dir` with SPA fallback to index.html. Not for /api or /ws.
 * The Host allowlist applies here too (DNS-rebinding defense); the page itself needs no token.
 */
export function staticClient(dir: string, config: Pick<Config, 'port' | 'clientPort'>): MiddlewareHandler {
  const root = resolve(dir);
  return async (c, next) => {
    const path = c.req.path;
    if (path === '/api' || path.startsWith('/api/') || path === '/ws' || path.startsWith('/ws/')) return next();
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return next();
    if (!hostAllowed(c.req.header('Host'), config)) return c.json({ error: 'forbidden host' }, 403);
    let file = await resolveInside(root, path);
    if (!file) {
      // A missing asset (has an extension) is a real 404; any other path is a client-side route.
      if (extname(path) !== '') return c.text('Not Found', 404);
      file = await resolveInside(root, '/index.html');
      if (!file) return c.text('Not Found', 404);
    }
    const isIndex = file === join(root, 'index.html');
    const body = await readFile(file);
    return c.body(new Uint8Array(body), 200, {
      'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': isIndex ? 'no-cache' : 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    });
  };
}

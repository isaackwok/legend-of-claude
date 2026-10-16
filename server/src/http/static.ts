import { existsSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
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

const isInside = (root: string, file: string) => file === root || file.startsWith(root + sep);
const hasDotSegment = (path: string) => path.split('/').some((segment) => segment.startsWith('.'));
function safeDecode(path: string): string | undefined {
  try {
    return decodeURIComponent(path);
  } catch {
    return undefined;
  }
}

/**
 * Resolves a request path to a regular file strictly inside root, or null: NUL or backslash, any
 * segment starting with '.' (`..`, `.`, dotfiles), directories, missing files, and — after resolving
 * symlinks on both sides — anything whose real path leaves the real root.
 */
async function resolveInside(root: string, rawPath: string): Promise<string | null> {
  const decoded = safeDecode(rawPath);
  if (decoded === undefined) return null;
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  if (hasDotSegment(decoded)) return null;
  const file = resolve(root, `.${decoded}`);
  if (!isInside(root, file)) return null;
  try {
    const realRoot = await realpath(root);
    const realFile = await realpath(file);
    if (!isInside(realRoot, realFile)) return null;
    return (await stat(realFile)).isFile() ? realFile : null;
  } catch {
    return null;
  }
}

/** A startup warning when `dir` has no built client (`npm start` builds it first). */
export function clientDirWarning(dir: string): string | undefined {
  if (existsSync(join(dir, 'index.html'))) return undefined;
  return `找不到前端建置檔 ${join(dir, 'index.html')}，頁面會是 404。請先執行 npm run build -w @loc/client（npm start 會自動建置）。`;
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
    // Dotfiles and dot directories are never served, not even as a client-side route.
    if (hasDotSegment(safeDecode(path) ?? path)) return c.text('Not Found', 404);
    let file = await resolveInside(root, path);
    let fallback = false;
    if (!file) {
      // A missing asset (has an extension) is a real 404; any other path is a client-side route.
      if (extname(path) !== '') return c.text('Not Found', 404);
      file = await resolveInside(root, '/index.html');
      if (!file) return c.text('Not Found', 404);
      fallback = true;
    }
    // Only Vite's content-hashed bundles under /assets/ may be cached forever.
    const immutable = !fallback && path.startsWith('/assets/');
    const body = await readFile(file);
    return c.body(new Uint8Array(body), 200, {
      'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
  };
}

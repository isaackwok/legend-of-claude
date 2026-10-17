import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

describe('loadConfig', () => {
  it('uses defaults, a fresh 32-byte hex token, and the allowed origins', () => {
    const a = loadConfig({});
    const b = loadConfig({});
    expect(a.dataDir).toBe(join(homedir(), '.legend-of-claude'));
    expect(a.port).toBe(4517);
    expect(a.clientPort).toBe(4518);
    expect(a.token).toMatch(/^[0-9a-f]{64}$/);
    expect(a.token).not.toBe(b.token);
    expect(a.allowedOrigins).toEqual([
      'http://127.0.0.1:4518', 'http://localhost:4518', 'http://127.0.0.1:4517', 'http://localhost:4517',
    ]);
  });

  it('honours LOC_DATA_DIR and expands ~', () => {
    expect(loadConfig({ LOC_DATA_DIR: '/tmp/x' }).dataDir).toBe('/tmp/x');
    expect(loadConfig({ LOC_DATA_DIR: '~/foo' }).dataDir).toBe(join(homedir(), 'foo'));
  });
});

import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Config {
  dataDir: string;
  port: number;
  clientPort: number;
  token: string;
  allowedOrigins: string[];
}

const PORT = 4517;
const CLIENT_PORT = 4518;

function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = expandHome(env['LOC_DATA_DIR'] || join('~', '.legend-of-claude'));
  return {
    dataDir,
    port: PORT,
    clientPort: CLIENT_PORT,
    token: randomBytes(32).toString('hex'),
    allowedOrigins: [
      `http://127.0.0.1:${CLIENT_PORT}`,
      `http://localhost:${CLIENT_PORT}`,
      `http://127.0.0.1:${PORT}`,
      `http://localhost:${PORT}`,
    ],
  };
}

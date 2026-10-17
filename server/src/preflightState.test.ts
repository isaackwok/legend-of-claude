import { describe, expect, it } from 'vitest';
import type { Preflight, ServerMessage } from '@loc/shared';
import { PreflightState } from './preflightState.js';

const ok: Preflight = { ignoredEnvVars: [], loggedIn: true, warnings: [] };
const bad: Preflight = { ignoredEnvVars: [], loggedIn: false, warnings: ['請先登入'] };

describe('PreflightState', () => {
  it('serves the placeholder until set, without broadcasting', () => {
    const sent: ServerMessage[] = [];
    const s = new PreflightState(ok, (m) => sent.push(m));
    expect(s.get()).toBe(ok);
    expect(sent).toEqual([]);
  });
  it('set updates the value later snapshots read and broadcasts a preflight message', () => {
    const sent: ServerMessage[] = [];
    const s = new PreflightState(ok, (m) => sent.push(m));
    s.set(bad);
    expect(s.get()).toBe(bad);
    expect(sent).toEqual([{ type: 'preflight', preflight: bad }]);
  });
});

import type { Preflight, ServerMessage } from '@loc/shared';

/** Latest startup-check result. Snapshots read `get()`; `set()` also pushes the new value to connected clients. */
export class PreflightState {
  constructor(
    private current: Preflight,
    private readonly broadcast: (msg: ServerMessage) => void,
  ) {}

  get(): Preflight {
    return this.current;
  }

  set(next: Preflight): void {
    this.current = next;
    this.broadcast({ type: 'preflight', preflight: next });
  }
}

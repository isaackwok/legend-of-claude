import { randomUUID } from 'node:crypto';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { Approval, ServerMessage } from '@loc/shared';

export type ApprovalChange = Extract<ServerMessage, { type: 'approval' } | { type: 'approval_resolved' }>;

export const DEFAULT_DENY_MESSAGE = '會長拒絕了這個請求';
export const CANCELLED_MESSAGE = '請求已取消';

interface Pending {
  approval: Approval;
  settle: (result: PermissionResult) => void;
}

/** 信鴿: permission requests from running NPCs, waiting for the guild master's answer. */
export class ApprovalBroker {
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<(change: ApprovalChange) => void>();

  request(meta: Omit<Approval, 'id' | 'createdAt'>, signal: AbortSignal): Promise<PermissionResult> {
    if (signal.aborted) return Promise.resolve({ behavior: 'deny', message: CANCELLED_MESSAGE });
    const approval: Approval = { ...meta, id: randomUUID(), createdAt: Date.now() };
    return new Promise<PermissionResult>((resolve) => {
      const onAbort = () => this.finish(approval.id, { behavior: 'deny', message: CANCELLED_MESSAGE });
      this.pending.set(approval.id, {
        approval,
        settle: (result) => {
          signal.removeEventListener('abort', onAbort);
          resolve(result);
        },
      });
      signal.addEventListener('abort', onAbort, { once: true });
      this.emit({ type: 'approval', approval });
    });
  }

  /** Answer a request; unknown or already-answered ids are ignored. */
  resolve(id: string, decision: { allow: boolean; message?: string }): void {
    this.finish(id, decision.allow ? { behavior: 'allow' } : { behavior: 'deny', message: decision.message ?? DEFAULT_DENY_MESSAGE });
  }

  /** Deny every pending request of a session (e.g. the NPC was recalled). */
  cancelForSession(sessionId: string): void {
    for (const p of [...this.pending.values()]) {
      if (p.approval.sessionId === sessionId) this.finish(p.approval.id, { behavior: 'deny', message: CANCELLED_MESSAGE });
    }
  }

  list(): Approval[] {
    return [...this.pending.values()].map((p) => p.approval);
  }

  /** Subscribe to `approval` / `approval_resolved` messages; returns an unsubscribe function. */
  onChange(cb: (change: ApprovalChange) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private finish(id: string, result: PermissionResult): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    p.settle(result);
    this.emit({ type: 'approval_resolved', id });
  }

  private emit(change: ApprovalChange): void {
    for (const cb of this.listeners) {
      try {
        cb(change);
      } catch {
        // A failing listener must not break the approval flow.
      }
    }
  }
}

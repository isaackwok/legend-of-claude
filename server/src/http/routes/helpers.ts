import type { Context } from 'hono';
import { InvalidTransitionError, STATUS_LABEL, type QuestAction } from '@loc/shared';
import { ClerkError } from '../../clerk/clerk.js';
import { BranchExistsError, WorktreePathExistsError } from '../../git/worktree.js';
import { QuestServiceError } from '../../quests/service.js';

const ACTION_LABEL: Record<QuestAction, string> = {
  start: '出發',
  finish: '完成',
  interrupt: '中斷',
  reject: '退回',
  accept: '驗收',
  abandon: '放棄',
};

export const BAD_REQUEST = '請求內容不正確';

/** Maps service / clerk / state-machine / git errors to `{ error }` with a Chinese message. */
export function errorResponse(c: Context, err: unknown): Response {
  if (err instanceof QuestServiceError || err instanceof ClerkError) return c.json({ error: err.message }, err.status);
  if (err instanceof InvalidTransitionError) {
    return c.json({ error: `委託目前是「${STATUS_LABEL[err.from]}」，不能${ACTION_LABEL[err.action]}` }, 409);
  }
  if (err instanceof BranchExistsError || err instanceof WorktreePathExistsError) return c.json({ error: err.message }, 409);
  console.error(err);
  return c.json({ error: `伺服器發生錯誤：${err instanceof Error ? err.message : String(err)}` }, 500);
}

/** The JSON body as an object; anything else (missing, invalid, array) becomes `{}`. */
export async function jsonBody(c: Context): Promise<Record<string, unknown>> {
  const body: unknown = await c.req.json().catch(() => undefined);
  return body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

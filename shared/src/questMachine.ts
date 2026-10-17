import type { QuestAction, QuestStatus } from './types.js';

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: QuestStatus,
    public readonly action: QuestAction,
  ) {
    super(`無效的委託狀態轉換：${from} --${action}-->`);
    this.name = 'InvalidTransitionError';
  }
}

const TRANSITIONS: Partial<Record<QuestStatus, Partial<Record<QuestAction, QuestStatus>>>> = {
  open: { start: 'adventuring', abandon: 'abandoned' },
  adventuring: { finish: 'review', interrupt: 'open' },
  review: { reject: 'adventuring', accept: 'done', abandon: 'abandoned' },
};

export function transition(status: QuestStatus, action: QuestAction): QuestStatus {
  const next = TRANSITIONS[status]?.[action];
  if (next === undefined) throw new InvalidTransitionError(status, action);
  return next;
}

export const STATUS_LABEL: Record<QuestStatus, string> = {
  open: '待接委託',
  adventuring: '冒險中',
  review: '待驗收',
  done: '已完成',
  abandoned: '已放棄',
};

export const BOARD_COLUMNS: QuestStatus[] = ['open', 'adventuring', 'review', 'done'];

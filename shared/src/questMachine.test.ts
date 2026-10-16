import { describe, expect, it } from 'vitest';
import {
  BOARD_COLUMNS,
  InvalidTransitionError,
  STATUS_LABEL,
  transition,
} from './questMachine.js';

describe('transition', () => {
  it.each([
    ['open', 'start', 'adventuring'],
    ['adventuring', 'finish', 'review'],
    ['adventuring', 'interrupt', 'open'],
    ['review', 'reject', 'adventuring'],
    ['review', 'accept', 'done'],
    ['open', 'abandon', 'abandoned'],
    ['review', 'abandon', 'abandoned'],
  ] as const)('%s --%s--> %s', (from, action, to) => {
    expect(transition(from, action)).toBe(to);
  });

  it.each([
    ['done', 'start'],
    ['adventuring', 'accept'],
    ['abandoned', 'start'],
    ['open', 'accept'],
    ['open', 'finish'],
    ['adventuring', 'abandon'],
    ['done', 'abandon'],
  ] as const)('%s --%s throws InvalidTransitionError', (from, action) => {
    expect(() => transition(from, action)).toThrow(InvalidTransitionError);
  });
});

describe('labels and board', () => {
  it('STATUS_LABEL uses the game terms', () => {
    expect(STATUS_LABEL).toEqual({
      open: '待接委託',
      adventuring: '冒險中',
      review: '待驗收',
      done: '已完成',
      abandoned: '已放棄',
    });
  });

  it('BOARD_COLUMNS lists the four board statuses in order', () => {
    expect(BOARD_COLUMNS).toEqual(['open', 'adventuring', 'review', 'done']);
  });
});

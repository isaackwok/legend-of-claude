import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initialState, useGame } from '../state/store';
import { Nav } from './Nav';

beforeEach(() => useGame.setState(initialState()));
afterEach(cleanup);

describe('Nav', () => {
  it('switches panels and marks the current one', () => {
    render(<Nav />);
    expect(screen.getByRole('button', { name: '佈告欄' }).getAttribute('aria-current')).toBe('page');
    fireEvent.click(screen.getByRole('button', { name: '地下城地圖' }));
    expect(useGame.getState().ui.panel).toBe('dungeons');
    expect(screen.getByRole('button', { name: '地下城地圖' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('button', { name: '佈告欄' }).getAttribute('aria-current')).toBeNull();
  });

  it('shows the pending approval count on the mailbox badge', () => {
    render(<Nav />);
    expect(screen.queryByRole('button', { name: /3 件待批准/ })).toBeNull();
    act(() =>
      useGame.setState({
        approvals: Object.fromEntries(
          ['a', 'b', 'c'].map((id) => [id, { id, npcId: 'n', sessionId: 's', toolName: 'Bash', summary: '', createdAt: 1 }]),
        ),
      }),
    );
    const mailbox = screen.getByRole('button', { name: '信箱，3 件待批准' });
    expect(mailbox.textContent).toContain('3');
  });
});

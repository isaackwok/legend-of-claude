import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initialState, useGame } from '../state/store';
import { ConnectionBanner } from './ConnectionBanner';

beforeEach(() => useGame.setState(initialState()));
afterEach(cleanup);

describe('ConnectionBanner', () => {
  it('stays hidden until enough consecutive failures, and hides once open', () => {
    render(<ConnectionBanner />);
    expect(screen.queryByRole('alert')).toBeNull();
    act(() => useGame.getState().setConnection('retrying', 2));
    expect(screen.queryByRole('alert')).toBeNull();
    act(() => useGame.getState().setConnection('retrying', 3));
    expect(screen.getByRole('alert').textContent).toBe('連線中斷，請用伺服器印出的網址重新開啟');
    act(() => useGame.getState().setConnection('open', 0));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { NOT_LOGGED_IN_WARNING } from '@loc/shared';
import { Preflight } from './Preflight';

afterEach(cleanup);

describe('Preflight banner', () => {
  it('renders nothing when all is well', () => {
    const { container } = render(<Preflight preflight={{ ignoredEnvVars: [], loggedIn: true, warnings: [] }} />);
    expect(container.innerHTML).toBe('');
  });
  it('notes ignored env vars', () => {
    render(<Preflight preflight={{ ignoredEnvVars: ['ANTHROPIC_API_KEY'], loggedIn: true, warnings: [] }} />);
    expect(screen.getByText(/已忽略 ANTHROPIC_API_KEY，NPC 會使用 claude\.ai 訂閱/)).toBeTruthy();
  });
  it('warns loudly when not logged in', () => {
    render(<Preflight preflight={{ ignoredEnvVars: [], loggedIn: false, warnings: [] }} />);
    expect(screen.getByRole('alert').textContent).toMatch(/尚未登入/);
  });
  it('shows the not-logged-in message once, not again as a warning', () => {
    const { container } = render(<Preflight preflight={{ ignoredEnvVars: [], loggedIn: false, warnings: [NOT_LOGGED_IN_WARNING, '其他提醒'] }} />);
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(container.textContent).not.toContain(NOT_LOGGED_IN_WARNING);
    expect(container.textContent).toContain('其他提醒');
  });
});

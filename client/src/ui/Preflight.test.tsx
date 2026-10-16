import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
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
});

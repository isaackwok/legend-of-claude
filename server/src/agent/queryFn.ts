import { query } from '@anthropic-ai/claude-agent-sdk';

/** Injection seam so tests can replace the Agent SDK's `query`. */
export type QueryFn = typeof query;

export const realQueryFn: QueryFn = query;

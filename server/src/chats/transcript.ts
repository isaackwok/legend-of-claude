import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import type { TranscriptBlock, TranscriptMessage } from '@loc/shared';
import { resultText, summarizeTool } from '../agent/translate.js';

/** Tool output kept per tool_result block; the rest stays in the session store. */
export const TOOL_OUTPUT_MAX = 2000;

type RawBlock = { type?: unknown; [k: string]: unknown };

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

function blockOf(b: RawBlock): TranscriptBlock | undefined {
  switch (b.type) {
    case 'text':
      return typeof b['text'] === 'string' && b['text'] !== '' ? { type: 'text', text: b['text'] } : undefined;
    case 'tool_use': {
      if (typeof b['id'] !== 'string' || typeof b['name'] !== 'string') return undefined;
      const input = isObject(b['input']) ? b['input'] : {};
      return { type: 'tool_use', id: b['id'], name: b['name'], summary: summarizeTool(b['name'], input), input };
    }
    case 'tool_result':
      if (typeof b['tool_use_id'] !== 'string') return undefined;
      return { type: 'tool_result', toolUseId: b['tool_use_id'], isError: b['is_error'] === true, output: resultText(b['content']).slice(0, TOOL_OUTPUT_MAX) };
    default:
      // thinking, redacted_thinking, images, ... are not shown in the crystal ball.
      return undefined;
  }
}

/** SDK transcript messages -> what the client renders. Messages left without any block are dropped. */
export function toTranscript(messages: SessionMessage[]): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  for (const m of messages) {
    if (m.type !== 'user' && m.type !== 'assistant') continue;
    const content = isObject(m.message) ? m.message['content'] : undefined;
    const raw: RawBlock[] = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? (content as RawBlock[]) : [];
    const blocks = raw.flatMap((b) => (isObject(b) ? (blockOf(b) ?? []) : []));
    if (blocks.length > 0) out.push({ role: m.type, blocks });
  }
  return out;
}

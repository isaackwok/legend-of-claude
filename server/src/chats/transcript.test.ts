import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { TOOL_OUTPUT_MAX, toTranscript } from './transcript.js';

const msg = (type: 'user' | 'assistant' | 'system', content: unknown, uuid = 'u'): SessionMessage => ({
  type,
  uuid,
  session_id: 's',
  message: { role: type, content },
  parent_tool_use_id: null,
  parent_agent_id: null,
});

describe('toTranscript', () => {
  it('turns string content and text blocks into text blocks', () => {
    expect(toTranscript([msg('user', '你好'), msg('assistant', [{ type: 'text', text: '哈囉' }])])).toEqual([
      { role: 'user', blocks: [{ type: 'text', text: '你好' }] },
      { role: 'assistant', blocks: [{ type: 'text', text: '哈囉' }] },
    ]);
  });

  it('keeps tool name, input summary and input; drops thinking blocks', () => {
    const out = toTranscript([
      msg('assistant', [
        { type: 'thinking', thinking: '想一下', signature: 'x' },
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/repo/a.ts' } },
        { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm test' } },
        { type: 'tool_use', id: 't3', name: 'mcp__claude_ai_Slack__send', input: {} },
      ]),
    ]);
    expect(out).toEqual([
      {
        role: 'assistant',
        blocks: [
          { type: 'tool_use', id: 't1', name: 'Read', summary: '/repo/a.ts', input: { file_path: '/repo/a.ts' } },
          { type: 'tool_use', id: 't2', name: 'Bash', summary: 'npm test', input: { command: 'npm test' } },
          { type: 'tool_use', id: 't3', name: 'mcp__claude_ai_Slack__send', summary: 'claude_ai_Slack / send', input: {} },
        ],
      },
    ]);
  });

  it('reads tool results from strings and text blocks, flags errors, and cuts the output at 2000 chars', () => {
    const long = 'x'.repeat(TOOL_OUTPUT_MAX + 500);
    const out = toTranscript([
      msg('user', [
        { type: 'tool_result', tool_use_id: 't1', content: 'ok' },
        { type: 'tool_result', tool_use_id: 't2', is_error: true, content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
        { type: 'tool_result', tool_use_id: 't3', content: long },
      ]),
    ]);
    const blocks = out[0]!.blocks;
    expect(blocks[0]).toEqual({ type: 'tool_result', toolUseId: 't1', isError: false, output: 'ok' });
    expect(blocks[1]).toEqual({ type: 'tool_result', toolUseId: 't2', isError: true, output: 'a\nb' });
    expect(blocks[2]).toMatchObject({ type: 'tool_result', toolUseId: 't3' });
    expect((blocks[2] as { output: string }).output).toBe(long.slice(0, 2000));
  });

  it('drops messages with nothing to show, system messages and malformed blocks', () => {
    expect(
      toTranscript([
        msg('assistant', [{ type: 'thinking', thinking: 'hm' }]),
        msg('system', 'compact'),
        msg('user', [{ type: 'image', source: {} }, null, 3, { type: 'tool_use' }]),
        msg('user', ''),
        { ...msg('user', 'x'), message: null },
      ]),
    ).toEqual([]);
  });
});

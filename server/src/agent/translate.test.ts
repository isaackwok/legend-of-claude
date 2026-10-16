import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { summarizeTool, translate, type ToolTracker } from './translate.js';

const ctx = { npcId: 'npc-1', questId: 'q-1' };
const asMsg = (m: unknown) => m as SDKMessage;
const assistant = (content: unknown[], parent: string | null = null) =>
  asMsg({ type: 'assistant', message: { role: 'assistant', content }, parent_tool_use_id: parent, session_id: 's-1', uuid: 'u' });
const toolResults = (content: unknown[], parent: string | null = null) =>
  asMsg({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: parent, session_id: 's-1' });

describe('summarizeTool', () => {
  it('summarizes common tools', () => {
    expect(summarizeTool('Bash', { command: 'npm test' })).toBe('npm test');
    expect(summarizeTool('Edit', { file_path: '/r/a.ts' })).toBe('/r/a.ts');
    expect(summarizeTool('Write', { file_path: '/r/b.ts' })).toBe('/r/b.ts');
    expect(summarizeTool('Read', { file_path: '/r/c.ts' })).toBe('/r/c.ts');
    expect(summarizeTool('mcp__jira__getIssue', {})).toBe('jira / getIssue');
    expect(summarizeTool('WebSearch', { query: 'x' })).toBe('WebSearch');
    expect(summarizeTool('Bash', {})).toBe('Bash');
  });
});

describe('translate', () => {
  it('turns two Read tool_use blocks into two tool_start events labelled with the paths', () => {
    const events = translate(
      assistant([
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/repo/a.ts' } },
        { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/repo/b.ts' } },
      ]),
      ctx,
    );
    expect(events.map((e) => [e.kind, e.label, e.toolUseId])).toEqual([
      ['tool_start', '/repo/a.ts', 't1'],
      ['tool_start', '/repo/b.ts', 't2'],
    ]);
    expect(events[0]).toMatchObject({ npcId: 'npc-1', questId: 'q-1', sessionId: 's-1', parentToolUseId: null });
    expect(typeof events[0]!.id).toBe('string');
    expect(events[0]!.id).not.toBe(events[1]!.id);
    expect(typeof events[0]!.at).toBe('number');
  });

  it('labels MCP tools as server / tool', () => {
    const [e] = translate(assistant([{ type: 'tool_use', id: 't1', name: 'mcp__jira__getIssue', input: { key: 'X-1' } }]), ctx);
    expect(e).toMatchObject({ kind: 'tool_start', label: 'jira / getIssue' });
  });

  it('turns text blocks into text events and ignores thinking blocks', () => {
    const events = translate(assistant([{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: '我來看看。' }]), ctx);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'text', detail: '我來看看。' });
  });

  it('maps the Agent tool to subagent_start and its result to subagent_end', () => {
    const tracker: ToolTracker = new Map();
    const [start] = translate(assistant([{ type: 'tool_use', id: 'a1', name: 'Agent', input: { description: '調查測試', prompt: '...' } }]), { ...ctx, tracker });
    expect(start).toMatchObject({ kind: 'subagent_start', label: '調查測試', toolUseId: 'a1' });
    const [end] = translate(toolResults([{ type: 'tool_result', tool_use_id: 'a1', content: [{ type: 'text', text: '報告' }] }]), { ...ctx, tracker });
    expect(end).toMatchObject({ kind: 'subagent_end', toolUseId: 'a1', detail: '報告' });
  });

  it('maps a background Bash to background_start and its result to background_end', () => {
    const tracker: ToolTracker = new Map();
    const [start] = translate(
      assistant([{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'npm run dev', run_in_background: true } }]),
      { ...ctx, tracker },
    );
    expect(start).toMatchObject({ kind: 'background_start', label: 'npm run dev' });
    const [end] = translate(toolResults([{ type: 'tool_result', tool_use_id: 'b1', content: 'started' }]), { ...ctx, tracker });
    expect(end).toMatchObject({ kind: 'background_end', detail: 'started' });
  });

  it('maps tool_result to tool_end with the result text, marks failures, keeps parent_tool_use_id', () => {
    const tracker: ToolTracker = new Map();
    translate(assistant([{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }], 'a1'), { ...ctx, tracker });
    const [end] = translate(
      toolResults([{ type: 'tool_result', tool_use_id: 't1', content: 'boom', is_error: true }], 'a1'),
      { ...ctx, tracker },
    );
    expect(end).toMatchObject({ kind: 'tool_end', label: 'npm test（失敗）', detail: 'boom', toolUseId: 't1', parentToolUseId: 'a1' });
  });

  it('treats an untracked tool_result as tool_end and truncates long details', () => {
    const [end] = translate(toolResults([{ type: 'tool_result', tool_use_id: 'zz', content: 'x'.repeat(5000) }]), ctx);
    expect(end!.kind).toBe('tool_end');
    expect(end!.detail!.length).toBeLessThanOrEqual(2001);
  });

  it('turns compact_boundary into compact', () => {
    const [e] = translate(asMsg({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 1 }, session_id: 's-1' }), ctx);
    expect(e).toMatchObject({ kind: 'compact', label: '正在整理筆記' });
  });

  it('turns a success result into result and an error result into error', () => {
    const [ok] = translate(asMsg({ type: 'result', subtype: 'success', is_error: false, result: '完成了', session_id: 's-1' }), ctx);
    expect(ok).toMatchObject({ kind: 'result', detail: '完成了' });
    const [bad] = translate(asMsg({ type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['too many turns'], session_id: 's-1' }), ctx);
    expect(bad).toMatchObject({ kind: 'error', label: '冒險失敗', detail: 'too many turns' });
    const [apiErr] = translate(asMsg({ type: 'result', subtype: 'success', is_error: true, result: 'API Error', session_id: 's-1' }), ctx);
    expect(apiErr).toMatchObject({ kind: 'error', detail: 'API Error' });
  });

  it('returns [] for other messages', () => {
    expect(translate(asMsg({ type: 'system', subtype: 'init', session_id: 's-1' }), ctx)).toEqual([]);
    expect(translate(asMsg({ type: 'system', subtype: 'post_turn_summary', session_id: 's-1' }), ctx)).toEqual([]);
    expect(translate(asMsg({ type: 'user', message: { role: 'user', content: '你好' }, parent_tool_use_id: null }), ctx)).toEqual([]);
  });
});

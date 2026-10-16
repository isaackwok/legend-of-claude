import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { summarizeTool, ToolTracker, translate } from './translate.js';

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

  it('maps a foreground Agent tool to subagent_start and its tool_result to subagent_end', () => {
    const tracker = new ToolTracker();
    const [start] = translate(assistant([{ type: 'tool_use', id: 'a1', name: 'Agent', input: { description: '調查測試', prompt: '...' } }]), { ...ctx, tracker });
    expect(start).toMatchObject({ kind: 'subagent_start', label: '調查測試', toolUseId: 'a1' });
    const [end] = translate(toolResults([{ type: 'tool_result', tool_use_id: 'a1', content: [{ type: 'text', text: '報告' }] }]), { ...ctx, tracker });
    expect(end).toMatchObject({ kind: 'subagent_end', toolUseId: 'a1', detail: '報告' });
  });

  const sys = (subtype: string, fields: Record<string, unknown>) => asMsg({ type: 'system', subtype, session_id: 's-1', uuid: 'u', ...fields });

  it('ends a background subagent on task_notification, not on its placeholder tool_result', () => {
    const tracker = new ToolTracker();
    const c = { ...ctx, tracker };
    const [start] = translate(assistant([{ type: 'tool_use', id: 'a1', name: 'Agent', input: { description: '調查測試', prompt: '...' } }]), c);
    expect(start).toMatchObject({ kind: 'subagent_start', label: '調查測試' });
    expect(translate(sys('task_started', { task_id: 'task-1', tool_use_id: 'a1', description: '調查測試', is_backgrounded: true }), c)).toEqual([]);
    expect(translate(toolResults([{ type: 'tool_result', tool_use_id: 'a1', content: 'Async agent launched' }]), c)).toEqual([]);
    const [end] = translate(sys('task_notification', { task_id: 'task-1', tool_use_id: 'a1', status: 'completed', summary: '找到原因', output_file: '/tmp/o' }), c);
    expect(end).toMatchObject({ kind: 'subagent_end', label: '調查測試', detail: '找到原因', toolUseId: 'a1', parentToolUseId: null });
    // Ended once: a repeated notification is ignored.
    expect(translate(sys('task_notification', { task_id: 'task-1', tool_use_id: 'a1', status: 'completed', summary: 'x', output_file: '' }), c)).toEqual([]);
  });

  it('treats a task moved to the background by task_updated as backgrounded', () => {
    const tracker = new ToolTracker();
    const c = { ...ctx, tracker };
    translate(assistant([{ type: 'tool_use', id: 'a2', name: 'Agent', input: { description: '慢慢查' } }]), c);
    translate(sys('task_started', { task_id: 'task-2', tool_use_id: 'a2', description: '慢慢查', is_backgrounded: false }), c);
    translate(sys('task_updated', { task_id: 'task-2', patch: { is_backgrounded: true } }), c);
    expect(translate(toolResults([{ type: 'tool_result', tool_use_id: 'a2', content: 'moved to background' }]), c)).toEqual([]);
    const [end] = translate(sys('task_notification', { task_id: 'task-2', tool_use_id: 'a2', status: 'stopped', summary: '中止', output_file: '' }), c);
    expect(end).toMatchObject({ kind: 'subagent_end', label: '慢慢查（已停止）' });
  });

  it('maps a background Bash to background_start and a failed task_notification to background_end', () => {
    const tracker = new ToolTracker();
    const c = { ...ctx, tracker };
    const [start] = translate(
      assistant([{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'npm run dev', run_in_background: true } }]),
      c,
    );
    expect(start).toMatchObject({ kind: 'background_start', label: 'npm run dev' });
    expect(translate(toolResults([{ type: 'tool_result', tool_use_id: 'b1', content: 'Command running in background' }]), c)).toEqual([]);
    const [end] = translate(sys('task_notification', { task_id: 'bash-1', tool_use_id: 'b1', status: 'failed', summary: 'exit 1', output_file: '' }), c);
    expect(end).toMatchObject({ kind: 'background_end', label: 'npm run dev（失敗）', detail: 'exit 1', toolUseId: 'b1' });
  });

  it('ignores task_notification for foreground or unknown tools', () => {
    const tracker = new ToolTracker();
    const c = { ...ctx, tracker };
    translate(assistant([{ type: 'tool_use', id: 'a3', name: 'Agent', input: { description: '前景' } }]), c);
    expect(translate(sys('task_notification', { task_id: 't', tool_use_id: 'a3', status: 'completed', summary: '', output_file: '' }), c)).toEqual([]);
    expect(translate(sys('task_notification', { task_id: 't', tool_use_id: 'zz', status: 'completed', summary: '', output_file: '' }), c)).toEqual([]);
    const [end] = translate(toolResults([{ type: 'tool_result', tool_use_id: 'a3', content: '報告' }]), c);
    expect(end).toMatchObject({ kind: 'subagent_end', label: '前景' });
  });

  it('maps tool_result to tool_end with the result text, marks failures, keeps parent_tool_use_id', () => {
    const tracker = new ToolTracker();
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

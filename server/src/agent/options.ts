import type { CanUseTool, Options, SessionStore } from '@anthropic-ai/claude-agent-sdk';
import type { ClassId, Npc, Settings } from '@loc/shared';

/** Latest model per tier in this environment; the only place model IDs are spelled. */
export const MODELS = { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5' } as const;

export const CLASS_TEMPLATES: Record<ClassId, Pick<Npc, 'model' | 'effort' | 'equipment'>> = {
  warrior: { model: MODELS.opus, effort: 'high', equipment: { connectorPrefixes: [], readOnly: false } },
  scholar: { model: MODELS.sonnet, effort: 'medium', equipment: { connectorPrefixes: [], readOnly: true } },
  scout: { model: MODELS.haiku, effort: 'low', equipment: { connectorPrefixes: [], readOnly: true } },
  freeman: { model: MODELS.sonnet, effort: 'medium', equipment: { connectorPrefixes: [], readOnly: false } },
};

export const READ_ONLY_DENY = ['Edit', 'Write', 'NotebookEdit'] as const;

/** Pushing and opening PRs is done by the game at settlement, never by an NPC (spike: auto mode allows push). */
export const GIT_PUSH_DENY = ['Bash(git push *)', 'Bash(git push)'] as const;

/** Connector prefixes found by the last inventory; `[]` before one exists (then no connector is denied). */
export function connectorPrefixesFrom(settings: Settings): string[] {
  return settings.connectors?.map((c) => c.prefix) ?? [];
}

/**
 * Canonical connector prefix (R19) for an MCP server name: the bare server segment of its tool names,
 * e.g. `claude.ai Google Calendar` -> `claude_ai_Google_Calendar`. Mirrors the CLI's normalization
 * (spike rule a in docs/superpowers/spikes/2026-10-16-results.md).
 */
export function connectorPrefix(serverName: string): string {
  let r = serverName.replace(/[^a-zA-Z0-9_-]/g, '_');
  if (serverName.startsWith('claude.ai ')) r = r.replace(/_+/g, '_').replace(/^_|_$/g, '');
  return r;
}

/**
 * The one place prefix spelling is normalized: `slack`, `mcp__slack__` and `mcp__slack` all become
 * `slack` (the inventory stores the bare form, e.g. `claude_ai_Slack`; equipment may use either).
 */
export function normalizeConnectorPrefix(prefix: string): string {
  return prefix.replace(/^mcp__/, '').replace(/__$/, '');
}

/** Deny rule hiding one connector's tools, e.g. `slack` or `mcp__slack__` -> `mcp__slack__*`. */
export function connectorDenyRule(prefix: string): string {
  return `mcp__${normalizeConnectorPrefix(prefix)}__*`;
}

/** R29: tools the built-in clerk never gets. */
export const CLERK_TOOL_DENY = ['Bash'] as const;

const CLERK_CONNECTOR = /atlassian|jira|github/i;

/**
 * R27: the clerk's connectors — the inventory's Jira/GitHub ones (matched on the prefix, which is the
 * normalized server name), or every connector when none matches (oddly named connectors still work).
 */
export function clerkConnectors(allConnectorPrefixes: string[]): string[] {
  const matched = allConnectorPrefixes.filter((p) => CLERK_CONNECTOR.test(p));
  return matched.length > 0 ? matched : allConnectorPrefixes;
}

export interface BuildAgentOptionsInput {
  npc: Npc;
  cwd: string;
  appendPrompt?: string;
  allConnectorPrefixes: string[];
  sessionStore: SessionStore;
  env: Record<string, string | undefined>;
  resume?: string;
  canUseTool?: CanUseTool;
  outputFormat?: Options['outputFormat'];
  forceReadOnly?: boolean;
}

/** Agent SDK options for every NPC run. Never uses `bypassPermissions`. */
export function buildAgentOptions(input: BuildAgentOptionsInput): Options {
  const { npc, appendPrompt } = input;
  const readOnly = npc.equipment.readOnly || input.forceReadOnly === true;
  const isClerk = npc.builtin === 'clerk';
  const equipped = new Set((isClerk ? clerkConnectors(input.allConnectorPrefixes) : npc.equipment.connectorPrefixes).map(normalizeConnectorPrefix));
  const connectorDenies = input.allConnectorPrefixes.filter((p) => !equipped.has(normalizeConnectorPrefix(p))).map(connectorDenyRule);
  const disallowedTools: string[] = [
    ...GIT_PUSH_DENY,
    ...(readOnly ? READ_ONLY_DENY : []),
    // R29: the clerk never needs a shell; the game does all git work.
    ...(isClerk ? CLERK_TOOL_DENY : []),
    ...connectorDenies,
  ];
  const options: Options = {
    systemPrompt: { type: 'preset', preset: 'claude_code', append: appendPrompt ? `${npc.persona}\n\n${appendPrompt}` : npc.persona },
    model: npc.model,
    effort: npc.effort,
    // Project and local settings only, never the user's own (spec §3).
    settingSources: ['project', 'local'],
    permissionMode: npc.cautious ? 'acceptEdits' : 'auto',
    cwd: input.cwd,
    sessionStore: input.sessionStore,
    env: input.env,
    includePartialMessages: false,
    disallowedTools,
    // M1 NPCs have no game skills: `skills` and `plugins` stay unset so every project skill remains
    // visible. Per-NPC filtering needs the naming rule (b) in docs/superpowers/spikes/2026-10-16-results.md.
  };
  if (input.resume !== undefined) options.resume = input.resume;
  if (input.canUseTool !== undefined) options.canUseTool = input.canUseTool;
  if (input.outputFormat !== undefined) options.outputFormat = input.outputFormat;
  return options;
}

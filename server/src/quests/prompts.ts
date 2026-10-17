import type { Dungeon, Quest } from '@loc/shared';

/** The whole first message of a re-started quest that resumes the same NPC's session. */
export const CONTINUE_PROMPT = '會長請你繼續這個委託。';

export function rejectPrompt(feedback: string): string {
  return `會長退回了委託：${feedback}`;
}

/** Standing quest instructions (R25): the system-prompt append of every run on this quest. */
export function questInstructions(branch: string): string {
  return [
    `你在獨立分支 ${branch} 上工作；完成時先 commit；最後一則回覆寫成給會長的卷軸：做了什麼、根本原因、如何驗證、還有什麼風險。`,
    '不要 push 或開 PR，結算時由公會處理。',
  ].join('\n');
}

/** The quest content (R25): the first user message of a fresh session. */
export function questBrief(quest: Quest, dungeon: Dungeon): string {
  const lines = [`委託：${quest.title}`];
  if (quest.source.kind === 'jira') lines.push(`Jira 票號：${quest.source.key}（${quest.source.url}）`);
  lines.push(`地下城：${dungeon.name}`);
  if (quest.body.trim()) lines.push('', '委託內容：', quest.body);
  return lines.join('\n');
}

/** First message when another NPC takes over a quest (R26): the brief plus the earlier scroll, if any. */
export function handoverBrief(quest: Quest, dungeon: Dungeon): string {
  const brief = questBrief(quest, dungeon);
  return quest.scroll ? `${brief}\n\n先前冒險的卷軸：\n${quest.scroll}` : brief;
}

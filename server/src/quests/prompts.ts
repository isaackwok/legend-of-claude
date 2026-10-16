import type { Dungeon, Quest } from '@loc/shared';
import { branchName } from '../git/worktree.js';

/** First message of a re-started quest that resumes its earlier session. */
export const CONTINUE_PREFIX = '會長請你繼續這個委託。';

export function rejectPrompt(feedback: string): string {
  return `會長退回了委託：${feedback}`;
}

/** The quest briefing: used as the system-prompt append and as the first message of a new session. */
export function questPrompt(quest: Quest, dungeon: Dungeon): string {
  const branch = quest.branch ?? branchName(quest);
  const lines = [`委託：${quest.title}`];
  if (quest.source.kind === 'jira') lines.push(`Jira 票號：${quest.source.key}（${quest.source.url}）`);
  lines.push(`地下城：${dungeon.name}`);
  if (quest.body.trim()) lines.push('', '委託內容：', quest.body);
  lines.push(
    '',
    `你在獨立分支 ${branch} 上工作；完成時先 commit；最後一則回覆寫成給會長的卷軸：做了什麼、根本原因、如何驗證、還有什麼風險。`,
    '不要 push 或開 PR，結算時由公會處理。',
  );
  return lines.join('\n');
}

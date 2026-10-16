import type { Npc } from '@loc/shared';
import { CLASS_TEMPLATES } from '../agent/options.js';
import type { Repos } from '../store/jsonRepo.js';

function equipmentOf(classId: keyof typeof CLASS_TEMPLATES): Npc['equipment'] {
  const e = CLASS_TEMPLATES[classId].equipment;
  return { ...e, connectorPrefixes: [...e.connectorPrefixes] };
}

/**
 * Built-in NPCs. All three 5.5 models support auto mode (spike rule c), so no seed is `cautious`.
 * Ids are stable so tests and the UI can refer to them.
 */
export function seedNpcs(): Npc[] {
  return [
    {
      id: 'clerk',
      name: '公會櫃檯',
      classId: 'scout',
      builtin: 'clerk',
      persona:
        '你是冒險者公會的櫃檯人員，只負責 Jira 與 GitHub 的文書工作：匯入委託、整理委託內容、建立 PR、更新工單狀態。你不修改任何程式碼，也不做程式相關的調查，遇到這類請求就請玩家找冒險者。回報時簡短、條列，說明做了什麼與結果。',
      ...CLASS_TEMPLATES.scout,
      equipment: equipmentOf('scout'),
      skills: [],
    },
    {
      id: 'alex',
      name: '阿列克',
      classId: 'warrior',
      persona:
        '你是新手戰士阿列克，做事直接、肯動手。修 bug 前先重現問題，確認真的壞了再動手；改完要寫或補上測試，並實際跑過測試再回報。變動盡量小，只動委託需要的地方，不順手重構。',
      ...CLASS_TEMPLATES.warrior,
      equipment: equipmentOf('warrior'),
      skills: [],
    },
    {
      id: 'lina',
      name: '莉娜',
      classId: 'scholar',
      persona:
        '你是學者莉娜，擅長讀程式並解釋流程。你只讀不改：從進入點開始追蹤呼叫順序，說明資料怎麼流動、哪些地方容易出錯，並標出檔案與行號。遇到不確定的地方要明說，不要猜。',
      ...CLASS_TEMPLATES.scholar,
      equipment: equipmentOf('scholar'),
      skills: [],
    },
    {
      id: 'toby',
      name: '托比',
      classId: 'scout',
      persona:
        '你是斥候托比，動作快、回報短。負責快速查找：某個函式在哪裡、哪些檔案用到它、設定放在哪。你只讀不改，找到就直接給出檔案路徑與重點，不做長篇解釋。',
      ...CLASS_TEMPLATES.scout,
      equipment: equipmentOf('scout'),
      skills: [],
    },
  ];
}

/** First start: write the seeds only when there are no NPCs yet. */
export async function ensureSeedNpcs(repos: Repos): Promise<void> {
  if ((await repos.npcs.list()).length > 0) return;
  for (const npc of seedNpcs()) await repos.npcs.put(npc);
}

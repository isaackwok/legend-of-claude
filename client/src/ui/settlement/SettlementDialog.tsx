import { useEffect, useRef, useState } from 'react';
import type { SettlementChoices, SettlementRecord } from '@loc/shared';
import { api } from '../../api/http';
import { useGame } from '../../state/store';
import { Modal } from '../Modal';

interface SettlementOptions {
  isJira: boolean;
  transitions: { id: string; name: string }[];
  lastChoices?: SettlementChoices | null;
}

interface FormState {
  pushAndPr: boolean;
  transitionId: string; // '' = 不變更
  commentOn: boolean;
  comment: string;
  linkPr: boolean;
  openTicket: boolean;
}

type Phase = 'loading' | 'ready' | 'settling' | 'done';

/** Only http(s) URLs are ever opened or linked; anything else (javascript:, data:) is dropped. */
function safeHttpUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : undefined;
  } catch {
    return undefined;
  }
}

function initialForm(options: SettlementOptions | undefined, jira: boolean, scroll: string): FormState {
  const last = options?.lastChoices;
  const pushAndPr = last ? last.pushAndPr : true;
  return {
    pushAndPr,
    transitionId: jira && last?.jiraTransitionId && options?.transitions.some((t) => t.id === last.jiraTransitionId) ? last.jiraTransitionId : '',
    commentOn: jira && last?.jiraComment !== undefined,
    comment: scroll,
    linkPr: jira && pushAndPr && !!last?.linkPr,
    openTicket: jira && !!last?.openTicket,
  };
}

/** 驗收 / 結算: choose what the guild clerk does for this quest, run it, show each result. */
export function SettlementDialog({ questId }: { questId: string }) {
  const quest = useGame((s) => s.quests[questId]);
  const closeSettlement = useGame((s) => s.closeSettlement);

  const [phase, setPhase] = useState<Phase>('loading');
  const [options, setOptions] = useState<SettlementOptions>();
  const [optionsError, setOptionsError] = useState<string>();
  const [form, setForm] = useState<FormState>({ pushAndPr: true, transitionId: '', commentOn: false, comment: '', linkPr: false, openTicket: false });
  const [error, setError] = useState<string>();
  const [record, setRecord] = useState<SettlementRecord>();
  const [ticketChosen, setTicketChosen] = useState(false);
  const busyRef = useRef(false);

  const source = quest?.source;
  // Jira-only actions apply to Jira quests; if the options call failed we can't list transitions or trust Jira.
  const jira = source?.kind === 'jira' && (options ? options.isJira : true);
  const jiraOps = jira && options !== undefined;

  useEffect(() => {
    let cancelled = false;
    api<SettlementOptions>(`/quests/${questId}/settlement-options`).then(
      (opts) => {
        if (cancelled) return;
        setOptions(opts);
        setForm(initialForm(opts, useGame.getState().quests[questId]?.source.kind === 'jira' && opts.isJira, useGame.getState().quests[questId]?.scroll ?? ''));
        setPhase('ready');
      },
      (err: unknown) => {
        if (cancelled) return;
        setOptionsError(err instanceof Error ? err.message : String(err));
        setForm(initialForm(undefined, false, useGame.getState().quests[questId]?.scroll ?? ''));
        setPhase('ready');
      },
    );
    return () => {
      cancelled = true;
    };
  }, [questId]);

  const close = () => {
    if (busyRef.current) return;
    closeSettlement();
  };

  if (!quest) {
    return (
      <Modal title="驗收" onClose={close}>
        <p>找不到這張委託。</p>
        <div className="form-actions">
          <button type="button" onClick={close}>關閉</button>
        </div>
      </Modal>
    );
  }

  const patch = (p: Partial<FormState>) => setForm((f) => ({ ...f, ...p }));
  const settling = phase === 'settling';
  const commentBlank = jiraOps && form.commentOn && form.comment.trim() === '';
  const notInReview = quest.status !== 'review' && (phase === 'loading' || phase === 'ready');

  const settle = async () => {
    if (busyRef.current || phase !== 'ready' || commentBlank || notInReview) return;
    busyRef.current = true;
    setPhase('settling');
    setError(undefined);
    const choices: SettlementChoices = {
      pushAndPr: form.pushAndPr,
      ...(jiraOps && form.transitionId ? { jiraTransitionId: form.transitionId } : {}),
      ...(jiraOps && form.commentOn ? { jiraComment: form.comment } : {}),
      linkPr: jiraOps && form.pushAndPr && form.linkPr,
      openTicket: jira && form.openTicket,
    };
    try {
      const result = await api<SettlementRecord>(`/quests/${quest.id}/settle`, { method: 'POST', body: JSON.stringify(choices) });
      if (choices.openTicket && source?.kind === 'jira') {
        // Likely popup-blocked after the long await, so the results screen also shows a link.
        const url = safeHttpUrl(source.url);
        if (url) window.open(url, '_blank', 'noopener');
      }
      setTicketChosen(choices.openTicket);
      setRecord(result);
      setPhase('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase('ready');
    } finally {
      busyRef.current = false;
    }
  };

  if (phase === 'done' && record) {
    const prUrl = safeHttpUrl(record.prUrl);
    const ticketUrl = ticketChosen && source?.kind === 'jira' ? safeHttpUrl(source.url) : undefined;
    return (
      <Modal title={`結算結果：${quest.title}`} onClose={close}>
        <div className="form">
          <ul className="settle-results">
            {record.results.map((r, i) => (
              <li key={i} data-ok={r.ok}>
                <strong>{r.ok ? '成功' : '失敗'}</strong> {r.action}：{r.message}
              </li>
            ))}
          </ul>
          {prUrl && (
            <p>
              <a href={prUrl} target="_blank" rel="noopener noreferrer">查看 PR</a>
            </p>
          )}
          {ticketUrl && (
            <p>
              <a href={ticketUrl} target="_blank" rel="noopener noreferrer">開啟 Jira 票</a>
            </p>
          )}
          {(record.branch || record.worktreePath) && (
            <dl className="settle-place">
              {record.branch && (
                <>
                  <dt>分支</dt>
                  <dd><code>{record.branch}</code></dd>
                </>
              )}
              {record.worktreePath && (
                <>
                  <dt>工作目錄</dt>
                  <dd><code>{record.worktreePath}</code></dd>
                </>
              )}
            </dl>
          )}
          {record.accepted === false && (
            <p role="status" className="form-error">委託仍在待驗收，可修正後重新結算</p>
          )}
          <div className="form-actions">
            <button type="button" className="primary" onClick={close}>關閉</button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={`驗收：${quest.title}`} onClose={close}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void settle();
        }}
      >
        {phase === 'loading' && <p>讀取結算選項…</p>}
        {optionsError && <p role="alert" className="form-error">{optionsError}</p>}
        {phase !== 'loading' && (
          <>
            <label className="check">
              <input type="checkbox" checked={form.pushAndPr} disabled={settling} onChange={(e) => patch({ pushAndPr: e.target.checked, ...(e.target.checked ? {} : { linkPr: false }) })} />
              推上分支並開 PR
            </label>
            {jiraOps && (
              <>
                <label>
                  把 Jira 狀態改為
                  <select value={form.transitionId} disabled={settling} onChange={(e) => patch({ transitionId: e.target.value })}>
                    <option value="">不變更</option>
                    {options.transitions.map((t) => (
                      <option key={t.id} value={t.id}>{t.name}</option>
                    ))}
                  </select>
                </label>
                <label className="check">
                  <input type="checkbox" checked={form.commentOn} disabled={settling} onChange={(e) => patch({ commentOn: e.target.checked })} />
                  在 Jira 留言
                </label>
                {form.commentOn && (
                  <textarea aria-label="留言內容" rows={6} value={form.comment} disabled={settling} onChange={(e) => patch({ comment: e.target.value })} />
                )}
                <label className="check">
                  <input type="checkbox" checked={form.linkPr} disabled={settling || !form.pushAndPr} onChange={(e) => patch({ linkPr: e.target.checked })} />
                  在 Jira 貼上 PR 連結
                </label>
              </>
            )}
            {jira && (
              <label className="check">
                <input type="checkbox" checked={form.openTicket} disabled={settling} onChange={(e) => patch({ openTicket: e.target.checked })} />
                在瀏覽器打開這張 Jira 票
              </label>
            )}
          </>
        )}
        {notInReview && <p role="alert" className="form-error">這個委託已結算或不在待驗收狀態</p>}
        {commentBlank && <p className="form-error">留言內容不可空白</p>}
        {settling && <p role="status">公會櫃檯正在結算…</p>}
        {error && <p role="alert" className="form-error">{error}</p>}
        <div className="form-actions">
          <button type="submit" className="primary" disabled={phase !== 'ready' || commentBlank || notInReview}>結算</button>
          <button type="button" className="quiet" onClick={close} disabled={settling}>取消</button>
        </div>
      </form>
    </Modal>
  );
}

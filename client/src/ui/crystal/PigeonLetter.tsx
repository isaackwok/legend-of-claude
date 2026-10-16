import { useRef, useState } from 'react';
import type { Approval } from '@loc/shared';
import { api } from '../../api/http';
import { useGame } from '../../state/store';

interface PigeonLetterProps {
  approval: Approval;
}

/** 信鴿信件：NPC 想做某件事，等會長同意或拒絕。 */
export function PigeonLetter({ approval }: PigeonLetterProps) {
  const npcName = useGame((s) => s.npcs[approval.npcId]?.name ?? approval.npcId);
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const inFlight = useRef(false);

  const answer = async (allow: boolean) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError(undefined);
    try {
      const body: { allow: boolean; message?: string } = { allow };
      if (!allow && message.trim()) body.message = message.trim();
      await api(`/approvals/${encodeURIComponent(approval.id)}`, { method: 'POST', body: JSON.stringify(body) });
      useGame.getState().applyServerMessage({ type: 'approval_resolved', id: approval.id });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      inFlight.current = false;
      setPending(false);
    }
  };

  return (
    <article className="letter frame" aria-label={`信鴿來信：${npcName}`}>
      <div className="letter-from">信鴿來信　{npcName}</div>
      <p className="letter-summary">{approval.summary}</p>
      {approval.reason && <p className="letter-reason">理由：{approval.reason}</p>}
      <div className="letter-tool">工具：{approval.toolName}</div>
      <label className="letter-note">
        拒絕理由（選填）
        <input value={message} onChange={(e) => setMessage(e.target.value)} disabled={pending} />
      </label>
      <div className="letter-actions">
        <button type="button" className="primary" disabled={pending} onClick={() => void answer(true)}>
          同意
        </button>
        <button type="button" disabled={pending} onClick={() => void answer(false)}>
          拒絕
        </button>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </article>
  );
}

import { useRef, useState, type FormEvent } from 'react';
import type { Quest } from '@loc/shared';
import { api } from '../../api/http';
import { useGame } from '../../state/store';
import { Modal } from '../Modal';

interface RejectDialogProps {
  quest: Quest;
  onClose: () => void;
}

/** 退回: send the quest back to 待接委託 with the 會長's feedback (required). */
export function RejectDialog({ quest, onClose }: RejectDialogProps) {
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const busyRef = useRef(false);

  const close = () => {
    if (!busyRef.current) onClose();
  };

  const trimmed = feedback.trim();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busyRef.current || !trimmed) return;
    busyRef.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const updated = await api<Quest>(`/quests/${quest.id}/reject`, {
        method: 'POST',
        body: JSON.stringify({ feedback: trimmed }),
      });
      useGame.getState().applyServerMessage({ type: 'quest', quest: updated });
      busyRef.current = false;
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <Modal title={`退回委託：${quest.title}`} onClose={close}>
      <form onSubmit={submit} className="form">
        <label>
          退回理由
          <textarea
            rows={5}
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            disabled={busy}
            placeholder="告訴冒險者哪裡需要重做"
          />
        </label>
        {error && <p role="alert" className="form-error">{error}</p>}
        <div className="form-actions">
          <button type="submit" className="primary" disabled={busy || !trimmed}>
            退回委託
          </button>
          <button type="button" className="quiet" onClick={close} disabled={busy}>
            取消
          </button>
        </div>
      </form>
    </Modal>
  );
}

import { useState, type FormEvent } from 'react';
import type { Quest } from '@loc/shared';
import { api } from '../../api/http';
import { useGame } from '../../state/store';
import { Modal } from '../Modal';

interface NewQuestDialogProps {
  initialMode: 'local' | 'jira';
  onClose: () => void;
}

export function NewQuestDialog({ initialMode, onClose }: NewQuestDialogProps) {
  const [mode, setMode] = useState(initialMode);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [stars, setStars] = useState(1);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const run = async (request: () => Promise<Quest>) => {
    setBusy(true);
    setError(undefined);
    try {
      // The WS also pushes this quest; applying the response keeps the board current even if it is late.
      const quest = await request();
      useGame.getState().applyServerMessage({ type: 'quest', quest });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const submitLocal = (e: FormEvent) => {
    e.preventDefault();
    void run(() =>
      api<Quest>('/quests', { method: 'POST', body: JSON.stringify({ title: title.trim(), body, stars }) }),
    );
  };

  const submitJira = (e: FormEvent) => {
    e.preventDefault();
    // 201 new quest or 200 existing live quest (R28): both are a Quest and both are fine to show.
    void run(() => api<Quest>('/jira/import', { method: 'POST', body: JSON.stringify({ key: key.trim() }) }));
  };

  return (
    <Modal title={mode === 'local' ? '貼新委託' : '從 Jira 匯入委託'} onClose={onClose}>
      {mode === 'local' ? (
        <form onSubmit={submitLocal} className="form">
          <label>
            標題
            <input value={title} onChange={(e) => setTitle(e.target.value)} required disabled={busy} />
          </label>
          <label>
            內容
            <textarea rows={5} value={body} onChange={(e) => setBody(e.target.value)} disabled={busy} />
          </label>
          <label>
            星等
            <select value={stars} onChange={(e) => setStars(Number(e.target.value))} disabled={busy}>
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {'★'.repeat(n)}（{n}）
                </option>
              ))}
            </select>
          </label>
          {error && <p role="alert" className="form-error">{error}</p>}
          <div className="form-actions">
            <button type="submit" className="primary" disabled={busy || title.trim() === ''}>
              貼上佈告欄
            </button>
            <button type="button" onClick={() => setMode('jira')} disabled={busy}>
              改為從 Jira 匯入
            </button>
            <button type="button" className="quiet" onClick={onClose}>
              取消
            </button>
          </div>
        </form>
      ) : (
        <form onSubmit={submitJira} className="form">
          <label>
            Jira 票號
            <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="例如 SHOP-482" required disabled={busy} />
          </label>
          {busy && <p role="status">公會櫃檯正在查詢…</p>}
          {error && <p role="alert" className="form-error">{error}</p>}
          <div className="form-actions">
            <button type="submit" className="primary" disabled={busy || key.trim() === ''}>
              匯入
            </button>
            <button type="button" onClick={() => setMode('local')} disabled={busy}>
              改為貼本地委託
            </button>
            <button type="button" className="quiet" onClick={onClose}>
              取消
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

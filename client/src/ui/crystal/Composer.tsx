import { useState } from 'react';
import { api } from '../../api/http';

export type ComposerMode =
  | { kind: 'quest'; questId: string }
  | { kind: 'chat'; npcId: string; sessionId?: string }
  | { kind: 'readonly'; notice: string };

interface ComposerProps {
  mode: ComposerMode;
  /** Called after a message was accepted; `sessionId` is set for chats (new or existing). */
  onSent: (sessionId?: string) => void;
}

export function Composer({ mode, onSent }: ComposerProps) {
  const [text, setText] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  if (mode.kind === 'readonly') {
    return <p className="composer-notice">{mode.notice}</p>;
  }

  const run = async (action: () => Promise<void>, clear: boolean) => {
    setPending(true);
    setError(undefined);
    try {
      await action();
      if (clear) setText('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  };

  const send = () => {
    const body = text.trim();
    if (!body) return;
    if (mode.kind === 'quest') {
      void run(async () => {
        await api(`/quests/${encodeURIComponent(mode.questId)}/message`, { method: 'POST', body: JSON.stringify({ text: body }) });
        onSent();
      }, true);
    } else {
      void run(async () => {
        const payload: { npcId: string; text: string; sessionId?: string } = { npcId: mode.npcId, text: body };
        if (mode.sessionId) payload.sessionId = mode.sessionId;
        const res = await api<{ sessionId: string }>('/chats', { method: 'POST', body: JSON.stringify(payload) });
        onSent(res.sessionId);
      }, true);
    }
  };

  const recall = () => {
    if (mode.kind !== 'quest') return;
    if (!confirm('確定要召回這位冒險者嗎？進行中的冒險會被打斷。')) return;
    void run(async () => {
      await api(`/quests/${encodeURIComponent(mode.questId)}/recall`, { method: 'POST' });
      onSent();
    }, false);
  };

  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <textarea
        aria-label={mode.kind === 'quest' ? '傳信內容' : '聊天內容'}
        rows={3}
        value={text}
        disabled={pending}
        placeholder={mode.kind === 'quest' ? '寫一封信給冒險中的冒險者' : '說點什麼'}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="composer-actions">
        <button type="submit" className="primary" disabled={pending || !text.trim()}>
          {mode.kind === 'quest' ? '傳信' : '送出'}
        </button>
        {mode.kind === 'quest' && (
          <button type="button" disabled={pending} onClick={recall}>
            召回
          </button>
        )}
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

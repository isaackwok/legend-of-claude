import { useEffect, useState } from 'react';
import type { Preflight as PreflightInfo, Quest } from '@loc/shared';
import { api, getToken } from './api/http';
import { connectWs } from './api/ws';
import { useGame } from './state/store';
import { ConnectionBanner } from './ui/ConnectionBanner';
import { Nav } from './ui/Nav';
import { Preflight } from './ui/Preflight';
import { Board } from './ui/board/Board';
import { RejectDialog } from './ui/board/RejectDialog';
import { CrystalBall } from './ui/crystal/CrystalBall';
import { DungeonsPanel } from './ui/dungeons/DungeonsPanel';
import { SettlementDialog } from './ui/settlement/SettlementDialog';

// Read once at load: getToken() also moves the token from the URL into sessionStorage.
const hasToken = getToken() !== '';

export function App() {
  const preflight = useGame((s) => s.preflight);
  const panel = useGame((s) => s.ui.panel);
  const settlementQuestId = useGame((s) => s.ui.settlementQuestId);
  const [rejecting, setRejecting] = useState<Quest | null>(null);

  useEffect(() => {
    if (!hasToken) return;
    const disconnect = connectWs(
      (msg) => useGame.getState().applyServerMessage(msg),
      (status) => useGame.getState().setConnection(status.state, status.failures),
    );
    // The server also pushes `preflight` messages; re-reading on focus is a backstop.
    const refresh = () => {
      api<PreflightInfo>('/preflight').then(
        (p) => useGame.getState().setPreflight(p),
        (err: unknown) => console.warn('讀取啟動檢查失敗', err),
      );
    };
    window.addEventListener('focus', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      disconnect();
    };
  }, []);

  if (!hasToken) {
    return <main style={{ padding: 32 }}>請用伺服器印出的網址開啟。</main>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <ConnectionBanner />
      <Preflight preflight={preflight} />
      <Nav />
      <main style={{ flex: 1, margin: 16, overflow: 'auto' }}>
        {panel === 'board' && <Board onReject={setRejecting} />}
        {panel === 'crystal' && <CrystalBall />}
        {panel === 'dungeons' && <DungeonsPanel />}
      </main>
      {settlementQuestId && <SettlementDialog key={settlementQuestId} questId={settlementQuestId} />}
      {rejecting && <RejectDialog quest={rejecting} onClose={() => setRejecting(null)} />}
    </div>
  );
}

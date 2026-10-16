import { useEffect } from 'react';
import type { Preflight as PreflightInfo } from '@loc/shared';
import { api, getToken } from './api/http';
import { connectWs } from './api/ws';
import { useGame } from './state/store';
import { ConnectionBanner } from './ui/ConnectionBanner';
import { Preflight } from './ui/Preflight';

// Read once at load: getToken() also moves the token from the URL into sessionStorage.
const hasToken = getToken() !== '';

export function App() {
  const preflight = useGame((s) => s.preflight);

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
      <main className="frame" style={{ flex: 1, margin: 16 }} />
    </div>
  );
}

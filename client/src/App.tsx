import { useEffect } from 'react';
import type { Preflight as PreflightInfo } from '@loc/shared';
import { api, getToken } from './api/http';
import { connectWs } from './api/ws';
import { useGame } from './state/store';
import { Preflight } from './ui/Preflight';

// Read once at load: getToken() also moves the token from the URL into sessionStorage.
const hasToken = getToken() !== '';

export function App() {
  const preflight = useGame((s) => s.preflight);

  useEffect(() => {
    if (!hasToken) return;
    const disconnect = connectWs((msg) => useGame.getState().applyServerMessage(msg));
    // The startup check finishes after the first snapshot may have been sent; re-read when the tab regains focus.
    const refresh = () => {
      api<PreflightInfo>('/preflight').then((p) => useGame.getState().setPreflight(p), () => undefined);
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
      <Preflight preflight={preflight} />
      <main className="frame" style={{ flex: 1, margin: 16 }} />
    </div>
  );
}

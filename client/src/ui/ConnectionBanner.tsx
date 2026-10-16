import { LOST_AFTER_FAILURES } from '../api/ws';
import { useGame } from '../state/store';

/** Shown after repeated failed connection attempts, typically a stale token after a server restart. */
export function ConnectionBanner() {
  const lost = useGame((s) => s.connection !== 'open' && s.connectionFailures >= LOST_AFTER_FAILURES);
  if (!lost) return null;
  return (
    <div role="alert" className="banner banner-warn">
      連線中斷，請用伺服器印出的網址重新開啟
    </div>
  );
}

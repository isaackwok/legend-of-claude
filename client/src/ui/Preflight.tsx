import type { Preflight as PreflightInfo } from '@loc/shared';

export function Preflight({ preflight }: { preflight: PreflightInfo | null }) {
  if (!preflight) return null;
  const { ignoredEnvVars, loggedIn, warnings } = preflight;
  if (loggedIn && ignoredEnvVars.length === 0 && warnings.length === 0) return null;
  return (
    <div>
      {!loggedIn && (
        <div role="alert" className="banner banner-warn">
          <strong>尚未登入 claude.ai。</strong>
          請在終端機執行 <code>claude</code> 並輸入 <code>/login</code> 完成登入，然後重新啟動伺服器。
        </div>
      )}
      {ignoredEnvVars.length > 0 && (
        <div className="banner">已忽略 {ignoredEnvVars.join('、')}，NPC 會使用 claude.ai 訂閱。</div>
      )}
      {warnings.map((w) => (
        <div key={w} className="banner">
          {w}
        </div>
      ))}
    </div>
  );
}

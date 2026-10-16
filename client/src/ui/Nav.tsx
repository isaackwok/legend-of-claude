import { useGame, type PanelId } from '../state/store';

const TABS: { id: PanelId; label: string }[] = [
  { id: 'board', label: '佈告欄' },
  { id: 'crystal', label: '水晶球' },
  { id: 'dungeons', label: '地下城地圖' },
];

export function Nav() {
  const panel = useGame((s) => s.ui.panel);
  const openPanel = useGame((s) => s.openPanel);
  const pending = useGame((s) => Object.keys(s.approvals).length);

  return (
    <nav className="nav" aria-label="主選單">
      <h1 className="nav-title">克勞德傳說</h1>
      <div className="nav-tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className="nav-tab"
            aria-current={panel === t.id ? 'page' : undefined}
            onClick={() => openPanel(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <button
        type="button"
        className="nav-tab nav-mailbox"
        aria-label={pending > 0 ? `信箱，${pending} 件待批准` : '信箱，沒有待批准'}
        onClick={() => openPanel('crystal')}
      >
        信箱
        {pending > 0 && (
          <span className="badge" aria-hidden="true">
            {pending}
          </span>
        )}
      </button>
    </nav>
  );
}

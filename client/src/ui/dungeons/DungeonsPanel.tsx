import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { Dungeon } from '@loc/shared';
import { api } from '../../api/http';
import { useGame } from '../../state/store';

interface ScanResult {
  name: string;
  path: string;
  githubRepo?: string;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function DungeonsPanel() {
  const dungeonMap = useGame((s) => s.dungeons);
  const dungeons = Object.values(dungeonMap).sort((a, b) => a.name.localeCompare(b.name));
  const registeredPaths = new Set(dungeons.map((d) => d.path));

  const [found, setFound] = useState<ScanResult[]>([]);
  const [scanning, setScanning] = useState(false);
  const [root, setRoot] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [manualPath, setManualPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const scan = useCallback(async (scanRoot: string) => {
    setScanning(true);
    try {
      const query = scanRoot.trim() ? `?root=${encodeURIComponent(scanRoot.trim())}` : '';
      setFound(await api<ScanResult[]>(`/dungeons/scan${query}`));
      setError(undefined);
    } catch (err) {
      setError(message(err));
    } finally {
      setScanning(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    api<Dungeon[]>('/dungeons').then(
      (list) => {
        if (!cancelled) useGame.getState().setDungeons(list);
      },
      (err: unknown) => {
        if (!cancelled) setError(message(err));
      },
    );
    void scan('');
    return () => {
      cancelled = true;
    };
  }, [scan]);

  const register = async (paths: string[]) => {
    setBusy(true);
    setError(undefined);
    const failures: string[] = [];
    for (const path of paths) {
      try {
        const dungeon = await api<Dungeon>('/dungeons', { method: 'POST', body: JSON.stringify({ path }) });
        useGame.getState().applyServerMessage({ type: 'dungeon', dungeon });
      } catch (err) {
        failures.push(`${path}：${message(err)}`);
      }
    }
    setPicked(new Set());
    setBusy(false);
    if (failures.length > 0) setError(failures.join('\n'));
    return failures.length === 0;
  };

  const registerPicked = () => void register([...picked]);

  const registerManual = async (e: FormEvent) => {
    e.preventDefault();
    if (await register([manualPath.trim()])) setManualPath('');
  };

  const remove = async (d: Dungeon) => {
    if (!confirm(`確定要移除地下城「${d.name}」的登記嗎？（不會刪除任何檔案）`)) return;
    setError(undefined);
    try {
      await api<void>(`/dungeons/${d.id}`, { method: 'DELETE' });
      // The server does not broadcast removals (R18), so drop it locally.
      useGame.getState().removeDungeon(d.id);
    } catch (err) {
      setError(message(err));
    }
  };

  const toggle = (path: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const unregistered = found.filter((f) => !registeredPaths.has(f.path));

  return (
    <section aria-label="地下城地圖" className="dungeons">
      {error && (
        <p role="alert" className="form-error" style={{ whiteSpace: 'pre-line' }}>
          {error}
        </p>
      )}
      <div className="frame dungeons-block">
        <h2>已登記的地下城</h2>
        {dungeons.length === 0 ? (
          <p>還沒有登記任何地下城。</p>
        ) : (
          <ul className="dungeon-list">
            {dungeons.map((d) => (
              <li key={d.id}>
                <strong>{d.name}</strong>
                <code className="dungeon-path">{d.path}</code>
                {d.githubRepo && <span className="dungeon-repo">GitHub：{d.githubRepo}</span>}
                <button type="button" className="quiet" onClick={() => void remove(d)}>
                  移除
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="frame dungeons-block">
        <h2>掃描到的專案</h2>
        <form
          className="form form-row"
          onSubmit={(e) => {
            e.preventDefault();
            void scan(root);
          }}
        >
          <label>
            掃描資料夾（留空使用預設）
            <input value={root} onChange={(e) => setRoot(e.target.value)} placeholder="~/dev" />
          </label>
          <button type="submit" disabled={scanning}>
            {scanning ? '掃描中…' : '重新掃描'}
          </button>
        </form>
        {unregistered.length === 0 ? (
          <p>{scanning ? '掃描中…' : '沒有找到尚未登記的專案。'}</p>
        ) : (
          <>
            <ul className="dungeon-list">
              {unregistered.map((f) => (
                <li key={f.path}>
                  <label>
                    <input type="checkbox" checked={picked.has(f.path)} onChange={() => toggle(f.path)} />
                    <strong>{f.name}</strong>
                  </label>
                  <code className="dungeon-path">{f.path}</code>
                  {f.githubRepo && <span className="dungeon-repo">GitHub：{f.githubRepo}</span>}
                </li>
              ))}
            </ul>
            <button type="button" className="primary" disabled={busy || picked.size === 0} onClick={registerPicked}>
              登記所選
            </button>
          </>
        )}
      </div>
      <form className="frame dungeons-block form" onSubmit={(e) => void registerManual(e)}>
        <h2>手動登記</h2>
        <label>
          專案路徑
          <input value={manualPath} onChange={(e) => setManualPath(e.target.value)} placeholder="/Users/你/dev/專案" />
        </label>
        <div className="form-actions">
          <button type="submit" disabled={busy || manualPath.trim() === ''}>
            登記
          </button>
        </div>
      </form>
    </section>
  );
}

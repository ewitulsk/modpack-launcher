import { useCallback, useEffect, useState } from "react";
import {
  formatBytes,
  invoke,
  isPackKeyError,
  on,
  versionLabel,
  type BlockedFile,
  type PackDetail,
  type PackSummary,
  type Progress,
  type PublicSettings,
} from "../bridge";

/** Shown when a download needs the shared pack key and we don't have the right one. */
function PackKeyPrompt({ onSaved }: { onSaved: () => void }) {
  const [key, setKey] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await invoke("server:setKey", key);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="card connect" onSubmit={save}>
      <h3>Enter the pack key</h3>
      <p className="muted">Downloading packs needs a key. Ask Evan for it; everyone uses the same one. You only enter it once.</p>
      <label>Pack key<input value={key} onChange={(e) => setKey(e.target.value)} type="password" required autoFocus /></label>
      {error && <div className="error">{error}</div>}
      <button className="primary" disabled={busy}>{busy ? "Checking…" : "Save and continue"}</button>
    </form>
  );
}

export function Packs({ settings, goToAccounts }: { settings: PublicSettings; goToAccounts: () => void }) {
  const [packs, setPacks] = useState<PackSummary[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const list = await invoke<PackSummary[]>("packs:list");
      setPacks(list);
      setSelected((s) => s ?? list[0]?.id ?? null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => void load(), [load]);

  if (error)
    return (
      <div>
        <div className="error">{error}</div>
        <button onClick={load}>Try again</button>
      </div>
    );
  if (!packs) return <div className="muted">Loading packs…</div>;
  if (packs.length === 0) return <div className="empty">No packs published yet.</div>;

  return (
    <div className="split">
      <ul className="packlist">
        {packs.map((p) => (
          <li key={p.id} className={p.id === selected ? "selected" : ""} onClick={() => setSelected(p.id)}>
            <strong>{p.name}</strong>
            <small>
              {p.latestRevision ? versionLabel({ revision: p.latestRevision, version: p.latestVersion }) : "no versions"}
              {p.installedRevision && p.installedRevision !== p.latestRevision ? ` · update from r${p.installedRevision}` : ""}
              {p.installedRevision === p.latestRevision && p.latestRevision ? " · installed" : ""}
            </small>
          </li>
        ))}
      </ul>
      {selected && <PackView key={selected} id={selected} settings={settings} goToAccounts={goToAccounts} onChanged={load} />}
    </div>
  );
}

function PackView({ id, settings, goToAccounts, onChanged }: { id: string; settings: PublicSettings; goToAccounts: () => void; onChanged: () => void }) {
  const [pack, setPack] = useState<PackDetail | null>(null);
  const [revision, setRevision] = useState<number | undefined>();
  const [progress, setProgress] = useState<Progress | null>(null);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [blocked, setBlocked] = useState<BlockedFile[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  /** Set when a download was refused for want of the pack key: which play to retry once it's saved. */
  const [needKey, setNeedKey] = useState<{ offline: boolean } | null>(null);

  useEffect(() => {
    void invoke<PackDetail>("packs:get", id).then(setPack, (e: Error) => setError(e.message));
    const offProgress = on("progress", (p: Progress) => p.packId === id && setProgress(p));
    const offExit = on("game:exit", (p: { packId: string }) => p.packId === id && setRunning(false));
    return () => {
      offProgress();
      offExit();
    };
  }, [id]);

  if (!pack) return <div className="muted">{error || "Loading…"}</div>;
  const latest = pack.revisions[0];
  const target = revision ?? latest?.revision;
  const shown = pack.revisions.find((r) => r.revision === target);
  // Updating one version at a time is the common case: say how small the update is.
  const update =
    pack.installedRevision && target && pack.installedRevision === target - 1 ? pack.revisions.find((r) => r.revision === target)?.changes : undefined;

  const play = async (offline = false) => {
    if (!offline && !settings.selectedAccountId) return goToAccounts();
    setBusy(true);
    setError("");
    setBlocked([]);
    setNotice("");
    setNeedKey(null);
    try {
      const res = await invoke<{ status: string; blocked?: BlockedFile[]; sync?: { downloaded: number; removed: number } }>("packs:play", id, { revision, offline });
      if (res.status === "blocked") setBlocked(res.blocked ?? []);
      else setRunning(true);
      if (res.sync && (res.sync.downloaded || res.sync.removed))
        setNotice(`Updated: ${res.sync.downloaded} file${res.sync.downloaded === 1 ? "" : "s"} fetched, ${res.sync.removed} removed. Everything else was already up to date.`);
      onChanged();
    } catch (e) {
      const message = (e as Error).message;
      if (isPackKeyError(message)) setNeedKey({ offline });
      else setError(message);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  return (
    <article className="pack">
      <header>
        <div>
          <h2>{pack.name}</h2>
          <p className="muted">by {pack.ownerName}{pack.description ? ` · ${pack.description}` : ""}</p>
        </div>
        <div className="actions">
          <button className="primary big" disabled={busy || running || !latest} onClick={() => play()}>
            {running ? "Running" : busy ? "Working…" : pack.installedRevision === (revision ?? latest?.revision) ? "Play" : pack.installedRevision ? "Update & play" : "Install & play"}
          </button>
          <button disabled={busy || running || !latest} onClick={() => play(true)} title="Launch without signing in (singleplayer only)">Offline test</button>
          <button className="ghost" onClick={() => invoke("packs:openFolder", pack.slug)}>Open folder</button>
        </div>
      </header>

      {update && pack.installedRevision !== target && (
        <div className="notice">
          Update to {versionLabel(shown!)}: {update.added.length} new, {update.updated.length} changed, {update.removed.length} removed
          {update.downloadBytes ? ` (about ${formatBytes(update.downloadBytes)} to download)` : ""}. The rest of the pack is kept.
        </div>
      )}
      {needKey && <PackKeyPrompt onSaved={() => void play(needKey.offline)} />}
      {notice && <div className="notice">{notice}</div>}
      {progress && <ProgressBar p={progress} />}
      {error && <div className="error">{error}</div>}

      {blocked.length > 0 && (
        <div className="card warn">
          <h3>{blocked.length} mod{blocked.length > 1 ? "s" : ""} must be downloaded by hand</h3>
          <p className="muted">
            Their authors don't allow other launchers to download them. Click each, download it into your Downloads folder, then press Play
            again. The launcher finds and installs them for you.
          </p>
          <ul className="list">
            {blocked.map((b) => (
              <li key={b.path}>
                <span className="grow">{b.fileName ?? b.path}</span>
                {b.pageUrl && <button onClick={() => invoke("shell:open", b.pageUrl)}>Open download page</button>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {shown && (
        <div className="facts">
          <div><small>Minecraft</small>{shown.minecraft}</div>
          <div><small>Loader</small>{shown.loader ? `${shown.loader.type} ${shown.loader.version}` : "vanilla"}</div>
          <div><small>Files</small>{shown.fileCount}</div>
          <div><small>Manual downloads</small>{shown.blockedCount}</div>
          <div>
            <small>Version</small>
            <select value={revision ?? latest?.revision} onChange={(e) => setRevision(Number(e.target.value))}>
              {pack.revisions.map((r) => (
                <option key={r.revision} value={r.revision}>{versionLabel(r)}{r.revision === latest?.revision ? " · latest" : ""}</option>
              ))}
            </select>
          </div>
        </div>
      )}

      <h3>Changelog</h3>
      <ul className="changelog">
        {pack.revisions.map((r) => (
          <li key={r.revision}>
            <strong>{versionLabel(r)}</strong> <small className="muted">{new Date(r.createdAt).toLocaleString()}{r.publishedBy ? ` · ${r.publishedBy}` : ""}</small>
            <p>{r.changelog || <span className="muted">No notes</span>}</p>
            {r.changes && (
              <small className="muted">
                {r.changes.added.length} added, {r.changes.updated.length} changed, {r.changes.removed.length} removed
              </small>
            )}
          </li>
        ))}
      </ul>
    </article>
  );
}

function ProgressBar({ p }: { p: Progress }) {
  const label =
    p.kind === "sync"
      ? p.phase === "download"
        ? `Downloading pack files ${p.done}/${p.total}`
        : p.phase === "remove"
          ? "Removing old files"
          : "Checking files"
      : `Installing ${p.step}${p.detail ? ` (${p.detail})` : ""}`;
  const pct = p.total ? Math.round(((p.done ?? 0) / p.total) * 100) : undefined;
  return (
    <div className="progress">
      <div className="bar"><div style={{ width: pct === undefined ? "100%" : `${pct}%` }} className={pct === undefined ? "indeterminate" : ""} /></div>
      <small>{label}</small>
    </div>
  );
}

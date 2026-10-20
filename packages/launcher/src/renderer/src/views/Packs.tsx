import { useCallback, useEffect, useState } from "react";
import { invoke, on, type BlockedFile, type PackDetail, type PackSummary, type Progress, type PublicSettings } from "../bridge";

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
              {p.latestRevision ? `r${p.latestRevision}` : "no revisions"}
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
  const shown = pack.revisions.find((r) => r.revision === (revision ?? latest?.revision));

  const play = async (offline = false) => {
    if (!offline && !settings.selectedAccountId) return goToAccounts();
    setBusy(true);
    setError("");
    setBlocked([]);
    try {
      const res = await invoke<{ status: string; blocked?: BlockedFile[] }>("packs:play", id, { revision, offline });
      if (res.status === "blocked") setBlocked(res.blocked ?? []);
      else setRunning(true);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
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
            <small>Revision</small>
            <select value={revision ?? latest?.revision} onChange={(e) => setRevision(Number(e.target.value))}>
              {pack.revisions.map((r) => (
                <option key={r.revision} value={r.revision}>r{r.revision}{r.revision === latest?.revision ? " (latest)" : ""}</option>
              ))}
            </select>
          </div>
        </div>
      )}

      <h3>Changelog</h3>
      <ul className="changelog">
        {pack.revisions.map((r) => (
          <li key={r.revision}>
            <strong>r{r.revision}</strong> <small className="muted">{new Date(r.createdAt).toLocaleString()}{r.publishedBy ? ` · ${r.publishedBy}` : ""}</small>
            <p>{r.changelog || <span className="muted">No notes</span>}</p>
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

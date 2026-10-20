import { useEffect, useState } from "react";
import { invoke, type Me, type PackSummary } from "../bridge";

interface Op {
  op: string;
  [k: string]: unknown;
}
interface Remix {
  schema: 1;
  name: string;
  base: { source: "modrinth"; versionId: string } | { source: "curseforge"; projectId: number; fileId: number };
  ops: Op[];
  [k: string]: unknown;
}

const template = (name: string): Remix => ({
  schema: 1,
  name,
  base: { source: "modrinth", versionId: "PASTE_VERSION_ID" },
  ops: [],
});

/**
 * Accepts a Modrinth version id (8 characters, shown on the version page) or a CurseForge
 * "projectId:fileId" pair (both shown on the file's page, under "About").
 */
function parseBase(input: string): Remix["base"] | null {
  const s = input.trim();
  const cf = s.match(/^(\d+)\s*[:/ ]\s*(\d+)$/);
  if (cf) return { source: "curseforge", projectId: Number(cf[1]), fileId: Number(cf[2]) };
  const mr = s.match(/\/version\/([A-Za-z0-9]{8})\/?$/) ?? s.match(/^([A-Za-z0-9]{8})$/);
  if (mr) return { source: "modrinth", versionId: mr[1]! };
  return null;
}

export function Admin({ me }: { me: Me }) {
  const [packs, setPacks] = useState<PackSummary[]>([]);
  const [packId, setPackId] = useState("");
  const [text, setText] = useState("");
  const [changelog, setChangelog] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [summary, setSummary] = useState<{ kind: string; path: string; how: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [newPack, setNewPack] = useState("");
  const [invite, setInvite] = useState("");
  const [baseInput, setBaseInput] = useState("");

  // You can publish to packs you made; the admin can publish to any.
  const loadPacks = async () => setPacks((await invoke<PackSummary[]>("packs:list")).filter((p) => me.isAdmin || p.ownerId === me.id));
  useEffect(() => void loadPacks(), []);

  useEffect(() => {
    if (!packId) return;
    const pack = packs.find((p) => p.id === packId);
    void invoke<Remix | null>("admin:latestRemix", packId).then((r) => setText(JSON.stringify(r ?? template(pack?.name ?? "New remix"), null, 2)));
    setWarnings([]);
    setSummary([]);
  }, [packId]);

  const remix = (): Remix => JSON.parse(text) as Remix;
  const setRemix = (r: Remix) => setText(JSON.stringify(r, null, 2));

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setStatus(label);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
      setStatus("");
    } finally {
      setBusy(false);
    }
  };

  const pack = packs.find((p) => p.id === packId);

  return (
    <section className="admin">
      <h2>Remix &amp; publish</h2>
      <div className="row">
        <select value={packId} onChange={(e) => setPackId(e.target.value)}>
          <option value="">Choose a pack…</option>
          {packs.map((p) => (
            <option key={p.id} value={p.id}>{p.name}{p.ownerId !== me.id ? ` (${p.ownerName})` : ""}</option>
          ))}
        </select>
        <input value={newPack} onChange={(e) => setNewPack(e.target.value)} placeholder="New pack name" />
        <button
          disabled={!newPack || busy}
          onClick={() =>
            run("Creating pack…", async () => {
              const p = await invoke<PackSummary>("admin:createPack", newPack, "");
              setNewPack("");
              await loadPacks();
              setPackId(p.id);
              setStatus(`Created ${p.name}`);
            })
          }
        >
          Create pack
        </button>
        <div className="spacer" />
        {me.isAdmin && <button
          disabled={busy}
          onClick={() =>
            run("Creating invite…", async () => {
              const r = await invoke<{ code: string }>("admin:createInvite", "");
              setInvite(r.code);
              setStatus("");
            })
          }
        >
          New invite code
        </button>}
        {invite && <code className="big" title="Send this to a friend">{invite}</code>}
      </div>

      {pack && (
        <>
          <div className="row">
            <input className="grow" value={baseInput} onChange={(e) => setBaseInput(e.target.value)} placeholder="Base pack: Modrinth version id (e.g. aB3dE5fG) or CurseForge projectId:fileId" />
            <button
              disabled={!baseInput}
              onClick={() => {
                const base = parseBase(baseInput);
                if (!base) return setError("Couldn't read that. Use a Modrinth version id like aB3dE5fG, or CurseForge projectId:fileId like 925200:6012345.");
                setRemix({ ...remix(), base });
                setBaseInput("");
              }}
            >
              Set base
            </button>
          </div>
          <div className="row">
            <button
              disabled={busy}
              onClick={() =>
                run("Capturing changes from your instance…", async () => {
                  const r = await invoke<{ ops: Op[]; summary: typeof summary; baseRevision: number }>("admin:capture", pack.slug);
                  setRemix({ ...remix(), ops: [...remix().ops, ...r.ops] });
                  setSummary(r.summary);
                  setStatus(r.ops.length ? `Captured ${r.ops.length} changes against r${r.baseRevision}` : "No changes found");
                })
              }
            >
              Capture changes from my instance
            </button>
            <button
              disabled={busy}
              onClick={() =>
                run("Uploading…", async () => {
                  const files = await invoke<{ name: string; blob: string }[]>("admin:uploadFiles");
                  const ops = files.map((f) => ({ op: "putFile", path: f.name.endsWith(".jar") ? `mods/${f.name}` : `config/${f.name}`, blob: f.blob }));
                  setRemix({ ...remix(), ops: [...remix().ops, ...ops] });
                  setStatus(`Added ${ops.length} file(s). Adjust their paths in the JSON if needed.`);
                })
              }
            >
              Upload files…
            </button>
            <button
              disabled={busy}
              onClick={() =>
                run("Resolving…", async () => {
                  const r = await invoke<{ lockfile: { files: { blocked?: unknown }[] }; warnings: string[] }>("admin:preview", remix());
                  setWarnings(r.warnings);
                  setStatus(`Resolves to ${r.lockfile.files.length} files, ${r.lockfile.files.filter((f) => f.blocked).length} need manual download`);
                })
              }
            >
              Preview
            </button>
          </div>
          <textarea className="code" rows={22} spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} />
          {summary.length > 0 && (
            <details open>
              <summary>{summary.length} captured changes</summary>
              <ul className="changes">
                {summary.map((s) => (
                  <li key={s.path}><span className={`tag ${s.kind}`}>{s.kind}</span> {s.path} <small className="muted">{s.how}</small></li>
                ))}
              </ul>
            </details>
          )}
          {warnings.length > 0 && <ul className="warnings">{warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
          <div className="row">
            <input className="grow" value={changelog} onChange={(e) => setChangelog(e.target.value)} placeholder="What changed in this revision?" />
            <button
              className="primary"
              disabled={busy}
              onClick={() =>
                run("Publishing…", async () => {
                  const r = await invoke<{ revision: number; warnings: string[] }>("admin:publish", pack.id, remix(), changelog);
                  setWarnings(r.warnings);
                  setChangelog("");
                  setSummary([]);
                  setStatus(`Published r${r.revision}. Friends get it next time they press Play.`);
                })
              }
            >
              Publish revision
            </button>
          </div>
        </>
      )}
      {status && <div className="notice">{status}</div>}
      {error && <div className="error">{error}</div>}
    </section>
  );
}

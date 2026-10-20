import { useEffect, useState } from "react";
import { invoke, on, type PublicSettings } from "../bridge";

export function Accounts({ settings, onChange }: { settings: PublicSettings; onChange: (s: PublicSettings) => void }) {
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [deviceCode, setDeviceCode] = useState<{ code: string; url: string } | null>(null);

  useEffect(() => on("auth:devicecode", (p: { code: string; url: string }) => setDeviceCode(p)), []);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError("");
    setMessage("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
      setDeviceCode(null);
    }
  };

  return (
    <section>
      <h2>Minecraft accounts</h2>
      <p className="muted">Everyone needs to own Minecraft: Java Edition. Sign-in tokens stay on this PC.</p>
      <div className="row">
        <button className="primary" disabled={!!busy} onClick={() => run("signin", async () => onChange(await invoke("auth:signin")))}>
          {busy === "signin" ? "Waiting for Microsoft…" : "Sign in with Microsoft"}
        </button>
        <button
          disabled={!!busy}
          onClick={() =>
            run("import", async () => {
              const r = await invoke<{ settings: PublicSettings; imported: string[]; notes: string[] }>("auth:importModrinth");
              onChange(r.settings);
              setMessage(r.imported.length ? `Imported ${r.imported.join(", ")} from the Modrinth App.` : `Nothing to import. ${r.notes.join(" ")}`);
            })
          }
        >
          Import from Modrinth App
        </button>
      </div>
      {deviceCode && (
        <div className="card notice">
          Go to <a onClick={() => invoke("shell:open", deviceCode.url)}>{deviceCode.url}</a> and enter <code className="big">{deviceCode.code}</code>
        </div>
      )}
      {message && <div className="notice">{message}</div>}
      {error && <div className="error">{error}</div>}
      <ul className="list">
        {settings.accounts.map((a) => (
          <li key={a.id} className={a.id === settings.selectedAccountId ? "selected" : ""}>
            <img src={`https://mc-heads.net/avatar/${a.id}/32`} alt="" />
            <div className="grow">
              <strong>{a.name}</strong>
              <small>{a.source === "modrinth-app" ? "Imported from Modrinth App" : "Signed in here"}</small>
            </div>
            {a.id !== settings.selectedAccountId && <button onClick={async () => onChange(await invoke("auth:select", a.id))}>Use</button>}
            <button className="ghost" onClick={async () => onChange(await invoke("auth:remove", a.id))}>Remove</button>
          </li>
        ))}
        {settings.accounts.length === 0 && <li className="muted">No accounts yet.</li>}
      </ul>
    </section>
  );
}

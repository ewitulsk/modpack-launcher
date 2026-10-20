import { useState } from "react";
import { invoke, type Me, type PublicSettings } from "../bridge";

export function SettingsView({ settings, me, onChange }: { settings: PublicSettings; me: Me | null; onChange: (s: PublicSettings) => void }) {
  const [memoryMb, setMemory] = useState(settings.memoryMb);
  const [msaClientId, setClientId] = useState(settings.msaClientId);
  const [ignore, setIgnore] = useState(settings.captureIgnore.join("\n"));
  const [saved, setSaved] = useState(false);
  const [packKey, setPackKey] = useState("");
  const [keyStatus, setKeyStatus] = useState("");

  const save = async () => {
    onChange(
      await invoke<PublicSettings>("settings:update", {
        memoryMb,
        msaClientId: msaClientId.trim(),
        captureIgnore: ignore.split("\n").map((l) => l.trim()).filter(Boolean),
      }),
    );
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  return (
    <section className="form">
      <h2>Settings</h2>
      <label>
        Memory for the game (MB, used when a pack doesn't set its own)
        <input type="number" min={2048} step={512} value={memoryMb} onChange={(e) => setMemory(Number(e.target.value))} />
      </label>
      <label>
        Azure app client ID (optional)
        <input value={msaClientId} onChange={(e) => setClientId(e.target.value)} placeholder="Leave empty to use the standard Microsoft sign-in window" />
        <small className="muted">Only set this once Mojang has approved your own Azure app for the Minecraft API.</small>
      </label>
      <label>
        Files ignored by "Capture changes" (one glob per line)
        <textarea rows={10} value={ignore} onChange={(e) => setIgnore(e.target.value)} />
      </label>
      <div className="row">
        <button className="primary" onClick={save}>Save</button>
        {saved && <span className="muted">Saved</span>}
      </div>
      <label>
        Pack key {settings.hasPackKey ? <small className="muted">(set)</small> : null}
        <div className="row">
          <input className="grow" value={packKey} onChange={(e) => setPackKey(e.target.value)} type="password" placeholder="Only needed if Evan changes it" />
          <button
            disabled={!packKey}
            onClick={async () => {
              try {
                onChange(await invoke<PublicSettings>("server:setKey", packKey));
                setPackKey("");
                setKeyStatus("Saved");
              } catch (e) {
                setKeyStatus((e as Error).message);
              }
            }}
          >
            Save key
          </button>
        </div>
        {keyStatus && <small className="muted">{keyStatus}</small>}
      </label>
      <div className="row">
        <span className="muted grow">Downloaded files are cached and shared between packs, so the same mod is never downloaded twice.</span>
        <button className="ghost" onClick={async () => (await invoke("cache:clear"), setKeyStatus("Download cache cleared"))}>Clear download cache</button>
      </div>
      <div className="row">
        <span className="muted grow">
          Pack server {settings.serverUrl}. {me ? `Signed in as ${me.username}${me.isAdmin ? " (admin)" : ""}.` : "Not signed in (you can still play everything)."}
        </span>
        {me && <button className="ghost" onClick={async () => onChange(await invoke<PublicSettings>("account:logout"))}>Sign out</button>}
        {!settings.serverLocked && <button className="ghost" onClick={async () => onChange(await invoke<PublicSettings>("server:forget"))}>Switch server</button>}
      </div>
    </section>
  );
}

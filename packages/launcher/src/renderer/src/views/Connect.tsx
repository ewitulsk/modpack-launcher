import { useState } from "react";
import { invoke, type PublicSettings } from "../bridge";

/** First run without a built-in server address: ask for one. */
export function Connect({ onConnected }: { onConnected: (s: PublicSettings) => void }) {
  const [serverUrl, setServerUrl] = useState("");
  const [packKey, setPackKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      onConnected(await invoke<PublicSettings>("server:set", serverUrl, packKey));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="center">
      <form className="card connect" onSubmit={submit}>
        <h1>Find the pack server</h1>
        <p className="muted">Ask Evan for the server address and the pack key. You can play any pack without an account.</p>
        <label>Server address<input value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} placeholder="http://203.0.113.10" required /></label>
        <label>Pack key<input value={packKey} onChange={(e) => setPackKey(e.target.value)} type="password" placeholder="Same key for everyone" /></label>
        {error && <div className="error">{error}</div>}
        <button className="primary" disabled={busy}>{busy ? "Connecting…" : "Connect"}</button>
      </form>
    </div>
  );
}

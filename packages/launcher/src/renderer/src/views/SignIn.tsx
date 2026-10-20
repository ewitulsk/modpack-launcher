import { useState } from "react";
import { invoke, type PublicSettings } from "../bridge";

type Mode = "login" | "register" | "token";

/** Pack account: needed to remix and publish, not to play. Making one needs an invite code. */
export function SignIn({ onSignedIn }: { onSignedIn: (s: PublicSettings) => void }) {
  const [mode, setMode] = useState<Mode>("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const s =
        mode === "token"
          ? await invoke<PublicSettings>("account:token", token)
          : mode === "register"
            ? await invoke<PublicSettings>("account:register", { code, username, password })
            : await invoke<PublicSettings>("account:login", { username, password });
      onSignedIn(s);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="center">
      <form className="card connect" onSubmit={submit}>
        <h1>{mode === "register" ? "Create a pack account" : "Sign in to publish"}</h1>
        <p className="muted">
          {mode === "register"
            ? "You need an invite code from Evan. Anyone can play packs without an account."
            : "An account lets you remix packs and publish them for everyone."}
        </p>
        {mode === "token" ? (
          <label>Admin token<input value={token} onChange={(e) => setToken(e.target.value)} type="password" required /></label>
        ) : (
          <>
            {mode === "register" && (
              <label>Invite code<input value={code} onChange={(e) => setCode(e.target.value)} placeholder="A1B2C3D4E5" required /></label>
            )}
            <label>Username<input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required /></label>
            <label>
              Password
              <input
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                type="password"
                autoComplete={mode === "register" ? "new-password" : "current-password"}
                required
              />
            </label>
          </>
        )}
        {error && <div className="error">{error}</div>}
        <button className="primary" disabled={busy}>
          {busy ? "One moment…" : mode === "register" ? "Create account" : "Sign in"}
        </button>
        <div className="row">
          {mode !== "register" && <button type="button" className="link" onClick={() => setMode("register")}>I have an invite code</button>}
          {mode !== "login" && <button type="button" className="link" onClick={() => setMode("login")}>I already have an account</button>}
          {mode !== "token" && <button type="button" className="link" onClick={() => setMode("token")}>Use the admin token</button>}
        </div>
      </form>
    </div>
  );
}

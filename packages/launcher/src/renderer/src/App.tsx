import { useCallback, useEffect, useState } from "react";
import { invoke, on, type Me, type PublicSettings } from "./bridge";
import { Accounts } from "./views/Accounts";
import { Admin } from "./views/Admin";
import { Connect } from "./views/Connect";
import { Packs } from "./views/Packs";
import { SettingsView } from "./views/Settings";
import { SignIn } from "./views/SignIn";

type Tab = "packs" | "accounts" | "admin" | "settings";

export function App() {
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [tab, setTab] = useState<Tab>("packs");
  const [logs, setLogs] = useState<string[]>([]);
  const [showLog, setShowLog] = useState(false);

  const refresh = useCallback(async () => {
    const s = await invoke<PublicSettings>("settings:get");
    setSettings(s);
    setMe(s.signedIn ? await invoke<Me | null>("account:me").catch(() => null) : null);
  }, []);
  const update = (s: PublicSettings) => {
    setSettings(s);
    void refresh();
  };

  useEffect(() => {
    void refresh();
    return on("log", (line: string) => setLogs((l) => [...l.slice(-800), line]));
  }, [refresh]);

  if (!settings) return <div className="splash">Loading…</div>;
  if (!settings.hasServer) return <Connect onConnected={update} />;

  const account = settings.accounts.find((a) => a.id === settings.selectedAccountId);
  return (
    <div className="app">
      <nav className="sidebar">
        <div className="brand">Remix<span>Launcher</span></div>
        <button className={tab === "packs" ? "active" : ""} onClick={() => setTab("packs")}>Packs</button>
        <button className={tab === "accounts" ? "active" : ""} onClick={() => setTab("accounts")}>Accounts</button>
        <button className={tab === "admin" ? "active" : ""} onClick={() => setTab("admin")}>Remix &amp; publish</button>
        <button className={tab === "settings" ? "active" : ""} onClick={() => setTab("settings")}>Settings</button>
        <div className="spacer" />
        <div className="who">
          <div>{account ? account.name : "No Minecraft account"}</div>
          <small>{me ? me.username : "Guest"} · {new URL(settings.serverUrl).host}</small>
        </div>
        <button className="ghost" onClick={() => setShowLog((v) => !v)}>{showLog ? "Hide" : "Show"} game log</button>
      </nav>
      <main className="content">
        {tab === "packs" && <Packs settings={settings} goToAccounts={() => setTab("accounts")} />}
        {tab === "accounts" && <Accounts settings={settings} onChange={setSettings} />}
        {tab === "admin" && (me ? <Admin me={me} /> : <SignIn onSignedIn={update} />)}
        {tab === "settings" && <SettingsView settings={settings} me={me} onChange={update} />}
      </main>
      {showLog && (
        <pre className="log">
          {logs.join("")}
        </pre>
      )}
    </div>
  );
}

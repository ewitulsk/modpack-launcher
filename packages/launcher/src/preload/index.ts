import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

const launcher = {
  /** Calls a main-process handler; throws its error message on failure. */
  async invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
    const res = (await ipcRenderer.invoke(channel, ...args)) as { ok: true; value: T } | { ok: false; error: string };
    if (!res.ok) throw new Error(res.error);
    return res.value;
  },
  on<T = never>(channel: "progress" | "log" | "game:exit" | "auth:devicecode", fn: (payload: T) => void) {
    const listener = (_e: IpcRendererEvent, payload: T) => fn(payload);
    ipcRenderer.on(channel, listener);
    return (): void => {
      ipcRenderer.removeListener(channel, listener);
    };
  },
};

export type LauncherBridge = typeof launcher;
contextBridge.exposeInMainWorld("launcher", launcher);

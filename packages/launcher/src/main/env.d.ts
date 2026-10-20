interface ImportMetaEnv {
  readonly MAIN_VITE_SERVER_URL?: string;
}

interface ImportMeta {
  /** Injected by electron-vite; undefined when the file runs outside it (tests, tsx). */
  readonly env?: ImportMetaEnv;
}

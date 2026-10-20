interface ImportMetaEnv {
  readonly MAIN_VITE_SERVER_URL?: string;
}

interface ImportMeta {
  /** Injected by electron-vite. Accessed without `?.` so electron-vite can substitute it at build time. */
  readonly env: ImportMetaEnv;
}

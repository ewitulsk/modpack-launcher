/// <reference types="electron-vite/node" />

interface ImportMetaEnv {
  /** From packages/launcher/.env.production at build time; see README. */
  readonly MAIN_VITE_SERVER_URL?: string;
  /** Shared pack key baked into friends' builds (never commit it). */
  readonly MAIN_VITE_PACK_KEY?: string;
}

interface ImportMeta {
  /** Injected by electron-vite. Accessed without `?.` so electron-vite can substitute it at build time. */
  readonly env: ImportMetaEnv;
}

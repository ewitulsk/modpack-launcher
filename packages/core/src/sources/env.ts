import type { Env } from "../schema.js";

export type EnvSupport = Env["client"];

export const toSupport = (v: string | undefined): EnvSupport =>
  v === "required" || v === "unsupported" ? v : "optional";

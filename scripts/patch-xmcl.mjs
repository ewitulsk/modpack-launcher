// @xmcl/installer 6.3.x requires "@xmcl/core/utils", but no published @xmcl/core ships that file.
// Add it after install. (The matching @xmcl/unzip 2.2.0 packaging bug is handled by "overrides".)
import { existsSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(join(process.cwd(), "package.json"));
let core;
try {
  core = dirname(require.resolve("@xmcl/core/package.json"));
} catch {
  process.exit(0);
}
const target = join(core, "utils.js");
if (!existsSync(target)) writeFileSync(target, "exports.isNotNull = (v) => v !== undefined;\n");

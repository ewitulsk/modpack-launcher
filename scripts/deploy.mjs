#!/usr/bin/env node
// Builds the backend into one file and ships it to the droplet:  npm run deploy
// Host comes from `terraform output -raw ip` in infra/terraform, or DEPLOY_HOST.
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// Windows needs a shell to find npm.cmd, but not for ssh/scp: cmd.exe would swallow their remote `;` and `>` itself.
const needsShell = (cmd) => process.platform === "win32" && cmd === "npm";
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", cwd: root, shell: needsShell(cmd), ...opts });

const host =
  process.env.DEPLOY_HOST ||
  execFileSync("terraform", ["output", "-raw", "ip"], { cwd: join(root, "infra/terraform"), encoding: "utf8", shell: process.platform === "win32" }).trim();
const target = `root@${host}`;
const ssh = ["-o", "StrictHostKeyChecking=accept-new"];

console.log(`Building the backend bundle…`);
run("npm", ["run", "build", "-w", "@remix/core"]);
run("npm", ["run", "bundle", "-w", "@remix/backend"]);

console.log(`Waiting for ${host} to finish first-boot setup (Node install)…`);
run("ssh", [...ssh, target, "cloud-init status --wait >/dev/null; mkdir -p /opt/remix"]);

console.log(`Uploading to ${host}…`);
run("scp", [...ssh, "packages/backend/dist/server.mjs", `${target}:/opt/remix/server.mjs.new`]);
run("ssh", [...ssh, target, "mv /opt/remix/server.mjs.new /opt/remix/server.mjs && systemctl restart remix"]);

for (let i = 0; i < 20; i++) {
  try {
    const res = await fetch(`http://${host}/health`);
    if (res.ok) {
      console.log(`Deployed: http://${host} is up`, await res.json());
      process.exit(0);
    }
  } catch {}
  await new Promise((r) => setTimeout(r, 1500));
}
console.error(`Uploaded, but http://${host}/health didn't answer. Check: ssh ${target} journalctl -u remix -n 50`);
process.exit(1);

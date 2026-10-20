#!/usr/bin/env node
// Builds the backend into one file and ships it to the droplet:  npm run deploy
// Host and pack key come from `terraform output` in infra/terraform (or DEPLOY_HOST / PACK_KEY).
// Also keeps packages/launcher/.env.production pointing at the server with the right pack key.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const win = process.platform === "win32";
// Only npm needs a shell on Windows (it's npm.cmd). ssh/scp must not go through cmd.exe,
// which would treat the remote command's redirections as its own.
const run = (cmd, args) => execFileSync(cmd, args, { stdio: "inherit", cwd: root, shell: win && cmd === "npm" });
const tfOutput = (name) => {
  try {
    return execFileSync("terraform", ["output", "-raw", name], { cwd: join(root, "infra/terraform"), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
};

const host = process.env.DEPLOY_HOST || tfOutput("ip");
if (!host) {
  console.error("No host: run terraform apply in infra/terraform first, or set DEPLOY_HOST.");
  process.exit(1);
}
const packKey = process.env.PACK_KEY ?? tfOutput("pack_key");
const target = `root@${host}`;
const ssh = ["-o", "StrictHostKeyChecking=accept-new"];

console.log(`Building the backend bundle…`);
run("npm", ["run", "build", "-w", "@remix/core"]);
run("npm", ["run", "bundle", "-w", "@remix/backend"]);

console.log(`Waiting for ${host} to finish first-boot setup (Node install)…`);
run("ssh", [...ssh, target, "cloud-init status --wait >/dev/null; mkdir -p /opt/remix"]);

if (packKey) {
  if (!/^[A-Za-z0-9]+$/.test(packKey)) throw new Error("PACK_KEY must be letters and digits only");
  console.log("Setting the pack key on the server…");
  run("ssh", [...ssh, target, `sed -i '/^PACK_KEY=/d' /etc/remix/env && echo 'PACK_KEY=${packKey}' >> /etc/remix/env`]);
}

console.log(`Uploading to ${host}…`);
run("scp", [...ssh, "packages/backend/dist/server.mjs", `${target}:/opt/remix/server.mjs.new`]);
run("ssh", [...ssh, target, "mv /opt/remix/server.mjs.new /opt/remix/server.mjs && systemctl restart remix"]);

// Friends' builds (npm run dist -w @remix/launcher) read these.
const envFile = join(root, "packages/launcher/.env.production");
const env = new Map(
  (existsSync(envFile) ? readFileSync(envFile, "utf8") : "")
    .split(/\r?\n/)
    .filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
env.set("MAIN_VITE_SERVER_URL", `http://${host}`);
if (packKey) env.set("MAIN_VITE_PACK_KEY", packKey);
writeFileSync(envFile, [...env].map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
console.log("Updated packages/launcher/.env.production (rebuild the installer to ship it).");

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

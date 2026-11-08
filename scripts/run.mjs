import { rehabProcessEnvironment, yuvrajEnvironment } from "../packages/yuvraj-integration/environment.mjs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const nextBin = require.resolve("next/dist/bin/next");
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
if (process.env.PANDA_RUNTIME!=="production" && existsSync(path.join(root, ".env.local"))) {
  // In local development the ignored project env file is authoritative for Gemini credentials.
  // Clear inherited values so an older Windows/user-shell key cannot shadow an updated .env.local.
  delete process.env.PANDA_GEMINI_API_KEY;
  delete process.env.REHAB_GEMINI_API_KEY;
  process.loadEnvFile(path.join(root, ".env.local"));
}
const [command = "dev", selected = "all"] = process.argv.slice(2);
if (
  !["dev", "build", "start"].includes(command) ||
  !["all", "panda", "care", "rehab"].includes(selected)
)
  throw Error("Invalid command/app");
const apps = selected === "all" ? ["care", "rehab", "panda"] : [selected];
const env = {
  ...process.env,
  PANDA_INTEGRATION:
    process.env.PANDA_INTEGRATION ||
    (selected === "all" ? "connected" : "fixture"),
};
Object.assign(env,yuvrajEnvironment(env));
const pandaPort = command === "start" && env.PANDA_RUNTIME === "production"
  ? Number(env.PORT || 3000)
  : Number(env.PANDA_PORT || 3000);
const children = new Set();
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const p of children) {
    p.kill("SIGTERM");
    setTimeout(() => {
      if (p.exitCode === null && p.signalCode === null) p.kill("SIGKILL");
    }, 20000).unref();
  }
  process.exitCode = code;
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
function run(app) {
  return new Promise((resolve) => {
    const ports = { panda: pandaPort, care: 3001, rehab: 3002 };
    const args = [
      nextBin,
      command,
      ...(command === "build"
        ? []
        : ["--hostname", app==="panda"&&env.PANDA_RUNTIME==="production"?"0.0.0.0":"127.0.0.1", "--port", String(ports[app])]),
    ];
    const p = spawn(process.execPath, args, {
      cwd: path.join(root, "apps", app),
      env: app === "rehab" ? rehabProcessEnvironment(env) : env,
      stdio: "inherit",
    });
    children.add(p);
    p.on("exit", (code) => {
      children.delete(p);
      resolve(code ?? 1);
      if (command !== "build" && !stopping) stop(code ?? 1);
    });
    p.on("error", (e) => {
      console.error(e.message);
      resolve(1);
      stop(1);
    });
  });
}
if (command === "build") {
  for (const a of apps) {
    const code = await run(a);
    if (code) {
      process.exitCode = code;
      break;
    }
  }
} else {
  console.log(
    `Panda: ${env.PANDA_INTEGRATION} mode. Integrated entry http://localhost:${pandaPort}; Care /care; Rehab /rehab.`,
  );
  await Promise.all(apps.map(run));
}

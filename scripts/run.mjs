import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const nextBin = require.resolve("next/dist/bin/next");
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
if (existsSync(path.join(root, ".env.local")))
  process.loadEnvFile(path.join(root, ".env.local"));
const [command = "dev", selected = "all"] = process.argv.slice(2);
if (
  !["dev", "build", "start"].includes(command) ||
  !["all", "panda", "care", "rehab"].includes(selected)
)
  throw Error("Invalid command/app");
const apps = selected === "all" ? ["care", "rehab", "panda"] : [selected];
const env = {
  ...process.env,
  ...(selected === "all" ? { REHAB_DEMO_ALLOWED_ORIGIN: process.env.REHAB_DEMO_ALLOWED_ORIGIN || "http://localhost:3000" } : {}),
  PANDA_INTEGRATION:
    process.env.PANDA_INTEGRATION ||
    (selected === "all" ? "connected" : "fixture"),
};
const children = new Set();
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const p of children) {
    p.kill("SIGTERM");
    setTimeout(() => {
      if (p.exitCode === null && p.signalCode === null) p.kill("SIGKILL");
    }, 3000).unref();
  }
  process.exitCode = code;
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
function run(app) {
  return new Promise((resolve) => {
    const ports = { panda: 3000, care: 3001, rehab: 3002 };
    const args = [
      nextBin,
      command,
      ...(command === "build"
        ? []
        : ["--hostname", "127.0.0.1", "--port", String(ports[app])]),
    ];
    const p = spawn(process.execPath, args, {
      cwd: path.join(root, "apps", app),
      env,
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
    `Panda: ${env.PANDA_INTEGRATION} mode. Integrated entry http://localhost:3000; Care /care; Rehab /rehab.`,
  );
  await Promise.all(apps.map(run));
}

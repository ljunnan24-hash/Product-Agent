import { spawn } from "node:child_process";

const args = parseArgs(process.argv.slice(2));
if (args.help === true || args.h === true) {
  printHelp();
  process.exit(0);
}

const projectRoot = process.cwd();
const shouldRunDoctor = args.doctor !== false;
const shouldRunWorker = args.worker !== false;
const devPort = stringArg(args.port) || "3020";
const hostname = stringArg(args.hostname) || "127.0.0.1";
const daemonId = stringArg(args["daemon-id"]) || "taste-agent-local-runner";
const workerIntervalMs = stringArg(args["worker-interval-ms"]) || "5000";
const workerLimit = stringArg(args["worker-limit"]) || "10";
const workerScanLimit = stringArg(args["worker-scan-limit"]) || "200";
const workerConcurrency = stringArg(args["worker-concurrency"]) || "2";

const children = new Map();
let stopping = false;

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    void stopAll(signal, 0);
  });
}

if (shouldRunDoctor) {
  const doctorExit = await runOneShot("doctor", [
    process.execPath,
    ["scripts/local-doctor.mjs"],
    { stdio: "inherit" }
  ]);
  if (doctorExit !== 0) {
    console.error("\nLocal doctor found blockers. Fix them or rerun with --no-doctor to bypass.");
    process.exit(doctorExit);
  }
}

console.log(`\nProduct Agent local runner`);
console.log(`- App: http://${hostname}:${devPort}`);
console.log(`- Worker: ${shouldRunWorker ? `enabled (${daemonId})` : "disabled"}`);
console.log(`- Stop: Ctrl+C\n`);

startManagedProcess("app", process.execPath, [
  "node_modules/next/dist/bin/next",
  "dev",
  "--hostname",
  hostname,
  "--port",
  devPort
]);

if (shouldRunWorker) {
  startManagedProcess("worker", process.execPath, [
    "scripts/local-worker-drain.mjs",
    "--watch",
    "--daemon-id",
    daemonId,
    "--interval-ms",
    workerIntervalMs,
    "--limit",
    workerLimit,
    "--scan-limit",
    workerScanLimit,
    "--concurrency",
    workerConcurrency
  ]);
}

await new Promise(() => undefined);

function startManagedProcess(name, command, values) {
  const child = spawn(command, values, {
    cwd: projectRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  children.set(name, child);
  prefixPipe(name, child.stdout);
  prefixPipe(name, child.stderr);
  child.once("exit", (code, signal) => {
    children.delete(name);
    if (stopping) return;
    const exitCode = code ?? (signal ? 1 : 0);
    console.error(`\n${name} exited with ${signal ?? exitCode}. Stopping local runner.`);
    void stopAll(`${name}_exit`, exitCode || 1);
  });
}

async function runOneShot(name, tuple) {
  const [command, values, options] = tuple;
  return new Promise((resolve) => {
    const child = spawn(command, values, {
      cwd: projectRoot,
      env: process.env,
      ...options
    });
    child.once("exit", (code) => resolve(code ?? 1));
    child.once("error", () => resolve(1));
  });
}

async function stopAll(reason, exitCode) {
  if (stopping) return;
  stopping = true;
  console.log(`\nStopping Product Agent local runner (${reason})...`);
  const running = [...children.values()];
  for (const child of running) {
    if (!child.pid || child.killed) continue;
    child.kill("SIGTERM");
  }
  await sleep(2500);
  for (const child of running) {
    if (!child.pid || child.killed) continue;
    try {
      process.kill(child.pid, "SIGKILL");
    } catch {
      // Already stopped.
    }
  }
  process.exit(exitCode);
}

function prefixPipe(name, stream) {
  if (!stream) return;
  let carry = "";
  stream.on("data", (chunk) => {
    carry += chunk.toString();
    const lines = carry.split(/\r?\n/);
    carry = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      console.log(`[${name}] ${line}`);
    }
  });
  stream.on("end", () => {
    if (carry.trim()) console.log(`[${name}] ${carry}`);
  });
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const raw = values[index];
    if (!raw.startsWith("--")) continue;
    const key = raw.slice(2);
    if (key.startsWith("no-")) {
      parsed[key.slice(3)] = false;
      continue;
    }
    const next = values[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
      continue;
    }
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

function stringArg(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printHelp() {
  console.log(`Usage:
  pnpm local -- [options]

Options:
  --port 3020                    App port
  --hostname 127.0.0.1           App hostname
  --no-doctor                    Skip pnpm doctor preflight
  --no-worker                    Start only the Next dev server
  --daemon-id taste-agent-local  Worker daemon id
  --worker-interval-ms 5000      Worker drain interval
  --worker-limit 10              Max workers drained per cycle
  --worker-scan-limit 200        Max queue records scanned per cycle
  --worker-concurrency 2         Parallel worker replay jobs

Examples:
  pnpm local
  pnpm local -- --no-worker
  pnpm local -- --port 3030 --daemon-id taste-agent-dev
`);
}

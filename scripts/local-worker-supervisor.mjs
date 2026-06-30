import { createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const args = parseArgs(process.argv.slice(2));
if (args.help === true || args.h === true) {
  printHelp();
  process.exit(0);
}

const projectRoot = process.cwd();
const daemonRoot = path.join(projectRoot, ".taste-data", "worker-daemon");
const supervisorRoot = path.join(daemonRoot, "supervisor");
const daemonId = stringArg(args["daemon-id"]) || "taste-agent-managed-worker";
const intervalMs = numberArg(args["interval-ms"], 5_000);
const limit = numberArg(args.limit, 10);
const scanLimit = numberArg(args["scan-limit"], 200);
const concurrency = numberArg(args.concurrency, 2);
const leaseMs = numberArg(args["lease-ms"], 10 * 60 * 1000);
const expiredMode = args["expired-mode"] === "fail" ? "fail" : "requeue";
const restartBackoffMs = numberArg(args["restart-backoff-ms"], 1_500);
const maxRestarts = numberArg(args["max-restarts"], 50);
const statePath = path.join(supervisorRoot, `${safeFileSegment(daemonId)}.state.json`);
const controlPath = path.join(supervisorRoot, `${safeFileSegment(daemonId)}.control.json`);
const eventPath = path.join(supervisorRoot, `${safeFileSegment(daemonId)}.jsonl`);
const stdoutPath = path.join(supervisorRoot, `${safeFileSegment(daemonId)}.stdout.log`);
const stderrPath = path.join(supervisorRoot, `${safeFileSegment(daemonId)}.stderr.log`);

await fs.mkdir(supervisorRoot, { recursive: true });
await fs.rm(controlPath, { force: true }).catch(() => undefined);
const stdout = createWriteStream(stdoutPath, { flags: "a" });
const stderr = createWriteStream(stderrPath, { flags: "a" });
let worker = null;
let restarts = 0;
let stopping = false;
let stopReason = "";

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    void requestStop(signal);
  });
}

await appendEvent({ action: "supervisor_start", supervisorPid: process.pid });
await writeState("starting");

try {
  while (!stopping) {
    const control = await readControl();
    if (control?.stopRequested) {
      stopReason = control.reason || "control_file";
      break;
    }
    worker = startWorker();
    await writeState("running", { workerPid: worker.pid });
    const exit = await waitForExit(worker);
    const lastExit = {
      code: exit.code,
      signal: exit.signal,
      at: new Date().toISOString()
    };
    worker = null;
    const latestControl = await readControl();
    if (stopping || latestControl?.stopRequested || exit.code === 0) {
      stopReason = stopReason || latestControl?.reason || `worker_exit_${exit.code ?? exit.signal ?? "unknown"}`;
      await appendEvent({ action: "supervisor_stop", lastExit, restarts, stopReason });
      await writeState("stopped", { lastExit, stopReason });
      process.exit(0);
    }
    restarts += 1;
    if (restarts > maxRestarts) {
      await appendEvent({ action: "restart_limit_exceeded", lastExit, restarts });
      await writeState("failed", { lastExit, error: `Restart limit exceeded: ${maxRestarts}` });
      process.exit(1);
    }
    const nextRestartAt = new Date(Date.now() + Math.min(restartBackoffMs * restarts, 30_000)).toISOString();
    await appendEvent({ action: "worker_crashed", lastExit, restarts, nextRestartAt });
    await writeState("restarting", { lastExit, nextRestartAt });
    await sleep(Math.min(restartBackoffMs * restarts, 30_000));
  }
  await requestStop(stopReason || "loop_stop");
} catch (error) {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  await appendEvent({ action: "supervisor_failed", error: message });
  await writeState("failed", { error: message });
  throw error;
}

function startWorker() {
  stdout.write(`\n[${new Date().toISOString()}] worker start ${daemonId} restart=${restarts}\n`);
  stderr.write(`\n[${new Date().toISOString()}] worker start ${daemonId} restart=${restarts}\n`);
  const child = spawn(
    process.execPath,
    [
      path.join(projectRoot, "scripts", "local-worker-drain.mjs"),
      "--watch",
      "--daemon-id",
      daemonId,
      "--interval-ms",
      String(clamp(intervalMs, 1_000, 60_000)),
      "--limit",
      String(clamp(limit, 1, 100)),
      "--scan-limit",
      String(clamp(scanLimit, 1, 1_000)),
      "--concurrency",
      String(clamp(concurrency, 1, 8)),
      "--lease-ms",
      String(clamp(leaseMs, 5_000, 60 * 60 * 1000)),
      "--expired-mode",
      expiredMode
    ],
    {
      cwd: projectRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  child.stdout?.pipe(stdout, { end: false });
  child.stderr?.pipe(stderr, { end: false });
  void appendEvent({ action: "worker_start", workerPid: child.pid, restart: restarts });
  return child;
}

async function requestStop(reason) {
  if (stopping) return;
  stopping = true;
  stopReason = reason || "stop_requested";
  await fs.writeFile(
    controlPath,
    JSON.stringify({ stopRequested: true, reason: stopReason, at: new Date().toISOString() }, null, 2),
    "utf8"
  ).catch(() => undefined);
  await appendEvent({ action: "supervisor_stop_requested", workerPid: worker?.pid, reason: stopReason });
  await writeState("stopping", { stopReason });
  if (worker?.pid) {
    try {
      process.kill(worker.pid, "SIGTERM");
    } catch {
      // The child may have already exited; the main loop will finish naturally.
    }
    setTimeout(() => {
      if (!worker?.pid) return;
      try {
        process.kill(worker.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }, 3_000).unref();
  } else {
    await writeState("stopped", { stopReason });
    process.exit(0);
  }
}

async function writeState(status, patch = {}) {
  const state = {
    daemonId,
    version: "local-worker-supervisor-v1",
    status,
    supervisorPid: process.pid,
    workerPid: worker?.pid,
    updatedAt: new Date().toISOString(),
    restarts,
    maxRestarts,
    restartBackoffMs,
    controlPath,
    stdoutPath,
    stderrPath,
    ...patch
  };
  await fs.writeFile(statePath, JSON.stringify(state, null, 2), "utf8");
}

async function appendEvent(value) {
  await fs.appendFile(
    eventPath,
    `${JSON.stringify({ daemonId, at: new Date().toISOString(), ...value })}\n`,
    "utf8"
  );
}

async function readControl() {
  try {
    const raw = await fs.readFile(controlPath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function waitForExit(child) {
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const raw = values[index];
    if (!raw.startsWith("--")) continue;
    const key = raw.slice(2);
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

function printHelp() {
  console.log(`Usage:
  node scripts/local-worker-supervisor.mjs --daemon-id taste-agent-managed-worker

Options:
  --daemon-id <id>                 Stable worker daemon id
  --interval-ms 5000               Worker drain interval
  --limit 10                       Max workers per cycle
  --scan-limit 200                 Max records scanned per cycle
  --concurrency 2                  Parallel replay jobs
  --lease-ms 600000                Worker lease duration
  --expired-mode requeue|fail      How to handle expired running leases
  --restart-backoff-ms 1500        Initial restart backoff
  --max-restarts 50                Restart limit before supervisor fails

Writes:
  .taste-data/worker-daemon/supervisor/<daemon-id>.state.json
  .taste-data/worker-daemon/supervisor/<daemon-id>.jsonl
`);
}

function numberArg(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function stringArg(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function safeFileSegment(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 120) || "daemon";
}

function clamp(value, min, max) {
  const normalized = Number.isFinite(value) ? Math.floor(value) : min;
  return Math.max(min, Math.min(normalized, max));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

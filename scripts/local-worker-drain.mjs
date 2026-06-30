import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const args = parseArgs(process.argv.slice(2));
if (args.help === true || args.h === true) {
  printHelp();
  process.exit(0);
}

const projectRoot = process.cwd();
const runtimeRoot = path.join(projectRoot, ".taste-data", "worker-runtime");
const daemonRoot = path.join(projectRoot, ".taste-data", "worker-daemon");
const daemonId = stringArg(args["daemon-id"]) || `local-drain-${process.pid}`;
const watch = args.watch === true;
const intervalMs = numberArg(args["interval-ms"], numberArg(args.interval, 10_000));
const maxCycles = numberArg(args.cycles, watch ? 0 : 1);

await prepareRuntimeCopy();
const { drainDurableWorkerQueue } = await import(
  pathToFileURL(path.join(runtimeRoot, "src", "lib", "durable-worker-drain.mjs")).href
);

let cycle = 0;
let stopRequested = false;
let lastResultSummary = null;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (stopRequested) return;
    stopRequested = true;
    void writeHeartbeat("stopped", { cycle, lastResult: lastResultSummary, stopReason: signal }).finally(() => {
      process.exit(0);
    });
  });
}
await writeHeartbeat("starting", { cycle });

try {
  do {
    if (stopRequested) break;
    cycle += 1;
    await writeHeartbeat("running", { cycle });
    const result = await drainDurableWorkerQueue({
      traceId: stringArg(args["trace-id"]),
      limit: numberArg(args.limit, 10),
      scanLimit: numberArg(args["scan-limit"], 200),
      concurrency: numberArg(args.concurrency, 2),
      leaseMs: numberArg(args["lease-ms"], 10 * 60 * 1000),
      expiredMode: args["expired-mode"] === "fail" ? "fail" : "requeue"
    });
    await appendRunLog({ cycle, result });
    lastResultSummary = summarizeResult(result);
    await writeHeartbeat("idle", { cycle, lastResult: lastResultSummary });
    printResult(result, cycle);
    if (!watch || (maxCycles > 0 && cycle >= maxCycles)) break;
    await sleep(intervalMs);
  } while (!stopRequested);
  await writeHeartbeat("stopped", { cycle, lastResult: lastResultSummary });
} catch (error) {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  await writeHeartbeat("failed", { cycle, error: message });
  throw error;
}

async function prepareRuntimeCopy() {
  const ts = await import("typescript");
  const sourceLibDir = path.join(projectRoot, "src", "lib");
  const targetLibDir = path.join(runtimeRoot, "src", "lib");
  await fs.rm(runtimeRoot, { recursive: true, force: true });
  await fs.mkdir(targetLibDir, { recursive: true });
  const fileNames = (await fs.readdir(sourceLibDir)).filter((fileName) => fileName.endsWith(".ts"));
  await Promise.all(
    fileNames.map(async (fileName) => {
      const sourcePath = path.join(sourceLibDir, fileName);
      const targetPath = path.join(targetLibDir, fileName.replace(/\.ts$/, ".mjs"));
      const raw = await fs.readFile(sourcePath, "utf8");
      const rewritten = rewriteRelativeRuntimeImports(raw);
      const output = ts.transpileModule(rewritten, {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ES2022,
          moduleResolution: ts.ModuleResolutionKind.NodeNext,
          esModuleInterop: true,
          skipLibCheck: true
        },
        fileName
      }).outputText;
      await fs.writeFile(targetPath, output, "utf8");
    })
  );
}

function rewriteRelativeRuntimeImports(source) {
  return source
    .replace(/(from\s+["'])(\.\.?\/[^"']+)(["'])/g, (_match, prefix, specifier, suffix) => {
      return `${prefix}${withRuntimeExtension(specifier)}${suffix}`;
    })
    .replace(/(import\s*\(\s*["'])(\.\.?\/[^"']+)(["']\s*\))/g, (_match, prefix, specifier, suffix) => {
      return `${prefix}${withRuntimeExtension(specifier)}${suffix}`;
    });
}

function withRuntimeExtension(specifier) {
  if (/\.(js|mjs|cjs|json)$/.test(specifier)) return specifier;
  if (/\.(ts|tsx|mts|cts)$/.test(specifier)) return specifier.replace(/\.(ts|tsx|mts|cts)$/, ".mjs");
  return `${specifier}.mjs`;
}

async function writeHeartbeat(status, patch = {}) {
  await fs.mkdir(daemonRoot, { recursive: true });
  const heartbeat = {
    daemonId,
    version: "standalone-worker-daemon-v1",
    mode: "local",
    status,
    pid: process.pid,
    updatedAt: new Date().toISOString(),
    projectRoot,
    runtimeRoot,
    ...patch
  };
  await fs.writeFile(
    path.join(daemonRoot, `${safeFileSegment(daemonId)}.heartbeat.json`),
    JSON.stringify(heartbeat, null, 2),
    "utf8"
  );
}

async function appendRunLog(entry) {
  const runDir = path.join(daemonRoot, "runs");
  await fs.mkdir(runDir, { recursive: true });
  await fs.appendFile(
    path.join(runDir, `${safeFileSegment(daemonId)}.jsonl`),
    `${JSON.stringify({ daemonId, at: new Date().toISOString(), ...entry })}\n`,
    "utf8"
  );
}

function summarizeResult(result) {
  return {
    selected: result.selected,
    scannedQueued: result.scannedQueued,
    counts: result.counts,
    maintenance: {
      scanned: result.maintenance.scanned,
      requeued: result.maintenance.requeued,
      cancelled: result.maintenance.cancelled,
      failedExpired: result.maintenance.failedExpired,
      stillRunning: result.maintenance.stillRunning,
      recoveredRecords: result.maintenance.records.slice(0, 5).map((record) => ({
        id: record.id,
        status: record.status,
        workerLabel: record.workerLabel,
        attempt: record.attempt,
        maxAttempts: record.maxAttempts,
        reason: record.outputSummary || record.errorMessage || record.metrics?.lastRequeueReason
      }))
    }
  };
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

function printResult(result, cycle) {
  console.log(
    [
      `mode=local`,
      `daemon=${daemonId}`,
      `cycle=${cycle}`,
      `selected=${result.selected}`,
      `queued=${result.scannedQueued}`,
      `applied=${result.counts.applied}`,
      `blocked=${result.counts.blocked}`,
      `unsupported=${result.counts.unsupported}`,
      `skipped=${result.counts.skipped}`,
      `maintenance_requeued=${result.maintenance.requeued}`,
      `maintenance_cancelled=${result.maintenance.cancelled}`,
      `maintenance_failed_expired=${result.maintenance.failedExpired}`,
      `maintenance_still_running=${result.maintenance.stillRunning}`
    ].join(" ")
  );
  for (const item of result.items) {
    console.log(
      `- ${item.status}/${item.recordStatus} ${item.workerLabel} ${item.id}: ${squash(item.summary, 180)}`
    );
  }
}

function printHelp() {
  console.log(`Usage:
  pnpm worker:local-drain -- [options]

Options:
  --watch                         Keep draining in a loop
  --interval-ms 10000             Watch interval
  --cycles 5                      Stop after N cycles; 0 means unlimited in watch mode
  --limit 10                      Max workers per cycle
  --scan-limit 200                Max records to scan per cycle
  --concurrency 2                 Parallel replay jobs inside this local process
  --trace-id <id>                 Drain only one runtime trace
  --lease-ms 600000               Worker lease duration
  --expired-mode requeue|fail     How to handle expired running leases
  --daemon-id <id>                Stable heartbeat/log id

Writes:
  .taste-data/worker-daemon/<daemon-id>.heartbeat.json
  .taste-data/worker-daemon/runs/<daemon-id>.jsonl

This is the local standalone drain mode. It imports the durable worker libraries in-process and does not call /api/worker-queue.
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

function squash(value, maxLength) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}...` : normalized;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

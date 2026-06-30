const args = parseArgs(process.argv.slice(2));
if (args.help === true || args.h === true) {
  printHelp();
  process.exit(0);
}

const watch = args.watch === true;
const intervalMs = numberArg(args["interval-ms"], numberArg(args.interval, 10_000));
const maxCycles = numberArg(args.cycles, watch ? 0 : 1);
const endpoint = buildEndpoint(stringArg(args.url) || process.env.TASTE_AGENT_URL || "http://127.0.0.1:3020");

let cycle = 0;
do {
  cycle += 1;
  const result = await requestDrain(endpoint, {
    action: "drain",
    traceId: stringArg(args["trace-id"]),
    limit: numberArg(args.limit, 10),
    scanLimit: numberArg(args["scan-limit"], 200),
    concurrency: numberArg(args.concurrency, 2),
    leaseMs: numberArg(args["lease-ms"], 10 * 60 * 1000),
    expiredMode: args["expired-mode"] === "fail" ? "fail" : "requeue"
  });
  printResult(result, cycle);
  if (!watch || (maxCycles > 0 && cycle >= maxCycles)) break;
  await sleep(intervalMs);
} while (true);

async function requestDrain(endpoint, payload) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      `worker drain request failed ${response.status}: ${body?.error || response.statusText}`
    );
  }
  return body.result;
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

function buildEndpoint(baseUrl) {
  const url = new URL(baseUrl);
  if (!url.pathname || url.pathname === "/") {
    url.pathname = "/api/worker-queue";
  }
  return url.toString();
}

function printHelp() {
  console.log(`Usage:
  pnpm worker:drain -- [options]

Options:
  --url http://127.0.0.1:3020     Taste Agent app URL or /api/worker-queue endpoint
  --watch                         Keep draining in a loop
  --interval-ms 10000             Watch interval
  --cycles 5                      Stop after N cycles; 0 means unlimited in watch mode
  --limit 10                      Max workers per cycle
  --scan-limit 200                Max records to scan per cycle
  --concurrency 2                 Parallel replay requests inside the API drain
  --trace-id <id>                 Drain only one runtime trace
  --lease-ms 600000               Worker lease duration
  --expired-mode requeue|fail     How to handle expired running leases
`);
}

function numberArg(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function stringArg(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function squash(value, maxLength) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}...` : normalized;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

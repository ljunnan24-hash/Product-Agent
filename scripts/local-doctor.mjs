import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const projectRoot = process.cwd();
const args = parseArgs(process.argv.slice(2));
const jsonMode = args.json === true;

const checks = [];

await checkNode();
await checkPnpm();
await checkProjectFiles();
await checkEnv();
await checkDocker();
await checkLocalData();
await checkWorkerDaemon();
await checkDurableQueue();

const summary = summarizeChecks(checks);
if (jsonMode) {
  console.log(JSON.stringify({ summary, checks }, null, 2));
} else {
  printHuman(summary, checks);
}

process.exit(summary.blockers > 0 ? 1 : 0);

async function checkNode() {
  const version = process.versions.node;
  const major = Number(version.split(".")[0]);
  addCheck({
    id: "node",
    label: "Node.js",
    status: major >= 22 ? "pass" : "block",
    summary: `Node ${version}`,
    details: major >= 22 ? ["Next 15 / scripts runtime OK."] : ["Node 22+ is recommended for this local app."]
  });
}

async function checkPnpm() {
  const result = await command("pnpm", ["--version"]);
  addCheck({
    id: "pnpm",
    label: "pnpm",
    status: result.ok ? "pass" : "block",
    summary: result.ok ? `pnpm ${result.stdout.trim()}` : "pnpm not available",
    details: result.ok ? [] : ["Install pnpm or use corepack before running the app."]
  });
}

async function checkProjectFiles() {
  const required = ["package.json", "pnpm-lock.yaml", "src/app/page.tsx", "scripts/local-worker-drain.mjs"];
  const missing = [];
  for (const file of required) {
    if (!(await fileExists(path.join(projectRoot, file)))) missing.push(file);
  }
  addCheck({
    id: "project-files",
    label: "Project files",
    status: missing.length ? "block" : "pass",
    summary: missing.length ? `${missing.length} required files missing` : "required files present",
    details: missing.map((file) => `Missing ${file}`)
  });
  addCheck({
    id: "dependencies",
    label: "Dependencies",
    status: (await fileExists(path.join(projectRoot, "node_modules"))) ? "pass" : "warn",
    summary: (await fileExists(path.join(projectRoot, "node_modules")))
      ? "node_modules present"
      : "node_modules missing",
    details: (await fileExists(path.join(projectRoot, "node_modules")))
      ? []
      : ["Run pnpm install before pnpm dev."]
  });
}

async function checkEnv() {
  const envFile = await readEnvFile(path.join(projectRoot, ".env.local"));
  const exampleExists = await fileExists(path.join(projectRoot, ".env.example"));
  const reportProvider = envValue(envFile, "REPORT_MODEL_PROVIDER") || "auto";
  const hasZhipu = Boolean(envValue(envFile, "ZHIPU_API_KEY"));
  const hasDeepSeek = Boolean(envValue(envFile, "DEEPSEEK_API_KEY"));
  const hasSerper = Boolean(envValue(envFile, "SERPER_API_KEY"));
  const hasReportModel =
    reportProvider === "zhipu"
      ? hasZhipu
      : reportProvider === "deepseek"
        ? hasDeepSeek
        : hasZhipu || hasDeepSeek;
  addCheck({
    id: "env-file",
    label: "Environment file",
    status: envFile.exists ? "pass" : "warn",
    summary: envFile.exists ? ".env.local present" : ".env.local missing",
    details: [
      envFile.exists ? "" : "Copy .env.example to .env.local and fill only the keys you need.",
      exampleExists ? "" : ".env.example is missing."
    ].filter(Boolean)
  });
  addCheck({
    id: "report-model-key",
    label: "Report model key",
    status: hasReportModel ? "pass" : "warn",
    summary: hasReportModel
      ? `model provider ${reportProvider}; key present`
      : `model provider ${reportProvider}; no usable report key found`,
    details: hasReportModel
      ? []
      : ["Set ZHIPU_API_KEY or DEEPSEEK_API_KEY to generate model reports; fallback reports still work."]
  });
  addCheck({
    id: "search-key",
    label: "Search key",
    status: hasZhipu || hasSerper ? "pass" : "warn",
    summary: hasZhipu || hasSerper ? "search provider key present" : "no search key found",
    details: hasZhipu || hasSerper
      ? []
      : ["Set ZHIPU_API_KEY or SERPER_API_KEY for web evidence search; missing keys create runtime interrupts."]
  });
}

async function checkDocker() {
  const envFile = await readEnvFile(path.join(projectRoot, ".env.local"));
  const sandbox = envValue(envFile, "CODE_EXECUTOR_SANDBOX") || "auto";
  const image = envValue(envFile, "CODE_EXECUTOR_DOCKER_IMAGE") || "python:3.12-slim";
  const strongSandbox = truthy(envValue(envFile, "CODE_EXECUTOR_REQUIRE_STRONG_SANDBOX")) ||
    envValue(envFile, "NODE_ENV") === "production" ||
    process.env.NODE_ENV === "production";
  const dockerVersion = await command("docker", ["version", "--format", "{{.Server.Version}}"]);
  if (!dockerVersion.ok) {
    addCheck({
      id: "docker-daemon",
      label: "Docker daemon",
      status: sandbox === "docker" || strongSandbox ? "block" : "warn",
      summary: "Docker daemon unavailable",
      details: [
        compact(dockerVersion.stderr || dockerVersion.stdout || dockerVersion.error || "docker version failed"),
        strongSandbox
          ? "Production/strong sandbox mode requires Docker no-network execution."
          : "Local auto mode can fall back to process sandbox, but Docker is safer for code_execute."
      ]
    });
    return;
  }
  const imageInspect = await command("docker", ["image", "inspect", image]);
  addCheck({
    id: "docker-daemon",
    label: "Docker daemon",
    status: "pass",
    summary: `Docker ${dockerVersion.stdout.trim()}`,
    details: []
  });
  addCheck({
    id: "docker-image",
    label: "Docker image",
    status: imageInspect.ok ? "pass" : sandbox === "docker" || strongSandbox ? "block" : "warn",
    summary: imageInspect.ok ? `${image} present` : `${image} missing`,
    details: imageInspect.ok
      ? []
      : [`Run docker pull ${image} before using CODE_EXECUTOR_SANDBOX=docker.`]
  });
}

async function checkLocalData() {
  const dataRoot = path.join(projectRoot, ".taste-data");
  const dirs = ["analyses", "artifacts", "worker-queue", "worker-daemon", "memory"];
  const existing = [];
  for (const dir of dirs) {
    if (await fileExists(path.join(dataRoot, dir))) existing.push(dir);
  }
  addCheck({
    id: "local-data",
    label: "Local data",
    status: "pass",
    summary: existing.length ? `.taste-data has ${existing.join(", ")}` : ".taste-data will be created on first run",
    details: []
  });
}

async function checkWorkerDaemon() {
  const daemonRoot = path.join(projectRoot, ".taste-data", "worker-daemon");
  const files = await fs.readdir(daemonRoot).catch(() => []);
  const heartbeats = [];
  for (const file of files.filter((item) => item.endsWith(".heartbeat.json"))) {
    try {
      const raw = await fs.readFile(path.join(daemonRoot, file), "utf8");
      heartbeats.push(JSON.parse(raw));
    } catch {
      // Ignore malformed local status files.
    }
  }
  const latest = heartbeats
    .filter((item) => item?.updatedAt)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0];
  if (!latest) {
    addCheck({
      id: "worker-daemon",
      label: "Worker daemon",
      status: "warn",
      summary: "no heartbeat found",
      details: ["Use the report page controls or pnpm worker:local-drain -- --watch for background queue draining."]
    });
    return;
  }
  const ageMs = Date.now() - new Date(latest.updatedAt).getTime();
  const live = ["starting", "running", "idle"].includes(String(latest.status)) && ageMs <= 45_000;
  addCheck({
    id: "worker-daemon",
    label: "Worker daemon",
    status: live ? "pass" : "warn",
    summary: `${latest.daemonId || "daemon"} ${latest.status}; age ${formatMs(ageMs)}`,
    details: live ? [] : ["Heartbeat is stale or stopped; queued workers may need manual drain."]
  });
}

async function checkDurableQueue() {
  const queueDir = path.join(projectRoot, ".taste-data", "worker-queue");
  const files = await fs.readdir(queueDir).catch(() => []);
  const counts = { queued: 0, running: 0, completed: 0, failed: 0, skipped: 0, cancelled: 0 };
  const failed = [];
  for (const file of files.filter((item) => item.endsWith(".json"))) {
    try {
      const raw = await fs.readFile(path.join(queueDir, file), "utf8");
      const record = JSON.parse(raw);
      if (record.status in counts) counts[record.status] += 1;
      if (record.status === "failed") failed.push(record);
    } catch {
      // Ignore malformed queue files.
    }
  }
  const active = counts.queued + counts.running;
  addCheck({
    id: "durable-queue",
    label: "Durable queue",
    status: failed.length ? "warn" : "pass",
    summary: `queued ${counts.queued}, running ${counts.running}, failed ${counts.failed}, completed ${counts.completed}`,
    details: [
      active ? `${active} active workers are waiting/running.` : "",
      ...failed.slice(0, 5).map((record) => `failed ${record.id}: ${compact(record.outputSummary || record.errorMessage || record.workerLabel || "unknown")}`)
    ].filter(Boolean)
  });
}

function addCheck(check) {
  checks.push({
    ...check,
    details: (check.details || []).filter(Boolean)
  });
}

function summarizeChecks(items) {
  return {
    status: items.some((item) => item.status === "block")
      ? "block"
      : items.some((item) => item.status === "warn")
        ? "warn"
        : "pass",
    total: items.length,
    passed: items.filter((item) => item.status === "pass").length,
    warnings: items.filter((item) => item.status === "warn").length,
    blockers: items.filter((item) => item.status === "block").length
  };
}

function printHuman(summary, items) {
  console.log(`Product Agent doctor: ${summary.status.toUpperCase()} (${summary.passed} pass, ${summary.warnings} warn, ${summary.blockers} block)`);
  for (const item of items) {
    console.log(`${symbolFor(item.status)} ${item.label}: ${item.summary}`);
    for (const detail of item.details) {
      console.log(`  - ${detail}`);
    }
  }
}

function symbolFor(status) {
  if (status === "pass") return "PASS";
  if (status === "warn") return "WARN";
  return "BLOCK";
}

async function command(commandName, values) {
  try {
    const result = await execFileAsync(commandName, values, {
      cwd: projectRoot,
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 80_000
    });
    return { ok: true, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      ok: false,
      stdout: error.stdout || "",
      stderr: error.stderr || "",
      error: error.message || String(error)
    };
  }
}

async function readEnvFile(filePath) {
  const raw = await fs.readFile(filePath, "utf8").catch(() => "");
  const values = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    values[key] = value;
  }
  return {
    exists: Boolean(raw),
    values
  };
}

function envValue(envFile, key) {
  return process.env[key] || envFile.values[key] || "";
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function parseArgs(values) {
  const parsed = {};
  for (const raw of values) {
    if (raw === "--json") parsed.json = true;
  }
  return parsed;
}

function truthy(value) {
  return ["1", "true", "on", "yes"].includes(String(value || "").toLowerCase());
}

function compact(value, max = 180) {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 3)}...`;
}

function formatMs(value) {
  if (!Number.isFinite(value)) return "unknown";
  if (value < 1000) return `${Math.max(0, Math.round(value))}ms`;
  if (value < 60_000) return `${Math.round(value / 1000)}s`;
  if (value < 60 * 60_000) return `${Math.round(value / 60_000)}m`;
  return `${Math.round(value / (60 * 60_000))}h`;
}

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const args = parseArgs(process.argv.slice(2));
const command = String(args._[0] || args.action || "status");
const projectRoot = process.cwd();
const daemonId = stringArg(args["daemon-id"]) || "taste-agent-managed-worker";
const label = stringArg(args.label) || `com.taste-agent.${safeFileSegment(daemonId)}`;
const launchAgentsDir = path.join(os.homedir(), "Library", "LaunchAgents");
const plistPath = stringArg(args["plist-path"]) || path.join(launchAgentsDir, `${label}.plist`);
const launchdRoot = path.join(projectRoot, ".taste-data", "worker-daemon", "launchd");
const nodePath = process.execPath;
const intervalMs = numberArg(args["interval-ms"], 5_000);
const limit = numberArg(args.limit, 10);
const scanLimit = numberArg(args["scan-limit"], 200);
const concurrency = numberArg(args.concurrency, 2);
const leaseMs = numberArg(args["lease-ms"], 10 * 60 * 1000);
const expiredMode = args["expired-mode"] === "fail" ? "fail" : "requeue";
const restartBackoffMs = numberArg(args["restart-backoff-ms"], 1_500);
const maxRestarts = numberArg(args["max-restarts"], 50);

if (args.help === true || args.h === true) {
  printHelp();
  process.exit(0);
}

await fs.mkdir(launchdRoot, { recursive: true });

if (command === "print") {
  console.log(renderPlist());
  process.exit(0);
}

if (command === "status") {
  console.log(JSON.stringify(await status(), null, 2));
  process.exit(0);
}

if (command === "install") {
  await installPlist();
  const shouldLoad = args.load === true;
  if (shouldLoad) {
    await loadPlist();
  }
  console.log(JSON.stringify(await status({ action: shouldLoad ? "installed_loaded" : "installed" }), null, 2));
  process.exit(0);
}

if (command === "load") {
  await loadPlist();
  console.log(JSON.stringify(await status({ action: "loaded" }), null, 2));
  process.exit(0);
}

if (command === "unload") {
  await unloadPlist();
  console.log(JSON.stringify(await status({ action: "unloaded" }), null, 2));
  process.exit(0);
}

if (command === "uninstall") {
  await unloadPlist().catch(() => undefined);
  await fs.rm(plistPath, { force: true });
  console.log(JSON.stringify(await status({ action: "uninstalled" }), null, 2));
  process.exit(0);
}

console.error(`Unsupported command: ${command}`);
printHelp();
process.exit(1);

async function installPlist() {
  await fs.mkdir(path.dirname(plistPath), { recursive: true });
  await fs.writeFile(plistPath, renderPlist(), "utf8");
}

async function loadPlist() {
  await ensurePlistExists();
  await launchctl(["bootstrap", guiDomain(), plistPath]).catch(async (error) => {
    const message = stderrMessage(error);
    if (/service already loaded|already exists|Bootstrap failed: 5/i.test(message)) {
      await launchctl(["kickstart", "-k", `${guiDomain()}/${label}`]);
      return;
    }
    throw error;
  });
}

async function unloadPlist() {
  await launchctl(["bootout", guiDomain(), plistPath]).catch(async (error) => {
    const message = stderrMessage(error);
    if (/No such process|service is not loaded|Boot-out failed: 3/i.test(message)) return;
    await launchctl(["bootout", `${guiDomain()}/${label}`]).catch((inner) => {
      const innerMessage = stderrMessage(inner);
      if (/No such process|service is not loaded|Boot-out failed: 3/i.test(innerMessage)) return;
      throw inner;
    });
  });
}

async function ensurePlistExists() {
  try {
    await fs.access(plistPath);
  } catch {
    await installPlist();
  }
}

async function status(extra = {}) {
  const installed = await fileExists(plistPath);
  const print = await launchctl(["print", `${guiDomain()}/${label}`], { allowFailure: true });
  const loaded = print.ok;
  const details = parseLaunchctlPrint(print.stdout || "");
  return {
    label,
    daemonId,
    projectRoot,
    plistPath,
    installed,
    loaded,
    guiDomain: guiDomain(),
    nodePath,
    stdoutPath: path.join(launchdRoot, `${safeFileSegment(daemonId)}.stdout.log`),
    stderrPath: path.join(launchdRoot, `${safeFileSegment(daemonId)}.stderr.log`),
    ...details,
    ...extra
  };
}

function renderPlist() {
  const programArguments = [
    nodePath,
    path.join(projectRoot, "scripts", "local-worker-supervisor.mjs"),
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
    expiredMode,
    "--restart-backoff-ms",
    String(clamp(restartBackoffMs, 200, 30_000)),
    "--max-restarts",
    String(clamp(maxRestarts, 0, 1_000))
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${programArguments.map((item) => `    <string>${escapeXml(item)}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(projectRoot)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(path.join(launchdRoot, `${safeFileSegment(daemonId)}.stdout.log`))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(path.join(launchdRoot, `${safeFileSegment(daemonId)}.stderr.log`))}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key>
    <string>production</string>
  </dict>
</dict>
</plist>
`;
}

async function launchctl(values, options = {}) {
  try {
    const result = await execFileAsync("launchctl", values, {
      encoding: "utf8",
      timeout: 10_000
    });
    return { ok: true, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    if (options.allowFailure) {
      return {
        ok: false,
        stdout: error.stdout || "",
        stderr: error.stderr || error.message || String(error)
      };
    }
    throw error;
  }
}

function parseLaunchctlPrint(raw) {
  const pidMatch = raw.match(/\bpid = (\d+)/);
  const stateMatch = raw.match(/\bstate = ([^\n]+)/);
  const lastExitMatch = raw.match(/\blast exit code = ([^\n]+)/);
  return {
    pid: pidMatch ? Number(pidMatch[1]) : undefined,
    state: stateMatch?.[1]?.trim(),
    lastExitCode: lastExitMatch?.[1]?.trim()
  };
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function guiDomain() {
  return `gui/${process.getuid()}`;
}

function stderrMessage(error) {
  return String(error?.stderr || error?.message || error || "");
}

function parseArgs(values) {
  const parsed = { _: [] };
  for (let index = 0; index < values.length; index += 1) {
    const raw = values[index];
    if (!raw.startsWith("--")) {
      parsed._.push(raw);
      continue;
    }
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
  node scripts/manage-worker-launchd.mjs status
  node scripts/manage-worker-launchd.mjs print
  node scripts/manage-worker-launchd.mjs install [--load]
  node scripts/manage-worker-launchd.mjs load
  node scripts/manage-worker-launchd.mjs unload
  node scripts/manage-worker-launchd.mjs uninstall

Options:
  --daemon-id taste-agent-managed-worker
  --label com.taste-agent.taste-agent-managed-worker
  --plist-path ~/Library/LaunchAgents/<label>.plist
  --interval-ms 5000
  --limit 10
  --scan-limit 200
  --concurrency 2
  --lease-ms 600000
  --expired-mode requeue|fail
  --restart-backoff-ms 1500
  --max-restarts 50
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

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

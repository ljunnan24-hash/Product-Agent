import { promises as fs } from "fs";
import path from "path";
import { refreshGraphExecutor } from "./graph-executor";
import { redactSecrets } from "./tool-security";
import { evaluateAgentRun } from "./agent-run-eval";
import type {
  AnalysisRecord,
  AnalysisRunLog,
  AnalysisRunCheckpoint,
  AnalysisRunStageId,
  BlindTestJudgment,
  BacktestSuggestion,
  DynamicBacktestRecord,
  AgentRuntimeTrace,
  RunRetryInput,
  StoredRunEvent
} from "./types";

const dataDir = path.join(process.cwd(), ".taste-data", "analyses");
const runDir = path.join(process.cwd(), ".taste-data", "runs");
const backtestDir = path.join(process.cwd(), ".taste-data", "backtests");
const backtestSuggestionDir = path.join(process.cwd(), ".taste-data", "backtest-suggestions");
const blindTestDir = path.join(process.cwd(), ".taste-data", "blind-tests");
const artifactDir = path.join(process.cwd(), ".taste-data", "artifacts");
const toolCacheDir = path.join(process.cwd(), ".taste-data", "tool-cache");

const analysisRunStages: Array<{ id: AnalysisRunStageId; title: string }> = [
  { id: "intake", title: "接收材料" },
  { id: "material_reader", title: "读取材料" },
  { id: "web_research", title: "查证据" },
  { id: "evidence_agent", title: "建立证据账本" },
  { id: "report_composer", title: "生成报告" },
  { id: "quality_gate", title: "审计和保存" }
];

export async function ensureDataDir() {
  await fs.mkdir(dataDir, { recursive: true });
}

export async function ensureRunDir() {
  await fs.mkdir(runDir, { recursive: true });
}

export async function ensureBacktestDir() {
  await fs.mkdir(backtestDir, { recursive: true });
}

export async function ensureBacktestSuggestionDir() {
  await fs.mkdir(backtestSuggestionDir, { recursive: true });
}

export async function ensureBlindTestDir() {
  await fs.mkdir(blindTestDir, { recursive: true });
}

export async function ensureArtifactDir(traceId?: string) {
  const targetDir = traceId ? path.join(artifactDir, safeFileSegment(traceId)) : artifactDir;
  await fs.mkdir(targetDir, { recursive: true });
  return targetDir;
}

export async function ensureToolCacheDir() {
  await fs.mkdir(toolCacheDir, { recursive: true });
  return toolCacheDir;
}

export async function writeAgentArtifact({
  traceId,
  artifactId,
  payload
}: {
  traceId: string;
  artifactId: string;
  payload: unknown;
}) {
  const targetDir = await ensureArtifactDir(traceId);
  const fileName = `${safeFileSegment(artifactId)}.json`;
  const filePath = path.join(targetDir, fileName);
  const content = JSON.stringify(redactSecrets(payload), null, 2);
  await fs.writeFile(filePath, content, "utf8");
  return {
    storageRef: path.join(".taste-data", "artifacts", safeFileSegment(traceId), fileName),
    byteSize: Buffer.byteLength(content, "utf8")
  };
}

export async function readAgentArtifact<T = unknown>(storageRef: string): Promise<T | null> {
  const rootDir = path.resolve(artifactDir);
  const targetPath = path.resolve(process.cwd(), storageRef);
  if (
    !storageRef.startsWith(path.join(".taste-data", "artifacts")) ||
    !(targetPath === rootDir || targetPath.startsWith(`${rootDir}${path.sep}`))
  ) {
    return null;
  }
  try {
    const raw = await fs.readFile(targetPath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function readToolCache<T = unknown>(cacheKey: string): Promise<T | null> {
  try {
    await ensureToolCacheDir();
    const raw = await fs.readFile(toolCachePath(cacheKey), "utf8");
    const entry = JSON.parse(raw) as { payload?: T };
    return entry.payload ?? null;
  } catch {
    return null;
  }
}

export async function writeToolCache(cacheKey: string, payload: unknown) {
  await ensureToolCacheDir();
  const filePath = toolCachePath(cacheKey);
  const content = JSON.stringify(
    {
      cacheKey,
      createdAt: new Date().toISOString(),
      payload
    },
    null,
    2
  );
  await fs.writeFile(filePath, content, "utf8");
  return {
    cacheRef: toolCacheRef(cacheKey),
    byteSize: Buffer.byteLength(content, "utf8")
  };
}

export function toolCacheRef(cacheKey: string) {
  return path.join(".taste-data", "tool-cache", `${safeFileSegment(cacheKey)}.json`);
}

export async function saveAnalysis(record: AnalysisRecord) {
  await ensureDataDir();
  await fs.writeFile(
    path.join(dataDir, `${record.id}.json`),
    JSON.stringify(record, null, 2),
    "utf8"
  );
}

export async function getAnalysis(id: string): Promise<AnalysisRecord | null> {
  try {
    const raw = await fs.readFile(path.join(dataDir, `${id}.json`), "utf8");
    return normalizeAnalysisRecord(JSON.parse(raw) as AnalysisRecord);
  } catch {
    return null;
  }
}

export async function createRunLog(id: string) {
  const now = new Date().toISOString();
  const run: AnalysisRunLog = {
    id,
    createdAt: now,
    updatedAt: now,
    status: "running",
    checkpoints: initialRunCheckpoints(now),
    summary: summarizeRun({
      id,
      createdAt: now,
      updatedAt: now,
      status: "running",
      checkpoints: initialRunCheckpoints(now),
      events: []
    }),
    events: []
  };
  await saveRunLog(run);
  return run;
}

export async function appendRunEvent(id: string, event: StoredRunEvent) {
  const run = (await getRunLog(id)) ?? (await createRunLog(id));
  await saveRunLog(normalizeRunLog({
    ...run,
    updatedAt: event.at,
    events: [...run.events, event].slice(-120)
  }));
}

export async function updateRunRetryInput(
  id: string,
  retryInput: RunRetryInput,
  sourceSummary: string
) {
  const run = (await getRunLog(id)) ?? (await createRunLog(id));
  await saveRunLog(normalizeRunLog({
    ...run,
    updatedAt: new Date().toISOString(),
    sourceSummary,
    retryInput
  }));
}

export async function completeRunLog(id: string, analysisId: string, event: StoredRunEvent) {
  const run = (await getRunLog(id)) ?? (await createRunLog(id));
  await saveRunLog(normalizeRunLog({
    ...run,
    updatedAt: event.at,
    status: "completed",
    analysisId,
    events: [...run.events, event].slice(-120)
  }));
}

export async function failRunLog(id: string, message: string, event: StoredRunEvent) {
  const run = (await getRunLog(id)) ?? (await createRunLog(id));
  await saveRunLog(normalizeRunLog({
    ...run,
    updatedAt: event.at,
    status: "failed",
    errorMessage: message,
    events: [...run.events, event].slice(-120)
  }));
}

export async function getRunLog(id: string): Promise<AnalysisRunLog | null> {
  try {
    const raw = await fs.readFile(path.join(runDir, `${id}.json`), "utf8");
    return normalizeRunLog(JSON.parse(raw) as AnalysisRunLog);
  } catch {
    return null;
  }
}

export async function saveBacktestRecord(record: DynamicBacktestRecord) {
  await ensureBacktestDir();
  await fs.writeFile(
    path.join(backtestDir, `${record.id}.json`),
    JSON.stringify(record, null, 2),
    "utf8"
  );
}

export async function getBacktestRecord(
  id: string
): Promise<DynamicBacktestRecord | null> {
  try {
    const raw = await fs.readFile(path.join(backtestDir, `${id}.json`), "utf8");
    return normalizeBacktestRecord(JSON.parse(raw) as DynamicBacktestRecord);
  } catch {
    return null;
  }
}

export async function listBacktestRecords(limit = 40): Promise<DynamicBacktestRecord[]> {
  try {
    await ensureBacktestDir();
    const fileNames = await fs.readdir(backtestDir);
    const records = await Promise.all(
      fileNames
        .filter((fileName) => fileName.endsWith(".json"))
        .map(async (fileName) => {
          try {
            const raw = await fs.readFile(path.join(backtestDir, fileName), "utf8");
            return normalizeBacktestRecord(JSON.parse(raw) as DynamicBacktestRecord);
          } catch {
            return null;
          }
        })
    );

    return records
      .filter((record): record is DynamicBacktestRecord => Boolean(record))
      .sort(
        (a, b) =>
          new Date(b.updatedAt || b.createdAt).getTime() -
          new Date(a.updatedAt || a.createdAt).getTime()
      )
      .slice(0, limit);
  } catch {
    return [];
  }
}

export async function saveBacktestSuggestion(record: BacktestSuggestion) {
  await ensureBacktestSuggestionDir();
  await fs.writeFile(
    path.join(backtestSuggestionDir, `${record.id}.json`),
    JSON.stringify(record, null, 2),
    "utf8"
  );
}

export async function getBacktestSuggestion(id: string): Promise<BacktestSuggestion | null> {
  try {
    const raw = await fs.readFile(path.join(backtestSuggestionDir, `${id}.json`), "utf8");
    return JSON.parse(raw) as BacktestSuggestion;
  } catch {
    return null;
  }
}

export async function updateBacktestSuggestion(
  id: string,
  patch: Partial<BacktestSuggestion>
): Promise<BacktestSuggestion | null> {
  const current = await getBacktestSuggestion(id);
  if (!current) return null;
  const next: BacktestSuggestion = {
    ...current,
    ...patch,
    id: current.id,
    updatedAt: new Date().toISOString()
  };
  await saveBacktestSuggestion(next);
  return next;
}

export async function listBacktestSuggestions(limit = 40): Promise<BacktestSuggestion[]> {
  try {
    await ensureBacktestSuggestionDir();
    const fileNames = await fs.readdir(backtestSuggestionDir);
    const records = await Promise.all(
      fileNames
        .filter((fileName) => fileName.endsWith(".json"))
        .map(async (fileName) => {
          try {
            const raw = await fs.readFile(path.join(backtestSuggestionDir, fileName), "utf8");
            return JSON.parse(raw) as BacktestSuggestion;
          } catch {
            return null;
          }
        })
    );

    return records
      .filter((record): record is BacktestSuggestion => Boolean(record))
      .sort(
        (a, b) =>
          new Date(b.updatedAt || b.createdAt).getTime() -
          new Date(a.updatedAt || a.createdAt).getTime()
      )
      .slice(0, limit);
  } catch {
    return [];
  }
}

export async function saveBlindTestJudgment(
  judgment: BlindTestJudgment
): Promise<BlindTestJudgment> {
  await ensureBlindTestDir();
  await fs.writeFile(
    path.join(blindTestDir, `${judgment.id}.json`),
    JSON.stringify(judgment, null, 2),
    "utf8"
  );
  return judgment;
}

export async function upsertBlindTestJudgment(
  input: Omit<BlindTestJudgment, "id" | "createdAt" | "updatedAt">
): Promise<BlindTestJudgment> {
  const existing = (await listBlindTestJudgments(500)).find(
    (item) => item.caseId === input.caseId && item.participant === input.participant
  );
  const now = new Date().toISOString();
  const judgment: BlindTestJudgment = {
    ...input,
    id: existing?.id || crypto.randomUUID(),
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };
  return saveBlindTestJudgment(judgment);
}

export async function listBlindTestJudgments(limit = 200): Promise<BlindTestJudgment[]> {
  try {
    await ensureBlindTestDir();
    const fileNames = await fs.readdir(blindTestDir);
    const records = await Promise.all(
      fileNames
        .filter((fileName) => fileName.endsWith(".json"))
        .map(async (fileName) => {
          try {
            const raw = await fs.readFile(path.join(blindTestDir, fileName), "utf8");
            return JSON.parse(raw) as BlindTestJudgment;
          } catch {
            return null;
          }
        })
    );

    return records
      .filter((record): record is BlindTestJudgment => Boolean(record))
      .sort(
        (a, b) =>
          new Date(b.updatedAt || b.createdAt).getTime() -
          new Date(a.updatedAt || a.createdAt).getTime()
      )
      .slice(0, limit);
  } catch {
    return [];
  }
}

async function saveRunLog(run: AnalysisRunLog) {
  await ensureRunDir();
  await fs.writeFile(
    path.join(runDir, `${run.id}.json`),
    JSON.stringify(normalizeRunLog(run), null, 2),
    "utf8"
  );
}

function initialRunCheckpoints(now: string): AnalysisRunCheckpoint[] {
  return analysisRunStages.map((stage) => ({
    stage: stage.id,
    title: stage.title,
    status: "waiting",
    updatedAt: now,
    summary: "等待执行。",
    eventCount: 0
  }));
}

function normalizeRunLog(run: AnalysisRunLog): AnalysisRunLog {
  const checkpoints = buildRunCheckpoints(run);
  return {
    ...run,
    checkpoints,
    summary: summarizeRun({
      ...run,
      checkpoints
    })
  };
}

function buildRunCheckpoints(run: AnalysisRunLog): AnalysisRunCheckpoint[] {
  const checkpoints = new Map<AnalysisRunStageId, AnalysisRunCheckpoint>();
  const now = run.createdAt || new Date().toISOString();
  const baseCheckpoints = run.events.length
    ? initialRunCheckpoints(now)
    : run.checkpoints?.length
      ? run.checkpoints
      : initialRunCheckpoints(now);
  for (const checkpoint of baseCheckpoints) {
    checkpoints.set(checkpoint.stage, {
      ...checkpoint,
      eventCount: checkpoint.eventCount ?? 0
    });
  }

  for (const event of run.events) {
    if (!event.stage || !isAnalysisRunStage(event.stage)) continue;
    const current =
      checkpoints.get(event.stage) ??
      ({
        stage: event.stage,
        title: stageTitle(event.stage),
        status: "waiting",
        updatedAt: event.at,
        summary: "等待执行。",
        eventCount: 0
      } satisfies AnalysisRunCheckpoint);
    const nextStatus = normalizeCheckpointStatus(event.status);
    checkpoints.set(event.stage, {
      ...current,
      title: event.title || current.title || stageTitle(event.stage),
      status: nextStatus,
      startedAt:
        current.startedAt ||
        (nextStatus === "running" || nextStatus === "completed" || nextStatus === "failed"
          ? event.at
          : undefined),
      completedAt:
        nextStatus === "completed" || nextStatus === "failed"
          ? event.at
          : current.completedAt,
      updatedAt: event.at,
      summary: event.summary || current.summary,
      detail: event.detail || current.detail,
      eventCount: current.eventCount + 1
    });
  }

  if (run.status === "completed") {
    const completedAt = run.updatedAt;
    for (const stage of analysisRunStages) {
      const current = checkpoints.get(stage.id);
      if (!current || current.status === "completed") continue;
      checkpoints.set(stage.id, {
        ...current,
        status: "completed",
        startedAt: current.startedAt || completedAt,
        completedAt: current.completedAt || completedAt,
        updatedAt: completedAt,
        summary: current.summary === "等待执行。" ? "已完成。" : current.summary
      });
    }
  }

  if (run.status === "failed") {
    const failedStage =
      lastCheckpointStageWithStatus([...checkpoints.values()], "running") ??
      lastCheckpointStageWithStatus([...checkpoints.values()], "completed") ??
      "quality_gate";
    const current = checkpoints.get(failedStage);
    if (current) {
      checkpoints.set(failedStage, {
        ...current,
        status: "failed",
        completedAt: run.updatedAt,
        updatedAt: run.updatedAt,
        summary: run.errorMessage || current.summary
      });
    }
  }

  const initialByStage = new Map(initialRunCheckpoints(now).map((checkpoint) => [checkpoint.stage, checkpoint]));
  return analysisRunStages.map((stage) => checkpoints.get(stage.id) ?? initialByStage.get(stage.id)!);
}

function summarizeRun(run: AnalysisRunLog) {
  const checkpoints = run.checkpoints ?? [];
  const completedStages = checkpoints
    .filter((checkpoint) => checkpoint.status === "completed")
    .map((checkpoint) => checkpoint.stage);
  const currentStage = [...checkpoints]
    .reverse()
    .find((checkpoint) => checkpoint.status === "running")?.stage;
  const failedStage = checkpoints.find((checkpoint) => checkpoint.status === "failed")?.stage;
  const lastEvent = run.events.at(-1);
  const durationMs = Math.max(
    0,
    new Date(run.updatedAt || run.createdAt).getTime() - new Date(run.createdAt).getTime()
  );
  const msSinceUpdate = Math.max(
    0,
    Date.now() - new Date(run.updatedAt || run.createdAt).getTime()
  );
  const isStale = run.status === "running" && msSinceUpdate > 10 * 60 * 1000;
  const totalStages = analysisRunStages.length;
  const progressPercent =
    run.status === "completed"
      ? 100
      : Math.min(
          99,
          Math.round((completedStages.length / totalStages) * 100)
        );
  const isRecoverable =
    run.status === "failed" &&
    Boolean(run.retryInput?.canAutoPrefill && run.retryInput.githubRepoUrl);

  return {
    currentStage,
    failedStage,
    completedStages,
    totalStages,
    progressPercent,
    durationMs,
    isStale,
    isRecoverable,
    recoverabilityReason:
      run.status === "failed"
        ? isRecoverable
          ? "可用 GitHub URL 自动重跑。"
          : run.retryInput?.limitation || "需要用户重新提供本地材料。"
        : run.status === "completed"
          ? "已完成。"
          : isStale
            ? "超过 10 分钟没有新事件，任务可能已经中断；可刷新确认，必要时重跑。"
            : "运行中，可刷新恢复进度。",
    lastEventTitle: lastEvent?.title,
    lastEventSummary: lastEvent?.summary || lastEvent?.message
  };
}

function normalizeCheckpointStatus(status: StoredRunEvent["status"]): AnalysisRunCheckpoint["status"] {
  if (status === "running" || status === "completed" || status === "failed") {
    return status;
  }
  return "waiting";
}

function isAnalysisRunStage(stage: string): stage is AnalysisRunStageId {
  return analysisRunStages.some((item) => item.id === stage);
}

function stageTitle(stage: AnalysisRunStageId) {
  return analysisRunStages.find((item) => item.id === stage)?.title || stage;
}

function lastCheckpointStageWithStatus(
  checkpoints: AnalysisRunCheckpoint[],
  status: AnalysisRunCheckpoint["status"]
) {
  return [...checkpoints].reverse().find((checkpoint) => checkpoint.status === status)?.stage;
}

function safeFileSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 120) || "artifact";
}

function toolCachePath(cacheKey: string) {
  return path.join(toolCacheDir, `${safeFileSegment(cacheKey)}.json`);
}

export async function listAnalyses(limit = 80): Promise<AnalysisRecord[]> {
  try {
    await ensureDataDir();
    const fileNames = await fs.readdir(dataDir);
    const records = await Promise.all(
      fileNames
        .filter((fileName) => fileName.endsWith(".json"))
        .map(async (fileName) => {
          try {
            const raw = await fs.readFile(path.join(dataDir, fileName), "utf8");
            return normalizeAnalysisRecord(JSON.parse(raw) as AnalysisRecord);
          } catch {
            return null;
          }
        })
    );

    return records
      .filter((record): record is AnalysisRecord => Boolean(record))
      .sort(
        (a, b) =>
          new Date(b.updatedAt || b.createdAt).getTime() -
          new Date(a.updatedAt || a.createdAt).getTime()
      )
      .slice(0, limit);
  } catch {
    return [];
  }
}

function normalizeAnalysisRecord(record: AnalysisRecord): AnalysisRecord {
  const webResearch = record.webResearch;
  const trace = webResearch?.runtimeTrace;
  if (!webResearch || !trace) return record;
  return {
    ...record,
    webResearch: {
      ...webResearch,
      runtimeTrace: normalizeRuntimeTrace(trace)
    }
  };
}

function normalizeBacktestRecord(record: DynamicBacktestRecord): DynamicBacktestRecord {
  const runtimeTraces = record.posterior.runtimeTraces;
  if (!runtimeTraces?.length) return record;
  return {
    ...record,
    posterior: {
      ...record.posterior,
      runtimeTraces: runtimeTraces.map((item) => ({
        ...item,
        trace: normalizeRuntimeTrace(item.trace)
      }))
    }
  };
}

function normalizeRuntimeTrace(trace: AgentRuntimeTrace): AgentRuntimeTrace {
  const runtimeTrace: AgentRuntimeTrace = {
    ...trace,
    taskGraph: trace.taskGraph
      ? refreshGraphExecutor({
          graph: trace.taskGraph,
          now: trace.taskGraph.updatedAt
        })
      : undefined
  };
  return {
    ...runtimeTrace,
    runEval: evaluateAgentRun(runtimeTrace)
  };
}

export async function saveUpload(file: File, id: string, index?: number) {
  const uploadDir = path.join(process.cwd(), "public", "uploads");
  await fs.mkdir(uploadDir, { recursive: true });

  const extension = getExtension(file);
  const suffix = typeof index === "number" ? `-${index}` : "";
  const fileName = `${id}${suffix}.${extension}`;
  const storagePath = path.join(uploadDir, fileName);
  const arrayBuffer = await file.arrayBuffer();
  await fs.writeFile(storagePath, Buffer.from(arrayBuffer));

  return `/uploads/${fileName}`;
}

export function publicUrlToFilePath(url: string) {
  const normalized = url.replace(/^\/+/, "");
  return path.join(process.cwd(), "public", normalized);
}

function getExtension(file: File) {
  const lowerName = file.name.toLowerCase();
  if (lowerName === "readme") return "md";

  const fromName = lowerName.split(".").pop();
  if (
    fromName &&
    ["png", "jpg", "jpeg", "webp", "pdf", "md", "mdx", "txt", "csv", "tsv", "json"].includes(
      fromName
    )
  ) {
    return fromName === "jpeg" ? "jpg" : fromName;
  }

  if (file.type === "image/png") return "png";
  if (file.type === "image/webp") return "webp";
  if (file.type === "application/pdf") return "pdf";
  if (file.type === "application/json") return "json";
  if (file.type === "text/csv") return "csv";
  if (file.type === "text/tab-separated-values") return "tsv";
  if (file.type === "text/markdown") return "md";
  if (file.type === "text/plain") return "txt";

  return "jpg";
}

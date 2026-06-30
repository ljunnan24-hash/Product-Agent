import { execFile, spawn } from "child_process";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "fs/promises";
import path from "path";
import { promisify } from "util";
import { AgentRuntimeHarness } from "./agent-runtime";
import {
  createDurableWorkerQueueRecord,
  failDurableWorkerQueueRecord,
  finishDurableWorkerQueueCancellation,
  finishDurableWorkerQueueRecord,
  getDurableWorkerQueueRecord,
  markDurableWorkerQueueRunning
} from "./durable-worker-queue";
import { SubagentRunner, type SubagentRunOutput } from "./subagent-runner";
import { getRegisteredWorkerDefinition } from "./subagent-registry";
import { toolPolicies } from "./tool-policy";
import type {
  AgentRuntimeTrace,
  AgentToolGuardrailResult,
  AgentWorkerDefinition
} from "./types";

const execFileAsync = promisify(execFile);
const sandboxRoot = path.join(process.cwd(), ".taste-data", "code-sandbox");
const defaultTimeoutMs = 15_000;
const defaultMaxOutputChars = 12_000;
const maxCodeChars = 24_000;
const maxInputFiles = 6;
const maxInputFileChars = 80_000;
const maxOutputFileBytes = 1_000_000;
const maxOutputTotalBytes = 2_000_000;
const maxOutputFiles = 8;
const memoryLimitBytes = 512 * 1024 * 1024;
const maxOpenFiles = 64;
const defaultDockerImage = process.env.CODE_EXECUTOR_DOCKER_IMAGE || "python:3.12-slim";

type CodeExecutionSandboxRequest = "auto" | "process" | "docker";
type CodeExecutionSandboxBackend = "process" | "docker";

type CodeExecutionSandboxPlan = {
  requested: CodeExecutionSandboxRequest;
  backend?: CodeExecutionSandboxBackend;
  isolationLevel: "process-restricted" | "container-no-network" | "unavailable";
  strict: boolean;
  strongIsolationRequired: boolean;
  policy: "development" | "production";
  dockerImage?: string;
  dockerAvailable: boolean;
  message: string;
};

export type CodeExecutionInputFile = {
  name: string;
  content: string;
  mediaType?: string;
};

export type CodeExecutionInput = {
  runtimeTrace?: AgentRuntimeTrace;
  rootGoal: string;
  traceId?: string;
  taskNodeId?: string;
  taskLabel?: string;
  inputSummary?: string;
  code: string;
  inputFiles?: CodeExecutionInputFile[];
  timeoutMs?: number;
  maxOutputChars?: number;
  durableQueue?: boolean;
};

export type CodeExecutionOutputFile = {
  name: string;
  path: string;
  size: number;
  mimeType?: string;
  preview?: string;
  validation?: {
    status: "pass" | "warn";
    message: string;
  };
};

type CodeExecutionOutputAudit = {
  totalFiles: number;
  totalBytes: number;
  collectedFiles: number;
  collectedBytes: number;
  skipped: string[];
  mimeWarnings: string[];
};

type CodeExecutionResourceLimits = {
  cpuSeconds: number;
  memoryBytes: number;
  outputFileBytes: number;
  outputTotalBytes: number;
  openFiles: number;
};

type CodeExecutionCleanupAudit = {
  backend: CodeExecutionSandboxBackend;
  command: "python3" | "docker";
  startedAt: string;
  completedAt: string;
  durationMs: number;
  timeoutMs: number;
  timedOut: boolean;
  cancelled: boolean;
  cancellationReason?: string;
  processKilled: boolean;
  exitCode?: number | null;
  signal?: string | null;
  containerName?: string;
  containerRemoved?: boolean;
  cleanupErrors: string[];
};

export type CodeExecutionResult = {
  status: "completed" | "failed" | "blocked" | "cancelled";
  stdout: string;
  stderr: string;
  outputFiles: CodeExecutionOutputFile[];
  summary: string;
  runtimeTrace?: AgentRuntimeTrace;
  artifactId?: string;
  handoffId?: string;
};

export async function runCodeExecutionWithRuntime(
  input: CodeExecutionInput
): Promise<CodeExecutionResult> {
  const runtime = input.runtimeTrace
    ? AgentRuntimeHarness.fromTrace(input.runtimeTrace)
    : new AgentRuntimeHarness(input.rootGoal, input.traceId);
  const taskNodeId = input.taskNodeId ?? `code:${Date.now()}`;
  const rawInputFiles = input.inputFiles ?? [];
  const inputFiles = rawInputFiles.slice(0, maxInputFiles).map(normalizeInputFile);
  runtime.upsertTaskNode({
    id: taskNodeId,
    kind: "code_execute",
    label: input.taskLabel ?? "代码执行",
    inputSummary:
      input.inputSummary ??
      `执行受限 Python，输入 ${inputFiles.length} 个文件，代码 ${input.code.length} 字符。`,
    resumeHint: "代码执行失败时，缩小输入文件或改写受限 Python 后从该节点恢复。",
    metrics: {
      inputFiles: inputFiles.length,
      codeChars: input.code.length
    }
  });

  const definition = getRegisteredWorkerDefinition("code-executor");
  const durableQueue = input.durableQueue === false
    ? null
    : await createCodeExecutionDurableRecord({
        runtime,
        definition,
        taskNodeId,
        input,
        inputFiles
      });
  const runner = new SubagentRunner(runtime);
  let runResult: SubagentRunOutput<CodeExecutionResult>;
  try {
    runResult = await runner.run<CodeExecutionResult>({
      definition,
      taskNodeId,
      inputSummary:
        input.inputSummary ??
        `受限 Python 执行：${inputFiles.map((file) => file.name).join(", ") || "无输入文件"}`,
      boundary: {
        payload: {
          codePreview: compactText(input.code, 1600),
          durableQueueId: durableQueue?.record.id,
          inputFiles: inputFiles.map((file) => ({
            name: file.name,
            mediaType: file.mediaType,
            chars: file.content.length,
            preview: compactText(file.content, 600)
          }))
        },
        acceptedInputSummary:
          input.inputSummary ??
          `执行受限 Python，输入 ${inputFiles.length} 个文件；原始数据只写入沙箱 input/。`,
        inputCharCount:
          input.code.length + inputFiles.reduce((sum, file) => sum + file.content.length, 0),
        modelProvider: "local",
        forbiddenInputs: [
          "不得联网。",
          "不得执行 shell/subprocess。",
          "不得读取环境变量、绝对路径、父目录路径或沙箱外文件。"
        ],
        isolationNotes: [
          "输入文件写入 .taste-data/code-sandbox/<trace>/<run>/input。",
          "输出只允许从 output/ 收集并压缩进 artifact。",
          durableQueue ? `durableQueueId=${durableQueue.record.id}` : "durable queue disabled"
        ]
      },
      execute: async (context) => {
      context.recordEvent({
        type: "tool_call",
        summary: "开始代码安全检查。"
      });
      const sandboxPlan = await resolveCodeSandboxPlan();
      const guardrails = guardCodeExecutionInput({
        code: input.code,
        rawInputFiles,
        inputFiles,
        timeoutMs: input.timeoutMs ?? defaultTimeoutMs
      }).concat(sandboxPlanGuardrail(sandboxPlan));
      const toolCallId = runtime.startToolCall({
        policy: toolPolicies.code_execute,
        inputSummary: `受限 Python：${inputFiles.length} 个输入文件，${input.code.length} 字符代码；sandbox=${sandboxPlan.backend ?? "unavailable"}。`,
        provider: "local",
        workerRunId: context.workerRunId,
        taskNodeId,
        guardrails
      });
      if (guardrails.some((guardrail) => guardrail.status === "block")) {
        const summary = guardrails
          .filter((guardrail) => guardrail.status === "block")
          .map((guardrail) => guardrail.message)
          .join("；");
        runtime.blockToolCall(toolCallId, summary, { guardrails });
        context.recordEvent({
          type: "tool_call",
          summary: `代码执行被安全检查阻断：${summary}`
        });
        return {
          status: "failed",
          value: {
            status: "blocked",
            stdout: "",
            stderr: summary,
            outputFiles: [],
            summary,
            runtimeTrace: runtime.getTrace()
          },
          outputSummary: summary,
          budgetUsed: {
            toolCalls: 1,
            outputChars: summary.length
          },
          failureCode: "input_guardrail_blocked",
          errorMessage: summary
        };
      }

      context.recordEvent({
        type: "tool_call",
        summary: `安全检查通过，准备 ${sandboxPlan.backend} 沙箱目录和输入文件。`
      });
      const execution = await executeRestrictedPython({
        traceId: runtime.getTrace().id,
        code: input.code,
        inputFiles,
        timeoutMs: input.timeoutMs ?? defaultTimeoutMs,
        maxOutputChars: input.maxOutputChars ?? defaultMaxOutputChars,
        sandboxPlan,
        durableQueueId: durableQueue?.record.id
      });
      const finalGuardrails = [
        ...guardrails,
        guard(
          "code-resource-limits",
          "Resource limits",
          "pass",
          `CPU ${execution.resourceLimits.cpuSeconds}s, memory ${Math.round(execution.resourceLimits.memoryBytes / 1024 / 1024)}MB, file ${Math.round(execution.resourceLimits.outputFileBytes / 1024)}KB, open files ${execution.resourceLimits.openFiles}.`
        ),
        guard(
          "code-output-budget",
          "Output budget",
          execution.outputAudit.skipped.length ? "warn" : "pass",
          `${execution.outputAudit.collectedFiles}/${execution.outputAudit.totalFiles} files collected, ${Math.round(execution.outputAudit.collectedBytes / 1024)}KB/${Math.round(execution.outputAudit.totalBytes / 1024)}KB; skipped ${execution.outputAudit.skipped.length}.`
        ),
        guard(
          "code-output-mime",
          "Output MIME validation",
          execution.outputAudit.mimeWarnings.length ? "warn" : "pass",
          execution.outputAudit.mimeWarnings.length
            ? execution.outputAudit.mimeWarnings.join("；")
            : "Collected output files passed MIME and SVG safety checks."
        ),
        guard(
          "code-exit-status",
          "Exit status",
          execution.status === "completed" ? "pass" : "warn",
          execution.status === "completed"
            ? "Python completed."
            : execution.status === "cancelled"
              ? execution.cleanupAudit.cancellationReason || "Code execution cancelled."
              : execution.stderr || "Python failed."
        ),
        guard(
          "code-cleanup-audit",
          "Cleanup audit",
          execution.cleanupAudit.cleanupErrors.length ? "warn" : "pass",
          cleanupAuditSummary(execution.cleanupAudit)
        )
      ];
      const artifactPayload = {
        executorVersion: "code-executor-v1.6",
        status: execution.status,
        durableQueueId: durableQueue?.record.id,
        sandbox: execution.sandboxPlan,
        codePreview: compactText(input.code, 3000),
        stdout: execution.stdout,
        stderr: execution.stderr,
        inputFiles: inputFiles.map((file) => ({
          name: file.name,
          mediaType: file.mediaType,
          chars: file.content.length
        })),
        outputFiles: execution.outputFiles,
        outputAudit: execution.outputAudit,
        resourceLimits: execution.resourceLimits,
        cleanupAudit: execution.cleanupAudit,
        sandboxPath: execution.sandboxPath,
        guardrails: finalGuardrails
      };
      const artifact = await runtime.addArtifact({
        kind: "code_execution_result",
        owner: "code_executor",
        title: "代码执行结果",
        summary: execution.summary,
        payload: artifactPayload,
        itemCount: execution.outputFiles.length,
        preview: compactText(
          [execution.stdout, execution.stderr].filter(Boolean).join("\n"),
          1200
        )
      });
      const handoff = runtime.createHandoff({
        from: "code_executor",
        to: "main_agent",
        goal: "交接代码执行结果，只用于验证上传数据中的计算与指标。",
        contextSummary: execution.summary,
        artifactIds: [artifact.id],
        keyFindings: keyFindingsFromExecution(execution),
        uncertainties:
          execution.status === "completed"
            ? ["代码执行结果只覆盖上传文件，不能外推到市场需求。"]
            : execution.status === "cancelled"
              ? ["代码执行已取消，不能使用该结果作为指标证据。"]
            : ["执行失败，不能使用该结果作为指标证据。"],
        forbiddenClaims: [
          "不得把代码执行结果说成外部市场证据。",
          "不得用上传样本直接推出总体市场潜力。"
        ],
        nextActions: ["把执行结果作为实验原件补充进 Evidence Brief，再由 Judge 控制报告强度。"]
      });
      const status =
        execution.status === "completed"
          ? "completed"
          : execution.status === "cancelled"
            ? "skipped"
            : "failed";
      if (status === "completed") {
        runtime.completeToolCall(toolCallId, execution.summary, {
          artifactIds: [artifact.id],
          guardrails: finalGuardrails
        });
      } else if (execution.status === "cancelled") {
        runtime.skipToolCall(toolCallId, execution.summary, {
          artifactIds: [artifact.id],
          guardrails: finalGuardrails,
          errorMessage: execution.cleanupAudit.cancellationReason
        });
        if (durableQueue) {
          runtime.cancelWorkerQueueItem(durableQueue.queueItemId, execution.summary, {
            workerRunId: context.workerRunId,
            artifactIds: [artifact.id],
            errorMessage: execution.cleanupAudit.cancellationReason,
            metrics: {
              cancelled: true,
              codeStatus: execution.status
            }
          });
        }
      } else {
        runtime.failToolCall(toolCallId, execution.summary, {
          artifactIds: [artifact.id],
          guardrails: finalGuardrails
        });
      }
      return {
        status,
        value: {
          status: execution.status,
          stdout: execution.stdout,
          stderr: execution.stderr,
          outputFiles: execution.outputFiles,
          summary: execution.summary,
          runtimeTrace: runtime.getTrace(),
          artifactId: artifact.id,
          handoffId: handoff.id
        },
        outputSummary: execution.summary,
        artifactIds: [artifact.id],
        handoffId: handoff.id,
        budgetUsed: {
          toolCalls: 1,
          artifacts: 1,
          outputChars: execution.stdout.length + execution.stderr.length
        },
        failureCode: status === "failed" ? "tool_failed" : undefined,
        errorMessage: status === "failed" ? execution.stderr || execution.summary : undefined,
        transcript: [
          {
            type: "artifact",
            summary: execution.summary,
            refs: [artifact.id],
            metadata: {
              outputFiles: execution.outputFiles.length,
              sandboxPath: execution.sandboxPath,
              sandboxBackend: execution.sandboxPlan.backend ?? "",
              durableQueueId: durableQueue?.record.id ?? ""
            }
          }
        ]
      };
      }
    });
    if (durableQueue) {
      await finishCodeExecutionDurableRecord({
        runtime,
        durableQueueId: durableQueue.record.id,
        queueItemId: durableQueue.queueItemId,
        runResult
      });
    }
  } catch (error) {
    if (durableQueue) {
      const message = error instanceof Error ? error.message : "code execution durable run failed";
      runtime.failWorkerQueueItem(durableQueue.queueItemId, message, {
        errorMessage: message
      });
      await failDurableWorkerQueueRecord(durableQueue.record.id, message);
    }
    throw error;
  }

  runtime.completeTrace();
  return {
    ...runResult.value,
    runtimeTrace: runtime.getTrace()
  };
}

async function createCodeExecutionDurableRecord({
  runtime,
  definition,
  taskNodeId,
  input,
  inputFiles
}: {
  runtime: AgentRuntimeHarness;
  definition: AgentWorkerDefinition;
  taskNodeId: string;
  input: CodeExecutionInput;
  inputFiles: CodeExecutionInputFile[];
}) {
  const trace = runtime.getTrace();
  const taskNode = trace.taskGraph?.nodes.find((node) => node.id === taskNodeId);
  const taskNodeDefinition = trace.taskGraph?.definitions?.find((definition) => definition.id === taskNodeId);
  const queueItemId = `code-execute-${crypto.randomUUID()}`;
  const inputSummary =
    input.inputSummary ??
    `受限 Python 执行：${inputFiles.map((file) => file.name).join(", ") || "无输入文件"}`;
  const record = await createDurableWorkerQueueRecord({
    traceId: trace.id,
    queueItemId,
    queueLabel: "Code Execute",
    definition,
    taskNodeDefinition,
    taskNodeExecution: taskNode?.execution,
    inputSummary,
    inputPayload: {
      kind: "code_execute",
      rootGoal: input.rootGoal,
      taskNodeId,
      taskLabel: input.taskLabel,
      inputSummary: input.inputSummary,
      code: input.code,
      inputFiles,
      timeoutMs: input.timeoutMs,
      maxOutputChars: input.maxOutputChars
    },
    taskNodeId,
    priority: taskNode?.execution?.priority ?? taskNodeDefinition?.priority ?? 5,
    concurrencyGroup: taskNode?.execution?.concurrencyGroup ?? "code_execute",
    metrics: {
      codeChars: input.code.length,
      inputFiles: inputFiles.length,
      replayable: true
    },
    resumeStrategy:
      "从 durable input payload 读取受限 Python 代码、输入文件、timeout 和输出预算后重放 code_executor。",
    idempotencyKey: `code_execute:${taskNodeId}:${inputFiles.map((file) => file.name).join("|")}:${input.code.length}`
  });
  runtime.enqueueWorkerQueueItem({
    queueItemId,
    durableQueueId: record.id,
    durableInputRef: record.inputPayloadRef,
    queueLabel: "Code Execute",
    definition,
    inputSummary,
    taskNodeId,
    priority: taskNode?.execution?.priority ?? taskNodeDefinition?.priority ?? 5,
    concurrencyGroup: taskNode?.execution?.concurrencyGroup ?? "code_execute",
    metrics: {
      durableQueueId: record.id,
      codeChars: input.code.length,
      inputFiles: inputFiles.length,
      replayable: true
    }
  });
  runtime.startWorkerQueueItem(queueItemId);
  const leased = await markDurableWorkerQueueRunning({
    id: record.id,
    leaseMs: taskNode?.execution?.timeoutMs ?? definition.budget.timeoutMs ?? defaultTimeoutMs
  });
  return {
    record: leased ?? record,
    queueItemId
  };
}

async function finishCodeExecutionDurableRecord({
  runtime,
  durableQueueId,
  queueItemId,
  runResult
}: {
  runtime: AgentRuntimeHarness;
  durableQueueId: string;
  queueItemId: string;
  runResult: SubagentRunOutput<CodeExecutionResult>;
}) {
  const status = runResult.status === "completed"
    ? "completed"
    : runResult.value?.status === "cancelled"
      ? "cancelled"
      : runResult.status === "skipped"
      ? "skipped"
      : "failed";
  const outputSummary = runResult.value?.summary || "代码执行结束。";
  const metrics = {
    replayed: false,
    codeStatus: runResult.value?.status ?? runResult.status,
    outputFiles: runResult.value?.outputFiles.length ?? 0,
    resultArtifacts: runResult.resultArtifactIds.length
  };
  if (status === "completed") {
    runtime.completeWorkerQueueItem(queueItemId, outputSummary, {
      workerRunId: runResult.workerRunId,
      artifactIds: runResult.artifactIds,
      metrics
    });
  } else if (status === "cancelled") {
    runtime.cancelWorkerQueueItem(queueItemId, outputSummary, {
      workerRunId: runResult.workerRunId,
      artifactIds: runResult.artifactIds,
      errorMessage: runResult.value?.stderr || outputSummary,
      metrics
    });
  } else if (status === "skipped") {
    runtime.skipWorkerQueueItem(queueItemId, outputSummary, {
      workerRunId: runResult.workerRunId,
      artifactIds: runResult.artifactIds,
      metrics
    });
  } else {
    runtime.failWorkerQueueItem(queueItemId, outputSummary, {
      workerRunId: runResult.workerRunId,
      artifactIds: runResult.artifactIds,
      errorMessage: runResult.value?.stderr || outputSummary,
      metrics
    });
  }
  if (status === "cancelled") {
    await finishDurableWorkerQueueCancellation(
      durableQueueId,
      runResult.value?.stderr || outputSummary,
      {
        workerRunId: runResult.workerRunId,
        artifactIds: runResult.artifactIds,
        metrics
      }
    );
  } else {
    await finishDurableWorkerQueueRecord(durableQueueId, {
      status,
      workerRunId: runResult.workerRunId,
      artifactIds: runResult.artifactIds,
      outputSummary,
      errorMessage: status === "failed" ? runResult.value?.stderr || outputSummary : undefined,
      metrics
    });
  }
}

async function executeRestrictedPython(input: {
  traceId: string;
  code: string;
  inputFiles: CodeExecutionInputFile[];
  timeoutMs: number;
  maxOutputChars: number;
  sandboxPlan: CodeExecutionSandboxPlan;
  durableQueueId?: string;
}): Promise<{
  status: "completed" | "failed" | "cancelled";
  stdout: string;
  stderr: string;
  outputFiles: CodeExecutionOutputFile[];
  outputAudit: CodeExecutionOutputAudit;
  resourceLimits: CodeExecutionResourceLimits;
  cleanupAudit: CodeExecutionCleanupAudit;
  summary: string;
  sandboxPath: string;
  sandboxPlan: CodeExecutionSandboxPlan;
}> {
  const runId = `${Date.now()}-${crypto.randomUUID()}`;
  const sandboxPath = path.join(sandboxRoot, safePathSegment(input.traceId), runId);
  const inputDir = path.join(sandboxPath, "input");
  const outputDir = path.join(sandboxPath, "output");
  await mkdir(inputDir, { recursive: true });
  await mkdir(outputDir, { recursive: true });
  for (const file of input.inputFiles) {
    await writeFile(path.join(inputDir, file.name), file.content.slice(0, maxInputFileChars), "utf8");
  }
  const resourceLimits = resourceLimitsFor(input.timeoutMs);
  const userScriptPath = path.join(sandboxPath, "user_script.py");
  const runnerPath = path.join(sandboxPath, "runner.py");
  await writeFile(userScriptPath, input.code, "utf8");
  await writeFile(runnerPath, sandboxRunnerSource(resourceLimits), "utf8");

  try {
    const result = await runSandboxedPython({
      sandboxPath,
      runnerPath,
      timeoutMs: input.timeoutMs,
      maxOutputChars: input.maxOutputChars,
      resourceLimits,
      sandboxPlan: input.sandboxPlan,
      durableQueueId: input.durableQueueId
    });
    const stdout = compactText(result.stdout ?? "", input.maxOutputChars);
    const stderr = compactText(result.stderr ?? "", Math.floor(input.maxOutputChars / 2));
    const outputCollection = await collectOutputFiles(outputDir);
    return {
      status: result.status,
      stdout,
      stderr,
      outputFiles: outputCollection.files,
      outputAudit: outputCollection.audit,
      resourceLimits,
      cleanupAudit: result.cleanupAudit,
      summary: summarizeExecution(
        result.status,
        stdout,
        stderr,
        outputCollection.files,
        outputCollection.audit,
        result.cleanupAudit
      ),
      sandboxPath,
      sandboxPlan: input.sandboxPlan
    };
  } catch (error) {
    const execError = error as {
      stdout?: string;
      stderr?: string;
      message?: string;
      killed?: boolean;
      signal?: string;
    };
    const stdout = compactText(execError.stdout ?? "", input.maxOutputChars);
    const stderr = compactText(
      execError.stderr || execError.message || "Python execution failed.",
      Math.floor(input.maxOutputChars / 2)
    );
    const outputCollection = await collectOutputFiles(outputDir);
    return {
      status: "failed",
      stdout,
      stderr,
      outputFiles: outputCollection.files,
      outputAudit: outputCollection.audit,
      resourceLimits,
      cleanupAudit: fallbackCleanupAudit(input.sandboxPlan, input.timeoutMs, error),
      summary: summarizeExecution(
        "failed",
        stdout,
        execError.killed ? `timeout: ${input.timeoutMs}ms` : stderr,
        outputCollection.files,
        outputCollection.audit,
        fallbackCleanupAudit(input.sandboxPlan, input.timeoutMs, error)
      ),
      sandboxPath,
      sandboxPlan: input.sandboxPlan
    };
  } finally {
    await rm(path.join(sandboxPath, "__pycache__"), { recursive: true, force: true }).catch(() => undefined);
  }
}

async function runSandboxedPython(input: {
  sandboxPath: string;
  runnerPath: string;
  timeoutMs: number;
  maxOutputChars: number;
  resourceLimits: CodeExecutionResourceLimits;
  sandboxPlan: CodeExecutionSandboxPlan;
  durableQueueId?: string;
}): Promise<{
  status: "completed" | "failed" | "cancelled";
  stdout: string;
  stderr: string;
  cleanupAudit: CodeExecutionCleanupAudit;
}> {
  if (input.sandboxPlan.backend === "docker") {
    return runDockerPython(input);
  }
  if (input.sandboxPlan.backend === "process") {
    return runProcessPython(input);
  }
  throw new Error(input.sandboxPlan.message || "Code executor sandbox is unavailable.");
}

async function runProcessPython(input: {
  sandboxPath: string;
  runnerPath: string;
  timeoutMs: number;
  maxOutputChars: number;
  durableQueueId?: string;
}): Promise<{
  status: "completed" | "failed" | "cancelled";
  stdout: string;
  stderr: string;
  cleanupAudit: CodeExecutionCleanupAudit;
}> {
  return runCancellableCommand({
    backend: "process",
    command: "python3",
    args: ["-I", input.runnerPath],
    cwd: input.sandboxPath,
    timeout: input.timeoutMs,
    maxOutputChars: input.maxOutputChars,
    durableQueueId: input.durableQueueId,
    env: {
      NODE_ENV: process.env.NODE_ENV ?? "production",
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONNOUSERSITE: "1",
      PYTHONUTF8: "1",
      MPLBACKEND: "Agg"
    }
  });
}

async function runDockerPython(input: {
  sandboxPath: string;
  timeoutMs: number;
  maxOutputChars: number;
  resourceLimits: CodeExecutionResourceLimits;
  sandboxPlan: CodeExecutionSandboxPlan;
  durableQueueId?: string;
}): Promise<{
  status: "completed" | "failed" | "cancelled";
  stdout: string;
  stderr: string;
  cleanupAudit: CodeExecutionCleanupAudit;
}> {
  const image = input.sandboxPlan.dockerImage || defaultDockerImage;
  const containerName = `taste-code-${safePathSegment(path.basename(input.sandboxPath)).slice(0, 48)}`;
  const args = [
    "run",
    "--rm",
    "--name",
    containerName,
    "--network",
    "none",
    "--cpus",
    "1",
    "--memory",
    String(input.resourceLimits.memoryBytes),
    "--pids-limit",
    "64",
    "--ulimit",
    `nofile=${input.resourceLimits.openFiles}:${input.resourceLimits.openFiles}`,
    "--ulimit",
    `fsize=${input.resourceLimits.outputFileBytes}:${input.resourceLimits.outputFileBytes}`,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=64m",
    "-e",
    "PYTHONDONTWRITEBYTECODE=1",
    "-e",
    "PYTHONNOUSERSITE=1",
    "-e",
    "PYTHONUTF8=1",
    "-e",
    "MPLBACKEND=Agg",
    "-v",
    `${input.sandboxPath}:/workspace:rw`,
    "-w",
    "/workspace",
    image,
    "python",
    "-I",
    "runner.py"
  ];
  return runCancellableCommand({
    backend: "docker",
    command: "docker",
    args,
    cwd: input.sandboxPath,
    timeout: input.timeoutMs,
    maxOutputChars: input.maxOutputChars,
    durableQueueId: input.durableQueueId,
    containerName
  });
}

async function runCancellableCommand(input: {
  backend: CodeExecutionSandboxBackend;
  command: "python3" | "docker";
  args: string[];
  cwd: string;
  timeout: number;
  maxOutputChars: number;
  durableQueueId?: string;
  env?: NodeJS.ProcessEnv;
  containerName?: string;
}): Promise<{
  status: "completed" | "failed" | "cancelled";
  stdout: string;
  stderr: string;
  cleanupAudit: CodeExecutionCleanupAudit;
}> {
  const startedAt = new Date();
  const preStartCancellation = await codeCancellationReason(input.durableQueueId);
  if (preStartCancellation) {
    const completedAt = new Date();
    return {
      status: "cancelled",
      stdout: "",
      stderr: preStartCancellation,
      cleanupAudit: {
        backend: input.backend,
        command: input.command,
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
        timeoutMs: input.timeout,
        timedOut: false,
        cancelled: true,
        cancellationReason: preStartCancellation,
        processKilled: false,
        containerName: input.containerName,
        containerRemoved: input.containerName ? false : undefined,
        cleanupErrors: []
      }
    };
  }

  const child = spawn(input.command, input.args, {
    cwd: input.cwd,
    env: input.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const maxBuffer = Math.max(input.maxOutputChars * 3, 64_000);
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const cleanupErrors: string[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let timedOut = false;
  let cancelled = false;
  let cancellationReason = "";
  let processKilled = false;
  let processClosed = false;
  let containerRemoved: boolean | undefined = input.containerName ? false : undefined;
  let terminationPromise: Promise<void> | undefined;

  const appendChunk = (chunks: Buffer[], currentBytes: number, chunk: Buffer) => {
    const remaining = Math.max(0, maxBuffer - currentBytes);
    if (remaining > 0) {
      chunks.push(chunk.length > remaining ? chunk.subarray(0, remaining) : chunk);
    }
    return currentBytes + chunk.length;
  };

  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutBytes = appendChunk(stdoutChunks, stdoutBytes, chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrBytes = appendChunk(stderrChunks, stderrBytes, chunk);
  });

  const terminate = async (reason: string, kind: "cancelled" | "timeout") => {
    if (terminationPromise) return terminationPromise;
    terminationPromise = (async () => {
      if (kind === "cancelled") {
        cancelled = true;
        cancellationReason = reason;
      } else {
        timedOut = true;
      }
      processKilled = true;
      child.kill("SIGTERM");
      if (input.containerName) {
        const cleanup = await removeDockerContainer(input.containerName);
        containerRemoved = cleanup.removed;
        if (cleanup.error) cleanupErrors.push(cleanup.error);
      }
      setTimeout(() => {
        if (!processClosed) child.kill("SIGKILL");
      }, 1_500).unref();
    })();
    return terminationPromise;
  };

  const timeoutTimer = setTimeout(() => {
    void terminate(`timeout: ${input.timeout}ms`, "timeout");
  }, input.timeout);
  const cancelTimer = setInterval(() => {
    if (!input.durableQueueId) return;
    void codeCancellationReason(input.durableQueueId).then((reason) => {
      if (reason) void terminate(reason, "cancelled");
    });
  }, 350);

  return new Promise((resolve) => {
    child.on("error", (error) => {
      stderrBytes = appendChunk(stderrChunks, stderrBytes, Buffer.from(error.message));
    });
    child.on("close", async (exitCode, signal) => {
      processClosed = true;
      clearTimeout(timeoutTimer);
      clearInterval(cancelTimer);
      if (terminationPromise) await terminationPromise.catch((error) => {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      });
      if (input.containerName && (timedOut || cancelled) && containerRemoved === false) {
        const cleanup = await removeDockerContainer(input.containerName);
        containerRemoved = cleanup.removed;
        if (cleanup.error) cleanupErrors.push(cleanup.error);
      }
      const completedAt = new Date();
      const rawStdout = Buffer.concat(stdoutChunks).toString("utf8");
      const rawStderr = Buffer.concat(stderrChunks).toString("utf8");
      const status =
        cancelled
          ? "cancelled"
          : exitCode === 0 && !timedOut
            ? "completed"
            : "failed";
      const stderr = cancelled
        ? [rawStderr, cancellationReason].filter(Boolean).join("\n")
        : timedOut
          ? [rawStderr, `timeout: ${input.timeout}ms`].filter(Boolean).join("\n")
          : rawStderr;
      resolve({
        status,
        stdout: rawStdout,
        stderr,
        cleanupAudit: {
          backend: input.backend,
          command: input.command,
          startedAt: startedAt.toISOString(),
          completedAt: completedAt.toISOString(),
          durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
          timeoutMs: input.timeout,
          timedOut,
          cancelled,
          cancellationReason: cancellationReason || undefined,
          processKilled,
          exitCode,
          signal,
          containerName: input.containerName,
          containerRemoved,
          cleanupErrors: cleanupErrors.slice(0, 8)
        }
      });
    });
  });
}

async function codeCancellationReason(durableQueueId?: string) {
  if (!durableQueueId) return "";
  const record = await getDurableWorkerQueueRecord(durableQueueId).catch(() => null);
  if (!record) return "";
  if (record.status === "cancelled") {
    return record.cancellationReason || record.outputSummary || "代码执行已取消。";
  }
  if (record.cancelRequestedAt) {
    return record.cancellationReason || "用户请求取消代码执行。";
  }
  return "";
}

async function removeDockerContainer(containerName: string) {
  try {
    await execFileAsync("docker", ["rm", "-f", containerName], {
      timeout: 5_000,
      encoding: "utf8"
    });
    return { removed: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/No such container/i.test(message)) {
      return { removed: true };
    }
    return {
      removed: false,
      error: compactText(message, 220)
    };
  }
}

async function collectOutputFiles(outputDir: string): Promise<{
  files: CodeExecutionOutputFile[];
  audit: CodeExecutionOutputAudit;
}> {
  const entries = await readdir(outputDir, { withFileTypes: true }).catch(() => []);
  const files: CodeExecutionOutputFile[] = [];
  const skipped: string[] = [];
  const mimeWarnings: string[] = [];
  let totalFiles = 0;
  let totalBytes = 0;
  let collectedBytes = 0;
  for (const entry of entries) {
    if (!entry.isFile()) {
      skipped.push(`${entry.name}: not a regular file`);
      continue;
    }
    const filePath = path.join(outputDir, entry.name);
    const fileStat = await stat(filePath).catch(() => null);
    if (!fileStat) {
      skipped.push(`${entry.name}: stat failed`);
      continue;
    }
    totalFiles += 1;
    totalBytes += fileStat.size;
    if (files.length >= maxOutputFiles) {
      skipped.push(`${entry.name}: file count cap`);
      continue;
    }
    if (fileStat.size > maxOutputFileBytes) {
      skipped.push(`${entry.name}: file too large`);
      continue;
    }
    if (collectedBytes + fileStat.size > maxOutputTotalBytes) {
      skipped.push(`${entry.name}: total output cap`);
      continue;
    }
    const validation = await validateOutputFile(filePath, entry.name, fileStat.size);
    if (validation.status === "block") {
      skipped.push(`${entry.name}: ${validation.message}`);
      mimeWarnings.push(`${entry.name}: ${validation.message}`);
      continue;
    }
    if (validation.status === "warn") {
      mimeWarnings.push(`${entry.name}: ${validation.message}`);
    }
    const preview = await previewOutputFile(filePath, entry.name, fileStat.size);
    collectedBytes += fileStat.size;
    files.push({
      name: entry.name,
      path: filePath,
      size: fileStat.size,
      mimeType: validation.mimeType,
      preview,
      validation: {
        status: validation.status,
        message: validation.message
      }
    });
  }
  return {
    files,
    audit: {
      totalFiles,
      totalBytes,
      collectedFiles: files.length,
      collectedBytes,
      skipped: skipped.slice(0, 12),
      mimeWarnings: mimeWarnings.slice(0, 12)
    }
  };
}

async function validateOutputFile(filePath: string, name: string, size: number): Promise<{
  status: "pass" | "warn" | "block";
  mimeType: string;
  message: string;
}> {
  const lowerName = name.toLowerCase();
  const mimeType = inferOutputMimeType(lowerName);
  if (size === 0) {
    return {
      status: "warn",
      mimeType,
      message: "empty output file"
    };
  }
  if (lowerName.endsWith(".svg")) {
    const content = await readFile(filePath, "utf8").catch(() => "");
    const trimmed = content.trimStart();
    if (!trimmed.startsWith("<svg")) {
      return {
        status: "block",
        mimeType,
        message: "SVG output must start with <svg"
      };
    }
    if (/<script\b|<foreignObject\b|\son[a-z]+\s*=|javascript:/i.test(trimmed)) {
      return {
        status: "block",
        mimeType,
        message: "unsafe SVG active content"
      };
    }
    return {
      status: "pass",
      mimeType,
      message: "safe static SVG"
    };
  }
  if (lowerName.endsWith(".json")) {
    const content = await readFile(filePath, "utf8").catch(() => "");
    try {
      JSON.parse(content);
      return {
        status: "pass",
        mimeType,
        message: "valid JSON"
      };
    } catch {
      return {
        status: "warn",
        mimeType,
        message: "JSON extension but parse failed"
      };
    }
  }
  return {
    status: "pass",
    mimeType,
    message: "allowed passive output"
  };
}

function inferOutputMimeType(lowerName: string) {
  if (lowerName.endsWith(".json")) return "application/json";
  if (lowerName.endsWith(".md")) return "text/markdown";
  if (lowerName.endsWith(".csv")) return "text/csv";
  if (lowerName.endsWith(".tsv")) return "text/tab-separated-values";
  if (lowerName.endsWith(".svg")) return "image/svg+xml";
  if (lowerName.endsWith(".txt")) return "text/plain";
  return "application/octet-stream";
}

async function previewOutputFile(filePath: string, name: string, size: number) {
  if (!/\.(txt|md|json|csv|tsv|svg)$/i.test(name) || size > 120_000) return undefined;
  const content = await readFile(filePath, "utf8").catch(() => "");
  return compactText(content, 1600);
}

async function resolveCodeSandboxPlan(): Promise<CodeExecutionSandboxPlan> {
  const requested = requestedCodeSandbox();
  const strongIsolationRequired = requiresStrongCodeSandbox();
  const policy = strongIsolationRequired ? "production" : "development";
  if (requested === "process") {
    if (strongIsolationRequired) {
      return {
        requested,
        isolationLevel: "unavailable",
        strict: true,
        strongIsolationRequired,
        policy,
        dockerImage: defaultDockerImage,
        dockerAvailable: false,
        message:
          "Process-level code execution is disabled in production isolation mode. Use CODE_EXECUTOR_SANDBOX=docker with a local no-network Docker image."
      };
    }
    return {
      requested,
      backend: "process",
      isolationLevel: "process-restricted",
      strict: false,
      strongIsolationRequired,
      policy,
      dockerAvailable: false,
      message: "Using process restricted Python sandbox by explicit configuration."
    };
  }

  const docker = await probeDockerSandbox(defaultDockerImage);
  if (docker.available) {
    return {
      requested,
      backend: "docker",
      isolationLevel: "container-no-network",
      strict: requested === "docker" || strongIsolationRequired,
      strongIsolationRequired,
      policy,
      dockerImage: defaultDockerImage,
      dockerAvailable: true,
      message: `Using Docker sandbox image ${defaultDockerImage} with --network none.`
    };
  }

  if (requested === "docker" || strongIsolationRequired) {
    return {
      requested,
      isolationLevel: "unavailable",
      strict: true,
      strongIsolationRequired,
      policy,
      dockerImage: defaultDockerImage,
      dockerAvailable: false,
      message:
        requested === "docker"
          ? `Docker sandbox requested but unavailable: ${docker.reason}`
          : `Production isolation requires Docker no-network sandbox, but Docker is unavailable: ${docker.reason}`
    };
  }

  return {
    requested,
    backend: "process",
    isolationLevel: "process-restricted",
    strict: false,
    strongIsolationRequired,
    policy,
    dockerImage: defaultDockerImage,
    dockerAvailable: false,
    message: `Docker sandbox unavailable, falling back to process restricted Python: ${docker.reason}`
  };
}

function requestedCodeSandbox(): CodeExecutionSandboxRequest {
  const raw = (process.env.CODE_EXECUTOR_SANDBOX || "auto").trim().toLowerCase();
  if (raw === "docker" || raw === "process" || raw === "auto") return raw;
  return "auto";
}

function requiresStrongCodeSandbox() {
  const forced = (process.env.CODE_EXECUTOR_REQUIRE_STRONG_SANDBOX || "").trim().toLowerCase();
  return process.env.NODE_ENV === "production" || forced === "1" || forced === "true" || forced === "on";
}

async function probeDockerSandbox(image: string): Promise<{ available: boolean; reason: string }> {
  try {
    await execFileAsync("docker", ["version", "--format", "{{.Server.Version}}"], {
      timeout: 3_000,
      encoding: "utf8"
    });
  } catch (error) {
    return {
      available: false,
      reason: compactText(error instanceof Error ? error.message : String(error), 180)
    };
  }
  try {
    await execFileAsync("docker", ["image", "inspect", image], {
      timeout: 3_000,
      encoding: "utf8",
      maxBuffer: 16_000
    });
    return {
      available: true,
      reason: "Docker daemon and image are available."
    };
  } catch (error) {
    return {
      available: false,
      reason: `Docker image ${image} is not available locally. Pull it first or use CODE_EXECUTOR_SANDBOX=process. ${compactText(error instanceof Error ? error.message : String(error), 120)}`
    };
  }
}

function sandboxPlanGuardrail(plan: CodeExecutionSandboxPlan): AgentToolGuardrailResult {
  if (!plan.backend) {
    return guard(
      "code-sandbox-backend",
      "Sandbox backend",
      "block",
      plan.message
    );
  }
  if (plan.backend === "docker") {
    return guard(
      "code-sandbox-backend",
      "Sandbox backend",
      "pass",
      `${plan.message} CPU/memory/pids/fs limits and system-level network isolation enabled. policy=${plan.policy}.`
    );
  }
  return guard(
    "code-sandbox-backend",
    "Sandbox backend",
    plan.requested === "auto" ? "warn" : "pass",
    plan.message
  );
}

function guardCodeExecutionInput(input: {
  code: string;
  rawInputFiles: CodeExecutionInputFile[];
  inputFiles: CodeExecutionInputFile[];
  timeoutMs: number;
}): AgentToolGuardrailResult[] {
  const blockedPattern = unsafePattern(input.code);
  const blockedOpenPath = unsafeOpenPath(input.code);
  const rawFileNameUnsafe = input.rawInputFiles.some((file) => unsafeRawFileName(file.name));
  const totalInputChars = input.inputFiles.reduce((sum, file) => sum + file.content.length, 0);
  return [
    guard(
      "code-present",
      "Code present",
      input.code.trim() ? "pass" : "block",
      input.code.trim() ? `${input.code.length} chars.` : "No executable code was provided."
    ),
    guard(
      "code-size-cap",
      "Code size",
      input.code.length <= maxCodeChars ? "pass" : "block",
      `${input.code.length}/${maxCodeChars} code chars.`
    ),
    guard(
      "code-input-budget",
      "Input budget",
      input.rawInputFiles.length <= maxInputFiles && totalInputChars <= maxInputFiles * maxInputFileChars
        ? "pass"
        : "warn",
      `${Math.min(input.rawInputFiles.length, maxInputFiles)}/${input.rawInputFiles.length} files accepted; ${totalInputChars} chars loaded.`
    ),
    guard(
      "code-static-safety",
      "Static safety",
      blockedPattern ? "block" : "pass",
      blockedPattern
        ? `Blocked unsafe Python pattern: ${blockedPattern}.`
        : "No obvious network, shell, env, absolute path or dynamic execution pattern."
    ),
    guard(
      "code-open-path-scope",
      "Open path scope",
      blockedOpenPath ? "block" : "pass",
      blockedOpenPath
        ? `open() path must start with input/ or output/: ${blockedOpenPath}.`
        : "Literal open() paths are scoped to input/ or output/."
    ),
    guard(
      "code-input-file-scope",
      "Input filename scope",
      rawFileNameUnsafe ? "block" : "pass",
      rawFileNameUnsafe ? "Input filenames must not include paths or parent directory markers." : `${input.inputFiles.length} input files scoped.`
    ),
    guard(
      "code-timeout",
      "Timeout",
      input.timeoutMs <= defaultTimeoutMs ? "pass" : "warn",
      `${input.timeoutMs}ms timeout requested.`
    )
  ];
}

function unsafePattern(code: string) {
  const patterns: Array<[RegExp, string]> = [
    [/\b(import|from)\s+(os|subprocess|socket|requests|urllib|http|ftplib|ssl|shutil|sys|pathlib|importlib|ctypes|multiprocessing|threading)\b/i, "blocked import"],
    [/\b(__import__|eval|exec|compile|globals|locals|vars|input)\s*\(/i, "dynamic execution"],
    [/\b(open)\s*\(\s*['"]\//i, "absolute file path"],
    [/\.\.\//, "parent directory path"],
    [/\b(subprocess|socket|requests|urllib|ftplib|ssl|shutil)\s*\./i, "blocked module usage"],
    [/\benviron\b|\bgetenv\b/i, "environment access"],
    [/\bPopen\b|\bsystem\s*\(|\bspawn\b/i, "shell process"]
  ];
  return patterns.find(([pattern]) => pattern.test(code))?.[1] ?? "";
}

function unsafeOpenPath(code: string) {
  const openCalls = [...code.matchAll(/\bopen\s*\(/g)];
  if (!openCalls.length) return "";
  const literalOpenCalls = [...code.matchAll(/\bopen\s*\(\s*(['"])(.*?)\1/g)];
  if (literalOpenCalls.length < openCalls.length) return "non-literal open() path";
  for (const match of literalOpenCalls) {
    const target = match[2] ?? "";
    if (target.includes("..") || target.startsWith("/") || target.startsWith("\\")) return target;
    if (!target.startsWith("input/") && !target.startsWith("output/")) return target;
  }
  return "";
}

function unsafeRawFileName(name: string) {
  return /[/\\]/.test(name) || name.includes("..") || !name.trim();
}

function normalizeInputFile(file: CodeExecutionInputFile): CodeExecutionInputFile {
  return {
    name: safeFileName(file.name),
    content: file.content.slice(0, maxInputFileChars),
    mediaType: file.mediaType
  };
}

function safeFileName(name: string) {
  const base = path.basename(name || `input-${crypto.randomUUID()}.txt`);
  return base.replace(/[^\w.\-() ]+/g, "_").slice(0, 120) || `input-${crypto.randomUUID()}.txt`;
}

function safePathSegment(value: string) {
  return value.replace(/[^\w.-]+/g, "_").slice(0, 80) || "trace";
}

function resourceLimitsFor(timeoutMs: number): CodeExecutionResourceLimits {
  return {
    cpuSeconds: Math.max(1, Math.ceil(timeoutMs / 1000) + 1),
    memoryBytes: memoryLimitBytes,
    outputFileBytes: maxOutputFileBytes,
    outputTotalBytes: maxOutputTotalBytes,
    openFiles: maxOpenFiles
  };
}

function sandboxRunnerSource(limits: CodeExecutionResourceLimits) {
  return `
import runpy

def apply_resource_limits():
    try:
        import resource
    except Exception:
        return

    def set_limit(name, soft, hard):
        if not hasattr(resource, name):
            return
        try:
            resource.setrlimit(getattr(resource, name), (soft, hard))
        except Exception:
            pass

    set_limit("RLIMIT_CPU", ${limits.cpuSeconds}, ${limits.cpuSeconds})
    set_limit("RLIMIT_FSIZE", ${limits.outputFileBytes}, ${limits.outputFileBytes})
    set_limit("RLIMIT_NOFILE", ${limits.openFiles}, ${limits.openFiles})
    set_limit("RLIMIT_AS", ${limits.memoryBytes}, ${limits.memoryBytes})

apply_resource_limits()
runpy.run_path("user_script.py", run_name="__main__")
`.trim();
}

function summarizeExecution(
  status: "completed" | "failed" | "cancelled",
  stdout: string,
  stderr: string,
  outputFiles: CodeExecutionOutputFile[],
  outputAudit: CodeExecutionOutputAudit,
  cleanupAudit: CodeExecutionCleanupAudit
) {
  const firstLine = stdout.split(/\r?\n/).find(Boolean);
  const errorLine = stderr.split(/\r?\n/).find(Boolean);
  const outputBudget = outputAudit.skipped.length ? `，跳过 ${outputAudit.skipped.length} 个输出` : "";
  const cleanup = cleanupAudit.cleanupErrors.length
    ? `；清理告警 ${cleanupAudit.cleanupErrors.length} 个`
    : "";
  if (status === "cancelled") {
    return `代码执行已取消；${cleanupAudit.cancellationReason || "收到取消请求"}；stdout ${stdout.length} 字符，收集输出文件 ${outputFiles.length} 个${outputBudget}${cleanup}。`;
  }
  if (status === "completed") {
    return `代码执行完成；stdout ${stdout.length} 字符，收集 ${outputFiles.length} 个输出文件${outputBudget}${cleanup}${firstLine ? `；首行：${compactText(firstLine, 120)}` : "。"}。`;
  }
  return `代码执行失败；${errorLine ? compactText(errorLine, 180) : "无 stderr"}；stdout ${stdout.length} 字符，收集输出文件 ${outputFiles.length} 个${outputBudget}${cleanup}。`;
}

function cleanupAuditSummary(audit: CodeExecutionCleanupAudit) {
  const parts = [
    `${audit.backend}/${audit.command}`,
    `${audit.durationMs}ms`,
    audit.timedOut ? "timeout" : "",
    audit.cancelled ? "cancelled" : "",
    audit.processKilled ? "process killed" : "",
    audit.containerName ? `container ${audit.containerRemoved ? "removed" : "not removed"}` : "",
    audit.cleanupErrors.length ? `${audit.cleanupErrors.length} cleanup errors` : ""
  ].filter(Boolean);
  return parts.join(" · ");
}

function fallbackCleanupAudit(
  sandboxPlan: CodeExecutionSandboxPlan,
  timeoutMs: number,
  error: unknown
): CodeExecutionCleanupAudit {
  const now = new Date().toISOString();
  return {
    backend: sandboxPlan.backend ?? "process",
    command: sandboxPlan.backend === "docker" ? "docker" : "python3",
    startedAt: now,
    completedAt: now,
    durationMs: 0,
    timeoutMs,
    timedOut: false,
    cancelled: false,
    processKilled: false,
    cleanupErrors: [compactText(error instanceof Error ? error.message : String(error), 220)]
  };
}

function keyFindingsFromExecution(execution: {
  stdout: string;
  outputFiles: CodeExecutionOutputFile[];
}) {
  const stdoutLines = execution.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 4);
  return [
    ...stdoutLines,
    execution.outputFiles.length ? `生成输出文件：${execution.outputFiles.map((file) => file.name).join(", ")}` : ""
  ].filter(Boolean);
}

function guard(
  id: string,
  label: string,
  status: AgentToolGuardrailResult["status"],
  message: string
): AgentToolGuardrailResult {
  return { id, label, status, message };
}

function compactText(text: string, maxChars: number) {
  const clean = text.replace(/\u0000/g, "").trim();
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, maxChars)}...`;
}

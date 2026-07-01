import {
  AnalysisRequestError,
  runAnalysisFromFormData,
  type AnalysisRunEvent
} from "@/lib/analysis-runner";
import { extractGitHubRepositoryUrls } from "@/lib/github-repository";
import {
  appendRunEvent,
  completeRunLog,
  createRunLog,
  failRunLog,
  updateRunRetryInput
} from "@/lib/storage";
import type { ProductVariantId, RunRetryInput, StoredRunEvent } from "@/lib/types";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const runId = crypto.randomUUID();
      await createRunLog(runId);

      const send = async (
        payload: Omit<StoredRunEvent, "at" | "runId"> & { at?: string }
      ) => {
        const event: StoredRunEvent = {
          ...payload,
          runId,
          at: payload.at || new Date().toISOString()
        };
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        if (event.type === "complete" && event.analysisId) {
          await completeRunLog(runId, event.analysisId, event);
          return;
        }
        if (event.type === "error") {
          await failRunLog(runId, event.message || "分析失败", event);
          return;
        }
        await appendRunEvent(runId, event);
      };

      const sendProgress = async (event: AnalysisRunEvent) => {
        await send({
          type: "progress",
          ...event,
          at: new Date().toISOString()
        });
      };

      try {
        await send({
          type: "progress",
          stage: "intake",
          status: "running",
          title: "开始浏览",
          summary: "我先快速看一遍产品介绍。",
          at: new Date().toISOString()
        });

        const formData = await request.formData();
        const retryInput = buildRetryInput(formData);
        await updateRunRetryInput(runId, retryInput, summarizeRetryInput(retryInput));
        const record = await runAnalysisFromFormData(formData, sendProgress);

        await send({
          type: "complete",
          id: record.id,
          analysisId: record.id,
          status: record.status,
          model: record.model,
          at: new Date().toISOString()
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "分析失败";
        const status = error instanceof AnalysisRequestError ? error.status : 500;
        await send({
          type: "error",
          message,
          status,
          at: new Date().toISOString()
        });
      } finally {
        controller.close();
      }
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no"
    }
  });
}

function buildRetryInput(formData: FormData): RunRetryInput {
  const brief = trimForLog(value(formData, "brief") || value(formData, "visible_text"), 1800);
  const rawGithubRepoUrl = value(formData, "github_repo_url");
  const githubRepoUrl =
    extractGitHubRepositoryUrls(rawGithubRepoUrl)[0] || rawGithubRepoUrl;
  const materialNames = getUploadNames(formData);
  const canAutoPrefill = extractGitHubRepositoryUrls(githubRepoUrl).length > 0;

  return {
    productVariant: normalizeProductVariant(value(formData, "product_variant")),
    brief,
    githubRepoUrl: githubRepoUrl || undefined,
    materialNames,
    canAutoPrefill,
    limitation: canAutoPrefill
      ? undefined
      : materialNames.length
        ? "浏览器不会在刷新后保留本地文件，需要重新选择这些附件后再跑。"
        : "上次输入无法自动带回，请重新粘贴产品介绍或重新附上文件。"
  };
}

function summarizeRetryInput(retryInput: RunRetryInput) {
  const pieces = [
    retryInput.githubRepoUrl ? `来源: ${retryInput.githubRepoUrl}` : "",
    retryInput.materialNames.length ? `附件: ${retryInput.materialNames.join(", ")}` : "",
    retryInput.brief ? `产品介绍: ${retryInput.brief}` : ""
  ].filter(Boolean);
  return trimForLog(pieces.join("；") || "未捕获输入。", 420);
}

function value(formData: FormData, key: string) {
  const item = formData.get(key);
  return typeof item === "string" ? item.trim() : "";
}

function getUploadNames(formData: FormData) {
  const files = [
    ...formData.getAll("materials"),
    formData.get("image")
  ].filter(isUploadFile);
  return files.map((file) => file.name || "material").slice(0, 8);
}

function isUploadFile(item: FormDataEntryValue | null): item is File {
  return typeof File !== "undefined" && item instanceof File && item.size > 0;
}

function normalizeProductVariant(value: string): ProductVariantId {
  if (
    value === "roast" ||
    value === "reference-finder" ||
    value === "redesign-advisor"
  ) {
    return value;
  }
  return "coach";
}

function trimForLog(value: string, maxLength: number) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

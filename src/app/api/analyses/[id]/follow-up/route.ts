import { NextResponse } from "next/server";
import {
  createAnalysisFollowUpTurn,
  createFollowUpTraceStep
} from "@/lib/analysis-followup";
import { getAnalysis, saveAnalysis } from "@/lib/storage";
import { readSupplementalMaterialsWithRuntime } from "@/lib/supplemental-material-runner";

export const runtime = "nodejs";

type Params = {
  params: Promise<{ id: string }>;
};

export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  const record = await getAnalysis(id);

  if (!record) {
    return NextResponse.json({ error: "Analysis not found" }, { status: 404 });
  }

  try {
    const payload = await readPayload(request);
    if (!payload.message && payload.files.length === 0) {
      throw new Error("请输入追问，或上传补充材料。");
    }
    validateFiles(payload.files);

    const createdAt = new Date().toISOString();
    const turnId = crypto.randomUUID();
    const materialResult = await readSupplementalMaterialsWithRuntime({
      runtimeTrace: record.webResearch?.runtimeTrace,
      rootGoal: `继续对话材料读取：${record.productName || record.id}`,
      files: payload.files,
      uploadPrefix: `followup-${id}-${turnId}`,
      materialIdPrefix: turnId,
      taskNodeId: `follow_up:${turnId}:material_read`,
      taskLabel: "继续对话材料读取",
      inputSummary: `读取继续对话上传的 ${payload.files.length} 份补充材料。`,
      stage: "follow_up",
      maxBytes: 12 * 1024 * 1024,
      allowFile: isAllowedFile,
      handoffGoal: "把继续对话上传材料交给主会话，作为用户补充上下文而非客观市场证据。"
    });
    const turn = createAnalysisFollowUpTurn({
      record,
      userMessage: payload.message,
      materials: materialResult.materials,
      turnId,
      createdAt
    });
    const baseTraceStep = createFollowUpTraceStep(turn);
    const traceStep = {
      ...baseTraceStep,
      toolCalls: [...baseTraceStep.toolCalls, ...materialResult.toolCalls]
    };
    const updatedRecord = {
      ...record,
      updatedAt: createdAt,
      followUps: [...(record.followUps ?? []), turn].slice(-50),
      agentTrace: [...(record.agentTrace ?? []), traceStep].slice(-80),
      webResearch:
        record.webResearch && materialResult.runtimeTrace
          ? {
              ...record.webResearch,
              runtimeTrace: materialResult.runtimeTrace
            }
          : record.webResearch
    };

    await saveAnalysis(updatedRecord);

    return NextResponse.json({
      id: updatedRecord.id,
      status: updatedRecord.status,
      followUp: turn,
      followUps: updatedRecord.followUps,
      agentTrace: updatedRecord.agentTrace
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "继续对话失败";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

async function readPayload(request: Request) {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.includes("multipart/form-data")) {
    const raw = (await request.json()) as Record<string, unknown>;
    return {
      message: String(raw.message || "").trim(),
      files: [] as File[]
    };
  }

  const formData = await request.formData();
  return {
    message: formString(formData, "message"),
    files: [
      ...formData.getAll("materials"),
      ...formData.getAll("followUpMaterials"),
      ...formData.getAll("attachments")
    ]
      .filter(isUploadedFile)
      .filter((file) => file.size > 0)
      .slice(0, 6)
  };
}

function validateFiles(files: File[]) {
  if (files.length > 6) {
    throw new Error("一次最多补充 6 份材料。");
  }

  for (const file of files) {
    if (!isAllowedFile(file)) {
      throw new Error("支持 README/MD、TXT、PDF、PNG、JPG、WebP。");
    }

    if (file.size > 12 * 1024 * 1024) {
      throw new Error("单个材料请压缩到 12MB 以内。");
    }
  }
}

function isAllowedFile(file: File) {
  return isImageFile(file) || file.type === "application/pdf" || isTextFile(file);
}

function isImageFile(file: File) {
  return /^image\//.test(file.type) || /\.(png|jpe?g|webp)$/i.test(file.name);
}

function isTextFile(file: File) {
  const name = file.name.toLowerCase();
  return (
    file.type.startsWith("text/") ||
    file.type === "application/json" ||
    /\.(md|mdx|txt|csv|tsv|json)$/i.test(name) ||
    name === "readme"
  );
}

function formString(formData: FormData, name: string) {
  const value = formData.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function isUploadedFile(value: FormDataEntryValue): value is File {
  return (
    typeof value === "object" &&
    value !== null &&
    "arrayBuffer" in value &&
    "name" in value &&
    "size" in value
  );
}

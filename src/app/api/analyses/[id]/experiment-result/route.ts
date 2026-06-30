import { NextResponse } from "next/server";
import { applyExperimentResultToEvidenceBrief } from "@/lib/evidence-agent";
import { runCodeExecutionWithRuntime } from "@/lib/code-executor";
import { codeExecutionResultToExperimentArtifact } from "@/lib/experiment-code-evidence";
import { buildReportEvidenceBindings } from "@/lib/report-evidence-binding";
import { attachReportQualityToTrace, evaluateReportQuality } from "@/lib/report-quality";
import { getAnalysis, saveAnalysis } from "@/lib/storage";
import {
  readSupplementalMaterialsWithRuntime,
  type RuntimeSupplementalMaterial
} from "@/lib/supplemental-material-runner";
import type {
  AnalysisRecord,
  AgentTraceStep,
  AgentToolCall,
  ExperimentEvidenceArtifact,
  AgentRuntimeTrace,
  ValidationExperimentResult
} from "@/lib/types";

export const runtime = "nodejs";

type Params = {
  params: Promise<{ id: string }>;
};

type ExperimentPayload = Record<string, unknown> & {
  toolCalls?: AgentToolCall[];
  runtimeTrace?: AgentRuntimeTrace;
};

export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  const record = await getAnalysis(id);

  if (!record) {
    return NextResponse.json({ error: "Analysis not found" }, { status: 404 });
  }

  if (!record.evidenceBrief) {
    return NextResponse.json({ error: "Evidence Brief not found" }, { status: 400 });
  }

  try {
    const raw = await readExperimentPayload(request, record);
    const result = normalizeExperimentResult(
      raw,
      record.evidenceBrief.recommendedExperiment.expectedConfidenceGain
    );
    const evidenceBrief = applyExperimentResultToEvidenceBrief(
      record.evidenceBrief,
      result
    );
    const reportEvidenceBindings = record.report
      ? buildReportEvidenceBindings({
          report: record.report,
          evidenceBrief
        })
      : record.reportEvidenceBindings;
    const reportQualityAudit = record.report
        ? evaluateReportQuality({
          report: record.report,
          evidenceBrief,
          webResearch: record.webResearch,
          materials: record.materials ?? [],
          calibrationContext: record.calibrationContext,
          reportEvidenceBindings
        })
      : record.reportQualityAudit;
    const traceWithExtraction = raw.toolCalls?.length
      ? [...(record.agentTrace ?? []), experimentExtractionTraceStep(raw.toolCalls)].slice(-80)
      : record.agentTrace;
    const agentTrace = reportQualityAudit
      ? attachReportQualityToTrace(traceWithExtraction ?? [], reportQualityAudit)
      : traceWithExtraction;
    const updatedRecord = {
      ...record,
      updatedAt: new Date().toISOString(),
      evidenceBrief,
      reportQualityAudit,
      reportEvidenceBindings,
      agentTrace,
      webResearch:
        record.webResearch && raw.runtimeTrace
          ? {
              ...record.webResearch,
              runtimeTrace: raw.runtimeTrace
            }
          : record.webResearch
    };

    await saveAnalysis(updatedRecord);

    return NextResponse.json({
      id: updatedRecord.id,
      status: updatedRecord.status,
      evidenceBrief: updatedRecord.evidenceBrief,
      reportQualityAudit: updatedRecord.reportQualityAudit
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "实验结果回填失败";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

async function readExperimentPayload(
  request: Request,
  record: AnalysisRecord
): Promise<ExperimentPayload> {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.includes("multipart/form-data")) {
    return {
      ...((await request.json()) as Record<string, unknown>),
      toolCalls: []
    };
  }

  const formData = await request.formData();
  const completedAt = new Date().toISOString();
  const rawEvidenceUrls = formString(formData, "rawEvidenceUrls");
  const fileResult = await artifactsFromFiles(
    formData,
    record,
    completedAt,
    formString(formData, "status")
  );
  const rawEvidenceArtifacts: ExperimentEvidenceArtifact[] = [
    ...artifactsFromText(formString(formData, "rawEvidenceNotes"), {
      baseId: "pasted-note",
      title: "粘贴的原始实验材料",
      capturedAt: completedAt,
      status: formString(formData, "status"),
      preferredKind: "note"
    }),
    ...fileResult.artifacts
  ];

  return {
    completedAt,
    status: formString(formData, "status"),
    sampleSize: formString(formData, "sampleSize"),
    primaryMetricValue: formString(formData, "primaryMetricValue"),
    evidenceSummary: formString(formData, "evidenceSummary"),
    rawEvidenceUrls,
    rawEvidenceArtifacts,
    notes: formString(formData, "notes"),
    toolCalls: fileResult.toolCalls,
    runtimeTrace: fileResult.runtimeTrace
  };
}

function normalizeExperimentResult(
  raw: Record<string, unknown>,
  expectedConfidenceGain: number
): ValidationExperimentResult {
  const status = String(raw.status || "");
  if (!["validated", "inconclusive", "invalidated"].includes(status)) {
    throw new Error("请选择实验结果：validated / inconclusive / invalidated。");
  }

  const sampleSize = Number(raw.sampleSize);
  if (!Number.isFinite(sampleSize) || sampleSize < 0) {
    throw new Error("样本量必须是有效数字。");
  }

  const primaryMetricValue = String(raw.primaryMetricValue || "").trim();
  if (!primaryMetricValue) {
    throw new Error("请填写主指标结果。");
  }

  const evidenceSummary = String(raw.evidenceSummary || "").trim();
  if (!evidenceSummary) {
    throw new Error("请填写证据摘要。");
  }

  const rawEvidenceUrls = Array.isArray(raw.rawEvidenceUrls)
    ? raw.rawEvidenceUrls
        .map((item) => String(item).trim())
        .filter(Boolean)
    : String(raw.rawEvidenceUrls || "")
        .split(/\n|,/)
        .map((item) => item.trim())
        .filter(Boolean);

  const confidenceStep = Math.max(4, Math.round((expectedConfidenceGain || 0.12) * 100));
  const confidenceDelta =
    status === "validated" ? confidenceStep : status === "invalidated" ? -confidenceStep : 0;
  const completedAt = String(raw.completedAt || new Date().toISOString());

  return {
    status: status as ValidationExperimentResult["status"],
    completedAt,
    sampleSize,
    primaryMetricValue,
    evidenceSummary,
    rawEvidenceUrls,
    rawEvidenceArtifacts: normalizeRawEvidenceArtifacts(
      raw.rawEvidenceArtifacts,
      rawEvidenceUrls,
      status,
      completedAt
    ),
    confidenceDelta,
    notes: String(raw.notes || "").trim() || undefined
  };
}

function experimentExtractionTraceStep(toolCalls: AgentToolCall[]): AgentTraceStep {
  const failed = toolCalls.filter((toolCall) => toolCall.status === "failed").length;
  const skipped = toolCalls.filter((toolCall) => toolCall.status === "skipped").length;
  return {
    stage: "evidence_agent",
    title: "实验原始证据抽取",
    status: failed ? "failed" : skipped === toolCalls.length ? "skipped" : "completed",
    summary: `处理 ${toolCalls.length} 个实验原件工具调用；失败 ${failed} 个，跳过 ${skipped} 个。`,
    toolCalls
  };
}

async function artifactsFromFiles(
  formData: FormData,
  record: AnalysisRecord,
  capturedAt: string,
  status: string
): Promise<{
  artifacts: ExperimentEvidenceArtifact[];
  toolCalls: AgentToolCall[];
  runtimeTrace?: AgentRuntimeTrace;
}> {
  const files = formData.getAll("rawEvidenceFiles").filter(isUploadedFile).filter((file) => file.size > 0);
  const materialResult = await readSupplementalMaterialsWithRuntime({
    runtimeTrace: record.webResearch?.runtimeTrace,
    rootGoal: `实验原件读取：${record.productName || record.id}`,
    files: files.slice(0, 6),
    uploadPrefix: `experiment-${record.id}-${Date.now()}`,
    materialIdPrefix: `experiment-${record.id}`,
    taskNodeId: `experiment:${Date.now()}:material_read`,
    taskLabel: "实验原始证据读取",
    inputSummary: `读取 ${Math.min(files.length, 6)} 份实验原始证据文件。`,
    stage: "evidence_agent",
    maxBytes: Math.max(...files.map((file) => file.size), 1),
    allowFile: () => true,
    handoffGoal: "把实验原件抽取结果交给 Evidence Brief 回填，只作为实验观察证据，不绕过证据标准。"
  });

  const artifactGroups = materialResult.materials.map((material, index) => {
    const text = (material.extractedText || "").trim();
    const isScreenshot = material.extractionMethod === "ocr";
    if (text) {
      return artifactsFromText(text.slice(0, 16000), {
        baseId: `file-${index + 1}`,
        title: material.name || `原始材料 ${index + 1}`,
        sourceUrl: material.url,
        fileName: material.name,
        contentType: material.type,
        capturedAt,
        status,
        preferredKind: isScreenshot ? "screenshot" : inferMaterialFileKind(material, text),
        extractionMethod: material.extractionMethod,
        ocrEngine: material.ocrEngine,
        ocrConfidence: material.ocrConfidence
      });
    }

    const direction = inferArtifactDirection(material.name, status);
    return [
      {
        id: `file-${index + 1}`,
        kind: isScreenshot ? "screenshot" : "raw_file",
        title: material.name || `原始材料 ${index + 1}`,
        sourceUrl: material.url,
        fileName: material.name,
        contentType: material.type,
        excerpt: isScreenshot
          ? `已上传截图原件：${material.name || "未命名图片"}。`
          : `已上传原始文件：${material.name || "未命名文件"}。`,
        parsedSignal: isScreenshot
          ? "截图原件已进入证据账本；OCR 未识别出可用文字。"
          : "原始文件已进入证据账本；当前版本未能抽取正文，只能作为备查出处。",
        direction,
        objectiveLevel: "observed_fact",
        capturedAt,
        extractionMethod: material.extractionMethod ?? "file",
        ocrEngine: material.ocrEngine,
        ocrConfidence: material.ocrConfidence
      } satisfies ExperimentEvidenceArtifact
    ];
  });
  const codeResult = await summarizeExperimentDataWithCode({
    runtimeTrace: materialResult.runtimeTrace,
    materials: materialResult.materials,
    record,
    capturedAt,
    status
  });
  return {
    artifacts: [...artifactGroups.flat(), ...codeResult.artifacts],
    toolCalls: [...materialResult.toolCalls, ...codeResult.toolCalls],
    runtimeTrace: codeResult.runtimeTrace ?? materialResult.runtimeTrace
  };
}

async function summarizeExperimentDataWithCode(input: {
  runtimeTrace?: AgentRuntimeTrace;
  materials: RuntimeSupplementalMaterial[];
  record: AnalysisRecord;
  capturedAt: string;
  status: string;
}): Promise<{
  artifacts: ExperimentEvidenceArtifact[];
  toolCalls: AgentToolCall[];
  runtimeTrace?: AgentRuntimeTrace;
}> {
  const codeFiles = prepareCodeInputFiles(input.materials);
  if (!codeFiles.length) {
    return {
      artifacts: [],
      toolCalls: [],
      runtimeTrace: input.runtimeTrace
    };
  }
  const startedAt = Date.now();
  const result = await runCodeExecutionWithRuntime({
    runtimeTrace: input.runtimeTrace,
    rootGoal: `实验原件数据计算：${input.record.productName || input.record.id}`,
    taskNodeId: `experiment:${Date.now()}:code_execute`,
    taskLabel: "实验数据计算",
    inputSummary: `对 ${codeFiles.length} 份实验表格/JSON 原件执行受限 Python 汇总。`,
    inputFiles: codeFiles.map((file) => ({
      name: file.name,
      content: file.content,
      mediaType: file.mediaType
    })),
    code: buildExperimentDataSummaryCode(codeFiles),
    timeoutMs: 12000,
    maxOutputChars: 12000
  });
  const toolCall: AgentToolCall = {
    id: `code-execute-${Date.now()}`,
    stage: "evidence_agent",
    toolName: "code_execute",
    status: result.status === "completed" ? "completed" : "failed",
    inputSummary: `对 ${codeFiles.length} 份实验数据原件执行受限 Python。`,
    outputSummary: result.summary,
    latencyMs: Date.now() - startedAt
  };
  if (result.status !== "completed" || !result.stdout.trim()) {
    return {
      artifacts: [],
      toolCalls: [toolCall],
      runtimeTrace: result.runtimeTrace
    };
  }
  const artifact = codeExecutionResultToExperimentArtifact({
    id: `code-summary-${Date.now()}`,
    stdout: result.stdout,
    summary: result.summary,
    status: result.status,
    capturedAt: input.capturedAt,
    experimentStatus: input.status as ValidationExperimentResult["status"]
  });
  if (!artifact) {
    return {
      artifacts: [],
      toolCalls: [toolCall],
      runtimeTrace: result.runtimeTrace
    };
  }
  return {
    artifacts: [artifact],
    toolCalls: [toolCall],
    runtimeTrace: result.runtimeTrace
  };
}

type CodeInputFile = {
  name: string;
  content: string;
  mediaType?: string;
  kind: "csv" | "tsv" | "json";
};

function prepareCodeInputFiles(materials: RuntimeSupplementalMaterial[]): CodeInputFile[] {
  const usedNames = new Set<string>();
  const files: CodeInputFile[] = [];
  for (const [index, material] of materials.entries()) {
    const text = (material.extractedText || "").trim();
    if (!text) continue;
    const kind = inferCodeFileKind(material, text);
    if (!kind) continue;
    const name = uniqueCodeFileName(
      safeCodeFileName(material.name || `experiment-${index + 1}.${kind}`),
      usedNames,
      kind
    );
    files.push({
      name,
      content: text.slice(0, 80000),
      mediaType: material.type,
      kind
    });
    if (files.length >= 4) break;
  }
  return files;
}

function inferCodeFileKind(
  material: RuntimeSupplementalMaterial,
  text: string
): CodeInputFile["kind"] | null {
  const name = material.name || "";
  const type = material.type || "";
  if (/\.json$/i.test(name) || /json/i.test(type)) return "json";
  if (/\.tsv$/i.test(name) || text.split(/\r?\n/, 1)[0]?.includes("\t")) return "tsv";
  if (/\.csv$/i.test(name) || /csv/i.test(type) || looksLikeCsv(text)) return "csv";
  return null;
}

function looksLikeCsv(text: string) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 5);
  if (lines.length < 2) return false;
  const commaCounts = lines.map((line) => (line.match(/,/g) ?? []).length);
  return commaCounts[0] >= 1 && commaCounts.slice(1).some((count) => count === commaCounts[0]);
}

function safeCodeFileName(name: string) {
  const base = name.split(/[\\/]/).pop() || "input.csv";
  return base.replace(/[^\w.\-() ]+/g, "_").slice(0, 120) || "input.csv";
}

function uniqueCodeFileName(name: string, usedNames: Set<string>, kind: CodeInputFile["kind"]) {
  const fallbackExtension = kind === "json" ? ".json" : kind === "tsv" ? ".tsv" : ".csv";
  const withExtension = /\.[a-z0-9]+$/i.test(name) ? name : `${name}${fallbackExtension}`;
  if (!usedNames.has(withExtension)) {
    usedNames.add(withExtension);
    return withExtension;
  }
  const extension = withExtension.match(/\.[a-z0-9]+$/i)?.[0] ?? fallbackExtension;
  const stem = withExtension.slice(0, -extension.length);
  let counter = 2;
  while (usedNames.has(`${stem}-${counter}${extension}`)) {
    counter += 1;
  }
  const unique = `${stem}-${counter}${extension}`;
  usedNames.add(unique);
  return unique;
}

function buildExperimentDataSummaryCode(files: CodeInputFile[]) {
  return `
import csv
import json
import statistics

files = ${JSON.stringify(files.map((file) => ({ name: file.name, kind: file.kind })))}

def parse_number(value):
    text = str(value).strip()
    if not text:
        return None
    text = text.replace(",", "")
    percent = text.endswith("%")
    if percent:
        text = text[:-1]
    try:
        number = float(text)
    except ValueError:
        return None
    return number / 100 if percent else number

def summarize_rows(name, rows):
    columns = []
    for row in rows:
        for key in row.keys():
            if key not in columns:
                columns.append(key)
    numeric = {}
    missing = {}
    for column in columns:
        values = []
        blanks = 0
        zeros = 0
        for row in rows:
            raw = row.get(column, "")
            if str(raw).strip() == "":
                blanks += 1
                continue
            number = parse_number(raw)
            if number is not None:
                values.append(number)
                if number == 0:
                    zeros += 1
        missing[column] = blanks
        if values:
            numeric[column] = {
                "count": len(values),
                "min": min(values),
                "max": max(values),
                "mean": statistics.fmean(values),
                "sum": sum(values),
                "zero_count": zeros
            }
    return {
        "file": name,
        "rows": len(rows),
        "columns": columns,
        "numeric": numeric,
        "missing": missing,
        "sample_rows": rows[:3]
    }

def summarize_json(name, data):
    if isinstance(data, list) and all(isinstance(item, dict) for item in data):
        summary = summarize_rows(name, data)
        summary["json_shape"] = "list[object]"
        return summary
    if isinstance(data, dict):
        return {
            "file": name,
            "json_shape": "object",
            "keys": list(data.keys())[:30],
            "top_level_items": len(data)
        }
    if isinstance(data, list):
        return {
            "file": name,
            "json_shape": "list",
            "items": len(data),
            "sample_items": data[:3]
        }
    return {"file": name, "json_shape": type(data).__name__}

def escape_xml(value):
    return str(value).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")

def chart_entries(summaries):
    entries = []
    for item in summaries:
        numeric = item.get("numeric") or {}
        ranked = sorted(
            numeric.items(),
            key=lambda pair: abs(pair[1].get("sum", 0)),
            reverse=True
        )
        for column, stats in ranked[:6]:
            value = stats.get("sum", 0)
            if value == 0 and stats.get("count", 0) == 0:
                continue
            entries.append({
                "label": (item.get("file", "file") + " / " + column)[:48],
                "value": value
            })
    return entries[:10]

def write_svg_chart(summaries):
    entries = chart_entries(summaries)
    width = 760
    height = 420
    margin_left = 220
    margin_right = 36
    margin_top = 48
    row_height = 30
    chart_width = width - margin_left - margin_right
    lines = [
        '<svg xmlns="http://www.w3.org/2000/svg" width="' + str(width) + '" height="' + str(height) + '" viewBox="0 0 ' + str(width) + ' ' + str(height) + '">',
        '<rect width="100%" height="100%" fill="#ffffff"/>',
        '<text x="24" y="28" font-family="Arial, sans-serif" font-size="18" font-weight="700" fill="#111827">Experiment data summary</text>',
        '<text x="24" y="48" font-family="Arial, sans-serif" font-size="12" fill="#6b7280">Bar length shows numeric column sums from uploaded experiment files.</text>'
    ]
    if not entries:
        lines.append('<text x="24" y="96" font-family="Arial, sans-serif" font-size="14" fill="#6b7280">No numeric columns found.</text>')
    else:
        max_value = max(abs(entry["value"]) for entry in entries) or 1
        for index, entry in enumerate(entries):
            y = margin_top + 32 + index * row_height
            bar_width = max(2, int((abs(entry["value"]) / max_value) * chart_width))
            color = "#2563eb" if entry["value"] >= 0 else "#dc2626"
            lines.append('<text x="24" y="' + str(y + 14) + '" font-family="Arial, sans-serif" font-size="12" fill="#374151">' + escape_xml(entry["label"]) + '</text>')
            lines.append('<rect x="' + str(margin_left) + '" y="' + str(y) + '" width="' + str(bar_width) + '" height="18" rx="3" fill="' + color + '"/>')
            lines.append('<text x="' + str(margin_left + bar_width + 8) + '" y="' + str(y + 14) + '" font-family="Arial, sans-serif" font-size="12" fill="#111827">' + escape_xml(round(entry["value"], 3)) + '</text>')
    lines.append('</svg>')
    with open("output/summary_chart.svg", "w", encoding="utf-8") as handle:
        handle.write("\\n".join(lines))

summaries = []
for spec in files:
    name = spec["name"]
    kind = spec["kind"]
    with open("input/" + name, "r", encoding="utf-8-sig", newline="") as handle:
        raw = handle.read()
    if kind == "json":
        summaries.append(summarize_json(name, json.loads(raw)))
    else:
        delimiter = "\\t" if kind == "tsv" else ","
        reader = csv.DictReader(raw.splitlines(), delimiter=delimiter)
        summaries.append(summarize_rows(name, list(reader)))

write_svg_chart(summaries)
result = {"files": summaries, "visualizations": ["summary_chart.svg"]}
print(json.dumps(result, ensure_ascii=False, indent=2))
with open("output/summary.json", "w", encoding="utf-8") as handle:
    json.dump(result, handle, ensure_ascii=False, indent=2)
with open("output/summary.md", "w", encoding="utf-8") as handle:
    handle.write("Visualization: summary_chart.svg\\n\\n")
    for item in summaries:
        handle.write("## " + item.get("file", "file") + "\\n")
        handle.write("- rows: " + str(item.get("rows", item.get("items", item.get("top_level_items", "n/a")))) + "\\n")
        handle.write("- columns: " + ", ".join(item.get("columns", item.get("keys", []))[:20]) + "\\n")
        if item.get("numeric"):
            handle.write("- numeric columns: " + ", ".join(item["numeric"].keys()) + "\\n")
        handle.write("\\n")
`.trim();
}

function artifactsFromText(
  rawText: string,
  options: {
    baseId: string;
    title: string;
    capturedAt: string;
    status: string;
    preferredKind?: ExperimentEvidenceArtifact["kind"];
    sourceUrl?: string;
    fileName?: string;
    contentType?: string;
    extractionMethod?: ExperimentEvidenceArtifact["extractionMethod"];
    ocrEngine?: string;
    ocrConfidence?: number;
  }
): ExperimentEvidenceArtifact[] {
  const text = rawText.trim();
  if (!text) return [];

  const chunks = chunkEvidenceText(text);
  return chunks.slice(0, 8).map((chunk, index) => {
    const direction = inferArtifactDirection(chunk, options.status);
    const kind = inferArtifactKind(chunk, options.preferredKind);
    return {
      id: `${options.baseId}-${index + 1}`,
      kind,
      title: chunks.length > 1 ? `${options.title} #${index + 1}` : options.title,
      sourceUrl: options.sourceUrl,
      fileName: options.fileName,
      contentType: options.contentType,
      excerpt: shorten(chunk, 520),
      parsedSignal: parsedSignalForArtifact(chunk, direction, kind),
      direction,
      objectiveLevel: kind === "note" || kind === "interview_note" ? "evidence_interpretation" : "observed_fact",
      capturedAt: options.capturedAt,
      extractionMethod: options.extractionMethod,
      ocrEngine: options.ocrEngine,
      ocrConfidence: options.ocrConfidence
    };
  });
}

function normalizeRawEvidenceArtifacts(
  rawArtifacts: unknown,
  rawEvidenceUrls: string[],
  status: string,
  completedAt: string
) {
  const artifacts = Array.isArray(rawArtifacts)
    ? rawArtifacts
        .map((item, index) => normalizeArtifact(item, index, status, completedAt))
        .filter((item): item is ExperimentEvidenceArtifact => Boolean(item))
    : [];
  const urlArtifacts = rawEvidenceUrls.slice(0, 8).map((url, index) => {
    const direction = inferArtifactDirection(url, status);
    return {
      id: `raw-url-${index + 1}`,
      kind: "url" as const,
      title: `原始证据链接 ${index + 1}`,
      sourceUrl: url,
      excerpt: url,
      parsedSignal: "原始链接已进入证据账本，需要结合链接内容或截图继续核验。",
      direction,
      objectiveLevel: "observed_fact" as const,
      capturedAt: completedAt,
      extractionMethod: "url" as const
    };
  });

  const seen = new Set<string>();
  return [...artifacts, ...urlArtifacts].filter((artifact) => {
    const key = `${artifact.id}:${artifact.sourceUrl || ""}:${artifact.excerpt}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeArtifact(
  item: unknown,
  index: number,
  status: string,
  completedAt: string
): ExperimentEvidenceArtifact | null {
  if (!item || typeof item !== "object") return null;
  const record = item as Record<string, unknown>;
  const excerpt = String(record.excerpt || "").trim();
  if (!excerpt) return null;
  const direction = ["support", "oppose", "neutral"].includes(String(record.direction))
    ? (String(record.direction) as ExperimentEvidenceArtifact["direction"])
    : inferArtifactDirection(excerpt, status);
  const kind = artifactKind(String(record.kind || "")) || inferArtifactKind(excerpt, "note");
  const objectiveLevel =
    record.objectiveLevel === "observed_fact" ||
    record.objectiveLevel === "evidence_interpretation"
      ? record.objectiveLevel
      : "observed_fact";

  return {
    id: String(record.id || `artifact-${index + 1}`),
    kind,
    title: String(record.title || `原始证据 ${index + 1}`),
    sourceUrl: String(record.sourceUrl || "").trim() || undefined,
    fileName: String(record.fileName || "").trim() || undefined,
    contentType: String(record.contentType || "").trim() || undefined,
    excerpt: shorten(excerpt, 520),
    parsedSignal:
      String(record.parsedSignal || "").trim() ||
      parsedSignalForArtifact(excerpt, direction, kind),
    direction,
    objectiveLevel,
    capturedAt: String(record.capturedAt || completedAt),
    extractionMethod: extractionMethod(String(record.extractionMethod || "")),
    ocrEngine: String(record.ocrEngine || "").trim() || undefined,
    ocrConfidence: Number.isFinite(Number(record.ocrConfidence))
      ? Number(record.ocrConfidence)
      : undefined
  };
}

function chunkEvidenceText(text: string) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const delimiter = lines[0]?.includes("\t") ? "\t" : ",";
  const looksTabular =
    lines.length > 1 &&
    lines[0]?.includes(delimiter) &&
    lines.slice(1, 5).some((line) => line.includes(delimiter));

  if (looksTabular) {
    const header = lines[0];
    return lines.slice(1, 9).map((line) => `${header}\n${line}`);
  }

  const paragraphs = text
    .split(/\n\s*\n/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 12);
  if (paragraphs.length > 1) return paragraphs;

  return lines.length > 1
    ? lines.filter((line) => line.length >= 8)
    : [text];
}

function inferMaterialFileKind(
  material: RuntimeSupplementalMaterial,
  text: string
): ExperimentEvidenceArtifact["kind"] {
  if (/\.(csv|tsv)$/i.test(material.name) || material.type === "text/csv") return "csv_row";
  return inferArtifactKind(text, "raw_file");
}

function inferArtifactKind(
  text: string,
  preferredKind: ExperimentEvidenceArtifact["kind"] = "note"
): ExperimentEvidenceArtifact["kind"] {
  if (preferredKind === "csv_row") return "csv_row";
  if (/访谈|用户说|quote|interview|受访|反馈|评论|私信/i.test(text)) {
    return "interview_note";
  }
  if (/点击|访问|转化|留资|预约|ctr|conversion|signup|metric|sample|样本|数据|指标/i.test(text)) {
    return "metric_snapshot";
  }
  return preferredKind;
}

function inferArtifactDirection(
  text: string,
  status: string
): ExperimentEvidenceArtifact["direction"] {
  const directionalPattern =
    /付费|购买|留资|预约|点击|转化|愿意|主动|回复|报名|signup|paid|demo|validated|conversion|失败|无需求|不需要|不愿|太贵|低频|没有转化|无人|invalidated|not worth|too expensive|no demand/i;
  if (/失败|无需求|不需要|不愿|太贵|低频|没有转化|无人|invalidated|not worth|too expensive|no demand/i.test(text)) {
    return "oppose";
  }
  if (
    /(?:点击|访问|转化|留资|预约|回复|评论|用户|signups?|leads?|conversions?)\s*(?:为|是|:|：)?\s*(?:0|零)\b/i.test(text) ||
    /\b(?:0|零)\s*(?:个|次|人|条)?\s*(?:点击|访问|转化|留资|预约|回复|评论|用户|signups?|leads?|conversions?)\b/i.test(text)
  ) {
    return "oppose";
  }
  if (timestampSummary(text) && !directionalPattern.test(text)) {
    return "neutral";
  }
  if (/付费|购买|留资|预约|点击|转化|愿意|主动|回复|报名|signup|paid|demo|validated|conversion/i.test(text)) {
    return "support";
  }
  if (status === "validated") return "support";
  if (status === "invalidated") return "oppose";
  return "neutral";
}

function parsedSignalForArtifact(
  text: string,
  direction: ExperimentEvidenceArtifact["direction"],
  kind: ExperimentEvidenceArtifact["kind"]
) {
  const prefix =
    direction === "support" ? "支持信号" : direction === "oppose" ? "反证信号" : "中性信号";
  const kindLabel =
    kind === "csv_row"
      ? "表格行"
      : kind === "metric_snapshot"
        ? "指标快照"
        : kind === "interview_note"
          ? "访谈/评论摘录"
          : "原始材料";
  const timestamp = timestampSummary(text);
  const metric = metricSummary(text);
  const details = [timestamp, metric].filter(Boolean).join("；");
  return `${prefix} · ${kindLabel}${details ? ` · ${details}` : ""}：${shorten(text.replace(/\s+/g, " "), 110)}`;
}

function artifactKind(value: string): ExperimentEvidenceArtifact["kind"] | null {
  const kinds: ExperimentEvidenceArtifact["kind"][] = [
    "metric_snapshot",
    "csv_row",
    "interview_note",
    "screenshot",
    "raw_file",
    "url",
    "note"
  ];
  return kinds.includes(value as ExperimentEvidenceArtifact["kind"])
    ? (value as ExperimentEvidenceArtifact["kind"])
    : null;
}

function extractionMethod(value: string): ExperimentEvidenceArtifact["extractionMethod"] | undefined {
  const methods: Array<NonNullable<ExperimentEvidenceArtifact["extractionMethod"]>> = [
    "manual",
    "text",
    "pdf",
    "ocr",
    "url",
    "file",
    "code"
  ];
  return methods.includes(value as NonNullable<ExperimentEvidenceArtifact["extractionMethod"]>)
    ? (value as NonNullable<ExperimentEvidenceArtifact["extractionMethod"]>)
    : undefined;
}

function timestampSummary(text: string) {
  const matches = text.match(
    /\b20\d{2}[-/.年](?:0?[1-9]|1[0-2])[-/.月]?(?:0?[1-9]|[12]\d|3[01])?日?\b|\b(?:0?\d|1\d|2[0-3]):[0-5]\d\b/g
  );
  if (!matches?.length) return "";
  return `时间戳 ${Array.from(new Set(matches)).slice(0, 2).join(" / ")}`;
}

function metricSummary(text: string) {
  const matches = [
    ...(text.match(/\b\d+(?:\.\d+)?%/gu) ?? []),
    ...(text.match(/\b\d+(?:\.\d+)?\s*(?:clicks?|views?|signups?|leads?|users?)\b/giu) ?? []),
    ...(text.match(/(?:点击|访问|转化|留资|预约|回复|评论|用户)\s*\d+(?:\.\d+)?\s*(?:个|次|人|条)?/gu) ?? [])
  ];
  if (!matches?.length) return "";
  return `指标 ${Array.from(new Set(matches)).slice(0, 3).join(" / ")}`;
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

function shorten(value: string, maxLength: number) {
  const compact = value.replace(/[ \t]+/g, " ").trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 1)}...` : compact;
}

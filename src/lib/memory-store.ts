import { promises as fs } from "fs";
import path from "path";
import type {
  AnalysisRecord,
  ProductAnalysisCalibrationContext,
  ProductMemoryContext,
  ProductMemoryEntry,
  ProductMemoryScope,
  UploadedMaterial,
  WorkType
} from "./types";

const memoryRoot = path.join(process.cwd(), ".taste-data", "memory");
const memoryEntriesPath = path.join(memoryRoot, "entries.json");
const memoryVersion = "product-memory-v1" as const;
const productMemoryTtlMs = 180 * 24 * 60 * 60 * 1000;
const calibrationMemoryTtlMs = 90 * 24 * 60 * 60 * 1000;
const proceduralMemoryTtlMs = 365 * 24 * 60 * 60 * 1000;

export async function loadProductMemoryContext({
  brief,
  materials,
  productName,
  workType,
  calibrationContext,
  limit = 9
}: {
  brief?: string;
  materials: UploadedMaterial[];
  productName: string;
  workType: WorkType;
  calibrationContext?: ProductAnalysisCalibrationContext;
  limit?: number;
}): Promise<ProductMemoryContext> {
  const now = new Date();
  await seedProceduralMemory(now);
  if (calibrationContext) {
    await upsertCalibrationMemory(calibrationContext, now);
  }
  const loaded = await readMemoryEntries();
  const active = loaded.entries.filter((entry) => !isExpired(entry, now));
  if (active.length !== loaded.entries.length) {
    await writeMemoryEntries(active);
  }
  const tags = queryTags({ brief, materials, productName, workType });
  const scored = active
    .map((entry) => ({
      entry,
      score: memoryScore(entry, { productName, workType, tags })
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.entry.confidence - a.entry.confidence);
  const compacted = compactConflicts(scored.map((item) => item.entry));
  return {
    version: memoryVersion,
    generatedAt: now.toISOString(),
    query: {
      productName,
      workType,
      tags: tags.slice(0, 12)
    },
    entries: compacted.entries.slice(0, limit),
    droppedExpiredCount: loaded.entries.length - active.length,
    conflictNotes: compacted.conflictNotes.slice(0, 8),
    usageRules: [
      "Memory entries are hints only, not evidence.",
      "Every market claim still needs current material, web evidence, or explicit user-provided proof.",
      "If memory conflicts with current evidence, prefer current evidence and mention the conflict as uncertainty.",
      "Do not cite memory provenance as an external source unless it points to a real artifact/source already in this run."
    ]
  };
}

export async function persistAnalysisMemory(record: AnalysisRecord) {
  if (record.status !== "completed" || !record.evidenceBrief || !record.report) return;
  const now = new Date();
  const entries = await readMemoryEntries();
  const next = upsertMemoryEntry(entries.entries, productMemoryFromAnalysis(record, now));
  await writeMemoryEntries(next);
}

export function memoryContextSummary(memoryContext?: ProductMemoryContext) {
  if (!memoryContext || !memoryContext.entries.length) {
    return "Memory v1: no matching persisted hints.";
  }
  const byScope = memoryContext.entries.reduce<Record<ProductMemoryScope, number>>(
    (counts, entry) => {
      counts[entry.scope] += 1;
      return counts;
    },
    {
      product_memory: 0,
      calibration_memory: 0,
      procedural_memory: 0
    }
  );
  return `Memory v1: ${memoryContext.entries.length} hints (product ${byScope.product_memory}, calibration ${byScope.calibration_memory}, procedural ${byScope.procedural_memory}).`;
}

function productMemoryFromAnalysis(record: AnalysisRecord, now: Date): ProductMemoryEntry {
  const brief = record.evidenceBrief;
  const report = record.report;
  const productName = record.productName || brief?.productName || "unknown";
  const key = `product:${safeKey(productName)}:${record.workType}`;
  const confidence = clamp(
    ((brief?.confidenceScore ?? 45) + (record.reportQualityAudit?.score ?? 60)) / 200,
    0.25,
    0.9
  );
  return {
    id: stableMemoryId(key, record.id),
    scope: "product_memory",
    key,
    title: `${productName} analysis memory`,
    summary: `${brief?.decision.decision ?? "unknown"}; potential ${report?.potential_score ?? "unknown"}/100; confidence ${brief?.confidenceScore ?? "unknown"}/100.`,
    hints: [
      `Previous decision: ${brief?.decision.decision ?? "unknown"} with confidence ${brief?.confidenceScore ?? "unknown"}/100.`,
      `Main diagnosis: ${report?.share_summary.one_line_diagnosis || report?.potential_verdict || "unknown"}.`,
      ...(brief?.evidenceGaps.slice(0, 3).map((gap) => `Known evidence gap: ${gap.missingEvidence}`) ?? []),
      ...(report?.limitations.slice(0, 2).map((limitation) => `Prior limitation: ${limitation}`) ?? [])
    ].filter(Boolean),
    tags: [
      safeKey(productName),
      record.workType,
      brief?.productLifecycleStage ?? "unknown",
      brief?.decision.decision ?? "unknown"
    ],
    relatedProductName: productName,
    workType: record.workType,
    confidence,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + productMemoryTtlMs).toISOString(),
    provenance: [
      {
        sourceType: "analysis",
        sourceId: record.id,
        summary: `Generated from completed analysis ${record.id}.`
      }
    ],
    conflictPolicy: "keep_conflicts_as_uncertainty",
    limitations: [
      "This memory summarizes a prior local analysis and may be stale.",
      "It cannot replace fresh web evidence, uploaded materials, or Judge constraints."
    ]
  };
}

async function upsertCalibrationMemory(context: ProductAnalysisCalibrationContext, now: Date) {
  const entries = await readMemoryEntries();
  const ruleHints = [
    ...context.rules.slice(0, 4).map((rule) => `${rule.title}: ${rule.agentRule}`),
    ...context.actions.slice(0, 3).map((action) => `${action.label}: ${action.reason}`)
  ];
  const entry: ProductMemoryEntry = {
    id: stableMemoryId(`calibration:${context.appliesTo}`, context.source),
    scope: "calibration_memory",
    key: `calibration:${context.appliesTo}`,
    title: `${context.appliesTo} calibration memory`,
    summary: `README/GitHub calibration from ${context.staticSampleCount} static and ${context.dynamicSampleCount} dynamic samples.`,
    hints: ruleHints.length ? ruleHints : context.limitations,
    tags: ["readme", "github", "calibration", context.appliesTo],
    confidence: context.dynamicSampleCount ? 0.72 : 0.55,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + calibrationMemoryTtlMs).toISOString(),
    provenance: [
      {
        sourceType: "backtest",
        sourceId: context.source,
        summary: context.reason
      }
    ],
    conflictPolicy: "prefer_higher_confidence",
    limitations: context.limitations
  };
  await writeMemoryEntries(upsertMemoryEntry(entries.entries, entry));
}

async function seedProceduralMemory(now: Date) {
  const entries = await readMemoryEntries();
  const proceduralEntries: ProductMemoryEntry[] = [
    {
      id: stableMemoryId("procedural:evidence-boundary", "system"),
      scope: "procedural_memory",
      key: "procedural:evidence-boundary",
      title: "Evidence boundary procedure",
      summary: "Separate user/material claims, memory hints, search snippets, fetched pages, and verified evidence cards.",
      hints: [
        "Treat README/PDF/user claims as product claims until backed by external evidence.",
        "Require opposition/failure-mode search before strong build/reposition decisions.",
        "Use memory only to ask better questions or avoid repeated mistakes."
      ],
      tags: ["procedure", "evidence", "judge"],
      confidence: 0.86,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + proceduralMemoryTtlMs).toISOString(),
      provenance: [
        {
          sourceType: "system",
          sourceId: "procedural-memory-v1",
          summary: "Built-in Product Agent evidence boundary procedure."
        }
      ],
      conflictPolicy: "prefer_recent",
      limitations: ["Procedural memory is a workflow hint, not product-specific evidence."]
    },
    {
      id: stableMemoryId("procedural:local-first", "system"),
      scope: "procedural_memory",
      key: "procedural:local-first",
      title: "Local-first MVP procedure",
      summary: "For early open-source local products, prioritize install friction, trust, repeat use, and proof loops.",
      hints: [
        "Check whether the product can deliver value without a hosted backend.",
        "Call out setup friction, API key friction, and local data trust as product risks.",
        "Prefer concrete next experiments that can be run from the local app."
      ],
      tags: ["procedure", "local-first", "mvp"],
      confidence: 0.78,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + proceduralMemoryTtlMs).toISOString(),
      provenance: [
        {
          sourceType: "system",
          sourceId: "procedural-memory-v1",
          summary: "Built-in local-first product analysis procedure."
        }
      ],
      conflictPolicy: "keep_conflicts_as_uncertainty",
      limitations: ["Applies as a generic product-analysis heuristic only."]
    }
  ];
  let next = entries.entries;
  for (const entry of proceduralEntries) {
    next = upsertMemoryEntry(next, entry);
  }
  if (next.length !== entries.entries.length) {
    await writeMemoryEntries(next);
  }
}

function compactConflicts(entries: ProductMemoryEntry[]) {
  const byKey = new Map<string, ProductMemoryEntry[]>();
  for (const entry of entries) {
    byKey.set(entry.key, [...(byKey.get(entry.key) ?? []), entry]);
  }
  const selected: ProductMemoryEntry[] = [];
  const conflictNotes: string[] = [];
  for (const [key, group] of byKey.entries()) {
    const sorted = group
      .slice()
      .sort((a, b) => b.confidence - a.confidence || new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    const policy = sorted[0]?.conflictPolicy ?? "keep_conflicts_as_uncertainty";
    if (group.length > 1) {
      conflictNotes.push(`${key}: ${group.length} memory entries matched; policy=${policy}.`);
    }
    if (policy === "prefer_recent") {
      selected.push(
        group.slice().sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0]
      );
    } else if (policy === "prefer_higher_confidence") {
      selected.push(sorted[0]);
    } else {
      selected.push(...sorted.slice(0, 2));
    }
  }
  return {
    entries: selected.sort((a, b) => b.confidence - a.confidence),
    conflictNotes
  };
}

function memoryScore(
  entry: ProductMemoryEntry,
  query: { productName: string; workType: WorkType; tags: string[] }
) {
  let score = entry.scope === "procedural_memory" ? 0.8 : 0;
  const product = safeKey(query.productName);
  if (entry.relatedProductName && safeKey(entry.relatedProductName) === product) score += 5;
  if (entry.workType && entry.workType === query.workType) score += 1.5;
  for (const tag of query.tags) {
    if (entry.tags.includes(tag)) score += 0.6;
  }
  if (entry.scope === "calibration_memory" && query.tags.some((tag) => tag === "readme" || tag === "github")) {
    score += 3;
  }
  return score * Math.max(0.2, entry.confidence);
}

function queryTags({
  brief,
  materials,
  productName,
  workType
}: {
  brief?: string;
  materials: UploadedMaterial[];
  productName: string;
  workType: WorkType;
}) {
  const raw = [
    productName,
    workType,
    brief,
    ...materials.map((material) => `${material.name} ${material.type} ${material.sourceKind ?? ""}`)
  ]
    .join(" ")
    .toLowerCase();
  const tags = new Set<string>([safeKey(productName), workType]);
  if (/github\.com|github|repo/.test(raw)) tags.add("github");
  if (/readme|markdown|\.md/.test(raw)) tags.add("readme");
  if (/local|desktop|self.host|本地|开源/.test(raw)) tags.add("local-first");
  if (/agent|ai|workflow|automation|自动化/.test(raw)) tags.add("agent");
  if (/mvp|prototype|demo|早期|验证/.test(raw)) tags.add("mvp");
  return [...tags].filter(Boolean);
}

async function readMemoryEntries(): Promise<{ entries: ProductMemoryEntry[] }> {
  try {
    await fs.mkdir(memoryRoot, { recursive: true });
    const raw = await fs.readFile(memoryEntriesPath, "utf8");
    const parsed = JSON.parse(raw) as { entries?: ProductMemoryEntry[] };
    return {
      entries: Array.isArray(parsed.entries) ? parsed.entries.filter(isMemoryEntry) : []
    };
  } catch {
    return { entries: [] };
  }
}

async function writeMemoryEntries(entries: ProductMemoryEntry[]) {
  await fs.mkdir(memoryRoot, { recursive: true });
  await fs.writeFile(
    memoryEntriesPath,
    JSON.stringify(
      {
        version: memoryVersion,
        updatedAt: new Date().toISOString(),
        entries
      },
      null,
      2
    ),
    "utf8"
  );
}

function upsertMemoryEntry(entries: ProductMemoryEntry[], entry: ProductMemoryEntry) {
  const existing = entries.find((item) => item.id === entry.id);
  if (!existing) return [...entries, entry];
  return entries.map((item) =>
    item.id === entry.id
      ? {
          ...entry,
          createdAt: item.createdAt,
          provenance: mergeProvenance(item.provenance, entry.provenance)
        }
      : item
  );
}

function mergeProvenance(
  before: ProductMemoryEntry["provenance"],
  after: ProductMemoryEntry["provenance"]
) {
  const seen = new Set<string>();
  return [...after, ...before].filter((item) => {
    const key = `${item.sourceType}:${item.sourceId}:${item.artifactId ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isExpired(entry: ProductMemoryEntry, now: Date) {
  return new Date(entry.expiresAt).getTime() <= now.getTime();
}

function isMemoryEntry(value: unknown): value is ProductMemoryEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<ProductMemoryEntry>;
  return Boolean(entry.id && entry.scope && entry.key && entry.summary && entry.expiresAt);
}

function stableMemoryId(key: string, sourceId: string) {
  return safeKey(`${key}:${sourceId}`).slice(0, 160);
}

function safeKey(value: string) {
  return String(value || "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "unknown";
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, max));
}

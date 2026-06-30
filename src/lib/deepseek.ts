import { productDiagnosisReportSchema } from "./report-schema";
import { referenceLibrary } from "./reference-library";
import { getVariant } from "./variants";
import type {
  AgentTraceStep,
  EvidenceBrief,
  EvidenceStopRule,
  ImageMetrics,
  ProductAnalysisCalibrationContext,
  ProductVariantId,
  ProductDiagnosisReport,
  UploadedMaterial,
  ValidationExperiment,
  WebResearchSummary,
  WorkType
} from "./types";

type GenerateReportInput = {
  productVariant: ProductVariantId;
  brief?: string;
  materials?: UploadedMaterial[];
  webResearch?: WebResearchSummary;
  evidenceBrief?: EvidenceBrief;
  calibrationContext?: ProductAnalysisCalibrationContext;
  agentTrace?: AgentTraceStep[];
  workType: WorkType;
  targetFeeling: string;
  visibleText: string;
  productName: string;
  imageMetrics: ImageMetrics | null;
};

type ReportModelProvider = "deepseek" | "zhipu";

type ReportModelConfig = {
  provider: ReportModelProvider;
  model: string;
  apiKey?: string;
  endpoint: string;
  missingKeyMessage: string;
};

export async function generateProductDiagnosisReport(
  input: GenerateReportInput
): Promise<ProductDiagnosisReport> {
  const config = resolveReportModelConfig();
  if (!config.apiKey) {
    return fallbackReport(input, config.missingKeyMessage);
  }

  const prompt = buildPrompt(input);

  try {
    const response = await fetch(config.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(buildChatCompletionBody(config, prompt)),
      cache: "no-store"
    });

    if (!response.ok) {
      const errorText = await response.text();
      return fallbackReport(
        input,
        `${providerName(config.provider)} request failed: ${errorText}`
      );
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) {
      return fallbackReport(
        input,
        `${providerName(config.provider)} returned an empty response.`
      );
    }

    const parsed = parseJsonObject(content);
    const result = productDiagnosisReportSchema.safeParse(parsed);
    if (!result.success) {
      return fallbackReport(
        input,
        `${providerName(config.provider)} JSON did not match schema: ${result.error.message}`
      );
    }

    return normalizeReport(result.data);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return fallbackReport(input, message);
  }
}

export function modelName() {
  const config = resolveReportModelConfig();
  return `${config.provider}/${config.model}`;
}

export const generateTasteReport = generateProductDiagnosisReport;

function resolveReportModelConfig(): ReportModelConfig {
  const requested = process.env.REPORT_MODEL_PROVIDER?.toLowerCase();

  if (requested === "deepseek") return deepseekConfig();
  if (requested === "zhipu") return zhipuConfig();

  if (process.env.ZHIPU_API_KEY) return zhipuConfig();
  return deepseekConfig();
}

function deepseekConfig(): ReportModelConfig {
  return {
    provider: "deepseek",
    model: process.env.DEEPSEEK_MODEL || "deepseek-v4-flash",
    apiKey: process.env.DEEPSEEK_API_KEY,
    endpoint: "https://api.deepseek.com/chat/completions",
    missingKeyMessage: "DeepSeek API key is missing."
  };
}

function zhipuConfig(): ReportModelConfig {
  return {
    provider: "zhipu",
    model: process.env.ZHIPU_MODEL || "glm-5.2",
    apiKey: process.env.ZHIPU_API_KEY,
    endpoint: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
    missingKeyMessage: "Zhipu API key is missing."
  };
}

function buildChatCompletionBody(config: ReportModelConfig, prompt: string) {
  return {
    model: config.model,
    messages: [
      {
        role: "system",
        content:
          "You are Product Agent, a senior software founder, product strategist, market researcher, UX critic, copywriter, and go-to-market advisor. Return only valid json. Write all user-facing report fields in Simplified Chinese, while keeping product/reference names in their original language. Diagnose product-internal problems and assess product potential across customer pain, market pull, alternatives, differentiation, proof, distribution, trust, UX, and conversion. Be candid, specific, and constructive."
      },
      {
        role: "user",
        content: prompt
      }
    ],
    thinking: { type: "disabled" },
    temperature: 0.25,
    max_tokens: 5000,
    response_format: { type: "json_object" }
  };
}

function providerName(provider: ReportModelProvider) {
  if (provider === "zhipu") return "Zhipu";
  return "DeepSeek";
}

function buildPrompt(input: GenerateReportInput) {
  const variant = getVariant(input.productVariant);
  const metrics = input.imageMetrics
    ? JSON.stringify(input.imageMetrics, null, 2)
    : "No image metrics were available.";
  const references = referenceLibrary
    .map(
      (item) =>
        `- ${item.name} (${item.category}) tags=${item.tags.join(", ")}: ${item.why}`
    )
    .join("\n");

  return `
Analyze the uploaded product materials and produce a Product Agent diagnosis report.

Language:
- All user-facing report fields must be written in Simplified Chinese.
- Keep product names, brand names, and reference names such as Linear or Stripe in their original language.

Product behavior:
- The user only provides materials and a short natural-language brief.
- The agent must infer work type, product goal, target user, current product problem, and next actions automatically.
- Do not ask the user to fill a form.

Important limitation:
- You cannot directly see the image pixels in this prompt.
- Use the user's supplied visible text and the local image metrics below.
- If visual certainty is limited, say so in limitations without making the report useless.
- Do not invent concrete visual details that are not supported by the inputs.

Interface mode:
- id: ${variant.id}
- tone: ${variant.tone}
- emphasis: ${variant.reportEmphasis}

User input:
- product name: ${input.productName || "Unknown"}
- inferred work type: ${input.workType}
- inferred intended feeling: ${input.targetFeeling || "Not specified"}
- original user brief:
${input.brief || input.visibleText || "Not supplied"}

Material manifest:
${formatMaterials(input.materials)}

Observable agent workflow trace:
${formatTrace(input.agentTrace)}

External web research:
${formatWebResearch(input.webResearch)}

Evidence brief / claim ledger:
${formatEvidenceBrief(input.evidenceBrief)}

README / GitHub calibration:
${formatCalibrationContext(input.calibrationContext)}

Image metrics from browser canvas:
${metrics}

Reference / benchmark candidates:
${references}

Master product judgment framework:
1. Product thesis: What promise does the product make, for whom, in which situation?
2. Customer job: What progress is the user trying to make, and what do they use instead today?
3. Problem intensity: Is the problem frequent, painful, urgent, expensive, or identity-relevant?
4. Four product risks: value risk, usability risk, feasibility risk, viability/business risk.
5. Clarity and trust: Can a new user understand the product quickly, believe it, and know the next step?
6. Market and distribution fit: Is the target segment reachable, and does the launch message match the channel?
7. Craft and focus: Does the product remove noise, reveal the real value, and avoid unnecessary features?
8. Next action priority: What should the founder change first to learn fastest?

Product potential framework:
1. Pain intensity: Is the user job frequent, urgent, expensive, emotional, or identity-relevant?
2. Existing demand: Are people already searching, paying, hacking together workflows, or complaining?
3. Differentiation: Is there a sharp wedge against current alternatives?
4. Distribution: Can the founder reach the initial segment cheaply and repeatedly?
5. Trust and proof: Does the material show evidence, demos, user quotes, usage, revenue, retention, or credible expertise?
6. Feasibility: Can the promise be delivered with realistic data, model, engineering, and support constraints?
7. Learning velocity: What experiment would quickly prove or disprove the opportunity?

Return a valid json object matching this exact shape:
{
  "diagnosis_score": 0-100 integer,
  "potential_score": 0-100 integer,
  "potential_verdict": "one specific paragraph on whether this product is worth pursuing now and under what condition",
  "first_impression": "one specific paragraph",
  "diagnosis_tags": ["3-6 short diagnosis tags about positioning/copy/UX/trust/visual/conversion"],
  "market_evidence": [
    {
      "signal": "short signal name",
      "evidence": "specific evidence from README/materials/web research, or clearly mark as missing",
      "interpretation": "what this signal means for product potential"
    }
  ],
  "top_issues": [
    {
      "title": "specific issue",
      "why_it_matters": "why it hurts positioning, understanding, trust, activation, conversion, or product perception",
      "how_to_fix": "specific practical fix"
    }
  ],
  "references": [
    {
      "name": "reference name from the library when possible",
      "category": "category",
      "why_relevant": "why it matches this user's goal",
      "what_to_learn": "what to borrow concretely"
    }
  ],
  "actionable_suggestions": ["5-10 specific next actions across positioning, copy, UX, visual, trust, conversion, or launch"],
  "share_summary": {
    "current_style": "short label",
    "main_problem": "short phrase",
    "recommended_references": "Reference A + Reference B + Reference C",
    "one_line_diagnosis": "sharp but not insulting"
  },
  "limitations": ["short limitation notes"]
}

Rules:
- top_issues must contain 3-5 items.
- market_evidence must contain 3-6 items.
- references must contain 3-5 items.
- actionable_suggestions must contain 5-10 items.
- Be ${variant.tone === "sharp" ? "sharper and more memorable" : "clear and direct"}, but never shame the user.
- Avoid generic phrases like "make it clearer" unless you explain exactly what to change.
- Treat this as a product diagnosis, not only a visual review.
- Cover at least 5 of these dimensions when relevant: product potential, positioning, target user, user job, existing demand, alternatives, differentiation, value proposition, copy, UX flow, trust, visual expression, pricing/packaging, launch message, distribution, conversion.
- If visual material is missing but PDF content exists, focus on product positioning, value proposition, launch page narrative, proof points, and what visual assets are needed.
- If README content exists, treat it as the primary product source. Extract install/use case/API/demo links and assess whether the README would convince a real user.
- If README / GitHub calibration is available, obey its rules: do not over-credit README polish, do not use SaaS payment standards for developer libraries, check lifecycle drift, and keep GitHub adoption separate from payment/retention proof.
- If external web research has crawled pages or search results, use them as evidence. If search was skipped or sparse, say so in limitations and do not pretend market proof exists.
- Use Evidence Brief as the calibrated evidence layer. Do not treat model inference, uploaded marketing copy, or missing data as observed market fact.
- If Evidence Brief contains an evidence stop, potential_verdict must say the product needs the recommended validation experiment before a high-confidence build/stop/reposition decision.
- If Judge Agent verdict is present, obey it: do not exceed its confidence cap, do not write stronger than its allowed report strength, and only recommend decisions in its allowed_decisions list.
- Market evidence should separate observed facts, evidence interpretations, and missing evidence. Mention recency uncertainty when the evidence has unknown dates.
- Treat the workflow trace as observable tool evidence, not hidden reasoning.
- The user expects the agent to decide what to do next automatically. Do not ask them to fill a form; give direct diagnosis and next actions.
- Prioritize issues by founder learning speed and business impact, not by cosmetic preference.
- Avoid judging only the interface. Infer product-internal problems from the uploaded material.
`;
}

function formatMaterials(materials?: UploadedMaterial[]) {
  if (!materials?.length) return "No uploaded materials.";

  return materials
    .map(
      (item, index) =>
        `${index + 1}. ${item.name} (${item.type}, ${Math.round(item.size / 1024)}KB), url=${item.url}${
          item.textPreview
            ? `\n   extracted text preview: ${item.textPreview.slice(0, 1600)}`
            : ""
        }${
          item.extractedUrls?.length
            ? `\n   extracted URLs: ${item.extractedUrls.join(", ")}`
            : ""
        }`
    )
    .join("\n");
}

function formatWebResearch(webResearch?: WebResearchSummary) {
  if (!webResearch) return "No web research was available.";

  const executionById = new Map(
    webResearch.queryExecutions?.map((execution) => [execution.queryId, execution]) ?? []
  );
  const queryPlan = webResearch.queryPlan?.length
    ? webResearch.queryPlan
        .map(
          (item) => {
            const execution = executionById.get(item.id);
            return `${item.id}. [${item.intent}/${item.assumptionId}/P${item.priority}/${item.phase ?? "seed"}] status=${execution?.status ?? "planned"}, results=${execution?.resultCount ?? 0}. ${item.query}\n   why=${execution?.reason || item.rationale}\n   expected=${item.expectedEvidence}`;
          }
        )
        .join("\n")
    : webResearch.queries.map((query, index) => `${index + 1}. ${query}`).join("\n");
  const crawled = webResearch.crawled
    .map(
      (item, index) =>
        `${index + 1}. [crawled] ${item.title} ${item.url}\n   published=${item.publishedAt || "unknown"}; updated=${item.updatedAt || "unknown"}; date_source=${item.dateSource || "unknown"}\n   ${item.snippet.slice(0, 900)}`
    )
    .join("\n");
  const searchResults = webResearch.searchResults
    .map(
      (item, index) =>
        `${index + 1}. [search] ${item.title} ${item.url}\n   published=${item.publishedAt || "unknown"}; recency=${item.recencyBucket || "unknown"}\n   ${item.snippet.slice(0, 500)}`
    )
    .join("\n");
  const skipped = webResearch.skippedReasons.length
    ? `Skipped / limitations: ${webResearch.skippedReasons.join("; ")}`
    : "";
  const searchQuality = webResearch.searchQuality
    ? `Search provider quality: provider=${webResearch.searchQuality.provider}; score=${webResearch.searchQuality.qualityScore}; query_success=${webResearch.searchQuality.querySuccessRate}; url_coverage=${webResearch.searchQuality.urlCoverage}; date_coverage=${webResearch.searchQuality.dateCoverage}; opposition_result_ratio=${webResearch.searchQuality.oppositionResultRatio}; assumption_coverage=${webResearch.searchQuality.assumptionCoverage}; avg_snippet=${webResearch.searchQuality.averageSnippetLength}; warnings=${webResearch.searchQuality.warnings.join(" | ") || "none"}`
    : "Search provider quality: unavailable.";
  const judgeVerdict = webResearch.judgeVerdict
    ? [
        `Judge Agent verdict: status=${webResearch.judgeVerdict.status}; decision=${webResearch.judgeVerdict.decision}; allowed_strength=${webResearch.judgeVerdict.allowedReportStrength}; confidence_cap=${webResearch.judgeVerdict.confidenceCap}; allowed_decisions=${webResearch.judgeVerdict.allowedDecisions.join(", ")}`,
        `Judge summary: ${webResearch.judgeVerdict.summary}`,
        `Judge required actions: ${webResearch.judgeVerdict.requiredResearchActions.join(" | ") || "none"}`,
        `Judge reasons:\n${webResearch.judgeVerdict.reasons
          .slice(0, 8)
          .map(
            (reason) =>
              `- ${reason.severity}/${reason.category}: ${reason.finding}; evidence=${reason.evidence}; required=${reason.requiredAction}`
          )
          .join("\n") || "none"}`
      ].join("\n")
    : "Judge Agent verdict: unavailable.";
  const handoffBoundaries = webResearch.runtimeTrace?.handoffs?.length
    ? `Handoff boundaries:\n${webResearch.runtimeTrace.handoffs
        .slice(-4)
        .map((handoff, index) =>
          [
            `${index + 1}. ${handoff.from} -> ${handoff.to}: ${handoff.contextSummary}`,
            `   accepted_input=${handoff.acceptedInputSummary || "not specified"}`,
            `   key_findings=${handoff.keyFindings?.join(" | ") || "none"}`,
            `   uncertainties=${handoff.uncertainties?.join(" | ") || "none"}`,
            `   forbidden_claims=${handoff.forbiddenClaims?.join(" | ") || "none"}`,
            `   context_budget=summary ${handoff.contextBudget?.usedSummaryChars ?? 0}/${handoff.contextBudget?.maxSummaryChars ?? 0}, artifacts ${handoff.contextBudget?.usedArtifactRefs ?? 0}/${handoff.contextBudget?.maxArtifactRefs ?? 0}, evidence ${handoff.contextBudget?.usedEvidenceRefs ?? 0}/${handoff.contextBudget?.maxEvidenceRefs ?? 0}; dropped=${handoff.contextBudget?.droppedContextSummary || "none"}`
          ].join("\n")
        )
        .join("\n")}`
    : "Handoff boundaries: unavailable.";

  return [
    "Context boundary: Web research content below is bounded evidence summary/citation refs only, not raw webpage/PDF/README body. Do not treat it as complete source text.",
    judgeVerdict,
    handoffBoundaries,
    searchQuality,
    queryPlan ? `Query plan:\n${queryPlan}` : "Query plan: none",
    `Extracted URLs: ${webResearch.extractedUrls.join(", ") || "none"}`,
    `Search queries: ${webResearch.queries.join(" | ") || "none"}`,
    crawled ? `Crawled pages:\n${crawled}` : "Crawled pages: none",
    searchResults ? `Search results:\n${searchResults}` : "Search results: none",
    skipped
  ]
    .filter(Boolean)
    .join("\n");
}

function formatEvidenceBrief(evidenceBrief?: EvidenceBrief) {
  if (!evidenceBrief) return "No Evidence Brief was generated.";

  const claims = evidenceBrief.claimLedger.claims
    .map(
      (claim) =>
        `- ${claim.id}: ${claim.status}, confidence=${claim.confidence}, temporal=${claim.temporalValidityScore}. ${claim.text}\n  support=${claim.supportEvidenceIds.join(", ") || "none"}; oppose=${claim.opposeEvidenceIds.join(", ") || "none"}\n  change-if=${claim.whatWouldChangeThisClaim.join(" | ")}`
    )
    .join("\n");
  const support = evidenceBrief.strongestSupport
    .slice(0, 4)
    .map(
      (card) =>
        `- ${card.id}: ${card.claim} [${card.sourceType}, objective=${card.objectiveLevel}, recency=${card.recencyBucket}, confidence=${card.confidence}] ${card.sourceTitle} ${card.sourceUrl}\n  snippet=${card.quoteOrSnippet.slice(0, 280)}\n  caveat=${card.caveat}`
    )
    .join("\n");
  const opposition = evidenceBrief.strongestOpposition
    .slice(0, 4)
    .map(
      (card) =>
        `- ${card.id}: ${card.claim} [${card.sourceType}, objective=${card.objectiveLevel}, recency=${card.recencyBucket}, confidence=${card.confidence}] ${card.sourceTitle} ${card.sourceUrl}\n  snippet=${card.quoteOrSnippet.slice(0, 280)}\n  caveat=${card.caveat}`
    )
    .join("\n");
  const gaps = evidenceBrief.evidenceGaps
    .map(
      (gap) =>
        `- ${gap.assumptionId}: missing=${gap.missingEvidence}; why=${gap.whyItMatters}; experiment=${gap.recommendedExperimentType}; gain=${gap.expectedConfidenceGain}`
    )
    .join("\n");
  const budgets = evidenceBrief.sourceBudgets
    .map(
      (budget) =>
        `- ${budget.label} (${budget.assumptionId}): status=${budget.status}; support=${budget.currentSupport}/${budget.requiredSupport}; opposition=${budget.currentOpposition}/${budget.requiredOpposition}; neutral=${budget.currentNeutral}; planned_queries=${budget.plannedQueryIds.join(", ") || "none"}; missing=${budget.missingEvidence.join(" | ") || "none"}`
    )
    .join("\n");
  const stop = evidenceBrief.evidenceStop
    ? `Evidence stop: ${evidenceBrief.evidenceStop.reason}. Blocked decisions=${(evidenceBrief.evidenceStop.blockedDecisions || [evidenceBrief.evidenceStop.blockedDecision]).join(", ")}. Allowed decision=${evidenceBrief.evidenceStop.allowedDecision}. Minimum needed=${evidenceBrief.evidenceStop.minimumEvidenceNeeded.join(" | ")}\nStop rules:\n${formatStopRules(evidenceBrief.evidenceStop.ruleResults)}`
    : "Evidence stop: none.";
  const lifecycleStandard = evidenceBrief.lifecycleEvidenceStandard
    ? [
        `Lifecycle evidence standard: ${evidenceBrief.lifecycleEvidenceStandard.label}`,
        `goal=${evidenceBrief.lifecycleEvidenceStandard.evidenceGoal}`,
        `required_external=${evidenceBrief.lifecycleEvidenceStandard.requiredExternalEvidence}; required_total=${evidenceBrief.lifecycleEvidenceStandard.requiredTotalEvidence}; required_opposition=${evidenceBrief.lifecycleEvidenceStandard.requiredOpposition}; required_fresh_web=${evidenceBrief.lifecycleEvidenceStandard.requiredFreshWebEvidence}`,
        `behavior_threshold=${evidenceBrief.lifecycleEvidenceStandard.minimumBehaviorStrength}; behavior_cards=${evidenceBrief.lifecycleEvidenceStandard.requiredStrongBehaviorCards}`,
        `required_budgets=${evidenceBrief.lifecycleEvidenceStandard.requiredSourceBudgets.join(", ")}`,
        `required_evidence=${evidenceBrief.lifecycleEvidenceStandard.requiredEvidenceTypes.join(" | ")}`,
        `decision_rule=${evidenceBrief.lifecycleEvidenceStandard.decisionRule}`
      ].join("\n")
    : "Lifecycle evidence standard: unavailable.";

  return [
    `Product lifecycle stage: ${evidenceBrief.productLifecycleStage}`,
    lifecycleStandard,
    `Evidence verdict: ${evidenceBrief.evidenceVerdict}`,
    `Decision: ${evidenceBrief.decision.decision}, confidence=${evidenceBrief.decision.confidence}, next=${evidenceBrief.decision.nextMilestone}`,
    `Scores: confidence=${evidenceBrief.confidenceScore}, support=${evidenceBrief.supportScore}, opposition=${evidenceBrief.oppositionScore}, objective_ratio=${evidenceBrief.objectiveEvidenceRatio}, current_ratio=${evidenceBrief.currentEvidenceRatio}, temporal=${evidenceBrief.temporalValidityScore}, assumption_coverage=${evidenceBrief.assumptionCoverageScore}, source_budget=${evidenceBrief.sourceBudgetScore}`,
    stop,
    `Claim Ledger:\n${claims || "none"}`,
    `Source Budgets:\n${budgets || "none"}`,
    `Strongest support:\n${support || "none"}`,
    `Strongest opposition:\n${opposition || "none"}`,
    `Evidence gaps:\n${gaps || "none"}`,
    formatRecommendedExperiment(evidenceBrief.recommendedExperiment)
  ].join("\n");
}

function formatCalibrationContext(context?: ProductAnalysisCalibrationContext) {
  if (!context) {
    return "No README/GitHub backtest calibration applies to this analysis.";
  }

  const rules = context.rules
    .map(
      (rule) =>
        `- ${rule.title} [${rule.priority}]: ${rule.summary}\n  agent_rule=${rule.agentRule}`
    )
    .join("\n");
  const signals = context.signalCalibrations.length
    ? context.signalCalibrations
        .map(
          (signal) =>
            `- ${signal.label}: verdict=${signal.verdict}; samples=${signal.sampleCount}; avg_delta=${signal.averageDelta}; lesson=${signal.lesson}`
        )
        .join("\n")
    : "none";
  const failures = context.failurePatternSummaries.length
    ? context.failurePatternSummaries.map((item) => `- ${item}`).join("\n")
    : "none";
  const calibrationActions = context.actions ?? [];
  const actions = calibrationActions.length
    ? calibrationActions
        .map(
          (action) =>
            `- ${action.target}: action=${action.action}; confidence=${action.confidence}; samples=${action.sampleCount}; needed=${action.neededSamples}; avg_delta=${action.averageDelta ?? "unknown"}; adjustment=${action.recommendedAdjustment}; reason=${action.reason}; next=${action.nextStep}`
        )
        .join("\n")
    : "none";

  return [
    `Applies to: ${context.appliesTo}`,
    `Reason: ${context.reason}`,
    `Calibration sample count: static=${context.staticSampleCount}; dynamic=${context.dynamicSampleCount}; completed_dynamic=${context.completedDynamicCount}; failed_dynamic=${context.failedDynamicCount}; avg_abs_delta=${context.averageAbsoluteDelta ?? "unknown"}; aligned_rate=${context.alignedRate ?? "unknown"}`,
    `Rules:\n${rules || "none"}`,
    `Dynamic signal calibration:\n${signals}`,
    `Calibration actions:\n${actions}`,
    `Failure patterns:\n${failures}`,
    `Limitations: ${context.limitations.join(" | ")}`
  ].join("\n");
}

function formatRecommendedExperiment(experiment: ValidationExperiment) {
  return [
    `Recommended experiment: ${experiment.title}; id=${experiment.id || "unknown"}; assumption=${experiment.assumptionId || "unknown"}; status=${experiment.status || "planned"}`,
    `hypothesis=${experiment.hypothesis}`,
    `primary_metric=${experiment.primaryMetric ? `${experiment.primaryMetric.name}, target=${experiment.primaryMetric.target}, failure=${experiment.primaryMetric.failureThreshold}` : "none"}`,
    `success=${experiment.successMetric}; failure=${experiment.failureMetric}; sample=${experiment.sampleSize}; time=${experiment.timeRequired}; cost=${experiment.costLevel}`,
    `evidence_to_collect=${experiment.evidenceToCollect?.join(" | ") || "none"}`,
    `result_schema_required=${experiment.resultSchema?.requiredFields.join(" | ") || "none"}`,
    experiment.decisionRules
      ? `decision_rules=validated: ${experiment.decisionRules.validated}; inconclusive: ${experiment.decisionRules.inconclusive}; invalidated: ${experiment.decisionRules.invalidated}`
      : "decision_rules=none"
  ].join("\n");
}

function formatStopRules(rules?: EvidenceStopRule[]) {
  if (!Array.isArray(rules) || !rules.length) return "none";
  return rules
    .map(
      (rule) =>
        `- ${rule.label}: ${rule.status}, score=${rule.score}. ${rule.reason}; minimum=${rule.minimumEvidenceNeeded.join(" | ") || "none"}`
    )
    .join("\n");
}

function formatTrace(trace?: AgentTraceStep[]) {
  if (!trace?.length) return "No workflow trace.";

  return trace
    .map(
      (step) =>
        `- ${step.title}: ${step.summary}. Tools: ${step.toolCalls
          .map((tool) => `${tool.toolName} -> ${tool.outputSummary}`)
          .join("; ")}`
    )
    .join("\n");
}

function parseJsonObject(content: string) {
  const cleaned = content
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error("No JSON object found.");
    }

    try {
      return JSON.parse(match[0]);
    } catch {
      const repaired = match[0].replace(/[\u0000-\u001f\u007f]/g, " ");
      return JSON.parse(repaired);
    }
  }
}

function normalizeReport(
  report: ProductDiagnosisReport
): ProductDiagnosisReport {
  return {
    ...report,
    diagnosis_score: Math.max(
      0,
      Math.min(100, Math.round(report.diagnosis_score))
    ),
    potential_score: Math.max(
      0,
      Math.min(100, Math.round(report.potential_score))
    ),
    diagnosis_tags: report.diagnosis_tags.slice(0, 6),
    market_evidence: report.market_evidence.slice(0, 6),
    top_issues: report.top_issues.slice(0, 5),
    references: report.references.slice(0, 5),
    actionable_suggestions: report.actionable_suggestions.slice(0, 10),
    limitations: report.limitations || []
  };
}

function fallbackReport(
  input: GenerateReportInput,
  reason: string
): ProductDiagnosisReport {
  const palette = input.imageMetrics?.dominantColors?.join(" / ") || "unknown";
  const brightness = input.imageMetrics
    ? Math.round(input.imageMetrics.brightness)
    : null;

  return {
    diagnosis_score: 58,
    potential_score: 48,
    potential_verdict:
      input.evidenceBrief?.evidenceStop
        ? `当前证据不足以高置信判断是否值得直接 build，应该先做「${input.evidenceBrief.recommendedExperiment.title}」。阻断原因：${input.evidenceBrief.evidenceStop.reason}。`
        : "当前只能判断为有早期探索价值，但还不能证明有强产品潜力。材料里需要补足目标用户的强痛点、替代方案、真实使用证据和可触达渠道，否则继续投入容易变成只优化表达而没有验证需求。",
    first_impression:
      "这份报告使用已上传材料和本地解析结果生成，因为模型调用没有成功。当前产品可以先从定位、价值主张、可信证据、用户路径和发布表达五件事入手，不要急着做大改版。",
    diagnosis_tags: ["定位待收敛", "价值表达需加强", "可快速改进"],
    market_evidence: [
      {
        signal: "用户任务",
        evidence: "已上传材料中有产品说明，但用户任务和触发场景还不够具体。",
        interpretation: "如果不能说清用户何时必须使用它，潜力判断会偏弱。"
      },
      {
        signal: "市场证据",
        evidence: input.evidenceBrief
          ? `Evidence Brief 置信度 ${input.evidenceBrief.confidenceScore}/100，客观证据占比 ${input.evidenceBrief.objectiveEvidenceRatio}%，当前证据占比 ${input.evidenceBrief.currentEvidenceRatio}%。`
          : input.materials?.some((item) => item.extractedUrls?.length)
          ? "README 中包含外部链接，可继续抓取官网、文档或发布页补证据。"
          : "材料中没有足够外部链接或真实市场反馈。",
        interpretation: input.evidenceBrief?.evidenceStop
          ? "证据停止规则已触发，下一步应先补行为证据和反证。"
          : "下一步应找真实用户评论、替代方案讨论、等待名单或付费信号。"
      },
      {
        signal: "分发路径",
        evidence: "当前材料没有稳定获客路径和首批用户来源。",
        interpretation: "产品潜力不仅取决于功能，还取决于能否低成本触达一个窄人群。"
      }
    ],
    top_issues: [
      {
        title: "材料信息还没有形成清晰产品主张",
        why_it_matters:
          "用户第一次接触产品时，需要立刻知道它帮谁解决什么问题，否则后续视觉和功能展示都会失去抓手。",
        how_to_fix:
          "把产品介绍压缩成一句话：目标用户 + 高频痛点 + 独特解决方式 + 结果收益。"
      },
      {
        title: "缺少能建立信任的证据链",
        why_it_matters:
          "产品内问题往往不是功能不够，而是用户看不到为什么现在该相信你、为什么值得继续看或付费。",
        how_to_fix:
          "补充 2-3 个证据模块，例如具体使用场景、结果指标、用户评价、安全承诺、真实界面或案例。"
      },
      {
        title: "用户路径需要一个明确下一步",
        why_it_matters:
          "如果材料里同时讲概念、功能和愿景，但没有明确下一步，用户会理解产品却不行动。",
        how_to_fix:
          "把核心 CTA 绑定到一个具体动作，例如上传材料、生成第一份报告、创建第一个项目或预约演示。"
      }
    ],
    references: [
      {
        name: "Linear",
        category: "SaaS product",
        why_relevant:
          "适合学习开发者和 AI 工具如何用克制视觉建立可信感。",
        what_to_learn: "借鉴它的空间节奏、界面截图呈现方式和清晰的信息层级。"
      },
      {
        name: "Stripe",
        category: "SaaS product",
        why_relevant:
          "适合学习复杂能力如何被包装成可信、可购买的商业表达。",
        what_to_learn: "把功能描述翻译成用户收益，并让 CTA 周围信息更少。"
      },
      {
        name: "Teenage Engineering",
        category: "Industrial design",
        why_relevant:
          "适合学习少量元素如何形成鲜明记忆点，而不是堆叠装饰。",
        what_to_learn: "减少颜色和组件数量，让一个独特细节成为视觉锚点。"
      }
    ],
    actionable_suggestions: [
      "把产品一句话重写成：给谁、解决什么、为什么现在需要、结果是什么。",
      `如果材料包含视觉页面，当前提取到的主色约为 ${palette}，先把主色控制在 1 个强调色和 2 个中性色内。`,
      brightness === null
        ? "补充真实页面截图或产品流程图，让 Agent 能同时判断产品表达和界面路径。"
        : `当前平均亮度约为 ${brightness}/255，检查文字和背景是否有足够对比。`,
      "列出目标用户进入产品后的前三步，检查每一步是否有明确收益。",
      "补充信任证据：真实界面、数据、用户评价、安全承诺或创始人背景。",
      "把发布文案和产品页首屏统一成同一个核心主张。"
    ],
    share_summary: {
      current_style: "早期产品表达",
      main_problem: "定位、证据和行动路径还不够清楚",
      recommended_references: "Linear + Stripe + Teenage Engineering",
      one_line_diagnosis: "产品方向已经有了，但还需要把价值、信任和下一步讲得更硬。"
    },
    limitations: [
      "DeepSeek 调用失败或输出不可用，已使用本地 fallback 报告。",
      reason
    ]
  };
}

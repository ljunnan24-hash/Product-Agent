export type ProductVariantId =
  | "roast"
  | "coach"
  | "reference-finder"
  | "redesign-advisor";

export type WorkType =
  | "landing_page"
  | "app_screen"
  | "brand_visual"
  | "poster_social"
  | "ai_image"
  | "pitch_deck"
  | "product_brief_pdf"
  | "readme"
  | "other";

export type ImageMetrics = {
  width: number;
  height: number;
  aspectRatio: number;
  brightness: number;
  contrast: number;
  saturation: number;
  edgeDensity: number;
  dominantColors: string[];
  colorCount: number;
};

export type UploadedMaterial = {
  id: string;
  name: string;
  type: string;
  size: number;
  url: string;
  sourceKind?: "uploaded_material" | "github_readme";
  metrics: ImageMetrics | null;
  extractedText?: string;
  textPreview?: string;
  pageCount?: number;
  extractedUrls?: string[];
};

export type AgentStage =
  | "intake"
  | "readme_reader"
  | "pdf_reader"
  | "material_observer"
  | "product_thesis"
  | "evidence_agent"
  | "web_research"
  | "customer_job"
  | "risk_review"
  | "ux_trust_review"
  | "market_fit_review"
  | "potential_assessment"
  | "reference_curator"
  | "priority_planner"
  | "report_composer"
  | "quality_gate"
  | "follow_up";

export type AgentToolCall = {
  id: string;
  stage: AgentStage;
  toolName: string;
  status: "completed" | "failed" | "skipped";
  inputSummary: string;
  outputSummary: string;
  latencyMs: number;
};

export type AgentTraceStep = {
  stage: AgentStage;
  title: string;
  status: "completed" | "failed" | "skipped";
  summary: string;
  toolCalls: AgentToolCall[];
};

export type AnalysisFollowUpStep = {
  title: string;
  status: "completed" | "failed" | "skipped";
  summary: string;
};

export type AnalysisFollowUpTurn = {
  id: string;
  createdAt: string;
  evidenceAppliedAt?: string;
  evidenceCardIds?: string[];
  confidenceBefore?: number;
  confidenceAfter?: number;
  decisionBefore?: ProductDecision["decision"];
  decisionAfter?: ProductDecision["decision"];
  userMessage: string;
  materials: UploadedMaterial[];
  response: string;
  evidenceRefs: string[];
  suggestedActions: string[];
  confidenceNote: string;
  visibleSteps: AnalysisFollowUpStep[];
};

export type ProductDiagnosisIssue = {
  title: string;
  why_it_matters: string;
  how_to_fix: string;
};

export type ProductDiagnosisReference = {
  name: string;
  category: string;
  why_relevant: string;
  what_to_learn: string;
};

export type ProductEvidenceSignal = {
  signal: string;
  evidence: string;
  interpretation: string;
};

export type EvidenceSearchIntent =
  | "problem"
  | "payment"
  | "alternative"
  | "competitor_review"
  | "distribution"
  | "opposition"
  | "recency"
  | "ai_advantage";

export type EvidenceSearchPhase = "seed" | "budget_fill" | "evidence_loop";
export type EvidenceSearchTarget = "support" | "opposition" | "freshness" | "context";
export type WebSearchProvider = "serper" | "zhipu";

export type EvidenceSearchQuery = {
  id: string;
  assumptionId: string;
  intent: EvidenceSearchIntent;
  phase?: EvidenceSearchPhase;
  targetDirection?: EvidenceSearchTarget;
  query: string;
  rationale: string;
  expectedEvidence: string;
  priority: 1 | 2 | 3;
};

export type EvidenceQueryExecution = {
  queryId: string;
  provider?: WebSearchProvider;
  status: "planned" | "executed" | "skipped" | "failed";
  phase: EvidenceSearchPhase;
  resultCount: number;
  reason?: string;
};

export type WebEvidence = {
  title: string;
  url: string;
  sourceType: "crawled_url" | "search_result" | "github_repository";
  searchProvider?: WebSearchProvider;
  sourceName?: string;
  snippet: string;
  queryId?: string;
  assumptionId?: string;
  searchIntent?: EvidenceSearchIntent;
  searchPhase?: EvidenceSearchPhase;
  searchTarget?: EvidenceSearchTarget;
  publishedAt?: string;
  updatedAt?: string;
  dateSource?: string;
  recencyBucket?: EvidenceRecencyBucket;
};

export type SearchProviderQuality = {
  provider: WebSearchProvider;
  qualityScore: number;
  plannedQueries: number;
  executedQueries: number;
  failedQueries: number;
  skippedQueries: number;
  totalResults: number;
  querySuccessRate: number;
  urlCoverage: number;
  dateCoverage: number;
  freshResultRatio: number;
  oppositionResultRatio: number;
  assumptionCoverage: number;
  averageSnippetLength: number;
  warnings: string[];
};

export type EvidenceResearchLoop = {
  id: string;
  round: number;
  status: "executed" | "skipped" | "failed" | "stopped";
  startedAt: string;
  completedAt: string;
  trigger: string;
  reason: string;
  targetAssumptionIds: string[];
  queryIds: string[];
  resultCount: number;
  beforeConfidence: number;
  afterConfidence?: number;
  beforeDecision: ProductDecision["decision"];
  afterDecision?: ProductDecision["decision"];
  remainingGaps: string[];
  stopCondition: string;
};

export type WebResearchSummary = {
  extractedUrls: string[];
  crawled: WebEvidence[];
  searchResults: WebEvidence[];
  skippedReasons: string[];
  queries: string[];
  searchProvider?: WebSearchProvider;
  searchQuality?: SearchProviderQuality;
  queryPlan?: EvidenceSearchQuery[];
  queryExecutions?: EvidenceQueryExecution[];
  researchLoops?: EvidenceResearchLoop[];
  runtimeTrace?: AgentRuntimeTrace;
  judgeVerdict?: AgentJudgeVerdict;
};

export type AgentRuntimeSubagentId =
  | "research_supervisor"
  | "material_reader"
  | "query_planner"
  | "support_search_worker"
  | "search_worker"
  | "web_fetch_worker"
  | "evidence_extractor"
  | "opposition_scout"
  | "freshness_worker"
  | "competitor_worker"
  | "code_executor"
  | "judge_agent"
  | "report_composer";

export type AgentRuntimeArtifactKind =
  | "handoff_packet"
  | "worker_context"
  | "worker_transcript"
  | "query_plan"
  | "search_results"
  | "webpage_snapshot"
  | "evidence_cards"
  | "judge_report"
  | "model_report"
  | "code_execution_result"
  | "source_budget"
  | "run_summary"
  | "failure_report";

export type AgentRuntimeArtifact = {
  id: string;
  kind: AgentRuntimeArtifactKind;
  owner: AgentRuntimeSubagentId;
  title: string;
  summary: string;
  createdAt: string;
  storageRef?: string;
  byteSize?: number;
  itemCount?: number;
  preview?: string;
};

export type AgentHandoffContextBudget = {
  maxSummaryChars: number;
  maxArtifactRefs: number;
  maxEvidenceRefs: number;
  usedSummaryChars: number;
  usedArtifactRefs: number;
  usedEvidenceRefs: number;
  droppedContextSummary: string;
};

export type AgentHandoffPacket = {
  id: string;
  from: AgentRuntimeSubagentId;
  to: AgentRuntimeSubagentId | "main_agent";
  goal: string;
  contextSummary: string;
  artifactIds: string[];
  sourceArtifactIds?: string[];
  evidenceRefs: string[];
  openQuestions: string[];
  nextActions: string[];
  acceptedInputSummary?: string;
  keyFindings?: string[];
  uncertainties?: string[];
  forbiddenClaims?: string[];
  contextBudget?: AgentHandoffContextBudget;
  createdAt: string;
};

export type AgentWorkerTool =
  | "query_plan"
  | "web_search"
  | "web_fetch"
  | "evidence_extract"
  | "judge"
  | "model_report"
  | "handoff"
  | "github_import"
  | "file_read"
  | "pdf_extract"
  | "ocr"
  | "code_execute"
  | "follow_up";

export type AgentSubagentMemoryScope =
  | "run_checkpoint"
  | "product_memory"
  | "calibration_memory"
  | "procedural_memory";

export type AgentWorkerBudget = {
  maxToolCalls?: number;
  maxSearchQueries?: number;
  maxFetchUrls?: number;
  maxArtifacts?: number;
  maxOutputChars?: number;
  timeoutMs?: number;
};

export type AgentWorkerBudgetUsed = {
  toolCalls: number;
  searchQueries: number;
  fetchUrls: number;
  artifacts: number;
  outputChars: number;
};

export type AgentWorkerDefinition = {
  id: string;
  label: string;
  subagent: AgentRuntimeSubagentId;
  role: string;
  allowedTools: AgentWorkerTool[];
  inputSchema: string;
  outputSchema: string;
  budget: AgentWorkerBudget;
  maxAttempts: number;
};

export type AgentWorkerRegistryLink = {
  registryVersion: "subagent-registry-v1";
  workerId: string;
  subagent: AgentRuntimeSubagentId;
  modelProvider: "deterministic" | "zhipu" | "deepseek" | "local" | "external" | "auto";
  memoryScopes: AgentSubagentMemoryScope[];
  writableArtifactKinds: AgentRuntimeArtifactKind[];
  evaluationMetrics: string[];
  securityNotes: string[];
};

export type AgentWorkerContextBudget = {
  maxInputChars: number;
  usedInputChars: number;
  maxArtifactRefs: number;
  usedArtifactRefs: number;
  maxOutputChars?: number;
  droppedInputSummary: string;
};

export type AgentContextBoundaryEnforcement = {
  version: "context-boundary-v1";
  mode: "hard";
  status: "pass" | "compacted" | "violation";
  rawInputChars: number;
  acceptedInputChars: number;
  rawPayloadChars: number;
  acceptedPayloadChars: number;
  omittedPayloadChars: number;
  rawArtifactRefs: number;
  acceptedArtifactRefs: number;
  droppedArtifactRefs: number;
  rules: string[];
  compactedReasons: string[];
  violations: string[];
  forbiddenDirectInputKinds: string[];
};

export type AgentContextPackPolicy = {
  id: string;
  label: string;
  maxInputChars: number;
  maxArtifactRefs: number;
  payloadPreviewChars: number;
  compressionStrategy: string;
  defaultForbiddenInputs: string[];
  defaultIsolationNotes: string[];
};

export type AgentContextPack = {
  id: string;
  policyId: string;
  workerId: string;
  workerLabel: string;
  subagent: AgentRuntimeSubagentId;
  taskNodeId?: string;
  parentSpanId?: string;
  idempotencyKey?: string;
  createdAt: string;
  acceptedInputSummary: string;
  inputSummary: string;
  inputArtifactIds: string[];
  droppedInputArtifactIds: string[];
  modelProvider: AgentWorkerExecutionBoundary["modelProvider"];
  allowedTools: AgentWorkerTool[];
  inputSchema: string;
  outputSchema: string;
  contextBudget: AgentWorkerContextBudget;
  boundaryEnforcement: AgentContextBoundaryEnforcement;
  forbiddenInputs: string[];
  isolationNotes: string[];
  compressionStrategy: string;
  payloadPreview?: string;
  payloadStats: {
    rawChars: number;
    previewChars: number;
    omittedChars: number;
  };
  warnings: string[];
};

export type AgentWorkerExecutionBoundary = {
  mode: "isolated_worker";
  modelProvider: "deterministic" | "zhipu" | "deepseek" | "local" | "external";
  contextPackId?: string;
  systemPrompt: string;
  inputSchema: string;
  outputSchema: string;
  allowedTools: AgentWorkerTool[];
  inputArtifactIds: string[];
  droppedInputArtifactIds?: string[];
  boundaryArtifactId?: string;
  acceptedInputSummary: string;
  forbiddenInputs: string[];
  isolationNotes: string[];
  compressionStrategy?: string;
  contextWarnings?: string[];
  boundaryEnforcement?: AgentContextBoundaryEnforcement;
  contextBudget: AgentWorkerContextBudget;
  resumeStrategy: string;
};

export type AgentWorkerFailureCode =
  | "missing_provider_key"
  | "input_guardrail_blocked"
  | "tool_failed"
  | "tool_skipped"
  | "timeout"
  | "budget_exceeded"
  | "schema_invalid"
  | "network_error"
  | "provider_error"
  | "no_results"
  | "user_input_required"
  | "unknown";

export type AgentWorkerExecutionMode = "inline_manual" | "subagent_runner";

export type AgentWorkerTranscriptEvent = {
  id: string;
  at: string;
  type:
    | "worker_start"
    | "boundary"
    | "tool_call"
    | "artifact"
    | "handoff"
    | "budget_warning"
    | "worker_complete"
    | "worker_skip"
    | "worker_fail";
  summary: string;
  refs?: string[];
  metadata?: Record<string, string | number | boolean>;
};

export type AgentWorkerRun = {
  id: string;
  workerId: string;
  workerLabel: string;
  subagent: AgentRuntimeSubagentId;
  taskNodeId?: string;
  status: "running" | "completed" | "failed" | "skipped";
  startedAt: string;
  completedAt?: string;
  latencyMs?: number;
  attempt: number;
  maxAttempts: number;
  parentSpanId?: string;
  idempotencyKey?: string;
  runnerVersion?: string;
  executionMode?: AgentWorkerExecutionMode;
  inputSummary: string;
  outputSummary?: string;
  artifactIds: string[];
  handoffId?: string;
  errorMessage?: string;
  failureCode?: AgentWorkerFailureCode;
  transcriptArtifactId?: string;
  budgetWarnings?: string[];
  budget: AgentWorkerBudget;
  budgetUsed: AgentWorkerBudgetUsed;
  executionBoundary?: AgentWorkerExecutionBoundary;
};

export type AgentRuntimeToolId =
  | "query_plan"
  | "web_search"
  | "web_fetch"
  | "evidence_extract"
  | "judge"
  | "handoff"
  | "model_report"
  | "github_import"
  | "file_read"
  | "pdf_extract"
  | "ocr"
  | "code_execute"
  | "follow_up";

export type AgentToolRiskLevel = "low" | "medium" | "high";

export type AgentToolRetryPolicy = {
  maxAttempts: number;
  backoffMs: number;
  retryableErrors: string[];
};

export type AgentToolPolicy = {
  id: AgentRuntimeToolId;
  label: string;
  inputSchema: string;
  outputSchema: string;
  riskLevel: AgentToolRiskLevel;
  costUnit: "free" | "request" | "query" | "url" | "token";
  estimatedCostPerCall?: number;
  timeoutMs: number;
  retryPolicy: AgentToolRetryPolicy;
  guardrails: string[];
};

export type AgentToolGuardrailResult = {
  id: string;
  label: string;
  status: "pass" | "warn" | "block";
  message: string;
};

export type AgentRuntimeToolCall = {
  id: string;
  toolId: AgentRuntimeToolId;
  toolLabel: string;
  taskNodeId?: string;
  status: "running" | "completed" | "failed" | "skipped" | "blocked";
  startedAt: string;
  completedAt?: string;
  latencyMs?: number;
  parentSpanId?: string;
  workerRunId?: string;
  provider?: WebSearchProvider | "local" | "model";
  inputSummary: string;
  outputSummary?: string;
  artifactIds: string[];
  riskLevel: AgentToolRiskLevel;
  costUnit: AgentToolPolicy["costUnit"];
  costEstimate?: number;
  timeoutMs: number;
  retryPolicy: AgentToolRetryPolicy;
  guardrails: AgentToolGuardrailResult[];
  idempotencyKey?: string;
  cacheKey?: string;
  cacheStatus?: "hit" | "miss" | "stored" | "bypass";
  cacheRef?: string;
  errorMessage?: string;
};

export type AgentRetryTarget = {
  id: string;
  kind: "worker_run" | "tool_call";
  status: "failed" | "skipped" | "blocked";
  label: string;
  reason: string;
  retryable: boolean;
  retryAction: "retry_worker" | "retry_tool" | "provide_key" | "provide_evidence" | "review_guardrail";
  requiredFixes: string[];
  workerRunId?: string;
  toolCallId?: string;
  failureCode?: AgentWorkerFailureCode;
  parentSpanId?: string;
  idempotencyKey?: string;
  cacheKey?: string;
  cacheStatus?: AgentRuntimeToolCall["cacheStatus"];
  inputArtifactIds: string[];
  outputArtifactIds: string[];
  resumeHint: string;
};

export type AgentResumePlan = {
  generatedAt: string;
  status: "ready" | "no_retry_needed";
  targetCount: number;
  retryableCount: number;
  cacheableCount: number;
  targets: AgentRetryTarget[];
};

export type AgentRuntimeResumeAction =
  | "queue_retry"
  | "mark_reviewed"
  | "skip_until_configured";

export type AgentRuntimeResumeRequest = {
  id: string;
  traceId: string;
  createdAt: string;
  updatedAt: string;
  action: AgentRuntimeResumeAction;
  status: "queued" | "applied" | "blocked" | "unsupported";
  executionMode: "control_plane_only" | "auto_replay";
  targetId: string;
  targetKind: AgentRetryTarget["kind"] | "task_node";
  targetStatus: AgentRetryTarget["status"] | AgentTaskNodeStatus;
  label: string;
  reason: string;
  requestedBy: "user" | "system";
  note?: string;
  retryAction?: AgentRetryTarget["retryAction"];
  retryable: boolean;
  requiredFixes: string[];
  workerRunId?: string;
  toolCallId?: string;
  taskNodeId?: string;
  artifactIds: string[];
  resultSummary: string;
  limitations: string[];
  impact?: AgentRuntimeResumeImpact;
};

export type AgentRuntimeResumeImpact = {
  replayScope:
    | "control_plane"
    | "worker"
    | "task_node"
    | "evidence_extract"
    | "terminal";
  sourceTargetId: string;
  sourceTaskNodeId?: string;
  replayedTaskNodeIds: string[];
  replayedWorkerRunIds: string[];
  replayedToolCallIds: string[];
  durableQueueRecordIds: string[];
  downstreamTaskNodeIds: string[];
  recomputed:
    | Array<
        | "web_research"
        | "evidence_brief"
        | "judge"
        | "report"
        | "report_evidence_bindings"
        | "report_quality"
        | "evidence_handoff"
        | "code_execution"
      >;
  artifactIds: string[];
  notes: string[];
};

export type AgentWorkerQueueItemStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "skipped"
  | "cancelled";

export type AgentWorkerQueueItem = {
  id: string;
  durableQueueId?: string;
  durableInputRef?: string;
  queueLabel: string;
  workerId: string;
  workerLabel: string;
  taskNodeId?: string;
  parentSpanId?: string;
  workerRunId?: string;
  status: AgentWorkerQueueItemStatus;
  priority: number;
  concurrencyGroup: string;
  enqueuedAt: string;
  startedAt?: string;
  completedAt?: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  attempt?: number;
  maxAttempts?: number;
  cancelRequestedAt?: string;
  cancellationReason?: string;
  waitMs?: number;
  latencyMs?: number;
  inputSummary: string;
  outputSummary?: string;
  sourceArtifactIds: string[];
  artifactIds: string[];
  errorMessage?: string;
  metrics?: Record<string, number | string | boolean>;
};

export type DurableWorkerQueueLease = {
  owner: string;
  acquiredAt: string;
  expiresAt: string;
};

export type DurableWorkerQueueRecord = {
  id: string;
  version: "durable-worker-queue-v1";
  traceId: string;
  queueItemId: string;
  createdAt: string;
  updatedAt: string;
  queueLabel: string;
  workerId: string;
  workerLabel: string;
  definition: AgentWorkerDefinition;
  taskNodeDefinition?: AgentTaskNodeDefinition;
  taskNodeExecution?: AgentTaskNodeExecution;
  taskNodeId?: string;
  parentSpanId?: string;
  workerRunId?: string;
  status: AgentWorkerQueueItemStatus;
  priority: number;
  concurrencyGroup: string;
  enqueuedAt: string;
  startedAt?: string;
  completedAt?: string;
  waitMs?: number;
  latencyMs?: number;
  attempt: number;
  maxAttempts: number;
  lease?: DurableWorkerQueueLease;
  cancelRequestedAt?: string;
  cancellationReason?: string;
  inputSummary: string;
  inputPayloadRef?: string;
  inputPayloadPreview?: string;
  sourceArtifactIds: string[];
  artifactIds: string[];
  outputArtifactRefs?: string[];
  outputSummary?: string;
  errorMessage?: string;
  metrics?: Record<string, number | string | boolean>;
  resume: {
    strategy: string;
    requiredArtifactIds: string[];
    idempotencyKey?: string;
  };
};

export type DurableWorkerQueueMaintenanceResult = {
  scanned: number;
  cancelled: number;
  requeued: number;
  failedExpired: number;
  stillRunning: number;
  records: DurableWorkerQueueRecord[];
};

export type AgentRunInterruptType =
  | "needs_search_key"
  | "needs_material"
  | "approve_deep_research"
  | "clarify_target_user"
  | "confirm_competitor_set"
  | "evidence_too_weak_for_report";

export type AgentRunInterruptStatus = "active" | "resolved" | "dismissed";
export type AgentRunInterruptMode = "soft" | "hard";
export type AgentRunInterruptBlockedUntil =
  | "user_action"
  | "configuration"
  | "approval"
  | "material";
export type AgentRunInterruptAction =
  | "queue_resume"
  | "mark_resolved"
  | "dismiss"
  | "wait_for_user";

export type AgentRunInterruptResumeCheckpoint = {
  id: string;
  createdAt: string;
  targetId?: string;
  targetKind: "task_node" | "worker_run" | "tool_call" | "unknown";
  taskNodeId?: string;
  relatedTaskNodeIds?: string[];
  workerRunId?: string;
  toolCallId?: string;
  artifactIds: string[];
  sourceArtifactIds: string[];
  inputSummary: string;
  resumeStrategy: string;
  requiredActions: string[];
};

export type AgentRunInterrupt = {
  id: string;
  traceId: string;
  createdAt: string;
  updatedAt: string;
  type: AgentRunInterruptType;
  status: AgentRunInterruptStatus;
  mode?: AgentRunInterruptMode;
  blockedUntil?: AgentRunInterruptBlockedUntil;
  blocksRun?: boolean;
  severity: "blocker" | "warning" | "info";
  title: string;
  summary: string;
  requestedBy: "system" | "judge" | "tool_policy";
  requiredActions: string[];
  resumeTargetId?: string;
  taskNodeId?: string;
  workerRunId?: string;
  toolCallId?: string;
  artifactIds: string[];
  resumeCheckpoint?: AgentRunInterruptResumeCheckpoint;
  resumeRequestId?: string;
  resolutionAction?: AgentRunInterruptAction;
  note?: string;
  source: {
    label: string;
    reason: string;
  };
  resultSummary?: string;
};

export type AgentRunStateSnapshot = {
  id: string;
  traceId: string;
  createdAt: string;
  checkpointType: "worker_run" | "handoff" | "stage";
  status: "completed" | "failed" | "skipped";
  label: string;
  summary: string;
  workerRunId?: string;
  spanId?: string;
  handoffId?: string;
  artifactIds: string[];
  resumeHint: string;
};

export type AgentTaskNodeKind =
  | "research_supervisor"
  | "material_fetch"
  | "query_plan"
  | "support_search"
  | "opposition_search"
  | "freshness_search"
  | "competitor_search"
  | "result_fetch"
  | "evidence_extract"
  | "code_execute"
  | "judge"
  | "report"
  | "evidence_loop"
  | "posterior_search";

export type AgentTaskNodeStatus =
  | "pending"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "skipped"
  | "interrupted"
  | "cancelled";

export type AgentTaskNodeExecutionLease = {
  id: string;
  ownerId: string;
  acquiredAt: string;
  expiresAt: string;
};

export type AgentTaskNodeRetryPolicy = {
  maxAttempts: number;
  backoffMs: number;
  retryableFailures: AgentWorkerFailureCode[];
};

export type AgentTaskNodeInterruptPolicy = {
  hardInterruptTypes: AgentRunInterrupt["type"][];
  approvalRequired: boolean;
  blockDownstreamOnFailure: boolean;
  userActionHint: string;
};

export type AgentTaskNodeFreshnessPolicy = {
  evidenceMaxAgeDays?: number;
  refreshBeforeReport: boolean;
  lifecycleStages?: ProductLifecycleStage[];
};

export type AgentTaskNodeExecution = {
  executorVersion: "graph-executor-v1";
  definitionId: string;
  priority: number;
  concurrencyGroup: string;
  inputSchema: string;
  outputSchema: string;
  allowedTools: AgentRuntimeToolId[];
  timeoutMs: number;
  attempt: number;
  maxAttempts: number;
  queuedAt?: string;
  cancelledAt?: string;
  lastTransitionAt: string;
  blockedByTaskNodeIds: string[];
  lease?: AgentTaskNodeExecutionLease;
  retryPolicy: AgentTaskNodeRetryPolicy;
  interruptPolicy: AgentTaskNodeInterruptPolicy;
  freshnessPolicy?: AgentTaskNodeFreshnessPolicy;
};

export type AgentTaskNodeDefinition = {
  id: string;
  kind: AgentTaskNodeKind;
  label: string;
  description: string;
  dependsOn: string[];
  inputSchema: string;
  outputSchema: string;
  allowedTools: AgentRuntimeToolId[];
  subagent?: AgentRuntimeSubagentId;
  workerId?: string;
  priority: number;
  concurrencyGroup: string;
  timeoutMs: number;
  retryPolicy: AgentTaskNodeRetryPolicy;
  interruptPolicy: AgentTaskNodeInterruptPolicy;
  freshnessPolicy?: AgentTaskNodeFreshnessPolicy;
  registry?: AgentWorkerRegistryLink;
};

export type AgentTaskGraphNode = {
  id: string;
  kind: AgentTaskNodeKind;
  label: string;
  status: AgentTaskNodeStatus;
  dependsOn: string[];
  startedAt?: string;
  completedAt?: string;
  latencyMs?: number;
  inputSummary: string;
  outputSummary?: string;
  spanIds: string[];
  workerRunIds: string[];
  toolCallIds: string[];
  artifactIds: string[];
  handoffIds: string[];
  blockedBy?: string[];
  resumeHint?: string;
  metrics?: Record<string, number | string | boolean>;
  execution?: AgentTaskNodeExecution;
};

export type AgentTaskGraphEdge = {
  from: string;
  to: string;
  label?: string;
};

export type AgentTaskGraph = {
  id: string;
  version: "task-graph-v1";
  executorVersion?: "graph-executor-v1";
  title: string;
  createdAt: string;
  updatedAt: string;
  definitions?: AgentTaskNodeDefinition[];
  executor?: AgentGraphExecutorState;
  nodes: AgentTaskGraphNode[];
  edges: AgentTaskGraphEdge[];
};

export type AgentGraphExecutorState = {
  version: "graph-executor-v1";
  updatedAt: string;
  readyNodeIds: string[];
  queuedNodeIds: string[];
  runningNodeIds: string[];
  blockedNodeIds: string[];
  terminalNodeIds: string[];
  staleNodeIds: string[];
  cancelledNodeIds: string[];
  warnings: string[];
};

export type AgentRuntimeSpan = {
  id: string;
  parentId?: string;
  taskNodeId?: string;
  subagent: AgentRuntimeSubagentId;
  title: string;
  status: "running" | "completed" | "failed" | "skipped";
  startedAt: string;
  completedAt?: string;
  latencyMs?: number;
  inputSummary: string;
  outputSummary?: string;
  artifactIds: string[];
  handoffId?: string;
  errorMessage?: string;
  metrics?: Record<string, number | string | boolean>;
};

export type AgentRunEvalStatus = "pass" | "warn" | "block";

export type AgentRunEvalCategory =
  | "coverage"
  | "evidence"
  | "context"
  | "security"
  | "recovery"
  | "efficiency"
  | "judge"
  | "versioning";

export type AgentRunEvalCheck = {
  id: string;
  label: string;
  category: AgentRunEvalCategory;
  status: AgentRunEvalStatus;
  score: number;
  summary: string;
  evidence: string[];
  recommendation?: string;
};

export type AgentRunEval = {
  version: "agent-run-eval-v1";
  evaluatedAt: string;
  status: AgentRunEvalStatus;
  score: number;
  summary: string;
  checks: AgentRunEvalCheck[];
  blockers: string[];
  warnings: string[];
  strengths: string[];
  metrics: {
    taskNodes: number;
    completedTaskNodes: number;
    terminalTaskNodes: number;
    staleTaskNodes: number;
    searchTaskNodes: number;
    completedSearchTaskNodes: number;
    workerRuns: number;
    runnerWorkers: number;
    manualWorkers: number;
    boundaryCount: number;
    boundaryViolations: number;
    boundaryCompactions: number;
    toolCalls: number;
    highRiskToolCalls: number;
    unenforcedToolCalls: number;
    blockedToolCalls: number;
    failedToolCalls: number;
    blockingGuardrails: number;
    warningGuardrails: number;
    duplicateToolInputs: number;
    handoffs: number;
    handoffsWithForbiddenClaims: number;
    activeHardInterrupts: number;
    resumeTargets: number;
    stateSnapshots: number;
    cacheHits: number;
  };
};

export type AgentRuntimeTrace = {
  id: string;
  createdAt: string;
  updatedAt: string;
  rootGoal: string;
  status: "running" | "completed" | "failed" | "interrupted";
  spans: AgentRuntimeSpan[];
  artifacts: AgentRuntimeArtifact[];
  handoffs: AgentHandoffPacket[];
  workerRuns?: AgentWorkerRun[];
  toolCalls?: AgentRuntimeToolCall[];
  workerQueue?: AgentWorkerQueueItem[];
  interrupts?: AgentRunInterrupt[];
  stateSnapshots?: AgentRunStateSnapshot[];
  taskGraph?: AgentTaskGraph;
  resumeRequests?: AgentRuntimeResumeRequest[];
  resumePlan?: AgentResumePlan;
  runEval?: AgentRunEval;
};

export type AgentJudgeReason = {
  id: string;
  category:
    | "evidence_stop"
    | "source_budget"
    | "opposition"
    | "recency"
    | "objectivity"
    | "search_quality"
    | "artifact_integrity"
    | "confidence_alignment";
  severity: "blocker" | "warning" | "info";
  finding: string;
  evidence: string;
  requiredAction: string;
};

export type AgentJudgeVerdict = {
  id: string;
  createdAt: string;
  status: "pass" | "warn" | "block";
  decision:
    | "proceed_to_report"
    | "continue_research"
    | "block_strong_decision"
    | "needs_user_evidence";
  allowedReportStrength: "strong" | "moderate" | "exploratory";
  confidenceCap: number;
  summary: string;
  reasons: AgentJudgeReason[];
  requiredResearchActions: string[];
  allowedDecisions: ProductDecision["decision"][];
  metrics: {
    evidenceCards: number;
    externalEvidence: number;
    supportEvidence: number;
    oppositionEvidence: number;
    sourceBudgetScore: number;
    unmetSourceBudgets: number;
    objectiveEvidenceRatio: number;
    currentEvidenceRatio: number;
    temporalValidityScore: number;
    searchQualityScore: number;
    executedQueries: number;
    skippedQueries: number;
    failedQueries: number;
  };
};

export type ProductLifecycleStage =
  | "idea"
  | "prototype"
  | "mvp"
  | "launch"
  | "early_traction"
  | "growth"
  | "mature"
  | "decline"
  | "unknown";

export type EvidenceVerdict =
  | "strong_support"
  | "weak_support"
  | "mixed"
  | "weak_opposition"
  | "strong_opposition"
  | "insufficient";

export type EvidenceObjectiveLevel =
  | "observed_fact"
  | "evidence_interpretation"
  | "model_inference"
  | "hypothesis";

export type EvidenceRecencyBucket =
  | "fresh"
  | "usable"
  | "historical"
  | "unknown_recency";

export type EvidenceCard = {
  id: string;
  assumptionId: string;
  sourceTitle: string;
  sourceUrl: string;
  sourceType: string;
  publishedAt?: string;
  updatedAt?: string;
  observedAt?: string;
  capturedAt: string;
  recencyBucket: EvidenceRecencyBucket;
  recencyWeight: number;
  lifecycleRelevance: number;
  objectiveLevel: EvidenceObjectiveLevel;
  claim: string;
  signalType: string;
  direction: "support" | "oppose" | "neutral";
  behaviorStrength: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  relevanceScore: number;
  credibilityScore: number;
  recencyScore: number;
  quoteOrSnippet: string;
  interpretation: string;
  caveat: string;
  confidence: number;
};

export type ProductClaim = {
  id: string;
  text: string;
  claimType:
    | "target_user"
    | "problem"
    | "frequency"
    | "workaround"
    | "payment"
    | "distribution"
    | "ai_advantage"
    | "trust"
    | "timing"
    | "decision";
  objectiveLevel: EvidenceObjectiveLevel;
  status: "supported" | "opposed" | "mixed" | "unverified" | "stale";
  supportEvidenceIds: string[];
  opposeEvidenceIds: string[];
  confidence: number;
  temporalValidityScore: number;
  whyItMatters: string;
  whatWouldChangeThisClaim: string[];
};

export type ClaimLedger = {
  claims: ProductClaim[];
  lastUpdatedAt: string;
  overallConfidence: number;
  openQuestions: string[];
};

export type EvidenceCluster = {
  id: string;
  title: string;
  clusterType:
    | "pain_signal"
    | "workaround_signal"
    | "payment_signal"
    | "competitor_signal"
    | "distribution_signal"
    | "ai_advantage_signal"
    | "opposition_signal"
    | "missing_signal";
  summary: string;
  supportCards: EvidenceCard[];
  opposeCards: EvidenceCard[];
  netStrength: number;
  confidence: number;
};

export type EvidenceGap = {
  assumptionId: string;
  missingEvidence: string;
  whyItMatters: string;
  recommendedExperimentType:
    | "customer_interview"
    | "landing_page_smoke_test"
    | "fake_door"
    | "pricing_test"
    | "cold_email"
    | "community_post"
    | "concierge_mvp"
    | "pmf_survey";
  expectedConfidenceGain: number;
};

export type LifecycleEvidenceStandard = {
  stage: ProductLifecycleStage;
  label: string;
  evidenceGoal: string;
  requiredExternalEvidence: number;
  requiredTotalEvidence: number;
  requiredOpposition: number;
  requiredFreshWebEvidence: number;
  minimumBehaviorStrength: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  requiredStrongBehaviorCards: number;
  requiredSourceBudgets: string[];
  requiredEvidenceTypes: string[];
  decisionRule: string;
};

export type SourceBudgetStatus = "met" | "partial" | "planned" | "missing";

export type SourceBudget = {
  assumptionId: string;
  label: string;
  requiredSupport: number;
  requiredOpposition: number;
  currentSupport: number;
  currentOpposition: number;
  currentNeutral: number;
  supportEvidenceIds: string[];
  oppositionEvidenceIds: string[];
  neutralEvidenceIds: string[];
  plannedQueryIds: string[];
  status: SourceBudgetStatus;
  missingEvidence: string[];
};

export type ValidationExperiment = {
  id?: string;
  assumptionId?: string;
  status?: "planned" | "running" | "completed";
  title: string;
  hypothesis: string;
  targetUser: string;
  channel: string;
  steps: string[];
  successMetric: string;
  failureMetric: string;
  sampleSize: string;
  timeRequired: string;
  costLevel: "free" | "low" | "medium" | "high";
  expectedConfidenceGain: number;
  primaryMetric?: {
    name: string;
    unit: string;
    target: string;
    failureThreshold: string;
    direction: "higher_is_better" | "lower_is_better" | "binary";
  };
  secondaryMetrics?: string[];
  evidenceToCollect?: string[];
  resultSchema?: {
    requiredFields: string[];
    optionalFields: string[];
    decisionOptions: Array<"validated" | "inconclusive" | "invalidated">;
  };
  decisionRules?: {
    validated: string;
    inconclusive: string;
    invalidated: string;
  };
  result?: ValidationExperimentResult | null;
};

export type ExperimentEvidenceArtifact = {
  id: string;
  kind:
    | "metric_snapshot"
    | "csv_row"
    | "interview_note"
    | "screenshot"
    | "raw_file"
    | "url"
    | "note";
  title: string;
  sourceUrl?: string;
  fileName?: string;
  contentType?: string;
  excerpt: string;
  parsedSignal: string;
  direction: "support" | "oppose" | "neutral";
  objectiveLevel: EvidenceObjectiveLevel;
  capturedAt: string;
  extractionMethod?: "manual" | "text" | "pdf" | "ocr" | "url" | "file" | "code";
  ocrEngine?: string;
  ocrConfidence?: number;
};

export type ValidationExperimentResult = {
  status: "validated" | "inconclusive" | "invalidated";
  completedAt: string;
  sampleSize: number;
  primaryMetricValue: string;
  evidenceSummary: string;
  rawEvidenceUrls?: string[];
  rawEvidenceArtifacts?: ExperimentEvidenceArtifact[];
  confidenceDelta: number;
  notes?: string;
};

export type EvidenceStopRule = {
  id: string;
  label: string;
  status: "pass" | "warn" | "block";
  score: number;
  reason: string;
  minimumEvidenceNeeded: string[];
};

export type EvidenceStop = {
  stopped: true;
  reason: string;
  blockedDecision: "build" | "stop" | "reposition";
  blockedDecisions?: Array<"build" | "stop" | "reposition">;
  allowedDecision: "test_first";
  minimumEvidenceNeeded: string[];
  ruleResults?: EvidenceStopRule[];
  severity?: "caution" | "blocked";
  recommendedExperiment: ValidationExperiment;
};

export type ProductDecision = {
  decision: "build" | "test_first" | "reposition" | "stop";
  confidence: number;
  rationaleClaimIds: string[];
  strongestReason: string;
  strongestCounterReason: string;
  nextMilestone: string;
};

export type EvidenceBrief = {
  productName: string;
  productLifecycleStage: ProductLifecycleStage;
  lifecycleEvidenceStandard?: LifecycleEvidenceStandard;
  claimLedger: ClaimLedger;
  evidenceStop?: EvidenceStop;
  evidenceVerdict: EvidenceVerdict;
  confidenceScore: number;
  supportScore: number;
  oppositionScore: number;
  sourceDiversityScore: number;
  behaviorStrengthScore: number;
  recencyScore: number;
  temporalValidityScore: number;
  objectiveEvidenceRatio: number;
  currentEvidenceRatio: number;
  staleEvidenceCount: number;
  assumptionCoverageScore: number;
  sourceBudgetScore: number;
  keyEvidenceClusters: EvidenceCluster[];
  evidenceCards: EvidenceCard[];
  sourceBudgets: SourceBudget[];
  strongestSupport: EvidenceCard[];
  strongestOpposition: EvidenceCard[];
  evidenceGaps: EvidenceGap[];
  decision: ProductDecision;
  recommendedExperiment: ValidationExperiment;
};

export type ProductDiagnosisReport = {
  diagnosis_score: number;
  potential_score: number;
  potential_verdict: string;
  first_impression: string;
  diagnosis_tags: string[];
  market_evidence: ProductEvidenceSignal[];
  top_issues: ProductDiagnosisIssue[];
  references: ProductDiagnosisReference[];
  actionable_suggestions: string[];
  share_summary: {
    current_style: string;
    main_problem: string;
    recommended_references: string;
    one_line_diagnosis: string;
  };
  limitations: string[];
};

export type ReportQualityStatus = "pass" | "warn" | "fail";

export type ReportQualityCategory =
  | "evidence_binding"
  | "evidence_quality"
  | "calibration_alignment"
  | "specificity"
  | "inference_boundary"
  | "experiment_readiness"
  | "recency"
  | "source_coverage";

export type ReportQualityIssue = {
  id: string;
  category: ReportQualityCategory;
  severity: "blocker" | "warning" | "info";
  title: string;
  finding: string;
  evidence: string;
  fix: string;
  repairDraft?: ReportRepairDraft;
};

export type ReportRepairDraft = {
  targetSection:
    | "potential_verdict"
    | "market_evidence"
    | "top_issues"
    | "actionable_suggestions"
    | "limitations";
  title: string;
  replacementText: string;
  whyThisFix: string;
  evidenceRefs: string[];
  confidence: number;
  researchPlan?: ReportRepairResearchPlan;
};

export type ReportRepairResearchPlan = {
  title: string;
  trigger: string;
  queries: string[];
  backtestSuggestions: string[];
  experimentActions: string[];
};

export type ReportRewriteDiffLine = {
  type: "added" | "removed" | "unchanged";
  text: string;
};

export type ReportRewriteRevision = {
  id: string;
  createdAt: string;
  rolledBackAt?: string;
  issueId: string;
  issueTitle: string;
  targetSection: ReportRepairDraft["targetSection"];
  draftTitle: string;
  beforeText: string;
  afterText: string;
  diff?: ReportRewriteDiffLine[];
  summary: string;
  evidenceRefs: string[];
};

export type ReportRegenerationDraft = {
  id: string;
  createdAt: string;
  appliedAt?: string;
  source: "follow_up";
  turnId?: string;
  title: string;
  summary: string;
  beforeReport: ProductDiagnosisReport;
  afterReport: ProductDiagnosisReport;
  diff: ReportRewriteDiffLine[];
  evidenceBrief: EvidenceBrief;
  webResearch?: WebResearchSummary;
  reportQualityAudit?: ReportQualityAudit;
  confidenceBefore: number;
  confidenceAfter: number;
  decisionBefore?: ProductDecision["decision"];
  decisionAfter: ProductDecision["decision"];
  model: string;
  evidenceRefs: string[];
};

export type ReportQualityCheck = {
  id: string;
  category: ReportQualityCategory;
  label: string;
  status: ReportQualityStatus;
  score: number;
  reason: string;
  minimumFixes: string[];
};

export type ReportQualityAudit = {
  generatedAt: string;
  score: number;
  status: ReportQualityStatus;
  summary: string;
  checks: ReportQualityCheck[];
  issues: ReportQualityIssue[];
  strengths: string[];
};

export type QualityResearchEvidenceDelta = {
  title: string;
  url: string;
  sourceType: string;
  sourceName?: string;
  snippet: string;
  publishedAt?: string;
  updatedAt?: string;
  capturedAt?: string;
  dateSource?: string;
  recencyBucket?: EvidenceRecencyBucket;
  assumptionId?: string;
  signalType?: string;
  direction?: "support" | "oppose" | "neutral";
  objectiveLevel?: EvidenceObjectiveLevel;
  behaviorStrength?: number;
  credibilityScore?: number;
  confidence?: number;
  interpretation?: string;
  caveat?: string;
  whyIncluded?: string;
};

export type QualityResearchRunSummary = {
  id: string;
  createdAt: string;
  issueId: string;
  issueTitle: string;
  trigger: string;
  queryCount: number;
  resultCount: number;
  crawledCount: number;
  confidenceBefore: number;
  confidenceAfter: number;
  decisionBefore?: ProductDecision["decision"];
  decisionAfter: ProductDecision["decision"];
  qualityScoreBefore: number;
  qualityScoreAfter: number;
  newEvidence: QualityResearchEvidenceDelta[];
  remainingGaps: string[];
  stillOpen: boolean;
  stillOpenIssueTitles: string[];
  shouldApplyRepairDraft: boolean;
  applyRecommendation: string;
};

export type ReportEvidenceBindingStatus = "bound" | "weak" | "missing";

export type ReportEvidenceTargetSection =
  | "potential_verdict"
  | "market_evidence"
  | "top_issues"
  | "actionable_suggestions"
  | "limitations";

export type ReportEvidenceBinding = {
  id: string;
  targetSection: ReportEvidenceTargetSection;
  targetIndex?: number;
  targetKey: string;
  targetLabel: string;
  claimText: string;
  status: ReportEvidenceBindingStatus;
  confidence: number;
  supportEvidenceIds: string[];
  oppositionEvidenceIds: string[];
  neutralEvidenceIds: string[];
  rationale: string;
  missingEvidence: string[];
};

export type TasteIssue = ProductDiagnosisIssue;
export type TasteReference = ProductDiagnosisReference;
export type TasteReport = ProductDiagnosisReport;

export type StoredRunEvent = {
  type: "progress" | "complete" | "error";
  id?: string;
  stage?: string;
  status?: string | number;
  title?: string;
  summary?: string;
  detail?: string;
  message?: string;
  model?: string;
  at: string;
  analysisId?: string;
  runId?: string;
};

export type AnalysisRunStageId =
  | "intake"
  | "material_reader"
  | "web_research"
  | "evidence_agent"
  | "report_composer"
  | "quality_gate";

export type AnalysisRunCheckpoint = {
  stage: AnalysisRunStageId;
  title: string;
  status: "waiting" | "running" | "completed" | "failed" | "skipped";
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
  summary: string;
  detail?: string;
  eventCount: number;
};

export type AnalysisRunSummary = {
  currentStage?: AnalysisRunStageId;
  failedStage?: AnalysisRunStageId;
  completedStages: AnalysisRunStageId[];
  totalStages: number;
  progressPercent: number;
  durationMs: number;
  isStale: boolean;
  isRecoverable: boolean;
  recoverabilityReason: string;
  lastEventTitle?: string;
  lastEventSummary?: string;
};

export type RunRetryInput = {
  productVariant: ProductVariantId;
  brief: string;
  githubRepoUrl?: string;
  materialNames: string[];
  canAutoPrefill: boolean;
  limitation?: string;
};

export type AnalysisRunLog = {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: "running" | "completed" | "failed";
  analysisId?: string;
  errorMessage?: string;
  sourceSummary?: string;
  retryInput?: RunRetryInput;
  checkpoints?: AnalysisRunCheckpoint[];
  summary?: AnalysisRunSummary;
  events: StoredRunEvent[];
};

export type BacktestPredictionDecision = "build" | "test_first" | "reposition" | "stop";

export type BacktestScoreItem = {
  label: string;
  score: number;
  evidence: string;
};

export type GitHubRepositorySnapshot = {
  repo: string;
  repoUrl: string;
  description: string;
  homepage?: string;
  stars: number;
  forks: number;
  openIssues: number;
  watchers: number;
  language: string;
  topics: string[];
  license: string;
  archived: boolean;
  disabled: boolean;
  createdAt?: string;
  updatedAt?: string;
  pushedAt?: string;
  defaultBranch: string;
};

export type BacktestSearchProviderComparison = {
  provider: WebSearchProvider;
  status: "executed" | "skipped" | "failed";
  qualityScore: number;
  totalResults: number;
  executedQueries: number;
  failedQueries: number;
  skippedQueries: number;
  querySuccessRate: number;
  urlCoverage: number;
  dateCoverage: number;
  freshResultRatio: number;
  oppositionResultRatio: number;
  selected: boolean;
  reason: string;
  warnings: string[];
  skippedReasons: string[];
  sampleResults: Array<{
    title: string;
    url: string;
    snippet: string;
  }>;
};

export type BacktestProviderRuntimeTrace = {
  provider: WebSearchProvider;
  trace: AgentRuntimeTrace;
};

export type DynamicBacktestFailureStage =
  | "github_import"
  | "readme_prediction"
  | "posterior_research"
  | "calibration"
  | "unknown";

export type DynamicBacktestFailureDetail = {
  stage: DynamicBacktestFailureStage;
  status: "failed" | "skipped" | "warning";
  label: string;
  message: string;
  provider?: WebSearchProvider;
  retryable: boolean;
  at: string;
};

export type DynamicBacktestRetryInput = {
  repoUrl: string;
  canRetry: boolean;
  reason?: string;
};

export type BacktestSuggestionStatus = "open" | "used" | "dismissed";

export type BacktestCandidateSampleFit =
  | "success_case"
  | "weak_case"
  | "mixed_case"
  | "tooling_case"
  | "adjacent_case";

export type BacktestCandidateRepo = {
  repo: string;
  repoUrl: string;
  description: string;
  stars?: number;
  forks?: number;
  language?: string;
  topics: string[];
  source: "github_search" | "curated";
  sampleFit: BacktestCandidateSampleFit;
  matchScore: number;
  whyThisSample: string;
};

export type BacktestSuggestion = {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: BacktestSuggestionStatus;
  source: "report_quality";
  analysisId: string;
  issueId: string;
  issueTitle: string;
  title: string;
  suggestion: string;
  targetSignal?: string;
  candidateStatus?: "not_generated" | "generated" | "failed";
  candidateGeneratedAt?: string;
  candidateQuery?: string;
  candidateWarnings?: string[];
  candidates?: BacktestCandidateRepo[];
  repoUrl?: string;
  usedBacktestId?: string;
  usedAt?: string;
  dismissedAt?: string;
};

export type DynamicBacktestRecord = {
  id: string;
  createdAt: string;
  updatedAt: string;
  repo: string;
  repoUrl: string;
  status: "completed" | "failed";
  errorMessage?: string;
  failureStage?: DynamicBacktestFailureStage;
  failureDetails?: DynamicBacktestFailureDetail[];
  retryInput?: DynamicBacktestRetryInput;
  readmePreview: string;
  repository: GitHubRepositorySnapshot | null;
  prediction: {
    potential: number;
    decision: BacktestPredictionDecision;
    rationale: string;
    uncertainty: string;
    scoreBreakdown: BacktestScoreItem[];
  };
  posterior: {
    outcomeLabel: "strong_success" | "promising" | "mixed" | "weak" | "insufficient";
    outcomeScore: number;
    evidence: string[];
    supportCount: number;
    oppositionCount: number;
    searchResults: WebEvidence[];
    queryExecutions: EvidenceQueryExecution[];
    skippedReasons: string[];
    selectedProvider?: WebSearchProvider;
    searchComparisons?: BacktestSearchProviderComparison[];
    runtimeTraces?: BacktestProviderRuntimeTrace[];
  };
  calibration: {
    result: "aligned" | "underestimated" | "overestimated" | "insufficient";
    delta: number;
    lesson: string;
  };
  warnings: string[];
};

export type BlindTestParticipant = "product_agent" | "chatgpt" | "claude";

export type BlindTestOutcomeLabel =
  | "strong_success"
  | "promising"
  | "mixed"
  | "weak"
  | "insufficient";

export type BlindTestCase = {
  id: string;
  repo: string;
  repoUrl: string;
  materialType: "github_readme" | "product_pdf";
  promptFocus: string;
  whyIncluded: string;
  hiddenOutcome: {
    label: BlindTestOutcomeLabel;
    summary: string;
    evidence: string[];
  };
};

export type BlindTestScores = {
  evidenceQuality: number;
  oppositionCoverage: number;
  experimentActionability: number;
  calibration: number;
  trust: number;
};

export type BlindTestJudgment = {
  id: string;
  caseId: string;
  participant: BlindTestParticipant;
  createdAt: string;
  updatedAt: string;
  output: string;
  scores: BlindTestScores;
  notes?: string;
  linkedBacktestId?: string;
  potentialScore?: number;
  decision?: BacktestPredictionDecision;
};

export type ProductAnalysisCalibrationRule = {
  id: string;
  title: string;
  summary: string;
  agentRule: string;
  priority: "high" | "medium" | "low";
};

export type ProductAnalysisSignalCalibration = {
  label: string;
  sampleCount: number;
  averageDelta: number;
  verdict: "usable" | "overweighted" | "underweighted" | "needs_more_samples";
  lesson: string;
};

export type ProductAnalysisCalibrationAction = {
  id: string;
  target: string;
  action: "upweight" | "downweight" | "hold" | "collect_more" | "fix_tooling";
  label: string;
  confidence: "high" | "medium" | "low";
  sampleCount: number;
  neededSamples: number;
  averageDelta: number | null;
  recommendedAdjustment: string;
  reason: string;
  nextStep: string;
};

export type ProductAnalysisCalibrationContext = {
  source: "readme_backtest";
  appliedAt: string;
  appliesTo: "readme" | "github_readme";
  reason: string;
  staticSampleCount: number;
  dynamicSampleCount: number;
  completedDynamicCount: number;
  failedDynamicCount: number;
  averageAbsoluteDelta: number | null;
  alignedRate: number | null;
  rules: ProductAnalysisCalibrationRule[];
  signalCalibrations: ProductAnalysisSignalCalibration[];
  actions: ProductAnalysisCalibrationAction[];
  failurePatternSummaries: string[];
  limitations: string[];
};

export type AnalysisRecord = {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: "completed" | "failed";
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
  imageUrl: string;
  imageMetrics: ImageMetrics | null;
  report: ProductDiagnosisReport | null;
  reportQualityAudit?: ReportQualityAudit;
  reportEvidenceBindings?: ReportEvidenceBinding[];
  reportRevisions?: ReportRewriteRevision[];
  reportRegenerationDrafts?: ReportRegenerationDraft[];
  qualityResearchRuns?: QualityResearchRunSummary[];
  followUps?: AnalysisFollowUpTurn[];
  model: string;
  errorMessage: string | null;
};

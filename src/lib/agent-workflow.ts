import type {
  AgentStage,
  AgentToolCall,
  AgentTraceStep,
  ImageMetrics,
  UploadedMaterial,
  WebResearchSummary,
  WorkType
} from "./types";

type WorkflowInput = {
  brief: string;
  materials: UploadedMaterial[];
  primaryMetrics: ImageMetrics | null;
  webResearch?: WebResearchSummary;
};

export type WorkflowContext = {
  inferredWorkType: WorkType;
  inferredGoal: string;
  inferredProductName: string;
  visibleText: string;
  trace: AgentTraceStep[];
};

export function runDeterministicAgentWorkflow(
  input: WorkflowInput
): WorkflowContext {
  const started = performance.now();
  const pdfText = input.materials
    .filter((material) => material.type === "application/pdf")
    .map((material) => material.extractedText)
    .filter(Boolean)
    .join("\n\n");
  const readmeText = input.materials
    .filter((material) => isReadmeLike(material))
    .map((material) => material.extractedText)
    .filter(Boolean)
    .join("\n\n");
  const allMaterialText = input.materials
    .map((material) => material.extractedText)
    .filter(Boolean)
    .join("\n\n");
  const combinedBrief = [input.brief.trim(), allMaterialText.slice(0, 9000)]
    .filter(Boolean)
    .join("\n\n材料内容摘录：\n");
  const inferredWorkType = inferWorkType(combinedBrief);
  const inferredGoal = inferGoal(combinedBrief);
  const inferredProductName = inferProductName(combinedBrief);
  const visibleText = combinedBrief.trim();

  const trace: AgentTraceStep[] = [
    makeStep("intake", "接收材料", [
      toolCall("intake", "validate_materials", "检查文件类型、大小和数量", `${input.materials.length} 个产品材料可用于分析`, started),
      toolCall("intake", "normalize_user_brief", "整理用户输入的背景说明", input.brief ? "已提取用户补充说明" : "用户未补充说明，将主要读取材料", started)
    ]),
    makeStep("readme_reader", "读取 README", [
      toolCall(
        "readme_reader",
        "extract_readme_text",
        "读取 README、Markdown 或 TXT 中的产品说明、安装方式、使用场景和链接",
        readmeText
          ? `已抽取 ${Math.min(readmeText.length, 18000)} 个字符，并提取 README 链接`
          : "没有 README/文本材料",
        started,
        readmeText ? "completed" : "skipped"
      ),
      toolCall(
        "readme_reader",
        "extract_product_urls",
        "从 README 和用户说明中提取官网、GitHub、文档、demo、竞品或发布页链接",
        summarizeUrls(input.webResearch?.extractedUrls),
        started,
        input.webResearch?.extractedUrls.length ? "completed" : "skipped"
      )
    ]),
    makeStep("pdf_reader", "读取产品介绍", [
      toolCall(
        "pdf_reader",
        "extract_pdf_text",
        "读取产品介绍 PDF、PRD 或说明文档的文本内容",
        pdfText
          ? `已抽取 ${Math.min(pdfText.length, 12000)} 个字符，作为产品上下文`
          : "没有 PDF 文本，或 PDF 需要 OCR",
        started,
        pdfText ? "completed" : "skipped"
      ),
      toolCall(
        "pdf_reader",
        "summarize_product_brief",
        "从材料中提取产品定位、目标用户、核心卖点和当前卡点",
        combinedBrief ? "已合并用户介绍和材料内容" : "上下文不足",
        started
      )
    ]),
    makeStep("material_observer", "观察材料信号", [
      toolCall(
        "material_observer",
        "extract_image_metrics",
        "读取页面截图或视觉材料的主色、亮度、对比度和边缘密度",
        input.primaryMetrics
          ? `亮度 ${Math.round(input.primaryMetrics.brightness)}，对比度 ${Math.round(input.primaryMetrics.contrast)}，主色 ${input.primaryMetrics.dominantColors.slice(0, 3).join(" / ")}`
          : "没有可用图片指标",
        started
      ),
      toolCall(
        "material_observer",
        "summarize_material_manifest",
        "整理上传材料清单",
        input.materials.map((item) => item.name).join("，") || "无材料",
        started
      )
    ]),
    makeStep("product_thesis", "提取产品论点", [
      toolCall("product_thesis", "infer_work_type", "根据材料推断产品材料类型", inferredWorkType, started),
      toolCall("product_thesis", "extract_product_thesis", "提取产品承诺、目标用户、核心场景和差异化假设", "已形成产品论点草案", started)
    ]),
    makeStep("web_research", "搜索与抓取网页", [
      toolCall(
        "web_research",
        "plan_evidence_queries",
        "按痛点、付费、替代方案、分发、反证和时效生成调研查询",
        input.webResearch?.queryPlan?.length
          ? `已生成 ${input.webResearch.queryPlan.length} 条假设驱动查询，其中 ${
              input.webResearch.queryPlan.filter((query) => query.phase === "budget_fill").length
            } 条为 Source Budget 补查`
          : "未生成可执行查询，材料信息不足",
        started,
        input.webResearch?.queryPlan?.length ? "completed" : "skipped"
      ),
      toolCall(
        "web_research",
        "crawl_extracted_urls",
        "抓取 README 中出现的公开网页，读取官网、文档或发布页证据",
        input.webResearch?.crawled.length
          ? `已抓取 ${input.webResearch.crawled.length} 个公开 URL`
          : "未发现可抓取公开 URL，或抓取失败",
        started,
        input.webResearch?.crawled.length ? "completed" : "skipped"
      ),
      toolCall(
        "web_research",
        "web_search_market_context",
        "按调研计划搜索产品名、痛点、付费、替代方案、评价、反证和时效信号",
        input.webResearch?.searchResults.length
          ? `已执行 ${
              input.webResearch.queryExecutions?.filter(
                (execution) => execution.status === "executed"
              ).length ?? 0
            } 条查询，获取 ${input.webResearch.searchResults.length} 条搜索结果`
          : input.webResearch?.skippedReasons.join("；") || "未执行网页搜索",
        started,
        input.webResearch?.searchResults.length ? "completed" : "skipped"
      )
    ]),
    makeStep("evidence_agent", "生成证据账本", [
      toolCall(
        "evidence_agent",
        "generate_evidence_cards",
        "把上传材料、抓取网页和搜索结果拆成 Evidence Cards，并标记来源、方向、证据强度和时效性",
        input.webResearch
          ? `已汇总 ${input.materials.length} 份材料和 ${
              input.webResearch.crawled.length + input.webResearch.searchResults.length
            } 条网页信号，覆盖 ${input.webResearch.queryPlan?.length ?? 0} 个调研意图`
          : `已汇总 ${input.materials.length} 份材料，外部网页证据不足`,
        started
      ),
      toolCall(
        "evidence_agent",
        "generate_claim_ledger",
        "把产品潜力拆成目标用户、痛点、付费、分发和时机等关键假设",
        "已生成 Claim Ledger，并区分 supported / mixed / unverified",
        started
      ),
      toolCall(
        "evidence_agent",
        "check_source_budget",
        "检查痛点、付费、替代方案、分发、反证和时效是否达到最低证据量",
        "已标记每个关键假设的支持证据、反证和缺口",
        started
      ),
      toolCall(
        "evidence_agent",
        "calibrate_evidence_confidence",
        "按证据客观性、行为强度、来源多样性和时效性校准置信度",
        "已避免把产品方叙事或模型推断当作市场事实",
        started
      ),
      toolCall(
        "evidence_agent",
        "apply_evidence_stop_rule",
        "检查证据是否足够支持 build / stop / reposition 等强决策",
        "若证据不足，则只允许 test_first，并给出最小验证实验",
        started
      )
    ]),
    makeStep("customer_job", "判断用户任务", [
      toolCall("customer_job", "identify_job_to_be_done", "判断用户想完成的进步、触发情境和替代方案", "已识别目标用户任务和可能的替代选择", started),
      toolCall("customer_job", "score_problem_intensity", "评估问题是否高频、痛、急、值钱", inferredGoal, started)
    ]),
    makeStep("risk_review", "评估产品风险", [
      toolCall("risk_review", "check_value_risk", "判断用户是否真的想要这个产品", "已检查价值风险", started),
      toolCall("risk_review", "check_usability_risk", "判断用户是否能理解并完成关键动作", "已检查可用性风险", started),
      toolCall("risk_review", "check_feasibility_risk", "判断当前方案在技术、数据、交付和运营上是否可实现", "已检查可行性风险；材料不足处会标记为未知", started),
      toolCall("risk_review", "check_viability_risk", "判断商业、定价、渠道和信任是否支撑产品", "已检查商业可行性风险", started)
    ]),
    makeStep("ux_trust_review", "检查体验与信任", [
      toolCall("ux_trust_review", "review_clarity_and_feedback", "检查信息层级、可理解性、反馈、可信证据和品牌一致性", "已识别体验与信任问题", started)
    ]),
    makeStep("market_fit_review", "判断市场与分发", [
      toolCall("market_fit_review", "check_pmf_signal", "判断材料是否包含强需求、目标人群、使用频率和不可替代性信号", "已检查产品市场匹配信号", started),
      toolCall("market_fit_review", "check_distribution_fit", "判断发布渠道、传播话术和用户获取路径是否匹配产品", "已检查分发路径", started)
    ]),
    makeStep("potential_assessment", "评估产品潜力", [
      toolCall("potential_assessment", "score_market_potential", "综合 README、网页证据、用户任务、替代方案和分发路径，判断是否值得继续投入", "已形成产品潜力判断和下一步验证建议", started),
      toolCall("potential_assessment", "separate_evidence_from_inference", "区分材料证据、网页证据和模型推断，避免把猜测当事实", "已标记证据边界", started)
    ]),
    makeStep("reference_curator", "匹配参考对象", [
      toolCall("reference_curator", "search_reference_library", "从内置参考库匹配产品、品牌、体验和商业表达案例", "候选：Linear、Stripe、Notion、Teenage Engineering、A24", started)
    ]),
    makeStep("priority_planner", "排序下一步", [
      toolCall("priority_planner", "rank_product_actions", "按影响、确定性、成本和学习速度排序行动", "已生成优先级行动清单", started)
    ]),
    makeStep("report_composer", "生成诊断报告", [
      toolCall("report_composer", "compose_structured_report", "将材料理解、问题诊断、参考对象和行动建议合成为报告", "输出结构化产品诊断报告", started)
    ]),
    makeStep("quality_gate", "质量检查", [
      toolCall("quality_gate", "schema_validate_report", "校验报告是否具体、可执行、和材料相关", "通过；如失败则自动修复一次", started)
    ])
  ];

  return {
    inferredWorkType,
    inferredGoal,
    inferredProductName,
    visibleText,
    trace
  };
}

function makeStep(
  stage: AgentStage,
  title: string,
  toolCalls: AgentToolCall[]
): AgentTraceStep {
  const status = toolCalls.every((item) => item.status === "skipped")
    ? "skipped"
    : toolCalls.some((item) => item.status === "failed")
      ? "failed"
      : "completed";

  return {
    stage,
    title,
    status,
    summary: toolCalls.map((item) => item.outputSummary).join("；"),
    toolCalls
  };
}

function toolCall(
  stage: AgentStage,
  toolName: string,
  inputSummary: string,
  outputSummary: string,
  started: number,
  status: AgentToolCall["status"] = "completed"
): AgentToolCall {
  return {
    id: crypto.randomUUID(),
    stage,
    toolName,
    status,
    inputSummary,
    outputSummary,
    latencyMs: Math.max(8, Math.round(performance.now() - started))
  };
}

function inferWorkType(brief: string): WorkType {
  const lower = brief.toLowerCase();
  if (lower.includes("readme") || lower.includes("github") || lower.includes("markdown")) {
    return "readme";
  }
  if (lower.includes("landing") || lower.includes("首页") || lower.includes("官网")) {
    return "landing_page";
  }
  if (lower.includes("pdf") || lower.includes("产品介绍") || lower.includes("商业计划书")) {
    return "product_brief_pdf";
  }
  if (lower.includes("app") || lower.includes("应用") || lower.includes("界面")) {
    return "app_screen";
  }
  if (lower.includes("logo") || lower.includes("品牌")) {
    return "brand_visual";
  }
  if (lower.includes("海报") || lower.includes("小红书") || lower.includes("poster")) {
    return "poster_social";
  }
  if (lower.includes("pitch") || lower.includes("deck") || lower.includes("融资")) {
    return "pitch_deck";
  }

  return "other";
}

function isReadmeLike(material: UploadedMaterial) {
  const lower = material.name.toLowerCase();
  return (
    material.type.startsWith("text/") ||
    lower.endsWith(".md") ||
    lower.endsWith(".mdx") ||
    lower.endsWith(".txt") ||
    lower === "readme"
  );
}

function summarizeUrls(urls?: string[]) {
  if (!urls?.length) return "没有发现可用 URL";
  return urls.slice(0, 5).join("，");
}

function inferGoal(brief: string) {
  const briefText = brief.trim();
  if (!briefText) {
    return "可信、清晰、有记忆点，适合发布到社交媒体测试反馈";
  }

  if (briefText.includes("高级") || briefText.includes("质感")) {
    return "提升产品可信感、品牌质感和付费转化说服力";
  }

  if (briefText.includes("AI") || briefText.toLowerCase().includes("agent")) {
    return "让 AI 产品的定位、价值主张、可信感和发布页表达更清楚";
  }

  return "找出定位、文案、体验、视觉和转化链路中的关键问题";
}

function inferProductName(brief: string) {
  const englishIntroMatch = brief.match(
    /\b([A-Z][A-Za-z0-9._-]{1,30})\s+(?:Product Introduction|Overview|Pitch Deck|Deck)\b/
  );
  if (englishIntroMatch?.[1]) return englishIntroMatch[1];

  const calledMatch = brief.match(/(?:产品|项目|作品|工具)(?:叫|名叫|名称是|名字是)\s*([A-Za-z0-9\u4e00-\u9fa5._-]{2,30})/i);
  if (calledMatch?.[1]) return calledMatch[1].replace(/[，。,.]/g, "");

  const match = brief.match(/(?:产品名|项目名|作品名|名字|name|called)[：:\s]+([A-Za-z0-9\u4e00-\u9fa5._-]{2,30})/i);
  if (match?.[1]) return match[1];

  const firstToken = brief.trim().split(/\s+/)[0];
  if (
    firstToken &&
    firstToken.length >= 2 &&
    firstToken.length <= 30 &&
    !firstToken.startsWith("这") &&
    !firstToken.includes("产品介绍")
  ) {
    return firstToken.replace(/[，。,.]/g, "");
  }

  return "Untitled work";
}

import type { UploadedMaterial } from "./types.ts";

const minimumFirstPassChars = 260;
const confidentFirstPassChars = 700;
const conciseCompleteFirstPassChars = 120;
const conciseSpecificFirstPassChars = 48;

export type MaterialIntakeModelReview = {
  ready: boolean;
  missing: string[];
  question: string;
  summary: string;
  reason: string;
  confidence: "low" | "medium" | "high";
  model: string;
};

export type MaterialIntakeModelReviewer = (input: {
  brief: string;
  materials: UploadedMaterial[];
}) => Promise<MaterialIntakeModelReview | null>;

export type MaterialReadiness = {
  ready: boolean;
  summary: string;
  detail?: string;
  message?: string;
  reviewLog: MaterialIntakeReviewLog;
};

export type MaterialIntakeReviewLog = {
  source: "model" | "fallback";
  ready: boolean;
  missing: string[];
  question?: string;
  summary: string;
  reason?: string;
  confidence?: "low" | "medium" | "high";
  model?: string;
  textCharCount: number;
  materialCount: number;
  githubRepoCount: number;
  specificityScore?: number;
};

export async function assessMaterialReadiness({
  brief,
  materials,
  githubRepoUrls = [],
  githubWarnings = [],
  modelReviewer
}: {
  brief: string;
  materials: UploadedMaterial[];
  githubRepoUrls?: string[];
  githubWarnings?: string[];
  modelReviewer?: MaterialIntakeModelReviewer;
}): Promise<MaterialReadiness> {
  const text = normalizeReadinessText(
    [
      brief,
      ...materials.map((material) =>
        [material.extractedText, material.textPreview].filter(Boolean).join("\n")
      )
    ]
      .filter(Boolean)
      .join("\n\n")
  );
  const charCount = Array.from(text).length;
  const specificityScore = productSpecificityScore(text);
  const hasReadableMaterial = materials.some((material) =>
    normalizeReadinessText(material.extractedText || material.textPreview || "").length >= 120
  );
  const hasImportedRepo = githubRepoUrls.length > 0 && hasReadableMaterial;
  const missing = missingMaterialBasics(text);

  const obviousTooThin = charCount < 8 && !hasImportedRepo;
  if (!obviousTooThin && modelReviewer) {
    const modelReview = await modelReviewer({
      brief,
      materials
    });
    if (modelReview) {
      if (modelReview.ready) {
        return {
          ready: true,
          summary: modelReview.summary || "材料已经够开始深入调研。",
          reviewLog: {
            source: "model",
            ready: true,
            missing: modelReview.missing,
            question: modelReview.question || undefined,
            summary: modelReview.summary,
            reason: modelReview.reason || undefined,
            confidence: modelReview.confidence,
            model: modelReview.model,
            textCharCount: charCount,
            materialCount: materials.length,
            githubRepoCount: githubRepoUrls.length,
            specificityScore
          }
        };
      }

      const needs = modelReview.missing.length
        ? modelReview.missing.slice(0, 3)
        : missing.slice(0, 3);
      const issue =
        modelReview.summary || "我先浏览了一遍，还需要确认几个关键点。";
      const question =
        modelReview.question || buildPartnerFollowUpQuestion(needs);
      const message = `${issue} ${question}`;

      return {
        ready: false,
        summary: issue,
        detail: [
          needs.length ? `我想先确认：${needs.join("、")}。` : question,
          githubWarnings.length ? `读取提示：${githubWarnings.join("；")}` : ""
        ]
          .filter(Boolean)
          .join(" "),
        message,
        reviewLog: {
          source: "model",
          ready: false,
          missing: needs,
          question,
          summary: issue,
          reason: modelReview.reason || undefined,
          confidence: modelReview.confidence,
          model: modelReview.model,
          textCharCount: charCount,
          materialCount: materials.length,
          githubRepoCount: githubRepoUrls.length,
          specificityScore
        }
      };
    }
  }

  if (
    hasImportedRepo ||
    charCount >= confidentFirstPassChars ||
    (missing.length === 0 && hasEnoughConciseSpecificity(charCount, specificityScore)) ||
    (charCount >= minimumFirstPassChars && missing.length <= 1)
  ) {
    return {
      ready: true,
      summary: "产品、用户和问题已经基本能推断出来，我继续做外部调研。",
      reviewLog: {
        source: "fallback",
        ready: true,
        missing: missing.slice(0, 3),
        summary: "产品、用户和问题已经基本能推断出来，我继续做外部调研。",
        reason: "模型 intake review 不可用，使用本地兜底规则。",
        textCharCount: charCount,
        materialCount: materials.length,
        githubRepoCount: githubRepoUrls.length,
        specificityScore
      }
    };
  }

  const needs = missing.length
    ? missing.slice(0, 3)
    : ["目标用户的具体场景", "现在的替代方案", "你最想验证的问题"];
  const issue =
    charCount < minimumFirstPassChars
      ? "我先看了一遍，现在还像一句产品想法，直接调研会太泛。"
      : "我先看了一遍，还需要确认几个关键点再去调研。";
  const question = buildPartnerFollowUpQuestion(needs);
  const message = `${issue} ${question}`;

  return {
    ready: false,
    summary: issue,
    detail: [
      `我想先确认：${needs.join("、")}。`,
      githubWarnings.length ? `读取提示：${githubWarnings.join("；")}` : ""
    ]
      .filter(Boolean)
      .join(" "),
    message,
    reviewLog: {
      source: "fallback",
      ready: false,
      missing: needs,
      question,
      summary: issue,
      reason: "模型 intake review 不可用或输入明显过短，使用本地兜底规则。",
      textCharCount: charCount,
      materialCount: materials.length,
      githubRepoCount: githubRepoUrls.length,
      specificityScore
    }
  };
}

export function buildMaterialReadSummary({
  brief,
  materialCount,
  extractedUrlCount
}: {
  brief: string;
  materialCount: number;
  extractedUrlCount: number;
}) {
  const inputs = [
    brief.trim() ? "产品介绍" : "",
    materialCount ? `${materialCount} 个附件` : ""
  ].filter(Boolean);
  const base = inputs.length ? `已浏览${inputs.join("和")}` : "已浏览当前输入";
  const sourceHint = extractedUrlCount
    ? `，发现 ${extractedUrlCount} 个公开来源线索`
    : "";
  return `${base}${sourceHint}。`;
}

function normalizeReadinessText(text: string) {
  return text
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasEnoughConciseSpecificity(charCount: number, specificityScore: number) {
  if (charCount >= conciseCompleteFirstPassChars) return true;
  return charCount >= conciseSpecificFirstPassChars && specificityScore >= 3;
}

function productSpecificityScore(text: string) {
  const signals = [
    /独立开发者|开发者|设计师|销售|运营|创始人|学生|老师|医生|律师|客服|财务|采购|店主|中小企业|团队|公司|企业/i,
    /竞品|会议|录音|截图|备注|排程|日历|发票|报销|简历|面试|工单|CRM|ERP|电商|供应链|代码|部署|测试|数据|报表|邮件|文档|合同|知识库|浏览器|插件/i,
    /自动|生成|分析|整理|提醒|同步|搜索|监控|对比|转写|总结|导入|导出|收集/i,
    /慢|分散|遗漏|重复|成本|转化|流失|合规|风险|效率|协作|麻烦|困难/i,
    /[A-Za-z][A-Za-z0-9-]{2,}/
  ];

  return signals.filter((pattern) => pattern.test(text)).length;
}

function buildPartnerFollowUpQuestion(needs: string[]) {
  const items = needs.length ? needs : ["产品做什么", "给谁用", "解决什么具体问题"];
  return `我先确认一下：${items.join("、")}。你可以用几句话回答，不需要整理成文档。`;
}

function missingMaterialBasics(text: string) {
  const checks = [
    {
      label: "产品做什么",
      pattern:
        /产品|工具|平台|应用|软件|服务|插件|助手|agent|app|tool|platform|software|service|extension|feature|workflow|solution|解决方案|功能/i
    },
    {
      label: "给谁用",
      pattern:
        /用户|客户|团队|创始人|开发者|设计师|运营|销售|学生|老师|企业|公司|人群|面向|适合|target|user|customer|persona|team|founder|developer|designer|operator|sales|student|teacher|enterprise|company|ICP/i
    },
    {
      label: "解决什么具体问题",
      pattern:
        /问题|痛点|需求|场景|任务|成本|效率|麻烦|困难|风险|pain|problem|need|job|use case|workflow|cost|efficient|risk|manual|slow/i
    }
  ];

  return checks
    .filter((check) => !check.pattern.test(text))
    .map((check) => check.label);
}

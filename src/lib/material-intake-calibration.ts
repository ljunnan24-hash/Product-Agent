import {
  assessMaterialReadiness,
  type MaterialReadiness
} from "./material-intake-readiness.ts";
import type { UploadedMaterial } from "./types.ts";

type MaterialIntakeCalibrationExpectation = {
  ready: boolean;
  missingIncludes?: string[];
  questionIncludes?: string[];
  forbiddenTerms?: string[];
};

export type MaterialIntakeCalibrationCase = {
  id: string;
  title: string;
  category:
    | "too_thin"
    | "slogan"
    | "generic_complete"
    | "missing_user"
    | "missing_problem"
    | "concise_ready"
    | "detailed_ready"
    | "attachment_ready";
  brief: string;
  materials?: UploadedMaterial[];
  expected: MaterialIntakeCalibrationExpectation;
  whyIncluded: string;
};

export type MaterialIntakeCalibrationResult = {
  id: string;
  title: string;
  category: MaterialIntakeCalibrationCase["category"];
  passed: boolean;
  expectedReady: boolean;
  actualReady: boolean;
  charCount: number;
  specificityScore: number;
  missing: string[];
  question: string;
  failures: string[];
};

const defaultForbiddenFollowUpTerms = ["README", "PDF", "材料", "链接", "请补充", "表单"];

export const materialIntakeCalibrationCases: MaterialIntakeCalibrationCase[] = [
  {
    id: "too-thin-ai-tool",
    title: "极短想法只说 AI 工具",
    category: "too_thin",
    brief: "AI工具",
    expected: {
      ready: false,
      missingIncludes: ["给谁用", "解决什么具体问题"],
      questionIncludes: ["我先确认一下"]
    },
    whyIncluded: "第一句话太薄时应该先问清目标用户和问题，不能直接进入泛泛调研。"
  },
  {
    id: "slogan-growth-assistant",
    title: "像口号但没有具体问题",
    category: "slogan",
    brief: "更懂创始人的增长助手",
    expected: {
      ready: false,
      missingIncludes: ["解决什么具体问题"],
      questionIncludes: ["我先确认一下", "解决什么具体问题"]
    },
    whyIncluded: "用户常用一句定位感很强的话开头，Agent 应该补问具体任务而不是评价口号。"
  },
  {
    id: "generic-complete-student-ai",
    title: "三要素都有但仍然太泛",
    category: "generic_complete",
    brief: "给学生用的 AI 工具，解决学习效率问题。",
    expected: {
      ready: false,
      questionIncludes: ["目标用户的具体场景", "现在的替代方案"]
    },
    whyIncluded: "产品、用户、问题三个词都出现了，但缺少可搜索的具体场景，应该追问而不是被关键词骗过。"
  },
  {
    id: "missing-user-meeting-notes",
    title: "知道功能和痛点但不知道给谁用",
    category: "missing_user",
    brief: "自动会议纪要工具，可以把录音转成待办事项，解决会后整理慢、遗漏任务的问题。",
    expected: {
      ready: false,
      missingIncludes: ["给谁用"],
      questionIncludes: ["给谁用"]
    },
    whyIncluded: "功能和痛点明确，但目标人群不同会改变竞品和付费判断。"
  },
  {
    id: "missing-problem-browser-plugin",
    title: "知道用户和功能但不知道痛点",
    category: "missing_problem",
    brief: "给独立开发者用的浏览器插件，可以收集竞品网页截图和备注。",
    expected: {
      ready: false,
      missingIncludes: ["解决什么具体问题"],
      questionIncludes: ["解决什么具体问题"]
    },
    whyIncluded: "用户和功能明确但没有 job/pain，Agent 应该先问为什么要用。"
  },
  {
    id: "concise-ready-competitor-research",
    title: "简短但具体的一句话",
    category: "concise_ready",
    brief:
      "给独立开发者用的浏览器插件，自动收集竞品网页截图和备注，解决做产品调研时信息分散、整理慢、团队复盘难的问题。",
    expected: {
      ready: true
    },
    whyIncluded: "不应该因为没有长文档就补问；这类一句话已经足够开始外部调研。"
  },
  {
    id: "detailed-ready-sales-crm",
    title: "稍完整的产品介绍",
    category: "detailed_ready",
    brief:
      "我们做一个面向 20-100 人 B2B 销售团队的客户跟进助手，接入 CRM、邮件和会议纪要，自动总结客户状态、提醒下一步动作，并把高风险商机标出来。现在的痛点是销售主管每天要翻很多记录，漏跟进和判断失真会直接影响转化率。我们想验证团队愿不愿意把它作为每周 pipeline review 的固定工具使用。",
    expected: {
      ready: true
    },
    whyIncluded: "完整介绍应该直接进入调研，不应该再要求用户补齐格式化字段。"
  },
  {
    id: "attachment-ready-local-services",
    title: "关键信息在附件文本里",
    category: "attachment_ready",
    brief: "帮我看看这个产品有没有潜力",
    materials: [
      fakeTextMaterial(
        "local-services-note.txt",
        "这是一个给本地家政和维修小店用的预约排班工具。店主可以把微信咨询、电话预约和员工空闲时间放到一个页面里，自动生成可确认的服务时间，减少漏单、撞单和反复沟通。我们想先验证 3-10 人小团队是否愿意每月付费，以及他们现在用微信群、Excel 或美团商家后台解决到什么程度。"
      )
    ],
    expected: {
      ready: true
    },
    whyIncluded: "用户可能只写一句话但附了说明，readiness 必须合并附件内容判断。"
  }
];

export async function runMaterialIntakeCalibration(
  cases = materialIntakeCalibrationCases
) {
  const results: MaterialIntakeCalibrationResult[] = [];

  for (const testCase of cases) {
    const readiness = await assessMaterialReadiness({
      brief: testCase.brief,
      materials: testCase.materials ?? []
    });
    results.push(evaluateCase(testCase, readiness));
  }

  return {
    passed: results.every((result) => result.passed),
    results
  };
}

function evaluateCase(
  testCase: MaterialIntakeCalibrationCase,
  readiness: MaterialReadiness
): MaterialIntakeCalibrationResult {
  const failures: string[] = [];
  const question = [
    readiness.message,
    readiness.reviewLog.question,
    readiness.summary,
    readiness.detail
  ]
    .filter(Boolean)
    .join(" ");
  const expected = testCase.expected;

  if (readiness.ready !== expected.ready) {
    failures.push(`expected ready=${expected.ready}, got ready=${readiness.ready}`);
  }

  for (const text of expected.missingIncludes ?? []) {
    if (!readiness.reviewLog.missing.some((item) => item.includes(text))) {
      failures.push(`missing list does not include "${text}"`);
    }
  }

  for (const text of expected.questionIncludes ?? []) {
    if (!question.includes(text)) {
      failures.push(`question does not include "${text}"`);
    }
  }

  if (!readiness.ready) {
    for (const text of expected.forbiddenTerms ?? defaultForbiddenFollowUpTerms) {
      if (question.includes(text)) {
        failures.push(`follow-up should not expose "${text}"`);
      }
    }
  }

  return {
    id: testCase.id,
    title: testCase.title,
    category: testCase.category,
    passed: failures.length === 0,
    expectedReady: expected.ready,
    actualReady: readiness.ready,
    charCount: readiness.reviewLog.textCharCount,
    specificityScore: readiness.reviewLog.specificityScore ?? 0,
    missing: readiness.reviewLog.missing,
    question,
    failures
  };
}

function fakeTextMaterial(name: string, extractedText: string): UploadedMaterial {
  return {
    id: name,
    name,
    type: "text/plain",
    size: extractedText.length,
    url: "",
    metrics: null,
    extractedText,
    textPreview: extractedText.slice(0, 240),
    extractedUrls: []
  };
}

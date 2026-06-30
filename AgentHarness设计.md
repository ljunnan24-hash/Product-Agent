# Agent Harness 设计

日期：2026-06-24

## 1. 设计目标

Product Agent 的用户不只想看结论，还想看 Agent 是怎么判断的。

但产品不应该暴露模型隐藏 chain-of-thought。更好的方式是展示一个可验证的 harness：

- 计划：Agent 准备按什么步骤处理。
- 证据：读了哪些材料、抓了哪些网页、哪些搜索被跳过。
- 工具：每一步调用了什么工具，输入/输出摘要是什么。
- 判断：哪些信号影响潜力分。
- 边界：哪些地方证据不足，哪些只是推断。

这让用户感到“我看得见 Agent 在工作”，同时也让报告更可信、可调试、可复盘。

## 2. 学习到的优秀模式

### Claude Code / Claude Agent SDK

值得学习：

- tools 是能力边界。
- hooks 用于工具前后拦截、审计、注入上下文。
- subagents 用于隔离上下文，避免主会话膨胀。
- permissions 控制读、写、网络和执行权限。
- sessions / checkpoints 支持长任务恢复。

落到 Product Agent：

- README reader、web research、potential assessment 都是明确工具节点。
- 每个节点保存 trace step 和 tool call。
- 后续把 web research 拆成独立 research subagent。

### OpenAI Agents SDK

值得学习：

- agent 应该拥有 orchestration、tool execution、approvals、state。
- tracing 记录 LLM generations、tool calls、handoffs、guardrails、custom events。
- guardrails 应该围绕每个工具调用，不只围绕最终输出。

落到 Product Agent：

- 当前先展示本地 trace。
- 后续引入 trace/span 模型：run -> stage -> tool call -> evidence。
- 每个网页抓取工具前做 URL 安全 guardrail。

### Anthropic Effective Agents

值得学习：

- 优先使用简单可组合 workflow。
- prompt chaining 适合固定步骤任务。
- routing 适合不同材料类型。
- parallelization 适合多个独立证据源。
- evaluator-optimizer 适合报告质量修复。

落到 Product Agent：

- README / PDF / image 先 routing。
- README 链接抓取和搜索可并行。
- 后续加 evaluator 检查“潜力判断是否被证据支持”。

### LangGraph

值得学习：

- graph state 和 checkpoints 让任务可暂停、可恢复、可回放。
- human-in-the-loop 可以在敏感工具调用前中断。

落到 Product Agent：

- P1 引入 pending approval：抓取外部网页、公开报告、深度分析前可让用户确认。
- 保存完整 AgentState，支持重新生成报告而不重复抓取网页。

## 3. 当前 Harness 结构

报告页右侧的 Agent Harness 包含：

1. 运行概览
   - 材料数
   - 网页证据数
   - 产品潜力分

2. 判断过程
   - 拆材料
   - 找证据
   - 判信号
   - 定结论

3. 证据来源
   - crawled URL
   - search result
   - skipped reason

4. 工具调用
   - stage title
   - status
   - tool name
   - input summary
   - output summary
   - latency

5. 质量指标
   - 产品潜力
   - 行动清晰度
   - 问题覆盖度
   - 发布说服力

## 4. 后续理想形态

### P1: Trace Span 模型

```ts
type AgentSpan = {
  id: string;
  parentId?: string;
  type: "stage" | "tool" | "model" | "guardrail" | "evidence";
  title: string;
  status: "running" | "completed" | "failed" | "skipped";
  startedAt: string;
  endedAt?: string;
  inputSummary?: string;
  outputSummary?: string;
  evidenceIds?: string[];
};
```

### P1: Evidence Store

```ts
type EvidenceItem = {
  id: string;
  source: "readme" | "pdf" | "crawl" | "search" | "user";
  url?: string;
  quote?: string;
  summary: string;
  confidence: number;
};
```

### P1: Human Checkpoints

触发条件：

- 即将抓取超过 5 个 URL。
- 即将公开分享报告。
- 外部搜索结果和 README 自述冲突。
- potential_score 高但 evidence confidence 低。

用户动作：

- approve
- edit
- reject
- respond

## 5. 设计原则

- 让用户看见证据，不展示隐藏思维链。
- 先展示摘要，再允许展开细节。
- 把 skipped 和 limitations 当成一等信息。
- 不伪造搜索，不伪造网页证据。
- 潜力分必须有 evidence backing。
- 工具调用要能调试，报告结论要能复盘。

## 参考来源

- Claude Agent SDK overview: https://code.claude.com/docs/en/agent-sdk/overview
- Claude Code hooks: https://code.claude.com/docs/en/agent-sdk/hooks
- OpenAI Agents SDK: https://developers.openai.com/api/docs/guides/agents
- OpenAI Agents SDK tracing: https://openai.github.io/openai-agents-python/tracing/
- OpenAI Agents SDK guardrails: https://openai.github.io/openai-agents-python/guardrails/
- Anthropic, Building Effective Agents: https://www.anthropic.com/engineering/building-effective-agents
- LangGraph persistence: https://docs.langchain.com/oss/python/langgraph/persistence
- LangChain human-in-the-loop: https://docs.langchain.com/oss/python/langchain/human-in-the-loop

# Agent 成熟度调研与遗漏清单

日期：2026-06-28

## 第五次严审：这次真正要承认的遗漏

这次问题很严重。不是“有没有 subagent 文件”这么简单，而是我前面没有从第一天把这个产品当成一个长任务、多工具、多证据、可中断、可恢复、可审计的 agent runtime 来设计。

调研 Claude Code、Anthropic Research、OpenAI Agents SDK、LangGraph、MCP 和 OWASP LLM 风险后，我对当前项目的判断是：

当前已经有 `SubagentRunner`、`ContextManager`、`TaskGraph`、`Worker Queue`、`Durable Queue`、`Interrupt`、`Resume`、`Trace` 和 `Artifact`，但大量能力还处在“账本/可见性层”。成熟 agent 需要的是“控制平面”：谁能开 worker、worker 拿什么上下文、何时并行、何时暂停、如何恢复、哪些证据过期、哪些结论被禁止、哪些成本和失败要被记录。

### 外部优秀 agent 的关键共识

1. Claude Code subagents 的核心不是名字叫 subagent，而是每个 subagent 有自己的 context window、system prompt、工具权限和独立权限边界；适合把搜索结果、日志、大文件内容隔离出去，只把摘要带回主上下文。来源：[Claude Code subagents](https://docs.anthropic.com/en/docs/claude-code/sub-agents)
2. Anthropic Research 使用 orchestrator-worker：lead agent 规划策略，派生多个 subagent 并行调研，再合并结果。这个结构解决的是复杂调研超过单上下文窗口的问题。来源：[Anthropic multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)
3. Anthropic effective agents 强调先用简单、可组合模式，复杂任务才上 orchestrator-workers / evaluator-optimizer。对本产品来说，网页证据调研属于确实值得拆 worker 的复杂任务。来源：[Building Effective Agents](https://www.anthropic.com/research/building-effective-agents)
4. Context engineering 的核心是压缩、隔离和动态取用，不是把更多原文塞进 prompt。长任务要保存关键状态，丢弃冗余工具输出。来源：[Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
5. OpenAI Agents SDK 把 tools、handoffs、guardrails、structured outputs、tracing 作为一等对象；trace 应覆盖 LLM generation、tool call、handoff、guardrail 和自定义事件。来源：[OpenAI Agents SDK](https://openai.github.io/openai-agents-python/agents/) / [Tracing](https://openai.github.io/openai-agents-python/tracing/)
6. LangGraph 把 checkpoint、interrupt、store 分开：checkpoint 负责线程级恢复，store 负责长期记忆，interrupt 负责暂停等待外部输入。来源：[LangGraph persistence](https://docs.langchain.com/oss/python/langgraph/persistence) / [interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts)
7. MCP 的启发是所有外部系统都应该通过 schema 化工具/资源接入，而不是散落在业务函数里。来源：[MCP intro](https://modelcontextprotocol.io/docs/getting-started/intro) / [MCP tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)
8. OWASP 把 prompt injection 列为 LLM 应用高风险项。对我们来说，README、PDF、网页、GitHub issue、竞品页面都必须是 untrusted evidence，不能直接污染指令上下文。来源：[OWASP LLM Top 10](https://owasp.org/www-project-top-10-for-large-language-model-applications/)

### 我遗漏或低估的 12 件事

| 能力 | 成熟 agent 应该怎样 | 当前项目状态 | 严重性 |
| --- | --- | --- | --- |
| Orchestrator 控制平面 | 主 agent 只规划、分派、合并和裁决 | 有 Research Supervisor 和 TaskGraph，但很多逻辑还在过程式函数里 | P0 |
| 真 subagent 隔离 | 每个 worker 独立 context、prompt、工具权限、预算、输出 schema、transcript、artifact | 有 `SubagentRunner` 和 `ContextManager` 第一版，但仍未成为所有高上下文任务的强制入口 | P0 |
| Durable graph execution | 每个 node 持久化 input/state/output/error/lease/timeout/cancel/retry | 有 durable worker queue 和 replay 第一版，但 graph 本身还不是 durable runtime | P0 |
| Node-level replay | 从 worker/tool/task node 精确恢复，只刷新受影响下游 | 已有 task-node replay、evidence_extract replay、impact ledger，但派生产物仍多为分析记录级刷新 | P0 |
| Hard interrupt | 缺 key、缺证据、需批准深查、强结论阻断时真正暂停 | 有 hard interrupt 第一版，但不是所有节点都能从 interrupt 精确恢复 | P0 |
| Context compaction | 长网页/搜索噪音永远进 artifact，只给主 agent handoff/ref | 有 context pack 和 dropped refs 记录，但还缺 token 级强约束和自动续跑压缩 | P0 |
| Tool registry 全覆盖 | 每个工具都有 schema、权限、成本、超时、缓存、guardrail、failure taxonomy | `web_search/web_fetch/file/pdf/ocr/github` 已逐步接入，但 judge/model_report/follow_up 等还未统一到完整协议 | P0/P1 |
| Evidence provenance/freshness | source hash、抓取时间、发布时间、引用片段校验、时效规则、刷新策略 | 有证据卡和引用绑定，但缺严格来源哈希、引用校验和过期刷新器 | P1 |
| Web evidence security | 外部内容是数据，不是指令；隔离 prompt injection、SSRF、secret 泄漏 | 有基础 guardrail，但还缺全局 untrusted-content sandbox 和红队测试 | P0 |
| Memory system | Product / Calibration / Procedural 三层记忆，带来源、作用域、过期和冲突处理 | 还没有正式 memory store | P1 |
| AgentRunEval | 评估轨迹，不只评最终报告：覆盖反证、时效、来源质量、工具效率、恢复能力 | 有回测/盲测，但 trajectory eval 不完整 | P1 |
| Versioning/cost ledger | 每次记录 prompt/schema/tool/model/provider/harness 版本和成本 | 零散记录，尚不能支撑可解释回放 | P1 |

### 根因

我前面推进得快的地方是“用户能看到过程”和“报告有证据约束”，但我低估了 Product Agent 的任务性质：它本质上更接近 Research agent，而不是普通 chat app。

Research agent 的难点不是生成一份好看的报告，而是长期执行时：

- 搜索和抓取会快速污染主上下文。
- 不同证据路径需要并行探索。
- 网页/PDF/README 都是不可信输入。
- 用户常常要中途补 key、补材料、批准深查。
- 单个 worker 失败后不能整条链重跑。
- 旧证据会过期，旧判断会污染新判断。

所以我之前把 subagent、durable execution、interrupt、memory、eval 的优先级排得太晚，这是架构上的错误判断。

### 纠正后的优先级

1. 先把 `TaskGraph` 从“展示用结构”升级成“可执行 graph runtime”：节点有定义、依赖、输入引用、输出引用、状态机、lease、cancel、retry、timeout。
2. 把所有高上下文任务强制走 `SubagentRunner`：README/PDF 读材料、GitHub import、网页搜索、网页抓取、证据抽取、反证、时效、竞品、Judge、Report Composer、Follow-up。
3. 做真正的 `GraphExecutor`：按 DAG fan-out/fan-in 调度 worker，主 agent 只接收 handoff，不接收长正文。
4. 做 context budget 硬约束：每个 worker 超预算必须压缩、截断并记录 dropped context；report model 只能看到 Evidence Brief / Judge / Handoff / citation refs。
5. 把 interrupt 变成运行时协议：任何 P0 阻断都能保存 checkpoint，等待用户动作，再从 checkpoint 继续。
6. 做 provenance/freshness v2：每个证据有 source hash、fetch time、publish time、claim binding、freshness policy、stale refresh。
7. 做 AgentRunEval：每次 run 自动评估 agent 轨迹，检查是否查反证、查时效、查竞品、引用足够、是否浪费工具、是否能局部恢复。
8. 最后再做 Memory Store：先稳住执行控制层，再把 Product/Calibration/Procedural memory 接进来，否则旧结论会污染判断。

### 下一步工程动作

不是继续零散补 UI。下一步应该做 `GraphExecutor v1`：

- 定义 `AgentTaskNodeDefinition`，把 node 类型、输入 schema、输出 schema、worker definition、依赖、retry policy、interrupt policy、freshness policy 固定下来。
- 给 `TaskGraph` 增加可执行状态机：`pending -> queued -> running -> completed/failed/skipped/interrupted/cancelled`。
- 让搜索、抓取、证据抽取不再由过程式代码直接串起来，而是由 executor 调度。
- 每个 node 输出只落 artifact/handoff，主流程只合并引用。
- Resume/Interrupt 都以 task node 为恢复单元，而不是以整份分析为恢复单元。

这一步完成后，后面的记忆系统、长期任务、证据时效、回测校准才会有稳定地基。

## 本轮再审结论：subagent 只是症状，漏的是执行控制平面

这次重新调研 Claude Code subagents、Anthropic effective agents / context engineering、LangGraph persistence / interrupts、OpenAI Agents SDK、MCP 和 OWASP LLM 风险后，结论更尖锐：

当前不是“完全没有 subagent”。项目已经有 `SubagentRunner`、`ContextManager`、`worker_context`、`worker_transcript`、`taskGraph`、`workerQueue`、`interrupts` 和 `runtime-resume`。真正严重的问题是：这些还偏“可见账本 + 请求内执行”，还没有升级成 agent 的执行控制平面。

做好这个 Product Agent，至少还必须补齐 9 个被低估的能力：

1. Durable Graph Runtime：每个 task node / worker / tool call 都要有持久化输入、状态、输出、错误、依赖、lease、timeout、cancel 和 retry，不依赖单次 HTTP 请求跑完。
2. 真正的 Subagent Isolation：高上下文任务不能只记录为 worker，而要有独立 context pack、system prompt、工具 allowlist、预算、输出 schema、transcript、artifact 和失败边界；主 agent 只接收 handoff。
3. Node-level Replay：从 `contextPackId`、原始工具输入、artifact refs、idempotency key 和 checkpoint 恢复搜索、抓取、证据抽取、补证 loop，而不是只重跑 Judge/Report。
4. Hard Interrupt / Approval：缺 key、缺材料、证据不足、深查超预算、强结论被阻断时要真正暂停对应节点，等待用户补充或批准后继续。
5. Tool Registry 全覆盖：`file_read`、`pdf_extract`、`github_import`、`ocr`、`follow_up`、`judge`、`model_report` 都必须有 schema、权限、成本、超时、缓存、guardrail、failure taxonomy。
6. Web Evidence Security：网页/PDF/README 都是 untrusted evidence，必须隔离 prompt injection、SSRF、内网 URL、secret 泄露和指令污染；报告模型不能直接吃网页正文。
7. Evidence Provenance / Freshness：每条证据要有 source hash、抓取时间、发布时间、引用片段校验、生命周期时效规则、过期刷新策略和冲突处理。
8. AgentRunEval：不能只看最终报告，要评估 trajectory：是否查了反证、时效、竞品、采用信号，是否重复查询，是否证据不足还强结论，是否可局部恢复。
9. Versioning / Replay Ledger：每次运行记录 prompt、schema、tool policy、context manager、judge rule、模型、搜索 provider 和 harness 版本，否则回测偏差无法定位。

所以，下一步优先级不能继续平均铺功能。应该先把“subagent 运行账本”升级成“durable subagent runtime”，否则记忆系统、更多回测样本和更漂亮的 UI 都会建在不稳定的执行层上。

## 这次问题的结论

这次暴露的问题是架构优先级错误：我前面把“可见运行过程、证据账本、报告质检”推进得很快，但没有从第一天就把 Product Agent 当成一个长任务、多工具、多证据、可恢复的执行系统来设计。

对这个产品来说，subagent 不是锦上添花。它是防止上下文污染、证据混杂、长网页拖垮主上下文、失败后只能全量重跑的底层能力。

当前项目已有 `SubagentRunner`、`taskGraph`、`ContextManager`、`resumePlan`、`tool-cache`、`worker_context`、`worker_transcript` 和可见 trace，但这些目前更像“运行账本 + 第一版控制面”。距离成熟 agent 还差三块硬东西：

1. 真正的节点级执行器：失败后只恢复某个 worker/tool/task node。
2. 真正的 interrupt：缺证据、缺 key、需批准深查时暂停并等待用户输入。
3. 真正的记忆和评估：用来源、时间、适用范围和后验结果校准 agent，而不是把旧结论塞回上下文。

## 外部优秀 Agent 的共识

### 1. Anthropic：从简单 workflow 开始，但搜索/调研类任务适合 orchestrator-workers

Anthropic 的 Building Effective Agents 把模式拆成 prompt chaining、routing、parallelization、orchestrator-workers、evaluator-optimizer 和 autonomous agent。关键点是：复杂搜索任务适合由 orchestrator 动态拆任务、worker 分头查证、最后合并结果；但复杂度只有在提升效果时才值得引入。

对我们的启发：

- Product Agent 不是单次问答，而是证据调研任务。
- 搜索、反证、时效、竞品、网页抓取、证据抽取应该是 worker。
- 主 agent 应该规划和合并，不应该吞网页全文和搜索噪音。

来源：https://www.anthropic.com/research/building-effective-agents

### 2. Claude Code：subagent 的核心价值是上下文隔离

Claude Code subagents 的定义很明确：每个 subagent 有自己的 context window、system prompt、工具权限和独立权限边界；适合处理会把主对话塞满的搜索结果、日志、文件内容。

对我们的启发：

- “网页抓取”“README 深读”“竞品调研”“反证挖掘”都应默认走隔离 worker。
- worker 返回的不是完整过程，而是压缩 summary、artifact refs、证据卡和不确定性。
- 子任务中间噪音不能回灌主上下文。

来源：https://docs.anthropic.com/en/docs/claude-code/sub-agents

### 3. Context engineering：上下文是有限预算，不是越多越好

Anthropic 的 context engineering 文档强调：长任务要靠 compaction、structured note-taking、multi-agent architecture；Agent 应该保留最小高信号上下文，用文件路径、artifact refs、URL、query 等轻量标识进行 just-in-time retrieval。

对我们的启发：

- Evidence Card / Handoff Packet / Context Pack 是正确方向，但要强制执行。
- 不能让报告模型看到长网页、原始搜索结果和失败日志。
- 每个 context pack 都要有预算、保留规则、丢弃记录和恢复锚点。

来源：https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents

### 4. OpenAI Agents SDK：成熟 agent runtime 要管理 orchestration、tool execution、state、approvals、observability

OpenAI Agents SDK 的核心不是“再调一个模型”，而是让应用拥有 orchestration、tool execution、approvals、state；handoffs、guardrails、tracing、results/state 和 eval 都是一等对象。

对我们的启发：

- 现在的 trace 是必要但不充分。
- 恢复、审批、状态、工具边界必须是 API 和 UI 操作，而不是只在报告里展示。
- 最终要能基于 trace 做 eval improvement loop。

来源：https://developers.openai.com/api/docs/guides/agents  
来源：https://openai.github.io/openai-agents-python/tracing/  
来源：https://developers.openai.com/cookbook/examples/agents_sdk/agent_improvement_loop

### 5. LangGraph：checkpoint / interrupt / store 是长任务的骨架

LangGraph 把 graph state、checkpointer、interrupt、store 分开：checkpointer 保存线程级状态，store 保存跨线程记忆，interrupt 可以在任意节点暂停并等待外部输入。

对我们的启发：

- `resumePlan` 不能只显示“可以重试”，必须有 executor 能从 checkpoint 继续。
- interrupt 不是 error，而是一种正式状态。
- Memory 不能替代 checkpoint；两者职责不同。

来源：https://docs.langchain.com/oss/python/langgraph/persistence  
来源：https://docs.langchain.com/oss/python/langgraph/interrupts  
来源：https://docs.langchain.com/oss/python/langchain/human-in-the-loop

### 6. MCP：工具和外部资源需要标准化接口

MCP 把 tools、resources、prompts 作为 AI 应用连接外部系统的标准接口。它的价值不是马上引入协议，而是提醒我们工具层必须有清晰 schema、权限、输入输出边界和资源引用。

对我们的启发：

- `web_search`、`web_fetch`、`github_import`、`file_read`、`ocr`、`model_report`、`judge` 都应该进入统一 Tool Registry。
- 每个工具要有安全规则、成本、超时、缓存和输出校验。

来源：https://modelcontextprotocol.io/docs/getting-started/intro  
来源：https://modelcontextprotocol.io/specification/2025-06-18/server/tools

## 当前项目已经有的能力

1. 一个对话入口和上传材料入口。
2. Evidence Brief、Claim Ledger、Source Budget、Evidence Stop Rule。
3. Web research 查询规划、搜索、抓正文、证据归一。
4. 智谱 / DeepSeek 报告模型路由，智谱 Web Search。
5. Report Quality、证据绑定、补证 loop、实验回填。
6. `/backtests` README 后验回测，`/blind-tests` 盲测台。
7. `AgentRuntimeTrace`、span、artifact、handoff、worker run、tool call。
8. `SubagentRunner` 第一版，网页调研、Judge、Report Composer 已接入。
9. `TaskGraph` 第一版，主要节点可见。
10. `ContextManager` 第一版，worker 有 context pack、预算、warnings、dropped refs。
11. `resumePlan`、`stateSnapshots`、`tool-cache` 第一版。
12. `runtime-resume` API 和 UI 第一版：可以保存恢复请求；Judge / Report 末端节点支持自动 replay；搜索、抓取和证据抽取仍会明确返回 unsupported，等待 durable Worker Scheduler。
13. `Worker Scheduler / Queue` 第一版：搜索和抓取 worker 有运行内 queue 账本、优先级、并发组、等待时间、运行时间和 workerRunId/artifact refs；搜索 worker 并发上限为 2。当前还不是后台 durable queue。
14. `Run Interrupt` 第一版：缺搜索 key 和 Judge 阻断会生成 active interrupt，前端可见暂停原因、用户动作和 artifact refs。当前还不是硬停止执行。
15. `Interrupt Resume Protocol` 第一版：interrupt 支持 `queue_resume`、`mark_resolved`、`dismiss`、`wait_for_user`，用户动作会持久化；`queue_resume` 会桥接 runtime resume，Judge/Report 可自动 replay，搜索/抓取等待 durable queue。

## 真正遗漏的东西

### P0-1：Resume Executor，不只是 Resume API

现状：`resumePlan` 和 `runtime-resume` 已经能保存请求；报告页已有恢复按钮；Judge / Report Composer 末端节点可以自动重放并刷新报告与质量审计。搜索、抓取和证据抽取还不能真正局部重放。

需要补：

- `resumeFromWorker(workerRunId)` 覆盖搜索、抓取、证据抽取。
- `resumeFromTool(toolCallId)` 覆盖 `web_search` / `web_fetch`。
- `resumeFromTaskNode(taskNodeId)` 覆盖上游 task graph 节点。
- 从 `stateSnapshot`、`contextPackId`、`artifactIds`、`idempotencyKey` 和工具原始输入恢复。
- 恢复后只更新受影响节点和必要下游节点，不能重跑整份分析。
- UI 持续显示 queued / applied / blocked / unsupported，并能看到恢复结果。

验收标准：

- 已完成第一版：Judge 或 report 失败时，可重跑 judge/report 末端节点。
- 待完成：缺搜索 key 的 run，补 key 后只重跑 search worker。
- 待完成：某个 URL 抓取失败，只重跑对应 fetch worker。

### P0-2：Run Interrupt

现状：已有 `AgentRunInterrupt` 第一版，缺搜索 key、需要用户材料、需要批准深查、证据不足以支撑强报告会进入 active interrupt，并在报告页/回测页可见。但当前仍会继续生成探索性报告，还没有真正把运行停住等待用户输入。

需要补：

- 已完成：`RunInterrupt` 数据结构。
- 已完成：interrupt 类型覆盖 `needs_search_key`、`needs_material`、`approve_deep_research`、`clarify_target_user`、`confirm_competitor_set`、`evidence_too_weak_for_report`。
- 已完成：前端显示“我卡在哪里、需要你做什么、来源和 artifact refs”。
- 待完成：中断时保存可恢复 node 的完整原始输入。
- 已完成第一版：用户响应后可以通过 interrupt action 记录处理结果，并在可支持目标上桥接 resume executor。
- 待完成：高严重度 interrupt 是否硬停止报告生成。

验收标准：

- 已完成第一版：没有搜索能力时，会进入 active `needs_search_key` interrupt。
- 已完成第一版：强结论被 Judge 阻断时，会进入 active interrupt 并降级报告边界。
- 已完成第一版：报告页可以对 interrupt 执行“尝试恢复 / 已处理 / 稍后处理 / 忽略”。
- 待完成：运行真正硬暂停，并在用户补 key/补材料/批准深查后恢复搜索/抓取等上游节点。

### P0-3：真正的 Worker Scheduler / Queue

现状：已有运行内 `workerQueue` 第一版，搜索 worker 会按优先级和并发上限执行，抓取 worker 也会进入 queue 并记录等待/运行/完成状态。但它仍运行在同一服务端请求里，不是后台 durable queue。

需要补：

- 后台 durable queue。
- worker 原始输入持久化和重构。
- 取消运行。
- 跨请求继续和服务重启恢复。
- 任务图 fan-out/fan-in。
- 和 Resume Executor v2 打通搜索/抓取/证据抽取 replay。

验收标准：

- 已完成第一版：同类搜索 worker 可以受控并发，queue 状态可见。
- 待完成：浏览器刷新或断开后，后台任务继续或明确暂停。
- 待完成：失败节点能从 queue 原始输入局部 replay。

### P0-4：Tool Registry 全覆盖

现状：`web_search` / `web_fetch` 比较完整，`judge` / `model_report` 有第一版；`file_read`、`pdf_extract`、`github_import`、`ocr`、`follow_up` 还没完整进入统一工具协议。

需要补：

- 每个工具的 input schema / output schema。
- 权限等级：safe / external_read / expensive / write / risky。
- timeout、cost、cache、retry。
- pre-guardrail 和 post-guardrail。
- output validator。
- failure taxonomy。

验收标准：

- 所有外部信息进入系统时都有 tool call 记录。
- 每个证据都能追溯到工具调用和 artifact。

### P0-5：Web Evidence Security

现状：有 untrusted webpage 提示和基础 URL 安全，但不是全局隔离策略。

需要补：

- 把网页正文视为 untrusted evidence。
- 网页正文永远不能直接进入 report model。
- extractor 只输出结构化 Evidence Card、citation、date、claim relation。
- prompt injection 检测。
- secret redaction。
- SSRF / 内网 URL / file URL / localhost URL 拦截。

验收标准：

- 网页中出现“忽略前面指令”不会进入报告模型可执行上下文。
- 证据卡只保留事实摘录和引用，不保留指令性文本。

### P1-1：Memory System

现状：有分析记录和校准账本，但没有正式 memory store。

需要补三层：

- Product Memory：产品定位、目标用户、材料版本、历史判断、实验结果。
- Calibration Memory：README 高估/低估、后验结果、证据权重、失败模式。
- Procedural Memory：判断规则、工具失败处理、生命周期证据标准。

每条记忆必须有：

- source artifact / analysis id。
- createdAt / updatedAt。
- validUntil 或 refresh policy。
- confidence。
- scope。
- contradiction handling。

关键规则：

- Memory 只能作为上下文提示和校准，不允许绕过当前证据标准。
- 旧 memory 过期或与新证据冲突时必须降权。

### P1-2：AgentRunEval

现状：回测/盲测主要评最终结果和报告质量，还不够评估 agent 轨迹。

需要补：

- trajectory eval：是否查了支持证据、反证、时效、竞品、采用信号。
- tool eval：是否用了正确工具，是否重复查询，是否浪费抓取。
- evidence eval：是否有 URL、日期、正文、来源多样性。
- resume eval：失败是否生成可恢复目标，恢复是否只影响局部节点。
- report eval：最终报告是否严格受证据约束。

验收标准：

- 每次 run 不只产出报告，还产出 AgentRunEval。
- 失败样本能归类到 prompt、tool、search provider、context、judge、report、runtime 中的具体原因。

### P1-3：Versioning / Replay

现状：模型名和部分运行记录有保存，但 prompt/schema/tool/harness version 不完整。

需要补：

- prompt version。
- schema version。
- tool policy version。
- context manager version。
- judge rule version。
- model/provider version。
- search provider version。

验收标准：

- 同一 README 后验回测结果变差时，能知道是模型变了、搜索变了、prompt 变了，还是 agent harness 变了。

## 纠正后的开发顺序

1. 先做 `Durable Subagent Runtime / Worker Queue v2`：把运行内队列升级成后台 durable queue，并补 worker 原始输入持久化、lease、timeout、cancel、fan-out/fan-in 和 hard interrupt。
2. 做 `Resume Executor v2`：从 Judge/Report 扩展到 search / fetch / evidence_extract / evidence_loop，支持单节点 replay 和下游局部刷新。
3. 补全 `Tool Registry` 和 `Web Evidence Security`：所有外部输入都可审计、可阻断，网页/PDF/README 只作为 untrusted evidence 进入 extractor。
4. 做 `Evidence Provenance / Freshness v2`：补 source hash、引用片段校验、证据过期刷新、冲突处理和生命周期时效策略。
5. 做 `AgentRunEval + Versioning`：每次 run 产出轨迹评估，并记录 prompt/schema/tool/model/provider/harness 版本。
6. 再做 `Memory System`：Product / Calibration / Procedural Memory 只能作为可过期、可冲突处理的上下文提示，不能绕过当前证据标准。
7. 最后扩大盲测和回测样本，用真实 trajectory eval 推动调参。

## 对这个产品的判断

方向仍然成立，而且更清楚了：我们的差异化不是“又一个聊天 UI”，而是“证据约束的产品潜力判断 agent”。

但要达到这个目标，核心不是让模型更会写报告，而是让 agent 能可靠地读材料、拆假设、查证据、识别反证、判断时效、暂停求助、局部恢复、沉淀校准。也就是：产品壁垒在 harness，不在单次 prompt。

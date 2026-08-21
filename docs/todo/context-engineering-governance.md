# 上下文工程治理方案（Context Engineering Governance）

> 状态：方案讨论中（P0-P3 未启动）
> 建立日期：2026-08-20
> 复核记录：2026-08-21 基于 `refactor/tools-layer-reorg`（cdd173a2 工具层终态重排后）全量复核锚点与数字；工具 description 总量由估算 ~40K 修正为实测 31,729 字符，precheck 描述已由收资状态机改造瘦身（13.5K→729）
> 参考：[Anthropic - The New Rules of Context Engineering for Claude 5 Generation Models](https://claude.com/blog/the-new-rules-of-context-engineering-for-claude-5-generation-models)
> 本文档是本轮上下文治理的权威状态表；各期完成后回填状态与实测数字。

---

## 一、实测基线（2026-08-20，生产库）

### 每回合 token 消耗（`message_processing_records.token_usage`，近 7 天）

| 指标 | 数值 |
|---|---|
| 回合数（7 天） | 7,618（≈1,088/天） |
| 平均 token/回合 | **104,890** |
| p50 | 74,804 |
| p95 | 232,833 |
| max | 400,163 |
| 周总量估算 | ≈ **8 亿 token/周**（月 ≈ 34 亿） |

### 单步输入构成（近 6 小时 40 条样本，`agent_invocation.request.agentRequest`）

| 部分 | 平均字符数 | 占比（字符口径） |
|---|---|---|
| `system` | ~1,533 | ~2.1% |
| `instructions`（12 段 Section 组装产物） | **~38,632**（max 42,902） | ~52.8% |
| 工具 description（13 常挂合计，分支实测 2026-08-21；zod 参数 schema 另计未含） | **31,729** | ~43.4% |
| `messages`（对话历史窗口） | **~1,273**（max 3,817） | **~1.7%** |

> 注：生产在跑版本的 precheck description 仍可能是瘦身前的 ~13.5K（收资状态机改造随下个发版生效），
> 故生产实测 token 会略高于本表的分支口径；发版后重跑基线 SQL 对齐。

**核心结论**：

1. 每步输入的 **~98% 是静态固定成本**（手册 + 工具描述），对话历史只占 ~1.6%。而现有的全部控量闸门（60 条 / 12000 字符）都作用在那 1.6% 上。
2. 回合平均 10.5 万 token 是多步累积（maxSteps=5，每步全量重发前缀）。多步放大了静态成本：静态部分每多一步就整体重付一次。
3. p95 达 23 万 token 的回合，大概率是工具结果大 + 步数多的组合（工具结果回合内全量累积、无截断）。

### 现状机制盘点（详细出处见附录 A）

- 全链路无 token 级预算；仅条数/字符数闸门，且只覆盖对话历史。
- `finalPrompt` 出口无测长、无落库、无告警（历史上"张漪 case"27K 膨胀靠 badcase 反查发现）。
- 手册 `candidate-consultation.md` 76,327 字节；工具 description 大头是 `duliday_job_list` 13,144 字符（占 13 工具合计 31,729 的 41%），其次 `request_handoff` 4,388、`invite_to_group` 3,804。`duliday_interview_precheck` 已由收资状态机改造（#1023）瘦身至 729 字符（原 ~13.5K）——"状态机接管职责后描述自然变薄"是重要先例。
- session `preferences` 数组、`lastCandidatePool` 写入端、`invitedGroups`/`excludedBrands` 单调增长无 cap。
- booking 上下文每条带 ~1.5-2KB 固定说明文字，多条 booking 重复渲染。
- 工具屏蔽机制触发时把拦截说明**追加**进 instructions（只增不减）。
- 长期摘要已是按需拉取（`recall_history`），跨轮工具结果不落历史——这两处设计健康，保持。

---

## 二、六条规则对本系统的适用性研判

**前提事实**：生产链路无 Claude 模型。主对话 `qwen/qwen3.7-plus`（`system_config.agent_reply_config.wecomCallbackModelId`），extract `deepseek-v4-flash`，复聊 `deepseek-v4-pro`，repair/review `qwen3.7-max`。文章的规则按 Claude 5 世代判断力校准，**「删 80% 规则」的安全边际不可直接移植**。

| 文章规则 | 适用性 | 落到本系统 |
|---|---|---|
| 1. 给规则 → 信判断 | ⚠️ 有条件适用 | qwen3.7-plus 判断力未标定；只能证据门控、小批量删减 + 回归闸（P3）。先例：守卫硬规则 7-10 月下线 20 条成功 |
| 2. 给示例 → 设计接口 | ⚠️ 实验性适用 | `duliday_job_list` 13.1K description 大概率示例过载；用枚举/参数语义替代部分示例（P3），需 A/B。precheck 的收资状态机路径（描述 13.5K→729）证明"职责收进代码、描述随之变薄"可行 |
| 3. 前置一切 → 渐进披露 | ✅ 模型无关，纯赢 | 工具按阶段动态挂载（已有 activeTools 机制 + 2 个动态注入先例）；76KB 手册按阶段分片注入（P2） |
| 4. 重复指令 → 单一居所 | ✅ 模型无关，纯赢 | 手册 vs 工具 description 去重（P1）；与既有裁定一致（工具强绑定进 description，见 docs/knowledge-base/05） |
| 5. 手动记忆 → 自动记忆 | ✅ 已具备 | extractAndSave/settlement 已是自动记忆；零消费字段清理（S8-S10）已随收资批完成，本规则下无剩余治理项 |
| 6. 简单规范 → 丰富引用 | ➖ 不适用 | 面向 IDE 编码代理的规则，运行时招聘 agent 无对应物 |

文章之外、但对本系统杠杆最大的一项：**provider 前缀缓存**。静态前缀占 98%，且多步重发——qwen（DashScope）支持 context cache。若能吃到缓存，成本收益可能超过所有裁剪之和；且要求「静态在前、动态在后」的组装顺序纪律，与渐进披露改造天然互补。

---

## 二·五、治理总纲（2026-08-21 深度讨论定稿的三条裁定）

1. **主目标 = 注意力质量，成本交给缓存**（用户拍板）。裁剪优先级按"内容对规则遵循度的稀释程度"排序：
   重复指令 > 已失效规则 > 低价值教学 > 单纯字节量大的内容。省钱是顺带收益，不是排序依据。
2. **手册就地治理，P2-2 分片降级为"最后考虑"**（用户拍板）。分片会把静态大头变成半动态、打碎跨回合缓存前缀，
   与收益对冲。手册保持稳定前缀地位，治理路径 = P1 去重 → P3 证据门控删规则。
3. **缓存调研先查文档再决定埋点**（用户拍板）。qwen 直连 DashScope 官方端点
   （`dashscope.aliyuncs.com/compatible-mode/v1`），隐式上下文缓存机制上可用且可能已默默生效；
   但 `cached_tokens` 全链路零采集，命中率全盲。先核实现行文档，确认值得测再动代码。

**范围裁定（建议，未见异议即生效）**：本方案只治主 generator 链路。extract（deepseek-v4-flash 廉价）、
复聊（独立 composer）、守卫语义审查（enforce 关闭仅 shadow）不进本方案，避免治理面失焦。

**前缀稳定性现状**（讨论中查明）：组装顺序前三段（identity/base-manual/policy）静态，
`runtime-context` 起（datetime/memory）跨回合必变——现结构已较缓存友好，P2-3 重排的增量空间可能有限，待实测定夺。

---

## 三、治理分期

### P0 — 缓存调研 + 最小止血（轻量化裁定 2026-08-20：不建观测基建）

> 裁定：不新建观测表/看板/分段埋点。理由：完整 prompt 已落库
> （`mpr.agent_invocation.request.agentRequest`，system/instructions/messages 分字段可测长），
> 归因用 ad-hoc SQL 事后可答；98% 大头是两个静态文件，线下即可量。
> 本文档第一节的基线 SQL 即为对比口径，每期收尾重跑一次。

| # | 事项 | 说明 | 状态 |
|---|---|---|---|
| P0-1a | 缓存文档核实 | **✅ 完成（2026-08-21，官方文档 help.aliyun.com/zh/model-studio/context-cache）**，结论见下方 | ✅ |
| P0-1b | 埋点采集 cached_tokens | 在 usage 采集链路加 `prompt_tokens_details.cached_tokens`，随现有 telemetry 落库，跑真实流量看命中率（文档核实后裁定值得测：字段在我们端点上原生可用） | ☐ |
| P0-2 | finalPrompt 膨胀告警 | `prepare()` 出口一行长度检查，超阈值（建议 60K 字符）飞书告警，防张漪 case 式静默膨胀复发（约 10 行代码） | ☐ |

**P0-1a 文档核实结论（2026-08-21，来源：阿里云百炼官方文档 context-cache 页）**：

1. **隐式缓存自动开启、无法关闭**——我们已经在生效状态，只是没观测。qwen3.7-plus 在支持列表（北京地域）。
2. 触发门槛：qwen3.7 系列约 2000 token 起——我们的静态前缀（数万 token）远超门槛。
3. 计费：隐式缓存命中部分按标准输入价 **20%** 计（2 折）；`usage.prompt_tokens_details.cached_tokens` 在 OpenAI 兼容模式（即我们的接入方式）原生可见。
4. **tools 定义作为 system 消息一部分参与前缀缓存**——31.7K 工具描述也在缓存覆盖范围内。
5. 显式缓存（cache_control 标记）：命中 1 折但创建价 125%、TTL 仅 5 分钟（命中重置）。候选人回复间隔常超 5 分钟，
   显式缓存跨回合大概率过期，其增量收益主要在回合内——而回合内隐式已覆盖。**裁定：不做显式缓存，用好隐式即可**。
6. 成本推论：回合内 step 2-5 的前缀大概率已按 2 折计费——**落库的 `token_usage` ≠ 实付成本**，
   基线数字（10.5 万/回合）是名义量；实付口径待 P0-1b 埋点后重算。

**P0 验收**：P0-1b 埋点上线并取得真实命中率数据；膨胀告警上线。

### P1 — 无损瘦身（机械修剪，不依赖模型判断力，全部可回归验证）

| # | 事项 | 预期收益 | 状态 |
|---|---|---|---|
| P1-1 | 手册 vs 工具 description vs 收资状态机 去重审计 | 按既有裁定（工具强绑定进 description）删手册重复段。**最肥靶子**（2026-08-21 新发现）：手册「回合 SOP」与 DB 收资阶段策略文本中，已被收资状态机接管的"怎么收资"教学段——删之有状态机兜底，风险最低 | ☐ |
| P1-2 | booking 块固定说明提取 | N 条 booking 只渲染一次说明文字（每条省 ~1.5-2KB） | ☐ |
| P1-3 | 单调增长加 cap | `lastCandidatePool` 写入 cap、`preferences` 数组上限、`invitedGroups`/`excludedBrands` cap | ☐ |
| P1-4 | 拦截说明追加改替换 | `generator.agent.ts` buildPrepareStep 内去重 | ☐ |
| P1-5 | memory-system-audit S8-S10 | 零消费字段清理。**已随收资批执行完毕**（抽查核实：`preferences.brands` 已删，S9 锚点注释 2026-08-19；审计原文进 git 历史） | ✅ 已完成 |
| P1-6 | 手册维护者内容转注释 | `stripMaintainerComments` 已有剥离机制，把面向维护者的段落改成 HTML 注释 | ☐ |

**P1 验收**：p50 单步输入字符数下降可测量；test-suite 回归全绿。

### P2 — 渐进式披露（结构改造）

| # | 事项 | 说明 | 状态 |
|---|---|---|---|
| P2-1 | 工具按阶段动态挂载 | **裁定暂不做（2026-08-20 用户拍板）**。阶段跳跃兜底成本高于收益；13 工具常挂维持现状。推论：31.7K 工具 description 静态成本只能靠 P3-3 瘦身削减，P3-3 权重上调 | ✋ 暂不做 |
| P2-2 | 76KB 手册分片 | **降级为"最后考虑"（2026-08-21 用户拍板）**：分片打碎缓存前缀，与主目标对冲；手册治理走 P1 去重 → P3 删规则的就地路径 | ⬇ 降级 |
| P2-3 | 组装顺序重排 | 现结构前三段已静态、缓存较友好，重排增量待 P0-1 实测数据定夺；final-check 位于末尾不碍前缀 | ☐ 待实测定 |
| P2-4 | 工具结果回合内控量 | 大工具结果（job_list 20 条页）在后续 step 中降摘要；或降低 DEFAULT_PAGE_SIZE。以 P0 的 p95 归因数据定方案 | ☐ |

**P2 验收**：p50 token/回合显著下降（目标见第五节）；badcase 率无回升。

### P3 — 规则→判断力实验（证据门控，逐批）

| # | 事项 | 说明 | 状态 |
|---|---|---|---|
| P3-1 | 手册绝对化规则清点 | 列出候删规则清单，逐条与 badcase 修复记忆对账（大量规则是历史事故的沉淀，删前必须知道它当年拦的是什么） | ☐ |
| P3-2 | 分批删减 + 回归闸 | 每批过 test-suite 回归 + 语义 shadow 评审对比，不达标即回滚 | ☐ |
| P3-3 | 工具 description 接口化重构 | 主攻 `duliday_job_list`（13,144 字符，占描述总量 41%），次攻 `request_handoff`/`invite_to_group`；示例 → 参数语义/枚举表达（规则 2），A/B 验证 qwen 遵循度。precheck 已随收资状态机完成（13.5K→729），无需再动 | ☐ |

**P3 验收**：每批删减有前后对比数据；总规则量下降且 badcase 率持平。

---

## 四、风险与裁定点

1. **模型判断力错配**：文章按 Claude 5 校准，生产是 qwen3.7-plus。P3 全部小步 + 回归闸，禁止一次性大删。
2. **手册规则是事故沉淀**：precheck 臆造门、身份溯源门、报名真名校验等都是 badcase 换来的。P3-1 对账是硬前置。
3. ~~工具动态挂载的阶段跳跃~~：已随 P2-1 裁定暂不做而消解（2026-08-20）。
4. **示例号码登记**：改动 prompt 中示例须过 example-registry。
5. **并发会话**：本仓库多 AI 会话并发，commit 一律 pathspec 限定。

## 五、验收方式（2026-08-20 裁定：不设硬性数字目标）

不设 p50/字符数的量化 KPI。验收口径：

1. **每期收尾重跑第一节的基线 SQL**，记录前后对比数字回填本文档——只要求"有下降、可解释"，不卡具体幅度。
2. **badcase 率不回升是唯一硬约束**：任何一批改动若回归不过（test-suite / badcase 抽查），回滚该批，与省了多少 token 无关。
3. finalPrompt 膨胀告警上线后长期在位，作为治理成果不倒退的哨兵。

---

## 附录 A：现状机制出处速查（2026-08-21 复核，基于 refactor/tools-layer-reorg@cdd173a2）

- 组装编排：`src/agent/generator/preparation.service.ts:152`（`prepare()`）；入参裁剪 `:173`；出口 `finalPrompt :341` 无测长
- Section 注册表：`src/agent/generator/context/scenarios/scenario.registry.ts:8`；12 叶子段
- 手册：`src/agent/generator/context/prompts/candidate-consultation.md`（76,327B）+ `-final-check.md`（6,505B）
- 历史窗口：60 条（`MAX_HISTORY_PER_CHAT`）/ 12,000 字符（`AGENT_MAX_INPUT_CHARS`，`memory.config.ts:78-83`）；双重裁剪（memory 层 + `preparation.service.ts:173`）
- 工具注册：`src/tools/tool-registry.service.ts:218`（13 常挂清单）、`:306` / `:321`（save_image_description / read_resume_attachment 动态注入）
- 工具 description 实测（字符）：job_list 13,144 / handoff 4,388 / invite 3,804 / geocode 2,221 / cancel 2,000 / modify 1,810 / skip_reply 974 / store_location 829 / precheck 729 / risk_alert 620 / advance_stage 619 / recall 242；13 常挂合计 31,729
- 工具结果渐进披露：`src/tools/job-list/render.util.ts:1049`（`FULL_DETAIL_CAP=6` 家全文）、`:1200`（其余降摘要行）
- 多步：`generator.agent.ts:262`（prepareStep 挂载，maxSteps=5、工具结果全累积）；拦截说明拼接 `:325-341`（activeTools 移除 + instructions 末尾追加）
- 同工具限次：`tool-call-analysis.ts:20`（同工具≤3）、`:26`（precheck≤2）
- 单调增长：`deep-merge.util.ts:12`（数组 Set 并集）、`session.service.ts:493`（candidatePool 写入零 cap；`:562` 有 prune 剔失效岗位但无数量上限）、presentedJobs 写入 cap 10（`:524`）
- 渲染 cap：候选池 10 行（`memory-block.formatter.ts:387`）、evidence 不注入（`:230-231`，张漪 case）
- settlement：`settlement.service.ts:24`（页大小 500）、`:27`（摘要输入 120 条封顶）、`:170`（最多 10 页）
- 相关文档：`docs/knowledge-base/05-Prompt-Section动态组装体系.md`（分层裁定）、`docs/architecture/collection-form-machine.md`（S8-S10 已随收资批执行完毕，审计原文见 git 历史 docs/todo/memory-system-audit.md）

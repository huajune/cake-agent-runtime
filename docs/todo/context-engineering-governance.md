# 上下文工程治理方案（Context Engineering Governance）

> 状态：方案讨论中（P0-P3 未启动）
> 建立日期：2026-08-20
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
| `system` | ~1,533 | ~1.9% |
| `instructions`（12 段 Section 组装产物） | **~38,632**（max 42,902） | ~47.5% |
| 工具 schema（13 个常挂工具，description 总量估算） | **~40,000** | ~49% |
| `messages`（对话历史窗口） | **~1,273**（max 3,817） | **~1.6%** |

**核心结论**：

1. 每步输入的 **~98% 是静态固定成本**（手册 + 工具描述），对话历史只占 ~1.6%。而现有的全部控量闸门（60 条 / 12000 字符）都作用在那 1.6% 上。
2. 回合平均 10.5 万 token 是多步累积（maxSteps=5，每步全量重发前缀）。多步放大了静态成本：静态部分每多一步就整体重付一次。
3. p95 达 23 万 token 的回合，大概率是工具结果大 + 步数多的组合（工具结果回合内全量累积、无截断）。

### 现状机制盘点（详细出处见附录 A）

- 全链路无 token 级预算；仅条数/字符数闸门，且只覆盖对话历史。
- `finalPrompt` 出口无测长、无落库、无告警（历史上"张漪 case"27K 膨胀靠 badcase 反查发现）。
- 手册 `candidate-consultation.md` 76,327 字节；`duliday_job_list` / `duliday_interview_precheck` description 各 ~13.5K 字符。
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
| 2. 给示例 → 设计接口 | ⚠️ 实验性适用 | 13.5K 的工具 description 大概率示例过载；用枚举/参数语义替代部分示例（P3），需 A/B |
| 3. 前置一切 → 渐进披露 | ✅ 模型无关，纯赢 | 工具按阶段动态挂载（已有 activeTools 机制 + 2 个动态注入先例）；76KB 手册按阶段分片注入（P2） |
| 4. 重复指令 → 单一居所 | ✅ 模型无关，纯赢 | 手册 vs 工具 description 去重（P1）；与既有裁定一致（工具强绑定进 description，见 docs/knowledge-base/05） |
| 5. 手动记忆 → 自动记忆 | ✅ 已具备 | extractAndSave/settlement 已是自动记忆；治理点是 memory-system-audit.md 的零消费字段清理（P1） |
| 6. 简单规范 → 丰富引用 | ➖ 不适用 | 面向 IDE 编码代理的规则，运行时招聘 agent 无对应物 |

文章之外、但对本系统杠杆最大的一项：**provider 前缀缓存**。静态前缀占 98%，且多步重发——qwen（DashScope）支持 context cache。若能吃到缓存，成本收益可能超过所有裁剪之和；且要求「静态在前、动态在后」的组装顺序纪律，与渐进披露改造天然互补。

---

## 三、治理分期

### P0 — 缓存调研 + 最小止血（轻量化裁定 2026-08-20：不建观测基建）

> 裁定：不新建观测表/看板/分段埋点。理由：完整 prompt 已落库
> （`mpr.agent_invocation.request.agentRequest`，system/instructions/messages 分字段可测长），
> 归因用 ad-hoc SQL 事后可答；98% 大头是两个静态文件，线下即可量。
> 本文档第一节的基线 SQL 即为对比口径，每期收尾重跑一次。

| # | 事项 | 说明 | 状态 |
|---|---|---|---|
| P0-1 | provider 缓存调研 | 确认 qwen3.7-plus 经当前网关是否支持/已启用 context cache；计费口径；AI SDK providerOptions 透传路径；顺手确认动态内容（datetime 等）是否污染静态前缀 | ☐ |
| P0-2 | finalPrompt 膨胀告警 | `prepare()` 出口一行长度检查，超阈值（建议 60K 字符）飞书告警，防张漪 case 式静默膨胀复发（约 10 行代码） | ☐ |

**P0 验收**：缓存可行性有结论（能/不能吃到、折扣多少、组装顺序要改什么）；膨胀告警上线。

### P1 — 无损瘦身（机械修剪，不依赖模型判断力，全部可回归验证）

| # | 事项 | 预期收益 | 状态 |
|---|---|---|---|
| P1-1 | 手册 vs 工具 description 去重审计 | 按既有裁定（工具强绑定进 description），删手册中重复段 | ☐ |
| P1-2 | booking 块固定说明提取 | N 条 booking 只渲染一次说明文字（每条省 ~1.5-2KB） | ☐ |
| P1-3 | 单调增长加 cap | `lastCandidatePool` 写入 cap、`preferences` 数组上限、`invitedGroups`/`excludedBrands` cap | ☐ |
| P1-4 | 拦截说明追加改替换 | `generator.agent.ts` buildPrepareStep 内去重 | ☐ |
| P1-5 | memory-system-audit S8-S10 | 零消费字段清理（已标"随时可做"） | ☐ |
| P1-6 | 手册维护者内容转注释 | `stripMaintainerComments` 已有剥离机制，把面向维护者的段落改成 HTML 注释 | ☐ |

**P1 验收**：p50 单步输入字符数下降可测量；test-suite 回归全绿。

### P2 — 渐进式披露（结构改造）

| # | 事项 | 说明 | 状态 |
|---|---|---|---|
| P2-1 | 工具按阶段动态挂载 | **裁定暂不做（2026-08-20 用户拍板）**。阶段跳跃兜底成本高于收益；13 工具常挂维持现状。推论：~40K 工具 schema 的静态成本只能靠 P3-3 description 瘦身削减，P3-3 权重上调 | ✋ 暂不做 |
| P2-2 | 76KB 手册分片 | 决策优先级栈 + 全局工作原则常驻；「回合 SOP」「阶段策略使用规则」「记忆使用规则」中阶段强相关内容改为按 stage 条件注入（stage-strategy section 机制可承载） | ☐ |
| P2-3 | 组装顺序重排 | 静态前缀（identity/手册/policy）→ 半静态（工具集）→ 动态（runtime-context）→ final-check，最大化缓存命中 | ☐ |
| P2-4 | 工具结果回合内控量 | 大工具结果（job_list 20 条页）在后续 step 中降摘要；或降低 DEFAULT_PAGE_SIZE。以 P0 的 p95 归因数据定方案 | ☐ |

**P2 验收**：p50 token/回合显著下降（目标见第五节）；badcase 率无回升。

### P3 — 规则→判断力实验（证据门控，逐批）

| # | 事项 | 说明 | 状态 |
|---|---|---|---|
| P3-1 | 手册绝对化规则清点 | 列出候删规则清单，逐条与 badcase 修复记忆对账（大量规则是历史事故的沉淀，删前必须知道它当年拦的是什么） | ☐ |
| P3-2 | 分批删减 + 回归闸 | 每批过 test-suite 回归 + 语义 shadow 评审对比，不达标即回滚 | ☐ |
| P3-3 | 工具 description 接口化重构 | 示例 → 参数语义/枚举表达（规则 2），A/B 验证 qwen 遵循度 | ☐ |

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

## 附录 A：现状机制出处速查

- 组装编排：`src/agent/generator/preparation.service.ts:149`（`prepare()`）；出口 `:338` 无测长
- Section 注册表：`src/agent/generator/context/scenarios/scenario.registry.ts:7`；12 叶子段
- 手册：`src/agent/generator/context/prompts/candidate-consultation.md`（76,327B）+ `-final-check.md`（6,505B）
- 历史窗口：60 条（`MAX_HISTORY_PER_CHAT`）/ 12,000 字符（`AGENT_MAX_INPUT_CHARS`，`memory.config.ts:78-82`）；双重裁剪（memory 层 + `preparation.service.ts:170`）
- 工具注册：`tool-registry.service.ts:243`（13 常挂）、`:318,337`（2 动态）；description 体量 job_list 13,484 / precheck 13,513 字符
- 多步：`generator.agent.ts:256-261`（maxSteps=5、工具结果全累积）；拦截说明追加 `:340`
- 单调增长：`deep-merge.util.ts:11`（Set 并集）、`session.service.ts:553`（candidatePool 写入零 cap）
- 渲染 cap：候选池 10 行（`memory-block.formatter.ts:387`）、evidence 不注入（`:231`，张漪 case）
- settlement：`settlement.service.ts:84`；摘要输入 120 条封顶
- 相关文档：`docs/knowledge-base/05-Prompt-Section动态组装体系.md`（分层裁定）、`docs/todo/memory-system-audit.md`（S8-S10 残留清理）

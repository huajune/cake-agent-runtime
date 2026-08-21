# 上下文工程治理方案（Context Engineering Governance）

> 状态：方案定稿（2026-08-21，三元目标版：注意力质量 + 抗腐烂 + 设计合理性），P0-P3 执行未启动
> 建立日期：2026-08-20
> 复核记录：2026-08-21 基于 `refactor/tools-layer-reorg`（cdd173a2 工具层终态重排后）全量复核锚点与数字；工具 description 总量由估算 ~40K 修正为实测 31,729 字符，precheck 描述已由收资状态机改造瘦身（13.5K→729）
> 参考：[Anthropic - The New Rules of Context Engineering for Claude 5 Generation Models](https://claude.com/blog/the-new-rules-of-context-engineering-for-claude-5-generation-models)
> 本文档是本轮上下文治理的权威状态表；各期完成后回填状态与实测数字。
> 原则沉淀：调研结论与八条裁定已蒸馏为 [principles/context-engineering-principles.md](../principles/context-engineering-principles.md)（C1~C8）——原则查那里，执行进度查这里。

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

## 二·五、治理总纲

### 三元目标（2026-08-21 用户定稿）

1. **注意力质量**：裁剪按"内容对规则遵循度的稀释程度"排序（重复指令 > 已失效规则 > 低价值教学 > 单纯字节量）。成本交给缓存，省钱是顺带收益。
2. **抗腐烂**：不止删今天的烂肉，还要堵住产生腐烂的机制（四个烂源见下），建立常设防腐层（见第六节）。
3. **设计合理性**：对上下文体系做一次架构审视（结论见下），修正结构性缺陷。

### 四个烂源（腐烂是机制问题，不是内容问题）

| 烂源 | 机理 | 本仓库标本 | 堵法 |
|---|---|---|---|
| 单向棘轮 | badcase 修复只加不减，无反向压力 | precheck 描述积到 13.5K；守卫硬规则积到 30 条后大下线 20 条 | 规则台账 + 膨胀告警（P0-2） |
| 规则与证据失联 | 规则入 prompt 即与来源 badcase 断链，事后不敢删 | P3-1 被迫事后"对账"重建链接 | 台账登记来源为必经流程 |
| 时效规则无 TTL | 临时口径无过期标注 | 旧 precheck 的"暑假工 2026 暑期临时规则" | 临时规则必须标注过期日期（纪律入规范） |
| 职责迁移不回收 | 代码接管行为后无人删 prompt 侧教学 | 收资状态机接管后，手册/DB 策略中收资教学仍在 | 回收纪律：接管行为的 PR 必须同批回收教学 |

### 设计审视结论

**骨架健康的部分（保持）**：分层放置原则（05 文档裁定）、语料域封闭注册表（teaching/evidence/tool_result）、长期摘要按需拉取（`recall_history`）、工具结果不跨回合、场景级 section 裁剪。

**四个真设计问题**：

1. 分层原则无 enforcement，全靠自觉 → 台账制部分缓解；违规放置检查暂不做自动化
2. **三个内容居所、三种变更纪律**：手册（PR+review）、description（代码但无尺寸压力）、DB 阶段策略文本（Dashboard 可改、零 review 零审计）——第三居所最危险且在主链内 → 纳入治理（下方裁定 3）
3. 规则无元数据（来源/日期/时效） → 台账制解决
4. 自动烂结构（拦截说明追加式、session 数组单调增长） → P1-3/P1-4 覆盖

### 裁定记录

**第一轮（2026-08-21 上午）**：
1. 主目标注意力质量优先（后扩展为三元）；2. 手册就地治理，P2-2 分片降级；3. 缓存先查文档再埋点。

**第二轮（2026-08-21，防腐专题）**：
4. **规则台账制：建，markdown 轻量版**——台账放 docs/，随 P3-1 清点一次性建成，之后加规则必须登记（内容摘要/来源链接/加入日期/时效性）。不建系统不建表。
5. **防腐纪律写进 CLAUDE.md + .claude/agents 规范**——职责迁移回收纪律与临时规则 TTL 标注要求，约束所有 AI 会话。
6. **DB 阶段策略文本纳入治理范围**——修正原范围裁定；stage-strategy 每回合渲染进 prompt，属主链。P1-1 一并审计；审完再议是否给 Dashboard 改动加约束。

**第三轮（2026-08-21，约束居所与行业对照专题）**：
7. **约束放置判定树入方案**（用户拍板）——P1-1 审计验收标准 + 台账分类轴：

   ```
   新约束 →
   ├─ 出站结果形态可确定性判定（假宣称/泄漏词等）→ 守卫 hard-rule（只拦完成时态，沿用既有裁定）
   └─ 生成时行为约束：
      ├─ 与单一工具强绑定 → 该工具 description（既有裁定）
      ├─ 与单一阶段强绑定 → stage-strategy（DB，待 F5 加约束）
      ├─ 跨工具跨阶段的人格/红线 → red-lines（DB）
      └─ 跨工具的操作规程 → 手册
   铁律：同一约束只准住一处；"教"（prompt）与"拦"（守卫）允许成对存在，但台账必须互链。
   ```

   现状实测：约束共有六个居所、三种变更纪律（手册 PR+review / description 代码无尺寸压力 /
   red-lines·thresholds·stage-strategy 走 DB 零 review / hard-constraints·turn-hints·拦截说明代码动态 /
   final-check / 守卫 rules），P1-1 按树归位、多处存在的归并到唯一居所。
8. **手册低频规程 Skill 化，加为 P3-4 实验项**（用户拍板）——模型按需拉取 playbook（进 messages 后缀，
   不碰前缀缓存），是被降级的 P2-2 分片的缓存友好替代路径。

**第四轮（2026-08-21，松绑 harness 专题）**：
9. **harness 两分法与松绑就绪立为原则 C9**（用户拍板，全文见 principles/context-engineering-principles.md）——
   判断替代型 harness（随模型折旧、新增须自带退场机制）vs 不变量保障型（不折旧、禁止交还模型）。
   定性：P3 删规则即本库判断替代型 harness 的首个系统性松绑工作流；守卫 30→10、语义审查 enforce 关闭、
   repair 链破产等既有裁定获行业趋势追认。松绑一律证据门控（qwen3.7-plus 非前沿、未与本 harness 共同后训练）。

### 行业对照结论（2026-08-21 调研）

**已与前沿一致的设计（增强"骨架健康"清单）**：prepareStep activeTools 屏蔽 + 13 工具常挂 ≈ Manus "mask,
don't remove"（P2-1 暂不做的裁定获行业佐证）；final-check 置末尾 ≈ Manus recitation（精简它须按此视角，
勿并入前缀）；四层记忆 ≈ Letta/MemGPT OS 式分层（且我们代码 pipeline 沉淀比模型自管更可控）；
settlement 摘要 ≈ Anthropic compaction；recall_history ≈ structured note-taking 读取侧；
收资状态机 ≈ "接口设计取代行为教学"方向。

**借鉴增量**：
1. **KV-cache 命中率 = 生产 agent 第一健康度指标**（Manus）→ P0-1b 升格为常设指标，且排查 JSON 序列化确定性（键序不稳静默打断缓存）
2. **两种 rot 并列**：context rot（上下文越长性能越衰减，行业实证，支撑"注意力质量"目标）≠ 内容腐烂（规则老化，本方案"抗腐烂"目标），治法不同
3. Skill/工具/MCP 分工共识："Skills hold the procedure, Tools take the actions, MCP provides the access"——MCP 的"接入即全量载入"正是行业公认的上下文痛点
4. 选择先于压缩（selection before compression）——与"注意力优先"裁定同构
5. **CoALA 记忆四分法对照**（2026-08-21 复盘）：四层记忆功能完备（settlement ≈ consolidation gate + 便宜模型摘要；无向量 RAG 是裁定不是缺口——封闭 schema + 单人小数据量下确定性召回更优）。真发现：真 procedural memory（手册/description/状态机规则）从未进入记忆治理框架、没有容量与沉淀机制——**本方案 P1/P3/防腐层本质是在补建 procedural 层的治理**；"程序记忆"命名错位（实为 stage state）已登记 glossary，代码改名搭车下次记忆域重构

**范围裁定（修正版）**：治理范围 = 主 generator 链路全部内容居所（手册 + 工具 description + **DB 阶段策略文本**）。extract、复聊、守卫语义审查仍不进本方案。

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
| P0-1b | 埋点采集 cached_tokens（**升格：常设第一健康度指标**） | 在 usage 采集链路加 `prompt_tokens_details.cached_tokens`，随现有 telemetry 落库。按 Manus 主张，缓存命中率是生产 agent 第一指标——不是一次性调研而是长期在位。附带排查：JSON 序列化确定性（键序不稳会静默打断前缀缓存） | ☐ |
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
| P1-1 | 手册 vs 工具 description vs 收资状态机 vs **DB 阶段策略文本** 去重审计 | 按既有裁定（工具强绑定进 description）删手册重复段。**最肥靶子**：手册「回合 SOP」与 DB 收资阶段策略文本中已被收资状态机接管的"怎么收资"教学段——删之有状态机兜底，风险最低。DB 策略文本按裁定 6 一并拉出审计（Dashboard 可改零 review，从未被审过） | ☐ |
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
| P3-1 | 手册绝对化规则清点 → **建常设规则台账** | 逐条与 badcase 修复记忆对账（删前必须知道它当年拦的是什么）；产出物按裁定 4 升级为常设台账（docs/ 下 markdown）：每条规则登记内容摘要/来源链接/加入日期/时效性。台账建成后成为加规则的必经登记处 | ☐ |
| P3-2 | 分批删减 + 回归闸 | 每批过 test-suite 回归 + 语义 shadow 评审对比，不达标即回滚 | ☐ |
| P3-3 | 工具 description 接口化重构 | 主攻 `duliday_job_list`（13,144 字符，占描述总量 41%），次攻 `request_handoff`/`invite_to_group`；示例 → 参数语义/枚举表达（规则 2），A/B 验证 qwen 遵循度。precheck 已随收资状态机完成（13.5K→729），无需再动 | ☐ |
| P3-4 | 手册低频规程 Skill 化实验 | P1-1 审计时标记"低频可拉取"段落（特殊 handoff 流程、罕见异常处理等）；P3 做拉取工具原型（类 recall_history 的 playbook 版）+ 回归验证。内容进 messages 后缀不破坏前缀缓存（裁定 8） | ☐ |

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

## 六、防腐机制（常设，全部为纪律+markdown，不建系统）

| # | 机制 | 落点 | 状态 |
|---|---|---|---|
| F1 | 规则台账 | 随 P3-1 一次性建成后常设（docs/ 下 markdown）；加规则必登记来源/日期/时效 | ☐ 随 P3-1 |
| F2 | 职责迁移回收纪律 | 写进 CLAUDE.md + `.claude/agents` 规范："代码/状态机接管某行为时，同批 PR 必须回收 prompt 侧对应教学" | ☐ 可立即做 |
| F3 | 临时规则 TTL 标注 | 同上写进规范：带时效的口径必须标注过期日期，过期即删（标本：暑假工 2026 暑期临时规则） | ☐ 可立即做 |
| F4 | 膨胀哨兵 | 即 P0-2 finalPrompt 告警，长期在位 | ☐ 随 P0-2 |
| F5 | Dashboard 策略改动约束 | 待 P1-1 审完 DB 策略文本现状后再议（裁定 6） | ⏸ 待议 |

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

## 附录 B：行业参考（2026-08-21 调研）

- Anthropic: [The New Rules of Context Engineering for Claude 5 Generation Models](https://claude.com/blog/the-new-rules-of-context-engineering-for-claude-5-generation-models)（六规则，本方案第二节）
- Anthropic: [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)（attention budget / compaction / note-taking / sub-agents / context rot）
- Manus: [Context Engineering for AI Agents: Lessons from Building Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)（KV-cache 第一指标 / mask-don't-remove / recitation / 确定性序列化）
- 阿里云百炼: [Context Cache 官方文档](https://help.aliyun.com/zh/model-studio/context-cache)（P0-1a 结论来源）
- Letta/MemGPT 记忆分层对照: [Virtual context management with MemGPT and Letta](https://www.leoniemonigatti.com/blog/memgpt.html)
- Skills/Tools/MCP 分工: [Skills vs MCP Explained](https://duet.so/guides/agent-skills-101-tools-vs-mcp-vs-skills)、[MCPs vs Agent Skills](https://www.damiangalarza.com/posts/2026-02-05-mcps-vs-agent-skills/)

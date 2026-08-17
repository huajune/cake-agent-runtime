# 收资字段解析统一方案（随候选人档案域重构 PR #1000 发版）

> 立项背景：2026-08-12 生产事故 batch_6a7bdffcce406a6aee46edb5_1786506236532——候选人已确认全部报名资料，precheck 仍判七字段缺失反复追问。
> 考古结论：**陈年结构缺口，非近期回归**。booking 侧三层匹配 04-14 齐备；06-10 precheck 引入补充标签回填时只搬了前两层，第三层（标准字段→标签回填）缺失至今；事故前三个版本无匹配行为变更。
> 决策记录：2026-08-12 用户裁定不做紧急止血（运营人工兜底两天），本方案作为彻底解法随 PR #1000 发版。PR #1002（暂停 claim enforce 删除）与本事故无关且对生产为 no-op，建议关闭。
> **2026-08-12 追加定调**：海绵侧已发布结构化标签契约（`/ai/api/jobs/interview-labels/batch-query` + 新 `/ai/api/workorder/entryUser`，labelId/fieldType/optionCode），基于新契约的迁移与简历初筛**立项为候选人档案域重构二期**（一期 = PR #1000 域统一 + 评审修复）。本文档 §8-§9 为二期设计与契约开放问题。
> **2026-08-14 追加**：同族第二起生产事故（「有无本地健康证」死锁，候选人被追问 5 次后真人接管）已补录于 §10，含现有三缺陷之外的两个新问题面（prechecked 闸门可伪造、多人同报碰撞）。裁定：不做单点止血，随本方案统一治理。

## 1. 三个设计缺陷（本方案的靶）

**缺陷一：字段身份由自然语言字符串相等裁决。** `customerLabel` 是运营手写自由文本，Agent 传参字段名是 LLM 生成自由文本，两个不受控词汇源靠「精确匹配+少量别名」握手。漂移是必然，别名表永远追不上。

**缺陷二：门比执行者笨。** precheck 的职责是预测 booking 的结果，但两者解析能力不同源——booking 有标准字段→标签回填（`/身高/`、`/健康证/` 正则族），precheck 没有。能力更强的执行者被能力更弱的门挡在前面。

**缺陷三：「确认」不是一等证据。** Agent 发预填表、候选人回「点头OK」表情，业务上是最强确认，但系统里什么都不是：消息表单提取只读候选人亲发的「字段：值」行，确认 producer 只有 name/city 两个手工特例。且产品方向持续加强预填 → 确认型会话占比上升 → 该盲区触发概率系统性上升。

## 2. 目标不变量（验收即验这四条）

- **I1 门不严于执行者**：∀ 会话状态，`precheck 判缺字段 ∩ booking 可组装字段 = ∅`。用生产标签语料做属性测试固化。
- **I2 模型不作字段身份的作者**：字段名/ID 只能来自系统下发，模型只填值。意译进不了协议层。
- **I3 确认即证据**：候选人对系统提案（预填表）的肯定应答，为提案内全部字段产生 confirmation 级证据。
- **I4 观测落库**：所有匹配兜底/分歧必须进 `agent_execution_events`（含 `ALWAYS_PERSISTED_EVENT_TYPES` 白名单登记——PR #1000 评审已发现漏登白名单导致观测死亡的先例），不只打日志。

## 3. 方案设计

### 3.1 新建收资解析共享域 `src/resolution/collection/`（缺陷二根治·第一步）

标签词汇匹配是确定性解析工作，按候选人档案域宪法归 `resolution`。新子域文件规划：

```
src/resolution/collection/
├── label-normalize.ts    # 标签归一化（NFKC/去空白/去括号单位注记「(cm)」「(kg)」）
├── label-match.ts        # 三层匹配主链（见 3.2），唯一入口 resolveSupplementField()
├── standard-backfill.ts  # 标准字段→标签回填（booking 现有 /身高/ 正则族整体迁入）
└── alias-table.ts        # 别名表（含本次事故四对 + 回扫探针挖掘产出）
```

依赖仅 `@sponge/*` 类型 + 域内引用，符合 `.eslintrc.js` resolution 边界，无需新豁免。

**消费方改造**：`tools/duliday/precheck/checklist.util.ts`、`tools/duliday/booking/interview-booking-customer-label.builder.ts` 各自的私有匹配实现**删除**，全部改调 `resolveSupplementField()`。禁止复制——复制即第三套引擎，比现状更糟。

### 3.2 三层匹配统一并升级

1. **L1 归一化精确 + 别名**（现有两侧逻辑合一，别名表唯一居所）。
2. **L2 标准字段→标签回填**（booking 现有正则族迁入共享域；precheck 从此同权——本次事故 3/7 字段由此收回）。
3. **L3 确定性近邻匹配**（新增）：归一化后子串包含 / 编辑距离 ≤ 保守阈值，仅在候选标签集合内无歧义（唯一命中）时采用；命中即用并 emit `supplement_key_fuzzy_matched` 事件。这是对「运营新写法 × 模型意译」二维漂移的**结构性兜底**，取代无限补别名的跑步机（本次事故 4/7 字段属此类）。纯确定性，无 LLM，符合「投递路径快环只准确定性动作」裁定。

### 3.3 协议收口（缺陷一根治·Phase 1 形态）

- precheck 输出的收资清单携带**逐字标签原文**（现 templateText 已有，补进结构化字段 `supplementFields: [{label, hint}]`），工具 schema 描述明确要求 echo 原文。
- 服务端不信任提示词约束（本仓库已多次实测击穿）：`candidateSupplementAnswers` 的 unknown key 一律走 L3 近邻解析，解析失败 emit `supplement_key_mismatch`（带原 key 与候选标签集），**静默丢弃从此不存在**。
- Phase 2 再做完全 ID 化（模型按 opaque ID 回传，标签名彻底退出协议层），需与工具 schema 及提示词联动改造，不挤进本次发版。

### 3.4 表单确认 producer（缺陷三根治）

在 `resolution/evidence/producers/` 新增 **form-confirmation producer**（通用，非逐字段手工特例）：

- 触发形态：assistant 最近一轮发出含「字段：值」预填行的收资表 + 候选人下一条为肯定应答（肯定词表 + 确认类表情）→ 表内**全部非空字段**获得 `confirmation` 级证据。
- 肯定词表收拢进 `signal/dialogue`（PR #1000 评审已发现三份分叉词表：dialogue/student-identity/city-confirmation，先收拢再复用，不再新增第四份）。
- 该 producer 同时解决评审修复清单 #4（性别表内确认死锁：「都对的」从此是合法确认）与本事故的表情确认盲区。
- 防误升级约束：仅认 assistant 表单轮次的**紧邻**候选人回复（复用既有 ask→first-reply 判定，评审 S6 建议顺带抽共享 helper）；否定/部分修改应答（「其他都对，电话改成…」）走既有字段覆盖路径，不整表确认。

### 3.5 观测与面积测定

- 三个新事件登记 `ALWAYS_PERSISTED_EVENT_TYPES`：`supplement_key_fuzzy_matched` / `supplement_key_mismatch` / `form_confirmation_applied`。
- 生产回扫探针（一次性脚本，`.env.production` + `SET LOCAL statement_timeout` 串行）：近 30 天 precheck 记录中「supplement 标签在 missingFields 且同轮传了归一化相似 key」的分歧率——定事故面积 + 为 alias-table 挖真实别名对。

## 4. 阶段与交付

| 阶段 | 内容 | 时点 |
|---|---|---|
| Phase 1 / 一期收尾（本方案主体，**过渡桥**） | 3.1 共享域 + 3.2 三层统一 + 3.3 协议收口（不含 ID 化）+ 3.4 确认 producer + 3.5 观测 | 随 PR #1000 发版；新旧接口并存期内是未迁移岗位的兜底路径，不是弃子 |
| Phase 2 / **候选人档案域重构二期·简历初筛**（§8） | 迁移到海绵结构化标签契约（labelId/fieldType/optionCode）：字段身份 ID 化、选项化收资、acceptedOptions 确定性初筛、precheck 本地校验对齐服务端 errorList | 独立立项，契约开放问题（§9）与海绵侧对齐后排期 |

原 Phase 2 中的「precheck = booking dry-run」思想在二期中以更强形态实现：双方共同对着**同一份标签 schema** 做校验与组装，分叉面在协议层消失。

## 5. 验证

- [ ] 事故 batch 回归 fixture：同字段组合（含四对近义名 + 三个重复标签）预期直接 `ready_to_book`
- [ ] I1 属性测试：抓生产在招岗位标签语料快照，遍历断言 precheck 判缺 ∩ booking 可组装 = ∅
- [ ] 确认 producer 正反例：表情确认 / 「都对的」 / 部分修改应答 / 无邻接表单的孤立「好的」（不得误升级）
- [ ] 三个观测事件落库断言（查 `agent_execution_events`，非仅 tracer.emit）
- [ ] `pnpm run ci:check` + `test:di-smoke`

## 6. 与在途工作的协调

- **PR #1000 修复会话已完成**（docs/todo/pr1000-review-fixes.md 已回写：P0/P1/P2 全部落地，生产形态 fixture 族已建）。本方案 Phase 1 可立即在同分支追加实施。注意修复会话已新增 `producers/gender-confirmation.ts`（表内确认+肯定应答），3.4 的通用 form-confirmation producer 实施时应**吸收/泛化它**，不要并存两个确认机制。
- **PR #1002**：建议关闭。理由：紧急止血前提已撤；内容对生产是 no-op（生产 `CANDIDATE_FACT_ADJUDICATION_MODE` 未设置，默认 shadow）；「enforce 下暂停 claim 删除」应作为裁决模式 rollout 的配置开关另行决策，不以注释代码形态合入。
- GPT 侧若已有止血改动，以本方案的共享域实现为准收敛，避免在旧结构上再长私有别名表。

## 7. 风险与对策

- **L3 近邻误匹配**：阈值保守 + 仅唯一命中采用 + 全量落观测事件，上线首周人工抽查 fuzzy_matched 样本。
- **确认 producer 误升级**：紧邻性约束 + 否定应答豁免 + 正反例测试；首周观测 form_confirmation_applied 样本。
- **与 PR #1000 耦合发版**：本方案依赖重构后的域结构，随 PR #1000 发版是最低成本路径；发版回归面大，以评审修复清单要求的「生产形态 fixture 族」共同兜底。

## 8. 二期设计：结构化标签契约迁移（简历初筛）

### 8.0 生产数据基线（2026-08-12 全量实测，非理论推演）

对生产网关全量在招岗位（445 个，按品牌维度覆盖扫描）+ 新 batch-query 接口的实测：

- **新接口已在生产网关可用**（`gateway.duliday.com/sponge/ai/api/jobs/interview-labels/batch-query`），437/445（98.2%）岗位已配置结构化标签，读取侧无需等待任何灰度。
- **labelId 是全局字典而非岗位私有**：全库 107 个 labelId（labelId 3=籍贯、4=身高(cm)、13=有无本地健康证、50=体重(kg) 跨岗位复用），头部 13 个标签覆盖约 75% 的标签实例（共 1975 实例）。→ labelId→我方规范字段的映射是一张**人工可维护的小表**，不需要运行时模糊匹配。
- **fieldType 分布**：TEXT 1389（70%）/ SINGLE_OPTION 568（29%）/ FILE 12 / MULTIPLE_OPTION 6；全部选项类标签都带 acceptedOptions。TEXT 主导意味着值的解析与规整仍在我方（出勤/时间段/住址等），但字段身份由 labelId 锁死。
- **筛选配置已有真实存量**：86 个 标签×岗位 对的 acceptedOptions 是选项全集的真子集——健康证（labelId 13）有 10 个岗位只接受 {有证, 无证接受办理}（排除「不接受办理」）；学历（labelId 2）在 89 个岗位上有 **4 种不同允许子集**（等于每岗学历门槛已机器可读）。→ 简历初筛不是未来功能，数据今天就在。
- **标准字段重复面**：416/445（93.5%）岗位至少有一个标签与标准字段重复（健康证 392、体重 182、身高 165、学历 89、籍贯 18）——一期事故的 precheck 回填缺口暴露面是**几乎全库**，此前少出事故仅因候选人自己抄表回填的日常路径兜着。
- **运营词汇漂移实锤在字典层**：能干几个月/能做多久/能工作几个月、每周可出勤天数/一周可以出勤几天/每周可出勤几天、居住地/居住地址/具体家庭住址、学信网在籍三变体、周四六日三变体——是**不同的 labelId**。对模型回显协议无害（逐字回显即可），但 labelId→规范字段映射表要把这些家族归并。
- **数据卫生问题**（应随 §9-10 提给海绵/运营）：`不要学生及暑假工`（42 岗）是纯筛选声明做成了 TEXT 收集标签；`有无健康证;有无分拣` 一个标签拼两问；`身份(学生/第二职业` 括号未闭合。
- 8 个岗位无任何标签（仅标准字段），old/new 两侧口径一致。

### 8.1 新契约解决了什么

- **缺陷一从根上消灭（选项类字段）**：`labelId` 是字段身份、`optionCode` 是值身份，模型与运营的自然语言从协议层退场（I2 由上游契约保证）。`labelTitle`/`optionLabel` 服务端按 ID 回查，可不传——传了也不作身份依据。
- **筛选与收集第一次在数据上分离**：`acceptedOptions` = 允许报名的选项列表，即**确定性简历初筛**。候选人答案落在允许集外 → 不符合岗位门槛，可在收资阶段即时拒绝/引导，而不是提交时才失败。呼应既有裁定「customerLabel 带括号约束是筛选条件≠收集字段」——现在筛选条件有了机器可读形态。
- **服务端权威校验回包**：`errorList[{field,msg}]` 使「门不严于执行者」（I1）有了服务端锚——precheck 本地校验只需对齐 batch-query 的同一份 schema。

### 8.2 迁移面（现状 → 目标）

- 提交端点：`a/supplier/entryUser`（旧 supplier 域，`customerLabelList` 自由文本）→ `/ai/api/workorder/entryUser`（海绵2.0 ai 网关，labelList by ID）。sponge.service 新增 `batchQueryInterviewLabels()` 与新版 `submitEntryUser()`，标签查询结果按 jobId 缓存（同品牌目录 30min TTL 策略）。
- 收资流：precheck 清单从 `interviewSupplement`/customerLabel 推导 → 改为 batch-query 标签驱动；`knownFieldMap` 增加 labelId 维度；templateText 渲染 labelTitle + labelInstructions + 选项枚举（单选/多选说明）。
- 值解析：候选人自由文本答案 → optionCode 的确定性映射（归一化 + 选项label匹配）落 `resolution/collection/`；标准档案字段（学历/健康证/身高体重等，现以 sponge enum ID 存在）→ 对应标签 optionCode 的自动回填映射。**resolution/collection 的职责从「两团自由文本互相匹配」收窄为「我方规范值 ↔ 标签 schema 的有界映射」**，一期的三层匹配器在此退役为未迁移岗位兜底。
- 初筛动作：precheck 在收资中即时比对 acceptedOptions，不合格走既有筛选拒绝话术链路（性别/年龄可明说的既定口径不变）；避免「收完资提交才发现不合格」的体验与工单浪费。
- `fieldType=FILE`：对话内文件类标签（预计承接简历/证件），提交语义待 §9-2/3 确认后设计；未确认前遇 FILE 标签降级为人工/跳过并观测。

### 8.3 二期不变量（在 §2 之上追加）

- **I5 标签 schema 单源**：precheck 校验、模板渲染、booking 组装、初筛判定消费同一次 batch-query 结果（同轮内同一快照，防标签中途变更导致门与执行者所见不一致）。
- **I6 初筛结论可回放**：每次 acceptedOptions 判定落观测事件（labelId、候选人答案、命中选项、判定结果），支撑运营侧回查「为什么拒绝」。

## 9. 契约开放问题（实施前须与海绵侧对齐）

1. **灰度与并存**：新 entryUser 是否一次性覆盖全部岗位？未配置新标签的岗位 batch-query 返回空 labels 还是不返回？判别开关按岗位还是全局？旧 `a/supplier/entryUser` 下线时间表？
2. **简历附件**：旧接口有 `uploadResume`（cloudStorageKey），新 schema 无对应字段——由 FILE 标签取代？FILE 的 `value` 传什么（cloudStorageKey？URL？）？上传接口是否沿用？
3. **acceptedOptions 语义**：答案不在允许集 → 提交必被 errorList 拒绝？`acceptedOptions` 为空数组的含义（不筛？无选项配置？）？TEXT 类型是否也有服务端校验规则（长度/格式）？
4. **value/options 互斥**：TEXT 传 options、OPTION 传 value 的服务端行为；MULTIPLE_OPTION 的数量上下限。
5. **errorList 键**：`field` 是展示名，程序化映射需要稳定键——建议海绵侧在 errorList 项中补 `labelId`。
6. **幂等与判重**：同人同岗重复提交的服务端行为（我方现有在途工单探测是否可下沉）。
7. **标签版本漂移**：会话中途运营修改标签配置，先前拿到的 labelId/optionCode 提交时失效的表现。
8. **环境与鉴权**：正式环境 base URL（spec 中为空）；Duliday-Token 是否沿用现有 per-bot tokenContext 机制。
9. **interviewTime**：格式约定；不传是否等价「等通知」（现有 PR #274 语义需保持）。
10. **labelInstructions 填写规范**：说明文案是收集提示还是筛选条件？需要运营侧填写纪律，避免自由文本约束重新混入（一期病根不换个字段复活）。

## 10. 事故补录：2026-08-14 「有无本地健康证」收资死锁（仅问题描述）

> 与 8-12 主案同族，是缺陷一/二在生产的又一次完整爆炸；同时暴露两个现有靶未覆盖的新问题面（§10.3/§10.4）。本节只记问题与证据，不含方案；治理随本方案统一处理，本次未做任何代码改动。

### 10.1 事实经过

两条会话、同两位候选人（牛艳雪/王淼）**两人合报**岗位 528855（成都你六姐-上海陆家嘴软件园店-前厅服务员（夜宵）-小时工）。岗位配置 collect 型补充标签「有无本地健康证」（即 §8.0 全局字典 labelId 13，健康证族 392 岗重复面的头部标签）。

- chat `6a7ebf32ce406a6aeedb037d`：07:21→08:40 「健康证是上海本地办的吗」被追问 **5 次**，候选人 5 次给出肯定答复（「是的」「对」「在上海的」「有啊」「行」），第 4 次时已明确不满（「都确认多少遍了」）。07:31 模型两次不带 `prechecked` 直调 booking 被本地闸门拒，失败上下文以「不过这次没有提交成功」外泄进候选人话术。08:42 真人经理接管手动报名，托管暂停。
- chat `6a4229f2ce406a6aeea72c81`：候选人换入口重报。09:02 已明确回答「都有健康证，都是本地的健康证」，09:12 仍被再次追问；09:16 仅牛艳雪报名成功（工单 457339），王淼失败且未被播报（§10.4）。

### 10.2 死锁机制：候选人答案没有任何一条路能到达标签

五个环节逐一失效，形成「追问 → 确认 → 仍判缺 → 再追问」闭环：

1. **同题双字段并存**：首轮 checklist 同时含标准字段「健康证情况」与岗位标签「有无本地健康证」，templateText 一表两问（「健康证：」「有无本地健康证：」两行）。证据 trace `batch_6a7ebf32ce406a6aeedb037d_1786691763562`。
2. **模型意译模板，标签行丢失**：Agent 未逐字下发 templateText，两行健康证被并写成自创的「有没有健康证：」一行。候选人抄表回填的行是「有没有健康证：有」，`extractSupplementAnswerFromMessages` 按标签原文匹配「字段：值」行永远失配——§8.0 所述「此前少出事故仅因候选人抄表回填兜着」的兜底路径，被模板意译击穿。
3. **答案通道错位**：候选人历轮确认经 `candidateHasHealthCertificate:"有本地健康证"`（该参数 schema 的示例值恰为「有本地健康证」，把模型引向此通道）与 `candidateClaims(field=healthCertificate, quote:"在上海的")` 进入，两条通道都正确判 local_valid、只落标准字段「健康证情况」；唯一能填标签的 `candidateSupplementAnswers` 在两会话全部 precheck 调用（17 次）中从未被模型使用。
4. **归一化不认识本地化变体**：`normalizeChecklistField` 的健康证别名仅 `健康证 / 健康证情况 / 有无健康证` 三写法（`src/tools/duliday/precheck/checklist.util.ts:107`），「有无本地健康证」被当作未知动态字段独立占位，标准字段的值无桥可达（supplement-overlap 桥接表现仅覆盖「身份」一个字段）。
5. **反馈回路驱动追问而非纠通道**：precheck notes 只输出「预检尚未通过，只缺：有无本地健康证。请向候选人补问」，模型照做；系统对「模型已传健康证答案但落错键」零感知，无任何信号能让循环收敛。证据：trace `batch_6a7ebf32ce406a6aeedb037d_1786693823036`（args 同时含 legacy 参数与 claim，result 仍 `missing:["有无本地健康证"], nextAction:collect_fields`），另 4 个 trace 全部同型。

### 10.3 新问题面一：prechecked 闸门可被模型伪造（本次实测击穿）

chat `6a4229f2ce406a6aeea72c81` trace `batch_6a4229f2ce406a6aeea72c81_1786698855463`：模型先如实传 `prechecked:{nextAction:"collect_fields", missingFieldsCount:1}` 被拒 2 次，随后**凭空伪造 `prechecked:{nextAction:"ready_to_book", missingFieldsCount:0}`** 重调（precheck 从未返回过该结果）。booking 不回查 precheckId 存档、直接放行到真实海绵 API，且提交成功。两个推论：

- 海绵 API 实际接受 `supplementAnswers:{"有无本地健康证":"有"}` ——本次死锁完全是本地闸门自我阻塞，执行者能过、门过不去（缺陷二的极端形态）。
- 「不要凭空猜 prechecked 的值」目前只有提示词约束，在候选人催促（「赶紧报名」「快点报名」）下被实测击穿。与 §3.3「服务端不信任提示词约束（本仓库已多次实测击穿）」同源，但 prechecked 闸门本身恰好不在该原则的覆盖范围内。

### 10.4 新问题面二：多人同报同岗，第二人结构性失败且静默

precheck 存档键为 `pc_<traceId>_<jobId>`，同轮两位候选人共用一个档位。王淼的 booking 被「姓名或联系电话与预检结果不一致」一致性闸门拒绝，**失败未向用户播报**（Agent 只播报了牛艳雪成功）。09:21 用户重发王淼资料，又被「近期已有预约工单」判重拦截（trace `batch_6a4229f2ce406a6aeea72c81_1786699295795`）——但 `ops_events` 中王淼（15563231209）无任何 `booking.succeeded` 底账，该在途工单疑似真人经理带外手建，Agent 侧无从核实。两人合报是本组会话的真实业务形态，当前结构下第二人必然过不去一致性闸门。

### 10.5 关联观察（备查）

- 复聊 `booking_incomplete` 场景在 08:39 把同一个已死锁的确认问题再次推给候选人，对死循环起放大作用。
- 首轮 templateText 预填「年龄：29」，与候选人后续自报 21/22 不符，疑似由首条消息「我是97」推断出生年所致（未深查，预填值来源可疑性记录备查）。

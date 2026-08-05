# 候选人资料证据化与裁决收口方案

> **体系定位**：本文属"候选人认知体系"三轴中的**证据准入轴**（证据出处、采信分级、消费准入），
> §0 总纲是另两轴中涉及事实采信内容的上位口径。姊妹文档——**记忆本体轴**：
> [memory-system-architecture.md](./memory-system-architecture.md)（架构总览）+
> [memory-and-hints-data-flow.md](./memory-and-hints-data-flow.md)（数据流细节，信封/source/confidence
> 的实现真相在彼处）；**判定机制轴**：
> [semantic-decision-taxonomy-plan.md](./semantic-decision-taxonomy-plan.md)（一个判定该用规则还是
> LLM 仲裁——本方案的 confirmation 纯规则识别器与其姓名仲裁器试点的分野对账见其 §3.2）。
> 四份共享同一条宪法：确定性守门、LLM 只降级不放权（HC-2）。
>
> 状态：主体已交付（城市线 P0/P1 已上线见 §16；报名字段 Claim/裁决/快照体系已实现并以 shadow 模式接线见 §18；Phase 4 旧路径删除待 enforce 观测期后）
> 目标：解决候选人最新自报资料、会话事实、长期 Profile 与模型工具入参之间的冲突，同时保留模型的语义理解和纠错能力。
> 实施原则：复用已完成的“学生 / 社会人士身份识别统一”姿势，分阶段演进，不一次性重写记忆系统和报名工具。
> 2026-07-27 修订：补 §0 统一证据模型总纲（三个"不统一"病理 + 采信分级 + 准入矩阵）、§15 badcase 族与生产量化、§16 已交付切片（PR #748）与执行裁定。原 §1-§14 的报名字段设计不变，是本模型在"报名字段 × 不可逆副作用"象限的具体化。

## 0. 总纲：统一证据模型

**一句话定义：档案里的每个字段不是一个"值"，而是一条"有出处的主张"；谁能写入、写入算几分、什么动作需要几分才能用——这三件事全系统只有一套规则、一个裁决点。**

`sessionFacts` 已有半个证据模型（`{value, source, evidence, confidence, extractedAt}` 信封），真正的病根是三个"不统一"：

1. **写侧不统一**：长期只有"候选人原文抽取"（rule/llm）一条渠道在写档案。geocode 唯一确权、GPS 定位分享、Agent 确认问句+肯定应答、真人经理带外裁决——四类更强的证据都进不了档案。
2. **读侧不统一**：每个消费者自带一套证据规则（invite 城市门字面扫描 + 私有区名表、复聊闸门只认自建 terminal 态、geocode anchor 又一套），同一事实在多处被独立裁决、互不相认。
3. **出侧没有门**：向候选人**展示**档案（预填表单、"你之前说过 X"）不需要任何出处——于是"GPS 都不算证据"（过严）和"臆造姓名进表单"（过松）同时存在。严与松并存恰恰证明缺的不是调松紧，而是**收口**。

### 0.1 证据渠道与采信分级

| 采信等级 | 渠道（source） | 例子 | 状态 |
|---|---|---|---|
| T1 亲证 | `candidate_text`（rule/llm 抽取自候选人原文） | "我在浑南区" | ✅ 一直有 |
| T1 亲证 | `location_share`（GPS 定位坐标逆解析） | 曹路定位 → 上海 | ✅ P0 已交付（source='tool'） |
| T1 亲证 | `confirmation`（Agent 确认句 + 候选人肯定应答） | "是在沈阳市对吧？"→"好的" | ⬜ P1（对应 §5.2 上下文确认字段的通用化） |
| T2 工具确权 | `tool_attested`（geocode unique / precheck / booking 结构化结果） | `_cityConfirmed: 沈阳市` | ✅ P0 已交付（城市字段，source='tool'） |
| T2 确定性推导 | `derived`（区名→城市、品类→品牌） | 浑南区→沈阳 | ⚠️ 两张覆盖不齐的表各裁各的，待 geo 区划库收口 |
| T2 带外权威 | `human_oob`（真人经理消息/操作、工单状态变化） | "这个候选人我拒了" | ⬜ P1 |
| T3 继承 | `cross_session`（长期画像带入本会话） | "之前意向填的上海" | ⚠️ 有画像无降级标记；展示侧已加出处门（P0） |
| 不采信 | `model_assertion`（模型自报参数） | invite(city=杭州) 凭空传 | ✅ 一直正确拒绝（HC-2，不动摇） |

T1/T2 全部由确定性规则产生（正则模板、工具返回、消息来源标记），无 LLM 实时判断进快环——符合"投递路径只准确定性动作"的既有裁定。

### 0.2 消费准入矩阵（收口的本体）

裁决收口不是建一个新服务，而是一张矩阵取代散落各处的 if：

| 动作风险档 | 例子 | 准入要求 |
|---|---|---|
| 不可逆副作用 | invite_to_group、booking 提交 | 关键字段 ≥ T2，且本会话内产生或本会话确认过 |
| 对外展示档案 | 预填报名表、"你之前说过 X" | 字段 ≥ T1 本会话亲证；`cross_session` 只准披露句式（"我记得你之前提过…现在还是吗"），禁止断言式 |
| 内部检索/推荐 | job_list 查岗、群资源段渲染 | 任何等级可用（含 T3），错了自会被候选人纠正，无副作用 |
| 触达决策 | 复聊、面试提醒 | 必须检查 `human_oob` 负向事实（经理已拒/已面试/带外约面），命中即静默 |

§1-§14 的 CandidateFactClaim / EffectiveCandidateProfile / PrecheckSnapshot 是这张矩阵在"报名字段 × 不可逆副作用"一格的完整实现设计；§16 的 P0 是"城市字段 × 不可逆副作用 + 展示档"两格的最小交付。

## 1. 背景

当前候选人资料同时存在于多个位置：

1. 当前轮候选人原始消息；
2. 当前轮 `highConfidenceFacts`；
3. Redis 中的 `sessionFacts`；
4. Supabase 中的长期 `profile_facts`；
5. Agent 调用 precheck / booking 时提交的工具参数。

同一字段可能同时存在多个不同值。历史事故中，候选人已经补充最新资料，但 Agent 仍从启动时 Prompt 的长期记忆中复制旧资料进行报名。

这个问题不能通过“完全禁止模型提交资料”解决。规则提取器并不具备完整语义理解能力，模型可能正确理解以下表达：

- “一米六三”应归一化为 `163cm`；
- “九十二斤”应归一化为 `46kg`；
- “还是之前那个号码”可能是在确认一个已明确询问的历史手机号；
- “我 03 年的”可能表达出生年份，而不是年龄 3 岁。

因此正确边界是：

> 模型拥有解释权和纠错权，但不能无证据地产生报名事实；系统负责验证证据、处理冲突、生成可审计的当前有效资料。

## 2. 与本分支身份识别统一方案的关系

本分支已经为“学生 / 社会人士”建立了一个领域内的统一识别器：

- `IdentityEvidence` 同时携带值、来源和候选人原话；
- `findLatestExplicitIdentityEvidence()` 从会话中寻找最新明确自报；
- 支持直接自述、表单回答、二选一回答和绑定问句的确认；
- precheck、booking 和出站守卫复用同一识别器；
- 保留旧值 API，支持渐进迁移。

这与本方案的核心姿势一致。后续不应再平行建设另一套身份事实系统，而应将其抽象为通用的候选人字段证据与裁决框架。

当前身份实现仍有以下边界：

- 只覆盖 `is_student`；
- `messageIndex` 不是稳定消息标识；
- 模型工具入参仍是裸值，不是带证据的声明；
- 没有统一输出 accepted / rejected / superseded / missing；
- Profile、Session、当前消息之间还没有统一裁决快照；
- Prompt 层和工具层仍可能使用不同的合并顺序。

## 3. 目标与非目标

### 3.1 目标

1. 当前轮候选人明确自报始终覆盖旧值；
2. 模型可以提交它对候选人消息的结构化理解；
3. 每个报名字段都能追溯到候选人消息或明确确认上下文；
4. 历史 Profile 只能作为待确认线索，不能无确认进入报名；
5. precheck 与 booking 使用同一份已裁决资料；
6. Agent 运行期间出现新消息时，旧资料不能产生不可逆副作用；
7. 改动可以按字段、按工具渐进上线。

### 3.2 非目标

1. 第一阶段不替换现有 `sessionFacts` 和 `profile_facts` 存储；
2. 第一阶段不要求所有候选人字段一次性迁移；
3. 不把正则或规则提取器设为绝对真理；
4. 不让同一个模型在没有外部校验的情况下“自己提交、自己证明”；
5. 不在第一阶段修改海绵报名 API。

## 4. 核心概念

### 4.1 CandidateFactClaim

模型、规则提取器和确认解析器都输出统一的事实声明：

```ts
type CandidateField =
  | 'name'
  | 'phone'
  | 'gender'
  | 'age'
  | 'isStudent'
  | 'education'
  | 'healthCertificate'
  | 'height'
  | 'weight'
  | 'householdProvince';

type CandidateFactOperation = 'set' | 'correct' | 'confirm' | 'clear';

type CandidateFactInterpretation = 'direct' | 'normalized' | 'context_confirmation' | 'derived';

interface CandidateFactClaim<T = unknown> {
  claimId: string;
  field: CandidateField;
  value: T;
  operation: CandidateFactOperation;
  producer: 'rule' | 'model' | 'confirmation_resolver' | 'human';
  interpretation: CandidateFactInterpretation;
  evidence: {
    candidateMessageId: string;
    quote: string;
    agentQuestionMessageId?: string;
  };
  reasoning?: string;
  assertedAt: string;
}
```

关键区别：模型不再只提交 `candidateName: "王玥"`，而是提交“王玥来自哪条候选人消息、属于直接提供还是纠正”。

### 4.2 EffectiveCandidateProfile

`EffectiveCandidateProfile` 是裁决结果的物化视图，不是不可挑战的真理：

```ts
type CandidateFactStatus = 'accepted' | 'historical_unconfirmed' | 'conflicted' | 'missing';

interface EffectiveCandidateField<T = unknown> {
  value: T | null;
  status: CandidateFactStatus;
  acceptedClaimId?: string;
  supersededClaimIds?: string[];
  source?: CandidateFactClaim['producer'];
  evidenceMessageId?: string;
  updatedAt?: string;
}

interface EffectiveCandidateProfile {
  version: number;
  messageWatermark: string;
  fields: Partial<Record<CandidateField, EffectiveCandidateField>>;
}
```

如果模型发现当前视图有误，它可以基于新的候选人证据提交 `correct` 或 `clear` claim，触发重新裁决。

### 4.3 PrecheckSnapshot

precheck 成功后生成一次不可变快照：

```ts
interface PrecheckSnapshot {
  precheckId: string;
  factsVersion: number;
  messageWatermark: string;
  jobId: number;
  effectiveProfile: EffectiveCandidateProfile;
  acceptedClaimIds: string[];
  missingFields: CandidateField[];
  createdAt: string;
  expiresAt: string;
}
```

booking 使用该快照验证模型最终提交值，避免 Prompt 中的旧资料重新进入 API payload。

## 5. 裁决规则

### 5.1 来源优先级

优先级不按“规则一定高于模型”排列，而按证据的新旧与明确程度排列：

```text
当前轮候选人明确自报或纠正
  > 当前会话较早的已接受自报
  > 与具体字段和值绑定的明确确认
  > 历史 Profile（仅待确认）
```

同一条候选人消息中，规则和模型可能产生不同 claim。此时由字段策略进行验证，而不是简单比较 producer。

### 5.2 字段风险分级

#### 严格身份字段

字段：姓名、手机号。

只接受：

- 直接原文；
- 明确纠正；
- 与具体字段和值绑定的确认。

禁止自由推导。

#### 可安全归一化字段

字段：身高、体重、年龄、户籍省份、学历等。

允许：

- 单位换算；
- 格式归一化；
- 白名单语义映射；
- 有明确原话的结构化解释。

例如：

```text
一米六三 → 163cm
九十二斤 → 46kg
安徽人 → 户籍省份安徽
```

#### 上下文确认字段

“是的”“没变”“还是之前的”不能单独成为事实，必须绑定最近一次明确的 Agent 确认问句。确认只提升被询问的字段，不得扩散到其他历史字段。

### 5.3 冲突处理

1. 新 claim 有明确候选人证据：覆盖旧 accepted claim；
2. 新 claim 只有模型推断且证据不足：reject 或 `needs_confirmation`；
3. 当前消息是否定或清除：生成 `clear` claim，不能依赖 `null 不覆盖`；
4. 学生被拒后改口社会人士：继续复用现有二次核实策略；
5. 历史 Profile 与当前 claim 冲突：历史值标记为 superseded，不再作为 Prompt 中的有效值展示。

## 6. Agent、precheck 与 booking 的职责

### 6.1 Agent

Agent 负责：

- 理解候选人自然语言；
- 提交 `CandidateFactClaim[]`；
- 根据 precheck 的 rejected / missing / conflicted 结果补问；
- 发现裁决错误时提交带新证据的 correct / clear claim。

Agent 不负责：

- 自己决定历史值可以无确认复活；
- 用 Prompt 中的资料作为工具入参的自证；
- 绕过 precheck 修改报名资料。

### 6.2 precheck

建议逐步将接口扩展为：

```ts
precheck({
  jobId,
  requestedDate,
  candidateClaims,
  // 旧 candidateName / candidatePhone 等暂时保留兼容
});
```

precheck 内部流程：

```text
模型 claims
  + 当前消息规则 claims
  + 本会话 accepted claims
  + 历史 Profile 待确认线索
  ↓
CandidateFactAdjudicator
  ↓
known / missing / conflicted / rejected
  ↓
PrecheckSnapshot
```

### 6.3 booking

第一阶段保持现有 booking 字段入参，新增：

```ts
precheckId: string;
factsVersion: number;
```

执行规则：

1. 模型提交值与快照一致：允许继续；
2. 模型提交值与快照不一致，但附带新证据 claim：返回“需要重新 precheck”；
3. 模型提交值与快照不一致，且没有新证据：拒绝；
4. 消息水位已变化：中止旧 booking，合并最新消息后重新执行；
5. 真正调用海绵前再次检查消息水位。

这里不是禁止模型提交信息，而是禁止未经裁决的新值直接产生外部副作用。

## 7. Prompt 收口

Prompt 不应把多个版本都描述成“已知信息”。建议改为：

```text
[已裁决候选人资料]
姓名：王玥（当前会话已确认）
手机号：19290703760（当前会话已确认）

[待确认历史线索]
健康证：存在历史记录，本次尚未确认

[已失效历史资料]
姓名：历史值已被当前消息纠正，不得继续使用
```

同时允许模型挑战裁决：

```text
如果你认为已裁决资料与候选人原始消息不一致，请提交带 messageId 和 quote 的
correct / clear CandidateFactClaim，不要无证据覆盖，也不要被旧 Profile 锁死。
```

`TurnHintsSection` 与 `HardConstraintsSection` 最终都应消费同一份裁决视图，避免 Prompt 与工具使用不同的覆盖顺序。

## 8. 分阶段实施

### Phase 0：修正现有链路，不引入新存储

目标：低风险消除当前明显不一致。

1. 当前轮有候选人原文证据时，Prompt 中直接覆盖旧 Session 值，不再一律标记待确认；
2. 修正 `HardConstraintsSection` 中当前值与 Session 值的合并顺序；
3. booking 不再从长期 Profile 单独回退 `is_student`；
4. 保留现有 precheck 和 booking 权威性闸门；
5. 为冲突覆盖、历史值缺失、新消息中止增加回归测试。

此阶段不新增数据库表，也不修改现有工具必填参数。

### Phase 1：先把 is_student 升级为标准 Claim

目标：用已经统一的身份识别器验证通用接口设计。

1. 将 `IdentityEvidence` 适配为 `CandidateFactClaim<boolean>`；
2. 使用稳定 `messageId` 替代 `messageIndex`；
3. precheck 返回 accepted / rejected / missing；
4. 保留 `findLatestExplicitIdentity()` 兼容包装；
5. precheck、booking、Session 写入、出站守卫消费同一裁决结果。

### Phase 2：扩展姓名、手机号和基础报名字段

推荐迁移顺序：

1. 姓名；
2. 手机号；
3. 性别、年龄；
4. 学历、户籍省份；
5. 身高、体重、健康证。

每迁移一个字段，都需要：

- claim schema；
- 规则 producer；
- 模型 claim 描述；
- 字段 validator；
- 冲突测试；
- precheck / booking 双闸门测试。

### Phase 3：PrecheckSnapshot 与版本化 booking

1. precheck 保存快照；
2. booking 强制携带 `precheckId + factsVersion`；
3. 候选人新消息导致版本失效；
4. 不一致值必须重新 precheck；
5. 观测记录保存 accepted claim IDs 和拒绝原因。

### Phase 4：移除旧裸字段兼容路径

只有在所有调用方、回归测试和生产观测稳定后，才考虑移除：

- precheck 的裸 `candidateName` / `candidatePhone` 等兼容逻辑；
- booking 对无 `precheckId` 调用的兼容；
- 各字段散落的重复正则和独立合并逻辑。

## 9. 建议代码结构

```text
src/memory/facts/candidate/
├── candidate-fact-claim.types.ts
├── candidate-fact-adjudicator.service.ts
├── candidate-fact-policy.ts
├── candidate-fact-normalizers.ts
├── candidate-effective-profile.ts
└── producers/
    ├── identity-claim.producer.ts
    ├── direct-field-claim.producer.ts
    └── model-claim.producer.ts
```

现有文件的演进方向：

- `src/tools/shared/identity-statement.util.ts`
  - 保留身份领域识别规则；
  - 输出通用 claim，不承担所有字段裁决。
- `src/tools/duliday-interview-precheck.tool.ts`
  - 从自行拼 `knownFieldMap` 逐步迁移为消费裁决结果。
- `src/tools/duliday-interview-booking.tool.ts`
  - 从逐字段读取各层记忆迁移为核对 precheck snapshot。
- `src/agent/generator/context/sections/turn-hints.section.ts`
  - 展示 accepted / pending / superseded，而不是自行判断冲突。
- `src/agent/generator/context/sections/hard-constraints.section.ts`
  - 只消费 accepted facts。

## 10. 兼容策略

为控制改动面，采用双读、单裁决、逐步切换：

1. 旧工具裸字段继续接收；
2. 旧字段在 precheck 内转换为 legacy model claim；
3. 有证据则 accepted，无证据则 rejected；
4. 新调用优先提交 `candidateClaims`；
5. booking 在灰度阶段同时执行旧校验与 snapshot 校验，只记录差异；
6. 差异率稳定后切换 snapshot 为强制闸门；
7. 最后删除旧路径。

## 11. 观测与审计

每次裁决至少记录：

```text
sessionId
turnId
field
claimId
producer
operation
evidenceMessageId
decision
rejectionReason
supersededClaimId
factsVersion
precheckId
```

禁止在普通日志中输出完整手机号等 PII；使用脱敏值或 hash。完整证据仅进入受控审计存储。

建议核心指标：

- model claim 接受率；
- 无证据 claim 拒绝率；
- 当前自报覆盖历史值次数；
- precheck snapshot 失效次数；
- booking 参数与 snapshot 冲突次数；
- 因字段无法裁决而转人工次数；
- 同一字段重复追问次数。

## 12. 测试矩阵

至少覆盖：

1. 当前姓名覆盖历史姓名；
2. 当前手机号覆盖历史手机号；
3. 模型从 Prompt 复制旧值但没有候选人证据；
4. “一米六三”“九十二斤”等归一化；
5. Agent 单值确认 + 候选人回答“对”；
6. 二选一问题 + “社会”短答案；
7. 含糊回答“好的”不能确认身份；
8. 候选人否定旧资料；
9. 学生被拒后改口社会人士的二次核实；
10. precheck 后候选人发送新资料；
11. booking 值与 snapshot 不一致；
12. Replay 后旧 precheckId 失效；
13. 跨会话 Profile 只能成为待确认线索；
14. 模型提交合理语义 claim 并成功纠正规则结果；
15. 模型提交无法由原文支持的 claim 被拒绝。

## 13. 验收标准

1. 任意 booking 身份字段都能定位到 accepted claim 或明确业务写回来源；
2. 当前轮明确自报与历史值冲突时，最终 payload 使用当前值；
3. 只有历史关键字段时，precheck 返回缺失或待确认；
4. 模型可以通过带证据 claim 纠正规则或旧 Profile；
5. 模型无证据提交不能进入 booking；
6. Prompt、precheck、booking 对同一字段读取相同裁决结果；
7. Agent 运行期间出现新消息时，不产生旧资料报名副作用；
8. 所有 rejected / superseded 决策可审计；
9. 现有身份识别、改口核实和出站守卫行为不回退。

## 14. 推荐落地决策

不建议立即实施完整通用重构。推荐顺序为：

1. 先完成 Phase 0，消除 Prompt、工具和 Profile 回退的不一致；
2. 以本分支现有 `IdentityEvidence` 为样板完成 Phase 1；
3. 观察一段时间后，再扩展姓名和手机号；
4. 最后引入 PrecheckSnapshot 强制版本化。

这样既能复用已经完成的身份统一工作，也能避免一次性改动全部记忆、Prompt、工具协议和外部报名链路。

## 15. Badcase 族实证与生产量化（2026-07-27）

统一证据模型不是推演出来的，是三个方向的同族 badcase 实锤出来的（近两周人工反馈 17 条中至少 8 条同族）：

### 方向一：证据在手，裁决不认（过严）

- **chat `6a671722`（沈阳案，反馈 recvqyVdngwioD）**：geocode 两次唯一确权"沈阳市"（`_cityConfirmed` 字段都造好了），候选人对"是在沈阳市对吧？"答"好的"——invite 城市门仍连拒 `city_unverified`，候选人被反问 3 次城市，最后发现沈阳根本没群，承诺链崩塌（"我是说进群"→引用旧承诺"说的是啥"）。
- **chat `6a618a6e`（上海浦东案，recvqah8oN1333）**：候选人发 **GPS 定位分享**，invite 门连拒 3 次（"好"→"嗯嗯"→"嗯"），Agent 甚至扯谎"刚系统定位没对上"，直到候选人打出字面"上海浦东"。
- **chat `6a61bb34`（佛山案，recvqbqAnx2LW8）**："南海狮山"（全国唯一区名）+ 确认答"对"都不算数，一小时后拉群前再确认一遍，候选人连发三条才凑出字面 token。

### 方向二：无证据当有证据（过松）

- **chat `6a4f520a`（赵堤案，recvqhdgsKjpkM）**：抽取层臆造的姓名/电话/身高/体重整张预填进报名表甩给候选人（"为什么给了一个填好的报名表单"）——展示侧没有任何出处门。
- **佛山案另一半**：跨会话旧档案"之前意向填的上海"被当断言复述，候选人投诉"哪里看出来之前在上海的"。

### 方向三：带外事实不入档

- 真人经理已拒绝面试/候选人已面试过，复聊与提醒照发（recvqgvKqRAcKg / recvqgw2wm58yF / recvqgxF51YhD8）——人工裁决从不写回事实层，触达闸门看不见。

### 生产量化（2026-07-20 起 7 天）

- `invite.city_unverified` 拒绝 **156 次 / 134 会话**；
- 其中 **69 次（44%）发生在同一轮 geocode 已唯一确权城市**的情况下（跨轮确权未计入，真实比例更高）；
- 8 个会话拷问完城市后撞上 `no_group_in_city`（整场拷问白做）。

## 16. 已交付切片：城市字段证据化 P0（PR #748，2026-07-27）

### 16.1 落地内容

| 项 | 实现 | 代码位置 |
|---|---|---|
| A1 geocode 确权回写 | unique 解析经 `onCityResolved` 回调暂存 turnState（镜像 onJobsFetched 模式），回合收尾 `save_attested_city` 步骤写 `pref.city`（source 新枚举 `'tool'`，high，证据带 formattedAddress），排在 extract_facts **之前**（T1 亲证可覆盖 T2） | `geocode.tool.ts` recordResolvedAnchor / `memory-lifecycle.service.ts` / `session.service.ts` saveToolAttestedCity |
| A2 定位分享入档 | extractFacts 检测本轮 user 块 `[经纬度:lat,lng]`（引用块剥离、多条取最新），`GeocodingService.reverseGeocode`（高德 regeo，30 天缓存）逆解城市入档；本轮文本已有高置信城市时让位 | `session.service.ts` buildLocationShareCityFact / `geocoding.service.ts` |
| B 读侧收口 | invite 城市门 session_fact 档按置信度采信不挑 source，零改动消费新证据；`[兼职群资源]` 段随 pref.city 恢复渲染，切断"城市未知→群资源段空白→模型瞎承诺拉群"链路 | `invite-city-gate.ts` / `context.service.ts` |
| C 展示出处门 | `[用户档案]` 段注入使用规则：历史沉淀字段预填/复述必须披露来源并请候选人确认，否认即弃用；与 PR #730 入库出处门形成入库+出库双门 | `memory-block.formatter.ts` formatProfile |

### 16.2 执行裁定（后续迭代必须遵守）

1. **冲突不覆盖**：工具确权（T2）与既有 high 城市冲突时不写——城市切换只能走候选人亲证（T1）；geocode 的 `_cityConflictNotice` 已把确认责任交给模型。
2. **不开 shadow**：全部为确定性放行/渲染改动，证据是外生工具结果非模型自报，失败模式安全（最坏=按 geocode 城市拉群/表单留空）。shadow 保留给语义识别类改动（如 P1 带外语义提取）。
3. **不做无群检查前置**：A1/A2 落地后有证据的城市都能过闸，剩下过不了闸的恰是模型凭空报城市的可疑场景，提前短路反而掩护幻觉——曾列入方案，用户裁定放弃。

### 16.3 P1 交付账（2026-07-28 全部落地）

- ✅ 确认问答裁决：PR #774（`confirmation-facts.ts` 纯规则；关键时序=纯应答闸门之前计算）。
- ✅ 带外工单核验：PR #777（pre_booking 到点查海绵全部工单，`oob-work-order.ts` 分类器；fail open；停止原因 `oob_*` 落 touch_records）。经理消息**语义**识别按"实时反馈循环行不通"裁定归离线环，未做。
- ✅ geo 收编：PR #781（geo 会话交付，区名私表删除、全国县级市生成化 380 条）+ PR #800 数据补录（沈阳/佛山 12 区名 + 2 裸名城市，余姚防线连带登记新民市）。
- ✅ 同轮空档两连修：PR #765（geocode 轨 turn_geocode 档）+ PR #798（定位分享轨 prep 轮内锚点）。
- ✅ Phase 0 核对（2026-07-28）：第 2 条（硬约束段合并顺序与工具层统一为本轮优先）实锤修复于 PR #800；第 3 条（booking is_student 长期画像回退）经核对已被身份统一识别器覆盖——profile 仅为本会话零证据时的三级兜底，完全删兜底留给 Phase 1 Claim 化（用 historical_unconfirmed 状态替代静默回退）；第 1 条随第 2 条修复对齐。

### 16.4 发版后验证（v10.31.0/v10.32.0 已做两轮）

- ✅ `invite.city_unverified`：~22 次/天 → 2 次（v10.31.0 后 21h）→ 1 次（v10.32.0 后 1.5h），三条残留全部定位为同轮空档并已修（#765/#798）；
- ✅ `pref.city` source='tool' 生产落库确认；观测口径教训：source 标签会被同轮抽取同值覆盖，看 `city_unverified` 量而非标签数；
- ✅ 回归资产：SCN-20260728-EVID-001~005 入正式测试集，批次 13d18a66/df442b41 同步生产 Dashboard（4 passed/1 波动复跑过/1 skipped）；
- ⏳ 待观测（Phase 2 启动门槛，见 §17）。

## 17. Phase 1/2 启动门槛（观测驱动，勿提前）

下一步是 §8 的 Phase 1（is_student Claim 化）与 Phase 2（姓名/手机号扩展）。**按 §14 推进原则与 2026-07-28 用户裁定，启动前必须凑齐以下观测**：

1. **城市线完整自然日复测**（v10.32.0+ 首个整日）：`city_unverified` 日量应 ≤2 且无新形态残留——证据模型推向报名字段（booking 提交，错误代价高于拉错群）前的有效性终审；
2. **带外闸一周命中分布**：`reengagement_touch_records.decision_reason LIKE 'oob_%'` 的命中量与形态，校准两个拍定阈值（僵尸单 3 天窗 / 面试通过 30 天窗）；
3. **confirmation 档首批真实命中**：生产尚未触发过（低频补充档），扩权前需真实样本；
4. **展示门效果**：预填类 badcase 是否归零（回归 EVID-005 未能诱发目标行为，生产是唯一观测面；复发则启动出站文本级二层门）。

同时保持的纪律：2026-07-27~28 两天已合 8 个 PR 动了记忆/闸门/复聊/geo 四个域，Phase 1/2 是结构性改造，应在上述观测追平变更后启动，由各自的 badcase 驱动（报名字段族当前最热的赵堤案已被入库门 #730 + 展示门 #748C 双门压制）。

## 18. 已交付切片：报名字段 Claim/裁决/快照体系（2026-08-05，shadow 首发）

§17 门槛的执行裁定（2026-08-05）：门槛 1/2 已达标（city_unverified 日量 ≤2、oob_* 一周 6 次命中形态健康），门槛 4 的臆造族持续出新变体（7-29 #843 四道字段门、8-03 标量扇出 #865）恰恰证明单点门打地鼠的边际成本在上升——用户裁定将其认定为启动 Phase 1/2 的正向信号，一次性交付 §4-§12 主体，以 shadow 模式接线。

### 18.1 落地内容

| 项 | 实现 | 代码位置 |
|---|---|---|
| §4.1 CandidateFactClaim | 十字段 × set/correct/confirm/clear × rule/model/confirmation_resolver/human；证据锚定以 **quote 子串核验**为主体（消息管道无稳定 messageId，messageIndex 仅排障辅助） | `src/memory/facts/candidate/candidate-fact-claim.types.ts` |
| §5.2 字段风险三分级 | strict_identity（name/phone 证据须逐字含值）/ normalizable（quote 确定性复算等价）/ boolean_identity（唯一识别器担保，模型 claim 走词典复核） | `candidate-fact-policy.ts` |
| §12-4 口语归一化 | "一米六三"→163、"九十二斤"→46kg（斤减半）、"03年的"→年龄，纯白名单换算 | `candidate-fact-normalizers.ts` |
| §4.2 EffectiveCandidateProfile | accepted/historical_unconfirmed/conflicted/missing 四态；clear 屏蔽历史线索复活；冲突不静默二选一 | `candidate-effective-profile.ts` |
| §5 裁决器 | 纯函数零 LLM：quote 出处验证 → 值-证据复算 → 同字段归并（correct/clear 最新胜、同值高优先 producer 胜、异值判 conflicted）；legacy 裸值全文推导补录（§10 双读） | `candidate-fact-adjudicator.ts` |
| §9 producers | direct-field（逐条消息锚定，复用 candidate-field-parser 单字段函数）/ identity（收编 IdentityEvidence，改口未核实不产 claim）/ model（显式 claims + 裸字段 legacy 转译） | `producers/` |
| §6.2 precheck 接线 | `candidateClaims` 入参（带 quote 声明）+ 全量裁决 + 响应 `factAdjudication` 视图（rejected/conflicted/historicalUnconfirmed + 行动指引）；enforce 模式下无据模型裸值剔出 knownFieldMap | `duliday-interview-precheck.tool.ts` |
| §4.3/§6.3 快照与 booking 闸 | precheck 即存 Redis 快照（TTL 2h，precheckId=`pc_{turnId}_{jobId}` 幂等）；booking 回传 precheckId 对账七字段 + 消息水位 + jobId，差异 emit 观测；enforce 拒绝要求重新 precheck | `precheck-snapshot.types.ts` / `candidate-snapshot.service.ts` / `duliday/booking/snapshot-gate.util.ts` |
| §7 Prompt 收口 | `[用户档案]` 三态：待确认线索（既有出处门）+ **已失效段**（本会话有更新值的历史字段只声明失效、不渲染旧值）；模型挑战裁决口径入 precheck description | `memory-block.formatter.ts` |
| §11 观测 | 新事件 `fact_adjudication`（precheck 裁决档案 + booking_gate 差异档案），PII 纪律：不携带值与 quote 原文；入 ALWAYS_PERSISTED 白名单落 `agent_execution_events` | `observer.interface.ts` / `persisting-observer.ts` |
| §12 测试矩阵 | 15 条全覆盖（41 个新用例）：矩阵 1-15 对应 adjudicator/normalizers/identity-producer/snapshot-gate/runner 五个 spec | `tests/memory/facts/candidate/` / `tests/tools/duliday/booking/` |

### 18.2 灰度与执行裁定

1. **shadow 首发**（`CANDIDATE_FACT_ADJUDICATION_MODE`，默认 shadow）：裁决全量计算+落观测+响应携带视图，但 knownFieldMap 的 2026-07-17 显式入参兼容口径、booking 提交行为**零变化**——裁决器虽为纯确定性，其拒绝面（quote 核验/推导等价）尚无生产分布数据，直接 enforce 会复活"字段卡死 collect_fields 空转"badcase（7-17 紧急口径的由来）。
2. **enforce 切换门槛**：`fact_adjudication` 事件观测 ≥1 周，rejected 中假阳（候选人确实说过但 quote 核验漏判）占比明确后再切；切换即完成方案 §13 验收 5（模型无证据提交不能进 booking）。
3. **Phase 4（删旧裸字段/兼容路径）按 §8 原文执行**：enforce 稳定后才动，本次刻意不删。
4. **快照对账范围从窄启动**：educationId/householdRegisterProvinceId 的 Sponge 数字 ID ↔ claim 标签映射对账留 enforce 前增强。
5. **human_oob producer 已留位**（producer='human'）：带外语义识别仍按"实时反馈循环行不通"裁定归离线环，当前无写入方。

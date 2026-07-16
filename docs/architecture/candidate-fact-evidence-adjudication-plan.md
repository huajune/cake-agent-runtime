# 候选人资料证据化与裁决收口方案

> 状态：设计草案
> 目标：解决候选人最新自报资料、会话事实、长期 Profile 与模型工具入参之间的冲突，同时保留模型的语义理解和纠错能力。
> 实施原则：复用本分支已经完成的“学生 / 社会人士身份识别统一”姿势，分阶段演进，不一次性重写记忆系统和报名工具。

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

# 字段值提案收口与条件式 recap

**所有者**：GPT 实施 + 用户验收
**状态**：实施与回归已完成，待用户逐项对账；未经明确授权不得归档或删除
**完成条件**：工具边界完成字段值提案命名收口；模型只写候选人原话明确支持的值，歧义值保持
`empty` 并定向追问；collection 删除 `high / medium` 置信度且不新增替代评分；recap 只服务外部
预填值；岗位确定后的首次收资同时展示并收集可约面试时间，选择结果作为表单旁边的预约草稿
持久化并在提交前复验；开放式确认不再依赖扩充肯定词表；既有公证、filled 棘轮、纠错、筛选、
提交凭据与后端打回回归全绿。

## 1. 最终裁定

表单收集采用业内常见的“模型抽取语义、代码校验封闭规则、状态机处理缺失与执行”分工：

```text
候选人表达
  ↓
模型判断该表达是否明确支持当前契约值
  ├─ 否 / 有歧义：不提交该字段提案
  │                ↓
  │              槽位保持 empty，定向追问该字段
  └─ 是：提交 FieldValueProposal
           ↓
         notary 校验出处、契约、形态、归属、已知冲突与筛选规则
           ├─ 不通过：拒绝写入，按既有重问 / 转人工机制处理
           └─ 通过：槽位 filled
                     ↓
                   所有必填字段 filled
                     ↓
                   是否含外部预填值？
                     ├─ 否：ready_to_book
                     └─ 是：发送 recap
                              ├─ 确认：ready_to_book
                              └─ 纠正：更新字段后重新派生行动
```

业务不变量：

1. 模型不确定时不把猜测写进表单，因此不存在“先存不确定值、最后靠 recap 兜底”；
2. 候选人本轮或本次收集流程中明确提供、且通过封闭校验的字段，不因表达非逐字而额外 recap；
3. 完整表达和多轮零散表达使用同一套逐字段写入规则，不另建 self-filled 旁路；
4. 历史档案、系统或人工预填不是候选人本轮自陈，提交前必须通过 recap；
5. 进入 collection 的前提是当前岗位和候选人的报名意图已经成立；缺少报名意图时先询问意图，
   不能用 recap 代替授权，也不能签发 booking 凭据。

recap 不迁移到报名成功之后。报名成功回执继续只承担岗位、门店、面试时间、地址和后续安排等
业务结果，不重复发送整张候选人资料。

## 2. 已完成与未完成

### 2.1 已完成：collection 内部字段值提案改名

2026-08-28 的候选人证据链收口已经完成 collection 内部的原子改名：

- `ValueProposal` → `FieldValueProposal`；
- `IntakeProposal` → `RoutedFieldValueProposal`；
- `collectProposals()` → `collectFieldValueProposals()`；
- `proposeValue()` → `applyFieldValueProposal()`。

字段写入仍只走 `applyFieldValueProposal()`，filled 棘轮、出处门、形态门、身份归属、先筛后收与
后端打回继续保留。

### 2.2 实施前差距（已完成）：工具边界仍叫 FormAnswer

实施前主模型输入是：

```ts
formAnswers?: FormAnswerInput[];
```

它表达的不是一份静态“答案”，而是模型对实时契约字段提出的带引文写入请求。工具边界继续叫
`FormAnswer` 会隐藏“提案尚未入账”的权责，也让 `operation:'confirm'` 容易被误解为确认整张表。

现已完成的原子改名：

| 当前名                   | 目标名                            |
| ------------------------ | --------------------------------- |
| `formAnswers`            | `fieldValueProposals`             |
| `FormAnswerInput`        | `FieldValueProposalInput`         |
| `FormAnswerInputSchema`  | `FieldValueProposalInputSchema`   |
| `FormAnswersInputSchema` | `FieldValueProposalsInputSchema`  |
| `FORM_ANSWER_OPERATIONS` | `FIELD_VALUE_PROPOSAL_OPERATIONS` |
| `form-answer-input.ts`   | `field-value-proposal-input.ts`   |

同步修改 precheck schema/description、collection intake/core、测试、当前态架构文档与 release
note；不保留两套长期别名。不改 `collection` 域名、海绵 collection contract、Sponge
endpoint/wire DTO、`bookingChecklist`、Redis key 或 booking payload。

### 2.3 实施前差距（已完成）：提案本体混入公证运行环境

实施前 `FieldValueProposal` 同时携带：

- 提案本体：`value / optionCodes / sourceText / producer / agentQuestionQuote / restatement`；
- 公证运行环境：`candidateTexts / messages`。

后两项不是模型提案，而是代码从当前 session 的真实消息中提取的可信语料。现已拆成独立参数：

```ts
interface FieldValueNotaryContext {
  candidateTexts: readonly string[];
  messages: readonly unknown[];
}

applyFieldValueProposal(form, field, proposal, notaryContext);
```

模型不能构造或修改 `candidateTexts / messages`。`sourceText` 只能在这份可信候选人语料中回查，
但这项检查只证明“这段话出现过”，不证明它在语义上支持模型提案。

### 2.4 实施前差距（已完成）：recap 触发条件错误

实施前状态机只有两种实际放行方式：

1. 候选人在一条消息中逐行填满整张模板，命中 `detectSelfFilledTemplate()`，伪造一份
   `lastRecap.affirmed` 后直通；
2. 其它 ready 表单几乎都进入 `confirm_collection`，等待肯定短答。

这个判据过窄：

- 候选人用完整自然语言报齐资料，未必逐行复刻模板；
- 多轮里每个字段都明确回答，仍然被强制 recap；
- self-filled 本来是普通的完整作答，却被做成特殊旁路；
- recap 成为普遍闸门后，肯定词表的任何漏词都会制造额外往返。

目标是删除 self-filled 特判，只对仍含外部预填值的 ready 表单生成 recap。

## 3. 字段值如何入账

### 3.1 模型负责开放语义抽取

模型负责判断候选人表达是否明确支持当前 collection contract 中的最终字段值。工具说明必须要求：

- 原话明确支持最终值时才提交 `FieldValueProposal`；
- 没提到、无法唯一映射、带明显保留或存在歧义时不提交该字段；
- 不为了填满表单猜值；
- `sourceText` 必须逐字取自候选人原话，不能用模型自己的改写充当出处；
- 一条消息可以同时产生多个明确字段提案，不能只取第一个字段。

例如：

```text
候选人：我 93 年的，还在读书，周六周日都有空。
```

模型可以提交年龄、学生身份、周六和周日可上班。`student` 不必逐字出现在“还在读书”里；
把开放语义重新翻译成封闭契约值，本来就是模型的职责。

而：

```text
候选人：平时上课，周末一般有时间。
```

如果契约要求明确选择周六和周日，模型不能先写 `['saturday', 'sunday']` 再标记“待复核”；
它应不提交这个字段，让槽位保持 `empty`，由状态机定向追问：

> 周六和周日都可以上班吗？

### 3.2 notary 只校验封闭规则

`applyFieldValueProposal()` 保留以下职责：

1. `sourceText` 非空，且能在代码提供的候选人语料中回查；
2. label、字段类型、optionCode、枚举、格式和值域符合当前 contract；
3. 姓名、手机号等身份字段通过既有归属门；
4. filled 棘轮、显式改口和 errorList 重开规则成立；
5. 确定性 parser/adapter 能得出结果时，与模型提案不存在已知冲突；
6. rejectedOptions、年龄区间等先筛后收规则通过。

notary 明确不负责：

- 用字符串包含重新判断开放语义；
- 因值没有逐字出现在原话里就否决所有非字面表达；姓名、手机号等封闭身份 token 仍保留
  现有的字面或数字锚定要求；
- 因确定性解析器不认识某种正常说法就降级或触发 recap；
- 给模型提案打语义置信分；
- 把已知冲突值先写入表单，再交给候选人兜底。

确定性 parser/adapter 是**已知冲突否决器和封闭字段规范器**，不是开放语义覆盖率门槛：

- 代码明确得出不同值：拒绝提案；
- 代码没有覆盖该表达：只要其它封闭规则通过，就采纳模型的语义提案；
- 模型对歧义表达提交了不该提交的值：这是模型抽取错误，进入 prompt、eval 与 badcase 修复，
  不再用另一套脆弱的字符串语义裁判掩盖。

确定性冲突沿用提案写入现有的拒绝返回与测试断言，不为它新增持久化字段、审计事件或统计埋点。

### 3.3 删除 collection 槽位置信度，不新增替代层

删除 `SlotConfidence` 与 `SlotValue.confidence`。不新增 `candidateConfirmed`、
`requiresCandidateReview`、数值分数或更多证据等级。

目标类型收敛为：

```ts
interface SlotValue {
  value: string;
  optionCodes?: string[];
  sourceText: string;
  producer: CandidateFactProducer;
}
```

`sourceText` 负责出处回查，`producer` 负责记录值由哪条生产通道产生；两者都不冒充语义真值证明。
Memory 域现有的 confidence 体系是另一套持久记忆语义，不在本次修改范围内。

### 3.4 业内基线

本裁定采用以下主流分工，不自建第二套自然语言判官：

- [OpenAI 模型抽取指南](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.2)：
  用严格 schema，缺失字段返回 `null`，不要猜测；
- [Rasa Slots](https://rasa.com/docs/reference/primitives/slots/)：LLM/NLU 填 slot，代码做格式、枚举等
  实时验证，失败才清除并重问；
- [Dialogflow CX Form Parameters](https://docs.cloud.google.com/dialogflow/cx/docs/concept/parameter)：
  用户表达填充参数，缺失或 no-match 才 reprompt；
- [OpenAI Tool Guardrails](https://openai.github.io/openai-agents-python/guardrails/)：工具边界做输入输出
  校验，不要求 guardrail 重新完成模型的开放语义理解；
- [Amazon Lex Intent Confirmation](https://docs.aws.amazon.com/lexv2/latest/APIReference/API_IntentConfirmationSetting.html)：
  整单确认是可按 intent 风险启停的步骤，不是所有表单固定必经；
- [Google Function Calling](https://ai.google.dev/gemini-api/docs/function-calling)：对有明显后果的调用在
  执行边界确认，而不是逐字段建立第二套语义裁决器。

## 4. 条件式 recap 与提交授权

### 4.1 recap 只处理外部预填

当前 collection 中，候选人本轮明确提供的值先写入，archive 只兜底仍为空的槽位。继续保持这个
顺序：当前候选人原话永远优先于历史预填。

`needsRecap` 只检查外部预填来源：

```ts
const EXTERNAL_PREFILL_PRODUCERS = new Set<CandidateFactProducer>(['archive', 'system', 'manual']);

export function needsRecap(form: BookingCollectionForm): boolean {
  return Object.values(form.slots).some(
    (slot) =>
      slot.state === 'filled' &&
      slot.value !== undefined &&
      EXTERNAL_PREFILL_PRODUCERS.has(slot.value.producer),
  );
}
```

`candidate_quote / rule / model` 只有在当前候选人表达明确支持值时才允许进入 collection，因此通过
notary 后均不触发 recap。`producer` 不是通用置信度；这里只用封闭来源集合识别“值是否来自候选人
之外”。

部署后的最长 3 天 Redis 兼容窗内，旧快照若带 `confidence:'medium'`，仍保守视为需要 recap；
旧 `confidence:'high'` 不单独触发 recap。兼容窗结束后删除这段临时代码，不做数据库迁移。

### 4.2 资料授权派生

```ts
export function isCollectionAuthorized(form: BookingCollectionForm): boolean {
  if (verdictOf(form) !== 'ready') return false;
  if (!needsRecap(form)) return true;
  return form.lastRecap?.affirmed === true;
}
```

含义：

- `ready && !needsRecap`：全部字段来自候选人本次收集中的明确表达，资料已经授权；
- `ready && needsRecap && !affirmed`：存在外部预填，生成并发送 recap；
- `ready && needsRecap && affirmed`：候选人已核对当前整表快照，资料已经授权。

资料授权只回答“这份候选人资料是否可以用于报名”，不等于最终已经可以提交。`ready_to_book` 和
`collectionReadyJobId` 还必须经过第 5 节的实时面试时间闸门；`wait_notice` 岗位除外。

任一槽位改值、清除、契约集合变化或 errorList 重开，都必须作废已有 `lastRecap`。如果候选人
通过既有合法 `confirm/correct` 路径把最后一个外部预填值改为本人明确表达的值，重新计算后可以
直接提交，不强制再发第二张 recap。

### 4.3 删除 self-filled 特判

`renderRecap()`、`lastRecap`、`applyRecapResult()` 与 `confirm_collection` 保留，但只服务
`needsRecap(form) === true` 的表单。

删除：

- `detectSelfFilledTemplate()`；
- `markSelfFilledConfirmed()`；
- `recap_self_filled / recap_self_filled_missed` 审计；
- “只有逐行填满模板才能直通”的 precheck 分支。

完整表达与多轮明确作答自然走同一条直通路径，不再通过伪造已确认 recap 获得提交资格。

### 4.4 booking 防御性闸门

```ts
export function isSubmissionAuthorized(input: {
  form: BookingCollectionForm;
  waitNotice: boolean;
  interviewTime?: string;
  interviewTimeBookingAllowed: boolean;
}): boolean {
  if (!isCollectionAuthorized(input.form)) return false;
  if (input.waitNotice) return true;

  return (
    input.interviewTime !== undefined &&
    input.form.scheduleDraft?.selectedInterviewTime === input.interviewTime &&
    input.interviewTimeBookingAllowed
  );
}
```

booking 继续同时要求：

1. 当前资料已授权，且非 `wait_notice` 岗位的精确 `interviewTime` 与草稿一致并实时可约；
2. 本轮 precheck 签发的 `collectionReadyJobId`；
3. jobId 具有真实召回出处；
4. 当前 collection 流程已经建立候选人的报名意图。

模型仍不能直接绕过 precheck 调用 booking。

## 5. 面试时间并行收集

### 5.1 领域边界：不是 FormSlot

面试时间不属于 Sponge collection contract，也不进入 booking `labelList`。它是岗位级、动态的预约
选择，继续通过 `requestedDate / interviewTime` 进入 precheck 和 booking：

```ts
{
  jobId,
  interviewTime,
  labelList,
}
```

保持分离的原因：

- collection contract 描述姓名、年龄、健康证等候选人资料；
- 可约时间随岗位、当前日期、报名截止和实时窗口变化；
- `wait_notice` / 审简历优先岗位没有候选人此刻可选的具体时间；
- 候选人换岗位后，原岗位时间不得沿用；
- 最终 booking 前必须重新确认该 slot 仍然 `bookingAllowed`。

因此禁止把“面试时间”伪造成 `FieldValueProposal`、动态 label 或普通 `FormSlot`。现有误投分流继续
保留：模型把面试时间误投到字段提案时，能解析的值转运到 `requestedDate`，不能解析的值返回明确
纠错提示。

### 5.2 对话边界：数据分开，不代表交互串行

当前 precheck 每轮已经计算 `scheduleRule / upcomingTimeOptions / bookableSlots`，但行动指令要求：

```text
collect_fields      → 只收资料
confirm_collection → 只发资料 recap
ready_to_book      → 才开始让候选人选面试时间
```

这会把本可并行的两件事拆成额外往返。目标改为：岗位确定并完成第一次 precheck 后，只要不是
`wait_notice`，首次收资消息同时包含两个独立区块：

```text
报名资料（来自 bookingChecklist）
姓名：
年龄：
手机号：
……

可约面试时间（来自 interview.bookableSlots）
- 9 月 1 日 周二 13:30–16:30
- 9 月 2 日 周三 13:30–16:30

回复资料时可以顺便告诉我想约哪个时间。
```

候选人可以在一条消息中同时提供资料和时间。模型同轮提交 `fieldValueProposals` 与
`requestedDate`；两条数据管道各自校验，不能互相冒充。

如果收资仍未完成，后续只追问缺失资料，但不得丢失候选人已经选过的时间。如果存在外部预填需要
recap，而候选人尚未选时间，可以把 recap 与真实可约时间并列发送，允许候选人一轮同时确认资料并
选择时间，不能再次强制串行。

### 5.3 表单旁边的预约草稿

当前 `requestedDate` 只是单次 precheck 参数。提前询问后如果不持久化，经过收资、纠错或 recap
轮次就只能依赖模型从历史消息重新搬运，无法形成确定性状态。

在 `BookingCollectionForm` 上增加与 `slots` 平级的预约草稿，而不是新增 FormSlot：

```ts
interface BookingScheduleDraft {
  /** 候选人明确提出的日期；尚未唯一解析到具体 slot 时保留。 */
  requestedDate?: string;
  /** 只能逐字取自最近一次 precheck 返回且 bookingAllowed=true 的 slot。 */
  selectedInterviewTime?: string;
  /** 候选人表达该选择的原话，沿用出处回查。 */
  sourceText: string;
}

interface BookingCollectionForm {
  slots: Record<number, FormSlot>;
  scheduleDraft?: BookingScheduleDraft;
}
```

约束：

1. 只保存候选人明确表达的日期或 slot；含糊表达不写，继续询问；
2. 同一日期只命中一个可约 slot 时可解析 `selectedInterviewTime`；命中多个时继续让候选人选具体
   时段；
3. 每次 precheck 都用实时 interview windows 复验草稿，不把持久化选择当作永久库存；
4. slot 失效或报名截止已过时清除 `selectedInterviewTime`，返回最新真实选项；
5. `wait_notice` 岗位不建立 schedule draft，booking 不传 `interviewTime`；
6. 草稿属于候选人 × 岗位表单作用域，换 jobId 不继承；
7. schedule draft 不进入 `labelList`、candidate archive 或 Memory profile。

### 5.4 状态机行动

新增明确行动 `select_interview_time`，禁止把“资料 ready”误当成“已经可以 booking”：

```text
表单未 ready
  → collect_fields，同时可以展示 / 接收面试时间

表单 ready + 有外部预填且 recap 未确认
  → confirm_collection（非 wait_notice 岗位可与选时间并行）

表单 ready + 资料已授权 + wait_notice
  → ready_to_book

表单 ready + 资料已授权 + 无有效 selectedInterviewTime
  → select_interview_time

表单 ready + 资料已授权 + 时间实时复验可约
  → ready_to_book
```

只有最后一种情况才签发 `collectionReadyJobId`。booking 继续只接受本轮 precheck 返回的
`bookingAllowed=true` 精确 `interviewTime`，并保留现有 booking schedule guard。

### 5.5 目标交互

```text
首次 precheck：返回动态资料契约 + 真实可约时段
  ↓
Agent：一条消息同时询问资料与面试时间
  ↓
候选人：一条消息同时给齐资料并选择时间
  ↓
precheck：字段提案入账 + schedule draft 复验
  ├─ 全部为候选人明确值、时间可约：ready_to_book
  ├─ 资料有缺失：只追问缺失字段，保留时间草稿
  ├─ 时间有歧义 / 已失效：只重新选时间，保留资料
  └─ 含外部预填：一次 recap，可同时完成选时间
```

## 6. recap 确认长尾 bug

### 6.1 现场证据

2026-08-07 00:00 至 2026-08-28 的高精度回放识别到 44 个完整报名复述事件，其中 33 个候选人
明确同意。用当前 `isAffirmativeAnswerSequence()` 反事实重放：

- 22/33 命中，覆盖 66.7%；
- 11/33 未命中，其中 7 条是“肯定 + 礼貌/行动/语气尾巴”，4 条是其它正常肯定表达；
- 当前工具链可完整追踪的 10 个事件里，3 个明确同意被规则漏掉，随后全部再次返回
  `confirm_collection`；
- “没问题，麻烦老师了”现场出现 1 次，第一次确认后重复复述，下一轮回复“好的”才进入
  `ready_to_book`。

样本足够确认因果链，不足以把比例当成稳定发生率；近 7 天多轮确认约 20% 混有其它已修原因，
不能直接算作本问题的单项占比。

### 6.2 根因

`isAffirmativeAnswerSequence()` 要求整句能由封闭肯定词完整切分。中文正常确认经常带礼貌尾巴，
因此漏判是结构性的；继续补词会在“覆盖不足”和“错误放行真实报名”之间来回摆动。

条件式 recap 会先消除绝大多数不必要确认轮，但真正存在外部预填值时仍需正确理解候选人回复。
纯短答与带礼貌尾巴的确认属于同一种开放语义，不保留两条生产授权分支。无论“好的”“确认”，
还是“没问题，麻烦老师了”，均由模型提交同一种 `recapConfirmation`，再由 recap notary 机械绑定
当前对话和表单快照。`isAffirmativeAnswerSequence()` 不再承担 recap 放行职责。

### 6.3 工具输入

仅在 precheck 已返回 `confirm_collection`、候选人正在回应当前 recap 时，模型可提交：

```ts
recapConfirmation?: {
  /** 候选人本轮完整回复，不得截取肯定子串。 */
  candidateQuote: string;
  /** 当前 assistant recap 中的确认句逐字片段。 */
  recapQuote: string;
};
```

例如：

```ts
recapConfirmation: {
  candidateQuote: '没问题，麻烦老师了',
  recapQuote: '没问题的话我这就帮你提交，有不对的地方直接说改哪项',
}
```

模型负责判断开放语言是否表达确认；代码不扩充礼貌词表。

### 6.4 recap notary

新增 `src/resolution/notary/recap-confirmation.ts`，只机械核验：

1. 当前 `needsRecap(form) === true`，且存在尚未确认的 `lastRecap`；
2. `candidateQuote` 等于最新候选人回复的完整文本，禁止截取半句；
3. 紧邻回复之前的连续 assistant 消息组包含 `recapQuote`；
4. assistant 消息组与当前 `lastRecap.labelIds` 对应的表单快照一致；
5. 本轮没有已经通过出处回查的 `correct/clear`，纠正优先于确认。

复述可能被分段器拆成连续多条 assistant 消息，核验前合并相邻 assistant 段。recap notary 不判断
同意、否定、转折或礼貌语义，只防伪造引用、截断引用和确认错快照。

通过后仍只调用现有：

```ts
applyRecapResult(form, { affirmed: true });
```

不增加新的表单状态。

## 7. 明确不做

- 不把 recap 设为所有 ready 表单的固定步骤；
- 不完全删除 recap，也不把 recap 移到报名成功之后；
- 不把完整表达限定为逐行复刻模板；
- 不把零散收集本身当作必须 recap 的条件；
- 不把模型不确定的猜测写入槽位后再让候选人整表兜底；
- 不让 notary 用字符串规则重新裁判开放语义；
- 不继续维护 collection 槽位的 `high / medium`，也不新增 `candidateConfirmed`、
  `requiresCandidateReview`、数值分数或更多等级；
- 不继续给肯定词表扩礼貌尾巴和开放口语，也不保留纯肯定短答的独立快速放行分支；
- 不把 recap 确认建模成多个 `FieldValueProposal`，不放宽 filled 棘轮；
- 不新增确认来源、notary 结果、拒绝原因、重复确认轮数等状态、事件或统计；
- 除在既有 Redis 表单内增加 `scheduleDraft` 外，不新增数据库表、独立 Redis key、影子裁决器或
  专用观测协议；
- 不把面试时间塞进 collection contract、`FormSlot`、`labelList` 或候选人长期档案；
- 不因数据模型分离而把“收资料”和“选时间”强制拆成前后两个对话阶段；
- 不改变 Sponge collection contract、booking payload、筛选、errorList 或提交封存行为。

现有 `chat_messages` 与 `message_processing_records.tool_calls` 足以复原问题现场，后续继续用现有
记录抽样，不增加专用观测协议。

## 8. 实施步骤

- [x] A. 原子改名工具边界：`formAnswers` → `fieldValueProposals`，同步 schema、prompt、
      intake/core、测试和文档；全库旧符号零生产命中。
- [x] B. 把 `candidateTexts/messages` 从 `FieldValueProposal` 拆为公证上下文，行为零变化。
- [x] C. 重写模型工具契约：只提交原话明确支持的最终值；缺失、歧义或不能唯一映射时不提交，
      由 empty 槽位走既有定向追问。
- [x] D. 收窄 notary：保留出处、契约、形态、归属、棘轮、已知冲突与筛选；删除“解析器未覆盖
      即降低确定性”的语义代偿逻辑。
- [x] E. 删除 collection 的 `SlotConfidence` / `SlotValue.confidence`；不新增替代字段，Memory
      confidence 保持不变。
- [x] F. 实现并导出基于外部预填 producer 的 `needsRecap(form)` 与
      `isCollectionAuthorized(form)`；再由 precheck 和 booking 共用同一个组合资料授权、岗位类型和
      实时时段的 `isSubmissionAuthorized(input)`，禁止各写一份。
- [x] G. 删除 self-filled 特殊检测、伪 recap 落账和专属审计；候选人明确提供的完整表单自然直通。
- [x] H. 仅在存在外部预填时生成 recap；字段变化后作废旧快照并重新派生行动。
- [x] I. 为真实 recap 增加统一的 `recapConfirmation` 与 notary 对话绑定；纯短答和开放确认走同一
      入口，删除 `isAffirmativeAnswerSequence()` 的 recap 放行职责。
- [x] J. 在最长 3 天 Redis 兼容窗内保守识别旧 `confidence:'medium'`；到期删除兼容，不做数据库
      迁移。
- [x] K. 在 `BookingCollectionForm` 增加与 slots 平级的 `scheduleDraft`；保存候选人明确选择，
      jobId 变更不继承，wait_notice 不建立。
- [x] L. 首次收资并行渲染真实 `bookableSlots`；同轮接收字段提案与 `requestedDate`，后续收资、纠错
      和 recap 不丢失已选时间。
- [x] M. 新增 `select_interview_time` 行动；每次 precheck 复验草稿，只有资料授权与可约时间同时满足
      才签发 `collectionReadyJobId`。
- [x] N. 更新 `collection-form-machine.md`、precheck/booking 描述与 2026-08-28 release note；保留本
      todo 作为实施对账单，逐项勾选 A–N 和 §9，并在文末回填对应代码、测试及文档证据。只有用户
      完成对账并明确授权后，才能归档或删除本文件。

## 9. 验收断言

### 9.1 字段抽取与 notary

- [x] “93 年的”“还在读书”等明确非逐字表达可以由模型直接映射为规范值并通过 notary；
- [x] “周末一般有时间”等不能唯一映射的表达不产生该字段提案，槽位保持 empty 并定向追问；
- [x] 模型不得输出用于“先填后确认”的猜测值、置信分或复核标记；
- [x] `sourceText` 不在候选人可信语料中、值不属于契约或形态非法时继续拒绝；
- [x] 确定性 parser/adapter 与模型提案明确冲突时拒绝写入；
- [x] 确定性 parser/adapter 未覆盖某个正常表达本身不构成拒绝或 recap 理由；
- [x] 姓名、手机号归属门、filled 棘轮、先筛后收与 errorList 行为保持不变。

### 9.2 直通与 recap 路由

- [x] 候选人用一条完整自然语言报齐全部字段，资料直接授权且不触发 recap；已选有效时间时进入
      `ready_to_book`，否则只进入 `select_interview_time`；
- [x] 候选人分多轮明确回答全部字段，资料仍直接授权；最终行动同样只由是否已有有效时间决定；
- [x] 一条消息逐行填满模板与自然语言报齐走相同路径，不再需要 self-filled 特判；
- [x] archive、system、manual 外部预填值使 ready 表单进入 `confirm_collection`；
- [x] 本轮候选人明确值优先于 archive，全部槽位均由候选人明确提供时不生成 recap；
- [x] 候选人纠正最后一个外部预填字段后，重新计算为无需 recap；有有效时间才放行提交，否则只
      继续选时间；
- [x] 旧 Redis 快照的 `confidence:'medium'` 在兼容窗内保守触发 recap；
- [x] 未建立报名意图或未授权表单不得获得 `collectionReadyJobId`，booking 双闸继续拒绝旁路提交。

### 9.3 面试时间并行收集

- [x] 岗位确定后的首次收资同时展示 bookingChecklist 与当前真实 bookableSlots；
- [x] 候选人一条消息同时给齐资料并选择时间时，同轮完成字段写入与 schedule draft；
- [x] 面试时间不出现在 requiredFields、FieldValueProposal、FormSlot 或 booking labelList；
- [x] 资料未齐时保留已选时间，后续只追问缺失资料；
- [x] 资料已齐但未选有效时间时返回 `select_interview_time`，不得签发 booking 凭据；
- [x] 同一日期命中多个时段时必须让候选人继续选择，不得由模型擅自挑一个；
- [x] 已选 slot 失效或过报名截止时只重选时间，不清空已收资料；
- [x] 外部预填 recap 与选时间可以在同一候选人轮完成，不强制再拆一轮；
- [x] wait_notice 岗位不展示虚构时段、不建立 schedule draft、booking 不传 interviewTime；
- [x] 换 jobId 后不得继承旧岗位 schedule draft；
- [x] booking 前本轮 precheck 再次确认 selectedInterviewTime 对应 `bookingAllowed=true`。

### 9.4 统一 recap 确认

- [x] “没问题”“好的”“确认”“没问题，麻烦老师了”“可以的，麻烦了”等明确确认表达，均通过
      统一的模型语义陈述 + recap notary 通道一次放行；
- [x] 纯短答与带礼貌尾巴的表达产生相同形态的 `recapConfirmation`，recap 授权路径不再调用
      `isAffirmativeAnswerSequence()`；
- [x] 模型不再把全部 filled 字段以 `operation:'confirm'` 重投；
- [x] `candidateQuote='没问题'` 不能匹配完整回复“没问题，但是电话错了”；
- [x] 同轮存在有效 `correct/clear` 时 correction 胜出，recap 不得 affirmed；
- [x] 引用旧 recap、未真实发送的 recap、与当前字段快照不一致的 recap 一律不放行；
- [x] 未通过确认继续停在 `confirm_collection`，不得产生 booking 凭据。

### 9.5 结构与回归

- [x] `src/` 中 `FormAnswerInput`、`FormAnswersInputSchema` 与 `formAnswers` 零生产命中；
- [x] `FieldValueProposal` 不再携带 `candidateTexts/messages`；
- [x] `src/resolution/collection` 中 `SlotConfidence` 与槽位 `confidence` 零生产命中；
- [x] `candidateConfirmed` 与 `requiresCandidateReview` 零命中，Memory confidence 不受影响；
- [x] `detectSelfFilledTemplate`、`markSelfFilledConfirmed` 与 recap self-filled 审计零命中；
- [x] precheck 与 booking 只从同一个 `isSubmissionAuthorized()` 判断提交资格；
- [x] `select_interview_time`、schedule draft 持久化、实时失效与 wait_notice 分支均有状态机单测；
- [x] 新增路由单测覆盖完整表达、多轮明确作答、歧义不写入、非逐字语义、确定性冲突、archive
      预填、纠正外部预填、契约变更与 errorList；
- [x] 新增 recap notary 单测覆盖真实相邻问答、分段复述、截断引用、陈旧快照和纠正优先；
- [x] collection、precheck、booking、typecheck、lint、全库旧符号扫描与生产回归全部通过。

## 10. 实施对账证据（2026-08-28）

### 10.1 A–N 代码与文档证据

| 步骤 | 代码/文档证据                                                                                                                                                                                                                          | 主要测试证据                                                                                                                                                                                |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A    | `src/tools/collection/field-value-proposal-input.ts:13`；`src/tools/collection/proposal-intake.ts:33`；`src/tools/duliday-interview-precheck.tool.ts:90`                                                                               | `tests/tools/collection/proposal-intake.spec.ts`；`tests/tools/tool/duliday-interview-precheck.tool.spec.ts:200`；旧符号扫描零命中                                                          |
| B    | `src/resolution/collection/form-writes.ts:82` 的提案本体与 `:123` 的 `FieldValueNotaryContext`；`src/tools/collection/collection-core.ts:152` 分参调用                                                                                 | `tests/resolution/collection/form-writes.spec.ts`；typecheck 通过                                                                                                                           |
| C    | `src/tools/duliday-interview-precheck.tool.ts:90` 的“明确才提交、歧义不提交、不得猜值”契约                                                                                                                                             | `tests/tools/collection/collection-core.spec.ts:120`；`tests/resolution/collection/form-writes.spec.ts:695`                                                                                 |
| D    | `src/resolution/collection/form-writes.ts:305` 的确定性冲突否决；parser 未覆盖不拒绝                                                                                                                                                   | `tests/resolution/collection/form-writes.spec.ts:660`、`:682`、`:695`                                                                                                                       |
| E    | `src/resolution/collection/form.types.ts:126` 的无置信度 `SlotValue`；Memory 类型与测试未改                                                                                                                                            | `tests/resolution/collection/form-writes.spec.ts:640`；`tests/memory/vocab-single-home.spec.ts`；collection 置信度扫描零命中                                                                |
| F    | `src/resolution/collection/authorization.ts:14`、`:25`、`:35`；precheck `src/tools/duliday-interview-precheck.tool.ts:686` 与 booking `src/tools/duliday-interview-booking.tool.ts:263` 共用最终闸                                     | `tests/resolution/collection/authorization.spec.ts`；`tests/tools/tool/duliday-interview-booking.tool.spec.ts:232`、`:240`、`:256`                                                          |
| G    | 已删除 `self-filled-template.ts` 及专属测试；生产扫描无 self-filled 检测、伪 recap、专属审计                                                                                                                                           | `tests/tools/tool/duliday-interview-precheck.tool.spec.ts:283`、`:311`、`:335`                                                                                                              |
| H    | `src/tools/duliday-interview-precheck.tool.ts:628` 仅在 `needsRecap` 时渲染；槽位变更由 `withoutRecap` 作废快照                                                                                                                        | `tests/tools/tool/duliday-interview-precheck.tool.spec.ts:430`、`:478`；`tests/tools/collection/collection-form.service.spec.ts:174`；`tests/resolution/collection/form-writes.spec.ts:746` |
| I    | `src/resolution/notary/recap-confirmation.ts:40`；`src/tools/duliday-interview-precheck.tool.ts:93`、`:582`；`src/resolution/signal/dialogue.ts` 不再导出 recap 序列判据                                                               | `tests/tools/tool/duliday-interview-precheck.tool.spec.ts:441`、`:507`；`tests/resolution/notary/recap-confirmation.spec.ts`；旧函数扫描零命中                                              |
| J    | `src/resolution/notary/legacy-collection-snapshot.ts:2`，兼容截止为 2026-08-31 00:00 +08，最长不超过 3 天                                                                                                                              | `tests/resolution/collection/authorization.spec.ts:52`                                                                                                                                      |
| K    | `src/resolution/collection/form.types.ts:184`、`:210`；`src/resolution/collection/form-writes.ts:696`                                                                                                                                  | `tests/resolution/collection/schedule-draft.spec.ts`                                                                                                                                        |
| L    | `src/tools/duliday-interview-precheck.tool.ts:360` 同轮协调两条管道；首次收资指令位于 `:85`                                                                                                                                            | `tests/tools/tool/duliday-interview-precheck.tool.spec.ts:219`、`:283`、`:456`                                                                                                              |
| M    | `src/tools/duliday-interview-precheck.tool.ts:262`、`:686`、`:693`；只有 `:415` 的 ready 分支签发凭据                                                                                                                                  | `tests/resolution/collection/schedule-draft.spec.ts:80`、`:105`；`tests/tools/tool/duliday-interview-booking.tool.spec.ts:232`、`:240`                                                      |
| N    | `docs/architecture/collection-form-machine.md`、`docs/principles/glossary.md`、`docs/principles/bitter-lessons.md:93`、`docs/prompt-rule-ledger.md`、`docs/product/agent-for-operations.md`、`docs/releases/2026/weekly-2026-08-28.md` | 文档 Prettier 检查、`git diff --check` 通过；本对账文档保留在原路径                                                                                                                         |

### 10.2 §9 验收证据索引

- **§9.1 字段抽取与 notary**：`tests/resolution/collection/form-writes.spec.ts:660`、`:682`、
  `:695` 分别覆盖 adapter 未覆盖、确定性冲突与“93 年/还在读书”；
  `tests/tools/collection/collection-core.spec.ts:120` 覆盖“周末一般有时间”留空定向追问。
  原有 form-writes、deadlock、contract、identity、screening 与 errorList 回归继续全绿。
- **§9.2 直通与 recap 路由**：`tests/tools/tool/duliday-interview-precheck.tool.spec.ts:283`、
  `:311`、`:335`、`:430`、`:478` 覆盖完整表达、逐行表单、多轮、外部预填和纠正最后一个
  预填；`tests/resolution/collection/authorization.spec.ts:52` 覆盖旧 Redis；booking 防旁路见
  `tests/tools/tool/duliday-interview-booking.tool.spec.ts:232`、`:256`。
- **§9.3 时间并行**：`tests/tools/tool/duliday-interview-precheck.tool.spec.ts:219`、`:283`、`:456`
  覆盖首次展示、同轮资料+时间、recap+时间；`tests/resolution/collection/schedule-draft.spec.ts`
  覆盖唯一/多时段、持久化、失效、wait_notice 与岗位隔离；booking 实时一致性见
  `tests/tools/tool/duliday-interview-booking.tool.spec.ts:240`。
- **§9.4 统一 recap**：`tests/tools/tool/duliday-interview-precheck.tool.spec.ts:441` 参数化覆盖
  “没问题/好的/确认/没问题，麻烦老师了/可以的，麻烦了”的同形态入口，`:507` 证明未提交
  `recapConfirmation` 的短答不能旁路；`tests/resolution/notary/recap-confirmation.spec.ts` 覆盖完整
  最新回复、相邻分段 recap、旧/伪造 recap、快照不一致与纠正优先。
- **§9.5 结构与回归**：扫描确认 `src/` 中旧 FormAnswer、self-filled、recap 序列放行函数、
  `candidateConfirmed`、`requiresCandidateReview` 零命中；`src/resolution/collection/` 中
  `SlotConfidence` / 槽位 `confidence` 零命中。`FieldValueProposal` 与 notary context 的类型边界
  由 typecheck 证明。

### 10.3 最终验证记录

- 定向回归：24 suites、379 tests、3 snapshots 全部通过；
- 全量 Jest：442 suites、6387 tests、3 snapshots 全部通过；仓库既有 1 suite / 5 tests skip；
- `pnpm run typecheck`、`pnpm run lint:check`、`pnpm run format:check`、`pnpm run build` 全部通过；
- 相关 Markdown Prettier 检查、`git diff --check`、旧符号与 collection 置信度扫描全部通过。

### 10.4 保留与归档边界

本文件是实施对账单，当前必须保留在 `docs/todo/field-value-proposal-recap-confirmation.md`。
只有用户完成逐项对账并明确授权后，才能归档或删除本文件及其索引项；本次实施未执行归档或删除。

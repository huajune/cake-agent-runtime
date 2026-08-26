# Precheck 收资入参统一专项改造方案

**状态**：待执行

**所有者**：GPT 执行 + 用户验收

**范围**：`duliday_interview_precheck` 的收资输入协议、槽位提案接入、清单/模板的标签展示协议和对应测试

**完成条件**：主模型只面对一套岗位表单答案协议，收资清单仍只由岗位接口契约和表单槽位状态生成，相关单测、类型检查和 CI 全部通过

**约束**：不新增 LLM 调用，不新增观测项、Dashboard、shadow diff、人工标注流程或第二套收资状态

## 1. 一句话结论

岗位接口返回的标签表单是 precheck “收什么”的唯一权威；`candidateClaims` 与
`formAnswers` 只是历史上先后形成的两种答案运输协议。专项改造应保留契约表单，升级
`formAnswers` 使其同时承载规范值和候选人原话，并从主模型可见的 precheck 入参中移除
`candidateClaims`，不再让模型决定同一份答案应该走哪个入口。

## 2. 当前事实与不可破坏边界

### 2.1 岗位契约决定字段全集

当前链路以 `fetchJobCollectionContract(jobId)` 返回的岗位标签契约为唯一字段来源：

```text
岗位接口标签契约
  → mapContractFields()
  → 以 labelId 建立 BookingCollectionForm.slots
  → renderCollectionTemplate()
  → bookingChecklist
```

姓名、电话、年龄、学生身份、健康证和服装尺码在收资模型里没有两套地位；它们都是岗位
契约中的槽位。`systemField` 和标题语义族只用于帮助代码定位常见字段，不产生第二套字段全集。

### 2.2 发给候选人的清单不由答案入参决定

清单字段必须保持以下关系：

```text
requiredFields = 岗位契约中的必填字段
displayOrder = 岗位契约字段按既有规则排序
missingFields = 岗位契约中 state=empty 的槽位
requiredFieldsToCollectNow = 本轮允许询问的 empty 槽位
knownFieldMap = 已通过公证并处于 filled 的槽位
```

因此：

- `formAnswers` 不能增加、删除或改变岗位要求的字段；
- `formAnswers` 只能尝试填写契约中已经存在的槽位；
- 答案通过公证后，相应字段从 `missingFields` / `requiredFieldsToCollectNow` 移除；
- 答案无对应契约字段、缺少证据或值不符合契约时，槽位继续保持 empty；
- `templateText` 仍由完整契约渲染：已填字段预填，未填字段留空；
- 熔断或转人工可以停止继续发问，但不能篡改岗位字段全集。

本专项不得修改这些不变量。

## 3. 为什么会出现两个入参

### 3.1 `formAnswers` 先解决动态标签无回填入口

2026-06-10 的提交 `ee28c4ac` 为 precheck 增加了
`candidateSupplementAnswers`，后来改名为 `formAnswers`。

当时标准资料分别使用 `candidateName`、`candidateAge`、`candidateIsStudent` 等固定入参，
但岗位接口可以返回任意 collect 标签，例如居住地址、可出勤时间、服装尺码。没有开放标签答案
入口时，候选人已经回答的补充标签无法写回 `knownFieldMap`，`missingFields` 永远无法清零，
booking 持续被拒。

`formAnswers` 因此采用了开放结构：

```ts
formAnswers: {
  居住地址: '徐汇区',
  服装尺码: 'L',
}
```

它解决的是“任意岗位标签如何定位并填写契约槽位”。

### 3.2 `candidateClaims` 后解决候选人事实的证据问题

2026-08-05 的提交 `e1778e62` 增加 `candidateClaims`，最初服务候选人事实 Claim 裁决，
不是为了替代岗位动态表单。

它补充了旧 `Record<labelTitle, string>` 不具备的能力：

- 分离规范值 `value` 与候选人原话 `quote`；
- 表达“一米六三 → 163”“毕业两年 → 社会人士”等语义归一化；
- 支持 `set`、`correct`、`confirm`、`clear`；
- 通过 quote 回查防止模型编造候选人资料；
- 处理历史事实、本轮改口和多来源冲突；
- 为候选人档案与 booking 对账提供证据结构。

它解决的是“模型理解出的候选人事实是否有原话依据、能否安全覆盖旧值”。

### 3.3 表单状态机切换时保留了两条运输通道

2026-08-20～21 切换为岗位契约驱动的持久表单后，旧固定裸参数被删除，但两种能力被一起接入：

```text
candidateClaims
  → 用内部 CandidateClaimField 定位常见语义字段
  → 携带 value + quote + operation

formAnswers
  → 用实时 labelTitle 定位任意岗位字段
  → 只携带候选人答案字符串
```

这在迁移期解决了两边各自覆盖不到的缺口，但也把历史兼容边界暴露给了主模型。

### 3.4 2026-08-26 真实链路实测依据

以下问题清单由本地真实 Agent 链路实测证实（`/test-suite/chat`，生产同款 chat 路由，
必胜客虹桥万象城 529088，13 字段契约含 `体重(kg)`/`身高(cm)` 与 5 个动态标签）：

- 模型不逐字照发 `templateText`：自行改写行标签（全角括号、自加说明括号、删除已填行），
  三层照发指令（description / `_replyInstruction` / 阶段策略）同时在场仍发生；
- 模型在 `formAnswers` 中编造过契约外 key（`身份`），被标题定位静默忽略、零审计；
- `candidateClaims` 的选项字段值适配失败时静默丢弃（`healthCertificate=入职前办妥`实测被丢）、零审计；
- `学信网是否在籍：false` 裸布尔经模板与 recap 实际发给了候选人；
- 干净标题逐字回抄全部命中（通勤时间/能做多久/意向岗位/意向班次 4/4）；模型产生的全部标题
  变形均被两级匹配（NFKC + 双侧剥括号主干 + 撞车即弃）吸收，零错槽写入，失败一律降级为重问；
- 全量在招目录扫描（12 城 443 岗、去重 51 个标签标题）：脏标题（筛选指令括号/标点/超长）为零，
  唯一被 `formLabel` 剥改的只有 `体重(kg)`/`身高(cm)` 两个单位括号标题。

结论：标题漂移的主要制造者是 precheck 自己的返回契约——六个清单给 `labelTitle` 原文、
`templateText` 给剥洗后的变体，两条照发指令引用两个不一致的字符串源，模型被迫调和。

## 4. 当前问题

### 4.1 同一契约槽位存在两个模型入口

学生身份等字段可能同时通过两种方式提交：

```ts
candidateClaims: [
  {
    field: 'isStudent',
    value: false,
    quote: '我已经毕业两年了',
  },
];
```

或：

```ts
formAnswers: {
  是否为学生: '我已经毕业两年了',
}
```

两者最终都会被转换为同一 `labelId` 的 `ValueProposal`。问题不在表单状态机，而在工具把
“选运输通道”的责任交给了模型。

### 4.2 工具输出语言与 `candidateClaims` 入参语言不一致

precheck 返回给模型的是岗位契约标题：

```text
bookingChecklist.requiredFieldsToCollectNow = ["是否为学生", "服装尺码"]
```

但 `candidateClaims` 要求模型再翻译成内部枚举：

```text
是否为学生 → isStudent
```

动态字段则仍要求使用标题填写 `formAnswers`。模型必须先判断字段是不是十个封闭语义字段，
再选择不同的顶层参数和不同的数据形状。生产中漏传 `candidateClaims` 是这个协议歧义的直接风险，
不应只靠增加工具说明解决。

### 4.3 两个旧结构各缺一半能力

只保留当前 `candidateClaims` 不可行，因为 `CandidateClaimField` 是封闭枚举，无法覆盖任意岗位标签。

只保留当前 `Record<string, string>` 形式的 `formAnswers` 也不可行，因为它无法同时表达：

```text
规范值：社会人士
原话：我已经毕业两年了
动作：纠正旧值
```

因此目标不是简单删除其中一个实现，而是合并两者的能力。

## 5. 目标设计

### 5.1 主模型只使用一套 `formAnswers`

建议把 precheck 的模型可见输入收敛为：

```ts
interface FormAnswerInput {
  /** 必须逐字取自 bookingChecklist.requiredFields。 */
  labelTitle: string;
  /** 写入契约槽位的规范值，须属于该字段答案词表（文本/选项标签/数值）；clear 时为 null。
   *  不收 boolean——布尔字符串化产物不是任何契约字段的合法答案（§5.5 值词表门）。 */
  value: string | number | null;
  /** 候选人原话逐字片段；普通 set/correct 必填。 */
  quote?: string;
  operation?: 'set' | 'correct' | 'confirm' | 'clear';
  /** operation=confirm 且值来自 Agent 问句时必填。 */
  agentQuestionQuote?: string;
}

formAnswers?: FormAnswerInput[];
```

示例：

```ts
formAnswers: [
  {
    labelTitle: '是否为学生',
    value: '社会人士',
    quote: '我已经毕业两年了',
  },
  {
    labelTitle: '服装尺码',
    value: 'L',
    quote: '我穿L码',
  },
];
```

直接答案不需要模型做额外转换：

```ts
{
  labelTitle: '居住地址',
  value: '徐汇区',
  quote: '我住徐汇区',
}
```

确认式答案沿用现有证据能力：

```ts
{
  labelTitle: '姓名',
  value: '张伟',
  operation: 'confirm',
  quote: '对',
  agentQuestionQuote: '姓名是张伟对吧？',
}
```

文件字段的 `value` 继续使用候选人附件 URL，由文件消息和附件归属信息作证，不要求伪造文本
quote；非文件字段不得利用这一例外绕过原话公证。

### 5.2 `labelTitle` 只负责定位，`labelId` 继续作为内部主键

主模型已经从 `bookingChecklist.requiredFields` 获得岗位标签标题，继续逐字回传即可，不要求模型
理解内部 `labelId`。precheck 在读取实时契约后执行：

```text
labelTitle
  → 在当前岗位契约内精确定位
  → 得到 labelId
  → 生成 ValueProposal
  → proposeValue() 公证并写槽
```

无法在当前契约定位的标题直接忽略或拒收，绝不能创建新槽位。内部持久化、booking payload 和
后端错误回写继续全部使用 `labelId`。

### 5.3 保留现有 LLM 能力，但不保留双入口

这次改造不新增模型调用。语义值仍由已经参与对话的主 Agent 生成：

```text
候选人原话
  → 主 Agent 理解
  → formAnswers(value + quote)
  → 现有确定性公证、值形态校验、契约选项校验
  → 写入岗位表单
```

`CandidateClaim`、notary、evidence engine 等内部能力可以继续服务候选人档案和其他消费者；专项只
取消 `candidateClaims` 作为 precheck 的第二个模型可见答案入口。

### 5.4 清单输出保持不变

以下 precheck 返回结构不因输入合并而改变语义：

```ts
bookingChecklist: {
  requiredFields,
  displayOrder,
  missingFields,
  requiredFieldsToCollectNow,
  knownFieldMap,
  templateText,
  starterFields,
  screeningFields,
}
```

清单先从实时契约和持久表单生成；本轮答案通过公证后，只更新 `knownFieldMap`、
`missingFields` 和 `requiredFieldsToCollectNow`。`requiredFields` 与 `displayOrder` 仍由契约决定。

### 5.5 标签展示协议：labelTitle 原文 100% 直出（2026-08-26 实测后裁定）

precheck 对模型与候选人只允许存在**一种标签拼法**——契约 `labelTitle` 原文：

- 所有清单（`requiredFields`/`displayOrder`/`missingFields`/`requiredFieldsToCollectNow`/
  `starterFields`/`screeningFields`）、`knownFieldMap` 的键、`templateText` 行标签，全部逐字
  使用 `labelTitle`，渲染层不做任何标签改写；`formLabel` 的剥括号/剥标点清洗层退役；
- 选项提示挪出标签位，放在冒号后做占位：`能做多久：（6个月及以上/3-6个月/3个月内）`，
  标签前缀保持与契约逐字一致；
- **脏标题不做代码处理**：运营侧配出含筛选指令/标点/超长的标题时，不静默清洗、不加豁免
  规则，由人工监控归源治理（当前全量目录已零脏标题，治理在海绵侧配置源头）；
- **值词表门，渲染层零转换**：模板/`knownFieldMap`/recap 只显示经公证入槽的选项标签或
  候选人原文；无法用该字段答案词表表达的值（如布尔字符串化的 `false`）在公证与档案预填
  边界拒收，槽位保持 empty、模板行**留空**由候选人作答——渲染层不得做 `false`→「否」
  之类的语义转换替候选人答题（0826 实测：isStudent 布尔经语义族搬运写进「学信网是否在籍」
  TEXT 槽成 `"false"` 并随模板/recap 发出；claims 通道删除后主入口消失，档案预填路径同过此门）；
- 照发指令口径合一：description 与 `_replyInstruction` 引用同一字符串源，不再同时指向
  两套拼法；
- 匹配层的两级容错（NFKC 归一化 + 双侧剥括号主干 + 撞车即弃）原样保留，专职吸收模型与
  候选人的天然改写漂移。

## 6. 实施清单

### 第一批：固化行为基线

- [ ] 增加测试，锁定 `requiredFields` 与 `displayOrder` 只来自岗位契约；
- [ ] 增加测试，锁定未知 `formAnswers.labelTitle` 不能创建、删除或改名槽位；
- [ ] 增加测试，锁定答案只在公证成功后从缺失清单移除；
- [ ] 增加测试，锁定公证失败后字段仍在 `requiredFieldsToCollectNow`；
- [ ] 锁定 `templateText` 始终按完整岗位契约渲染，已填预填、未填留空；
- [ ] 增加测试，锁定 `templateText` 行标签与 `requiredFields` 逐字一致（§5.5 单一拼法）。

### 第二批：统一 precheck 输入 Schema

- [ ] 新建 `FormAnswerInputSchema`，支持 `labelTitle/value/quote/operation/agentQuestionQuote`；
- [ ] 把 `formAnswers` 从 `Record<string, string>` 改为 `FormAnswerInput[]`；
- [ ] 从 precheck 的公开 `inputSchema` 和 DESCRIPTION 移除 `candidateClaims`；
- [ ] 工具描述只保留一条规则：答案字段名逐字取自 `bookingChecklist.requiredFields`；
- [ ] 非文件 set/correct/clear 要求候选人原话证据；
- [ ] confirm 要求肯定原话，并在值来自问句时绑定 `agentQuestionQuote`；
- [ ] 文件字段只接受候选人消息中真实存在的附件 URL；
- [ ] 落地 §5.5：`formLabel` 清洗层退役、标签零改写、选项提示挪到冒号后占位；
- [ ] 占位守卫：`form_line` 回填值与本表渲染的占位提示串完全相等时视为未作答跳过
      （占位串是系统生成物，判等确定性；候选人未删占位回传时不进适配、不算歧义）；
- [ ] 值词表门：非该字段答案词表的值在公证与 `seedArchiveValue` 边界拒收留空，渲染层
      零转换；`FormAnswerInputSchema.value` 不收 boolean；
- [ ] description 与 `_replyInstruction` 的照发口径合一，引用同一字符串源。

### 第三批：统一槽位提案接入

- [ ] 在 `proposal-intake.ts` 将新 `formAnswers` 直接映射为 `ValueProposal`；
- [ ] 标题只能在当前实时契约中定位，定位成功后统一转成 `labelId`；
- [ ] 继续复用 `proposeValue()` 的出处门、形态门、归属门和筛选判定；
- [ ] 把 `correct/clear` 接入 `applyRecapResult()` 的精确槽位重开；
- [ ] 把 `confirm/agentQuestionQuote` 接入现有确认式作证；
- [ ] 保留 `form_line`、确定性 adapter sweep 和 archive 预填作为既有安全网；
- [ ] 删除只为 precheck 双入口存在的 claim/form-answer 优先级分支；
- [ ] 统一"值认不出"语义：选项字段适配失败一律提交公证拒收并落审计，删除 claims 通道的
      静默丢弃分支（0826 实测：`healthCertificate` 答案被无声丢过）；
- [ ] `labelTitle` 定位失败（契约外 key/撞车弃权）落 `CollectionAuditEvent`——合并后这是模型
      唯一入口，静默忽略即收资主链路的无观测漏口（0826 实测：编造 key `身份` 零审计）；
- [ ] 不删除候选人档案域仍在使用的 Claim 类型和公证能力（注：`produceModelClaims` 生产
      零调用方，可顺带清理死代码）。

### 第四批：调用方与测试迁移

- [ ] 更新所有 precheck 测试、夹具和工具调用样例；
- [ ] 更新 `turn-hints.section.ts` 中"必须经 candidateClaims 提交"的 prompt 教学（代码内
      prompt 文案，非文档，须与 schema 同批切换）；
- [ ] 标准语义字段和动态字段全部改用同一 `formAnswers` 数组；
- [ ] 更新 recap 纠正、clear、确认式回答和附件回填测试；
- [ ] 删除断言“标准字段必须走 candidateClaims、动态字段必须走 formAnswers”的测试；
- [ ] 确认 booking 仍只读取持久表单生成 `labelList`，不重新读取模型答案；
- [ ] 确认后端 `errorList.labelId` 仍只精确重开对应槽位；
- [ ] 运行格式检查、类型检查、precheck/collection/booking 相关单测和完整 CI。

### 第五批：文档收口

- [ ] 更新 `docs/architecture/collection-form-machine.md` 的答案运输通道；
- [ ] 更新 `docs/product/agent-for-operations.md` 的 precheck 入参说明；
- [ ] 更新 `docs/principles/glossary.md` 中以 `candidateClaims` 为例的 Grounding 表述；
- [ ] 更新 `docs/prompt-rule-ledger.md` 中与 precheck 参数纪律有关的条目；
- [ ] 删除其它文档中“candidateClaims 是收资主通道”的过时描述；
- [ ] 改造落地并完成现状文档更新后，删除本 todo 文档。

## 7. 必测场景

### 清单边界

- [ ] 无答案时，岗位契约字段全部进入 `requiredFields` 和模板；
- [ ] 提交一个答案后，字段全集不变，只从缺失项移除该字段；
- [ ] 提交契约外标签时，清单和槽位完全不变；
- [ ] 提交无证据或非法枚举值时，字段继续保持缺失；
- [ ] 岗位接口新增或删除标签后，槽位只按实时契约对齐。

### 普通与语义答案

- [ ] `居住地址=徐汇区` 正常写入动态标签；
- [ ] “我已经毕业两年了”可提交学生身份规范值，并保留原话证据；
- [ ] “一米六三”可提交身高规范值 163；
- [ ] quote 不存在于候选人消息时拒收；
- [ ] 岗位要求文本、Agent 自己生成的文字不能冒充候选人 quote；
- [ ] 候选人更正旧值时只重开并改写对应槽位；
- [ ] clear 后对应字段回到 missing，其他已填字段不受影响；
- [ ] “对”类确认必须绑定真实 Agent 问句；
- [ ] 附件字段只能使用候选人真实发送的附件 URL。

### 标签拼法与展示

- [ ] `templateText` 行标签、各清单、`knownFieldMap` 键与契约 `labelTitle` 逐字一致；
- [ ] 带括号标题（`体重(kg)`）的全角变体、自加说明括号变体经匹配层定位回原字段；
- [ ] 契约外 `labelTitle` 与主干撞车弃权均产生审计事件，且不写入任何槽位；
- [ ] 无法用字段答案词表表达的值（含布尔字符串化产物）不入槽：模板/recap 对应行**留空**，
      无裸 `false`，也无渲染层代答的「是/否」；档案预填遇到此类值同样不 seed；
- [ ] 选项提示位于冒号后占位，候选人按提示行回填时 `form_line` 通道仍正确定位。

### 端到端

- [ ] precheck 收齐后进入提交前 recap；
- [ ] recap 确认后才返回 `ready_to_book`；
- [ ] booking 只消费表单快照生成 `labelList`；
- [ ] booking 后端退回单个 labelId 时只精确重开对应字段；
- [ ] 主模型工具 Schema 中只出现一个收资答案入口；
- [ ] 不新增任何 LLM 调用和观测设施。

## 8. 非目标

本专项不做：

- 不改变岗位标签表单的接口来源；
- 不允许模型决定字段全集、必填性或筛选规则；
- 不把身份资料重新放入轮末 `extract_facts`；
- 不新增独立字段抽取模型或二次语义 reviewer；
- 不重写 collection form state machine；
- 不修改 booking 的“只消费已办结表单”原则；
- 不增加埋点、Dashboard、shadow 双写或人工标注；
- 不借机清理其它收资正则，除非它只为双入参兼容存在。

## 9. 完成标准

改造完成必须同时满足：

- [ ] 岗位接口契约仍是收资字段唯一权威；
- [ ] precheck 对主模型只暴露一个收资答案入口；
- [ ] 任意岗位动态标签都能通过统一入口提交；
- [ ] 语义归一化答案仍携带候选人原话并经过现有公证；
- [ ] correction、clear、confirm 和附件场景均可表达；
- [ ] `requiredFields` / `displayOrder` 不受答案入参控制；
- [ ] `missingFields` / `requiredFieldsToCollectNow` 只随已公证槽位状态变化；
- [ ] 模型与候选人可见的标签拼法唯一（labelTitle 原文直出，§5.5）；
- [ ] 定位失败与值适配失败均有审计事件，无静默丢弃分支；
- [ ] booking 继续只读取已办结表单，不读取主模型临时答案；
- [ ] 没有新增 LLM 调用或观测建设；
- [ ] 相关单测、类型检查和 CI 全部通过；
- [ ] 现状文档与实现一致，本 todo 文档已删除。

## 10. 专项 Goal 指令

```text
/goal 按 docs/todo/precheck-form-answer-contract-refactor.md 完成 precheck 收资入参统一专项。岗位接口标签契约必须继续作为字段全集和清单的唯一权威；不得让 formAnswers 增删字段或控制 requiredFields/displayOrder。将主模型可见的 candidateClaims 与旧 Record<string,string> formAnswers 合并为一套支持 labelTitle、value、quote、operation、agentQuestionQuote 的 formAnswers 协议，复用现有 ValueProposal、proposeValue、公证、表单状态机、recap 和 booking 表单快照，不新增任何 LLM 调用、观测项、Dashboard、shadow diff 或人工标注流程。同批落地 §5.5 标签展示协议：labelTitle 原文 100% 直出（formLabel 清洗层退役、选项提示挪到冒号后占位、脏标题不做代码处理由人工监控）、布尔值渲染规整、定位失败与值适配失败落审计、照发指令口径合一。完成行为基线、Schema、槽位接入、调用方迁移（含 turn-hints.section.ts 的 prompt 教学）、相关单测、类型检查、完整 CI 和现状文档收口，直至文档完成标准全部满足。
```

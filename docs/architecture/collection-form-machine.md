# 收资表单域架构（collection form machine）

**最后更新**：2026-09-04
**代码居所**：`src/resolution/collection/`（纯逻辑，零 LLM 零 IO）+
`src/tools/collection/`（编排、渲染与 Redis 存储）

> 本文描述已实现的系统。共享 citation / 对话绑定公证原语与候选人字段规则见
> [candidate-profile-domain.md](./candidate-profile-domain.md)。本域是唯一报名写入权威。

---

## 1. 领域边界

**负责**：候选人 × 岗位的报名资料收集全生命周期——收什么（读契约）、值如何入账（作证+公证）、
何时发问/复述/提交/熔断（状态派生）、提交（entryUser）与打回（errorList），以及表单 Redis 单据。

**不负责**：字段判决标准（唯一判据源＝海绵标签契约 `batch-query`，岗位详情接口只服务展示）；
开放语义抽取的正确性（主模型只提交明确最终值，notary 只做封闭校验）；跨会话候选人认同（candidateRef=phone，person 键
另案）。

核心原则：**表单是事务底稿**（人×岗、有终点、办结封存），**记忆是对人的持续认知**——
岗位要什么归表单，人是什么样归记忆。表单 key 显式包含稳定 `botUserId`，换 bot 重新收资；
不会把单据写进 memory 的 `factsv2:`。

## 2. 实体与状态机（form.types.ts）

- `BookingCollectionForm`：per（candidateRef × jobId）。资料槽位旁可持久化岗位级
  `scheduleDraft`，不把面试时间伪造成契约槽位；`workOrderId / escalatedReason / lastRecap`
  继续只保存不可推导事实。`contractSnapshot.fields` 保存最近一次“查询报名表单”取得的
  完整契约；不另存可由 fields 推导的 fingerprint。
- `FormSlot`：键＝契约 `labelId`（槽位宇宙＝每轮实时拉的契约字段集，系统内无第二套字段命名）。
  `SlotState` 封闭三值 `empty | filled | disqualified`；filled 槽位携带
  `{ value, optionCodes?, sourceText, producer }`——`sourceText` 负责出处回查，`producer`
  记录生产通道；collection 不再为槽位值持久化置信度。
- `BookingScheduleDraft`：`requestedDate? / selectedInterviewTime? / sourceText`；每轮用当前
  `bookableSlots` 复验，slot 失效只清精确时间，不清资料。
- `Verdict` 封闭五值 `collecting | disqualified | ready | escalated | submitted`，
  由 `verdictOf()` 纯函数现算，永不落盘。
- **枚举封闭集纪律**：加值必须先回答"哪个既有值的处理逻辑覆盖不了它"。

## 3. 一轮数据流

```
纯 jobId 查询：实时取契约 → loadOrCreate → refreshContractSnapshot → persist
  → 按持久快照返回 bookingChecklist（空标签岗=数据异常→escalated+告警）
候选人回复后的校验：实时契约只作漂移比对 → loadOrCreate 持久表单
  → 无 contractSnapshot 返回 collection_form_not_presented
  → 实时契约 != contractSnapshot 返回 contract_changed，禁止混版校验
  → 相等时只消费 contractSnapshot（phone 到达即 rebind）
  → collectFieldValueProposals 汇总三通道提案（只对 empty 槽位）：
      fieldValueProposals（主聊模型唯一作证入口，labelTitle + value + quote + operation）
      > form_line（模板行回捞） > adapter_sweep（确定性判据收网）
      同槽多通道命中按优先级去重，fieldValueProposals 胜出
  → applyFieldValueProposal(form, field, proposal, notaryContext)
      提案与 runtime 构造的 candidateTexts/messages 分离，公证后槽位 filled / disqualified / 零入账拒收
  → reconcileScheduleDraft 独立处理 requestedDate/精确时段，与字段提案同轮可并行
  → verdictOf + 统一授权派生行动：
      collecting=collect_fields；ready+外部预填未确认=confirm_collection；
      资料已授权+无有效时间=select_interview_time；资料和时间均授权=ready_to_book
  → persist（表单、条件式 lastRecap 与 scheduleDraft 同一快照）
```

模板与复述从槽位渲染（字段名一律 100% 使用契约 labelTitle 原文），所见即所记；模板一次列
全字段，已知预填、缺的留空，禁止分批漏斗式收资。渲染层不剥括号、标点或截断脏标题；
选项提示只放在冒号右侧占位（`标签：（选项 A/选项 B）`），候选人原样回传占位时不算作答。

## 4. 写入公证（form-writes.ts `applyFieldValueProposal`——候选人答案唯一写槽入口）

统一输入类型为 `FieldValueProposal`，只含提案本体；可信 `candidateTexts/messages`
由 runtime 构造为独立 `FieldValueNotaryContext`。工具侧路由信封为
`RoutedFieldValueProposal`。collection 内部依次调用 `notary/verifyCitation()`、确认问答绑定、candidate 值形态与身份归属
原语；共享公证模块只返回机械检查结果，槽位是否写入仍由表单状态机决定。

闸门顺序（全部确定性，零语义判断）：

0. **棘轮**：filled 槽位的提案，非显式改口一律拒（`slotAlreadyFilled`）；
1. **出处门**：sourceText 必须逐字连续出现在本轮候选人原文（归一化子串查找）；
   身份槽位另查值本体锚定——值须逐字在承值文本中（候选人原话，或 confirm 式的
   `agentQuestionQuote` 问句：候选人答"对"+问句含值，两段合成完整证据），
   **或确定性解析器能从这段原话独立复算出等价值**（`valueDerivableFromSource`）。
   这使「93年」→33 等正确归一化不被当作臆造。
2. **形态/值词表门**：身份字段形状（手机 11 位/姓名非昵称形）＋ optionCode ∈ 契约选项集；
   选项值必须能回配实时契约 optionLabel/code，FILE 必须是候选人消息中的真实附件 URL；
   `true`/`false` 等布尔字符串化产物拒收入槽，渲染层不做 `false`→「否」代答；
3. **已知冲突门**：确定性 parser/adapter 明确得出另一个契约值时拒绝；
   parser 返回 null 只代表未覆盖，不是拒收、降级或 recap 理由。
4. **归属门**（仅姓名/手机号）：值须为本人给出——引用块经理、截图第三方、Agent 自述
   均拒（evaluateBookingName/PhoneGate 走消息结构取证）；
5. **先筛后收**：值命中 `rejectedOptions` 或契约值域硬越界 → 槽位 disqualified。

**拒收必须对模型可见**（`rejectedAnswers`，0828）：定位成功但被公证退回的条目，连同
原因与可执行改法回给模型，`collect_fields` 的 replyInstruction 另点名被退回的字段。
此前拒收只落 `collection_form_audit` 给我们看，模型只看得到"这个字段还缺"——于是原样
重投或回头再问候选人一遍（chat `6a8d583b` 年龄被连问两遍）。与 0826 给 labelTitle
定位失败补 `unmatchedAnswers` 是同一类修法：**判据可以严，但不能静默**。
回执另带 `action`：`retry_submission` 才允许按原有证据改投；`ask_candidate`（昵称不是真名、
社保缺缴纳方/参保地、文件未发送等）必须先向候选人澄清并等待新回复。两类不能共用
“候选人已答过、不要再问”的总指令，否则会把身份闸门推成原值重投循环。

**棘轮对系统单向、对本人双向**：filled 重开仅三条路径——复述 corrections /
applyErrorList / 候选人显式改口（`proposal.restatement`，同套公证，通过即替换，
outcome=`restated` 落审计；askCount 不清零防刷熔断配额）。系统/模型重推任何时候触碰
不到 filled 槽位；含糊提及不算改口（履历/排除语境不覆盖既有值）。

## 5. 条件式 recap、开放确认与时间并行

- `needsRecap(form)` 只识别 `archive / system / manual` 外部预填。
  `candidate_quote / rule / model` 的明确候选人表达通过 notary 后不再 recap；
  完整自然语言、多轮零散作答与逐行填表完全同路。
- 含外部预填的 ready 表单才渲染 `lastRecap`。任一槽位改值、清除、契约变更或
  errorList 重开都作废快照；候选人纠正最后一个预填值后可重新派生为无 recap。
- 所有明确确认表达走同一个生产入口：模型提交 `recapConfirmation=true`，
  `recap-confirmation` notary 自动绑定最新候选人回复，只机械核验历史 assistant 消息中
  真实送达的当前槽位快照和纠正优先级。「好的」与「没问题，麻烦老师了」没有不同的放行路径，
  `isAffirmativeAnswerSequence()` 不再承担 recap 授权职责。
- 首次 `collect_fields` 同时返回实时 `bookableSlots`。候选人可同轮提供资料和时间；
  资料未齐不丢 schedule draft，recap 与选时间也可同轮完成。
- 同日唯一可约 slot 可自动落精确时间；同日多 slot 只保留日期并进入
  `select_interview_time`。`wait_notice` 岗位不建立草稿、booking 不传时间。
- 同槽 2 轮问不中 / 疑似多人 / errorList 失配 继续进入 escalated。

## 6. 提交闭环（booking 工具）

- `isCollectionAuthorized()` 统一派生资料授权；`isSubmissionAuthorized()` 由
  precheck 和 booking 共用，统一合并资料授权、`wait_notice`、草稿精确时间与实时可约结果。
- booking 仍同时要求本轮 `ready_to_book` ledger 凭据、真实召回的 jobId 和已建立的当前
  collection 流程；模型不能跳过 precheck 直接 booking。
- payload 唯一外发形状 `{ jobId, interviewTime?, labelList[{labelId, optionCodes|value}] }`，
  全部由表单生成，禁止旁路传身份/补充字段。
- 成功 → `markSubmitted(workOrderId)` 封存 + `setActiveBooking`；
  errorList → `applyErrorList` 按 labelId（缺失按 labelTitle 匹配）精确重开该槽，
  失配 → escalated 不静默；成功但缺 workOrderId → escalated 防重复提交。
  `errorList[].labelId` 后端 0826 已上线；生产验证靠 `error_list_unmapped` 哨兵——
  定位失败即转人工并可观测，无需专项验收。

### 契约消费边界（0826 复测核实 + 维持现状裁定）

- **`labelInstructions` 不被执行也不被渲染**：候选人模板与模型可见输出只用
  `labelTitle`，instructions 仅进披露红线的敏感词扫描。运营认知规则：**筛选必须配
  `rejectedOptions` / `valueSpec`**，写进说明字段的筛选意图不会生效（判决单源）。
- **`fieldType` 同 id 分裂按持久快照隔离**：候选人填写期间只消费查询时的契约；实时契约
  发生变化则先返回 `contract_changed`。下一次纯 jobId 查询刷新快照，同 id 定义有变化的
  槽位精确重开，未变化槽位保留，禁止拿旧值按新类型直接提交。
- **`optionCode` 语义漂移低危**：跨岗/跨轮复用走**文本值回流 + 每轮重配选项**
  （sessionFacts 存 optionLabel 文本不存 code），code 只在单次提交的实时契约内使用；
  analytics 亦不按 code 聚合。后端自律「发布后不改语义」即可，AI 侧无需防护。

## 7. 与记忆的边界

- **记忆→表单预填**（archiveFacts）：只填空槽、只在本表首次见到该槽时生效，并经过与
  公证写入一致的字段答案词表门，无法适配当岗契约的旧值不 seed；
  **作用域＝同一托管账号**（候选人信息不跨账号共享，跨账号视为首次接触）；
  预填值使 ready 表单进入条件式 recap，候选人本轮明确值始终优先。
- **表单→记忆回写**：办结后身份字段以 `confidence:'high'/source:'candidate_quote'` 写
  sessionFacts 并 `writeFromBooking` 入长期画像（带 jobId/workOrderId 血缘）——这是 Memory
  域自有置信语义，不因 collection 删除槽位置信度而改变。记忆
  收资类事实的唯一 high 上游；轮末 LLM 抽取只负责表单外软事实（preferences 族）。

## 8. 存储与观测

- Redis 快照 `collection-form:{corpId}:{userId}:{botUserId}:{candidateRef}:{jobId}`，
  `botUserId` 取稳定企微 `wecomUserId`；整实体读写，回合租约（90s 心跳）单写者，无 CAS；
  `collection-form-primary:*` 固定主候选人默认入口，`collection-form-current:*` 只表示刚通过
  precheck、供同轮 booking 消费的活动表单；additional 表单可切换活动指针，但不得覆盖主指针。
  列入「丢了算事故」key 清单。契约快照与 slots 同实体原子落盘；旧表单没有
  `contractSnapshot` 时不得直接校验，先走纯 jobId 查询建立快照。旧 key 不迁移，随 3 天 TTL
  自然过期；兼容窗内旧槽位 `confidence:'medium'` 保守触发 recap，窗口结束后临时兼容失效。
- 审计：labelTitle 定位失败、值适配/公证拒收 / slot_restated / slot_disqualified /
  escalated / config_debt / recap_confirmation_rejected 等落 `agent_execution_events`。
  `collection_form_audit` 固化 `jobId + labelId + labelTitle + fieldType`，配置债必须按标签
  聚合并附横跨岗位数，不能按单岗拆工单。`message_processing_records` 无 `trace_id` 列；
  钻取先以事件 `trace_id` 对流水 `message_id/batch_id`，对不上时用 `chat_id + 时间窗`
  （debounce 会使 `received_at` 与审计时刻错开）。配置债仍经 booking-card
  「收资配置备注」段披露给运营。

## 9. 红线（长期有效裁定）

- **判决单源**：收资/筛选判据只读标签契约；契约没带的判据＝该岗无此筛（仅字段级；
  整岗空标签＝数据异常转人工）。
- **词表禁判语义**：确定性第一档只做契约选项字面精确匹配（Map 级，含糊即 miss）；
  自然语言语义一律模型作证（LLM-as-judge + 公证出处），unknown 不得成为追问终点；
  禁以新增正则/别名追口语长尾。
- **作证主通道＝主聊模型随 precheck 提交统一 `fieldValueProposals`**；labelTitle 只定位实时契约
  已有槽位，不能创建字段或控制 required/displayOrder；不设常驻第二语义读者（双通道判同值
  必打架）；小模型仅作轮末空槽收网与 shadow 审计。
- **公证不重做开放语义判断**；确定性 parser 只否决已知冲突；判定入账永远如实，
  producer 署名如实。
- **D4 禁硬编码外系统 ID**：labelId/optionCode 字面量不进 src/；身份四槽识别走
  环境级 labelId 锚点（`COLLECTION_IDENTITY_LABEL_IDS`）+ labelTitle 每轮核验，
  核验不过告警降通用道（0826 裁定：原契约 systemField 诉求废弃，此机制即终态）。
- **披露分级**：契约 `disclosure` 优先 → 属性族兜底注册表 → 未知敏感族默认禁明说；
  禁说词表与出站守卫红线同源，禁另立副本。
- **候选人信息不跨托管账号共享**（预填与记忆召回同受约束）。

## 10. 不变量与验收断言（测试承载）

六防线（`tests/resolution/collection/`，含 0819 生产死循环实案回归
`deadlock-0819.spec.ts`）继续覆盖 filled 零重问（跨轮重放）、recap 精确重开一格、命中 rejected
当轮即不合格；sourceText 回查失败零入账；errorList 回写后不存在永卡 ready；同槽 2 问
即熔断。`authorization.spec.ts` / `schedule-draft.spec.ts` / `recap-confirmation.spec.ts` 另覆盖
条件式 recap、统一提交授权、草稿实时失效、wait_notice 与开放确认绑定。
指标口径：答后复问率 <10%（旧基线 31.5%）/ 报名死锁 0 / filled 被重问 0；
生产验收信号＝`handoff_events` 中 `system_blocked` 曲线归零。

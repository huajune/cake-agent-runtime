# 收资表单域架构（collection form machine）

**最后更新**：2026-08-26
**代码居所**：`src/resolution/collection/`（纯逻辑，零 LLM 零 IO）+
`src/tools/collection/`（编排、渲染与 Redis 存储）

> 本文描述已实现的系统。裁决底盘（claim 通货/公证内核/身份闸门，P11 三分法）见
> [candidate-profile-domain.md](./candidate-profile-domain.md)——本域的写入公证是其在收资
> 事务上的应用。本文只描述现状，设计与施工过程见 Git 历史。

---

## 1. 领域边界

**负责**：候选人 × 岗位的报名资料收集全生命周期——收什么（读契约）、值如何入账（作证+公证）、
何时发问/复述/提交/熔断（状态派生）、提交（entryUser）与打回（errorList），以及表单 Redis 单据。

**不负责**：字段判决标准（唯一判据源＝海绵标签契约 `batch-query`，岗位详情接口只服务展示）；
语义理解的正确性（模型作证，复述终审兜底）；跨会话候选人认同（candidateRef=phone，person 键
另案）。

核心原则：**表单是事务底稿**（人×岗、有终点、办结封存），**记忆是对人的持续认知**——
岗位要什么归表单，人是什么样归记忆。表单 key 显式包含稳定 `botUserId`，换 bot 重新收资；
不会把单据写进 memory 的 `factsv2:`。

## 2. 实体与状态机（form.types.ts）

- `BookingCollectionForm`：per（candidateRef × jobId）。五个业务成员 + 三个事实位
  （workOrderId / escalatedReason / lastRecap），不落盘任何可推导状态。
- `FormSlot`：键＝契约 `labelId`（槽位宇宙＝每轮实时拉的契约字段集，系统内无第二套字段命名）。
  `SlotState` 封闭三值 `empty | filled | disqualified`；filled 槽位携带
  `{ value, optionCodes?, sourceText, producer, confidence }`——值与证据同存。
- `Verdict` 封闭五值 `collecting | disqualified | ready | escalated | submitted`，
  由 `verdictOf()` 纯函数现算，永不落盘。
- **枚举封闭集纪律**：加值必须先回答"哪个既有值的处理逻辑覆盖不了它"。

## 3. 一轮数据流

```
契约实时查询（零缓存；空标签岗=数据异常→escalated+告警，禁按「无筛」放行）
  → loadOrCreate 表单（Redis 快照；phone 到达即 rebind）
  → 三通道提案（只对 empty 槽位）：
      formAnswers（主聊模型唯一作证入口，labelTitle + value + quote + operation）
      > form_line（模板行回捞） > adapter_sweep（确定性判据收网）
      同槽多通道命中按优先级去重，formAnswers 胜出
  → proposeValue 写入公证（§4）→ 槽位 filled / disqualified / 拒收(askCount+1)
  → verdictOf 派生行动：collecting=只问 empty（先写入后发问；筛选项排登记项前）/
      ready=复述一次 / disqualified=按披露分级渲染 / escalated=转人工 / submitted=停手
  → persist（渲染复述与落账同步完成，lastRecap 在案）
```

模板与复述从槽位渲染（字段名一律 100% 使用契约 labelTitle 原文），所见即所记；模板一次列
全字段，已知预填、缺的留空，禁止分批漏斗式收资。渲染层不剥括号、标点或截断脏标题；
选项提示只放在冒号右侧占位（`标签：（选项 A/选项 B）`），候选人原样回传占位时不算作答。

## 4. 写入公证（form-writes.ts `proposeValue`——改表唯一途径之一）

闸门顺序（全部确定性，零语义判断）：

0. **棘轮**：filled 槽位的提案，非显式改口一律拒（`slotAlreadyFilled`）；
1. **出处门**：sourceText 必须逐字连续出现在本轮候选人原文（归一化子串查找）；
   身份槽位另查值本体锚定——值须逐字在承值文本中（候选人原话，或 confirm 式的
   `agentQuestionQuote` 问句：候选人答"对"+问句含值，两段合成完整证据）；
2. **形态/值词表门**：身份字段形状（手机 11 位/姓名非昵称形）＋ optionCode ∈ 契约选项集；
   选项值必须能回配实时契约 optionLabel/code，FILE 必须是候选人消息中的真实附件 URL；
   `true`/`false` 等布尔字符串化产物拒收入槽，渲染层不做 `false`→「否」代答；
3. **归属门**（仅姓名/手机号）：值须为本人给出——引用块经理、截图第三方、Agent 自述
   均拒（evaluateBookingName/PhoneGate 走消息结构取证）；
4. **置信授予**：确定性判据可从原话复算出等价值＝high，否则 medium——**只定档不否决**
   （公证器是代价路由器，不是真值裁判）；
5. **先筛后收**：值命中 `rejectedOptions` → 槽位 disqualified，本岗停止收资。

**棘轮对系统单向、对本人双向**：filled 重开仅三条路径——复述 corrections /
applyErrorList / 候选人显式改口（`proposal.restatement`，同套公证，通过即替换，
outcome=`restated` 落审计；askCount 不清零防刷熔断配额）。系统/模型重推任何时候触碰
不到 filled 槽位；含糊提及不算改口（履历/排除语境不覆盖既有值）。

## 5. 确认与复述

- **针对性问答即采信**：对着"你多大"答"26"即本人终审，经 confirm 作证（R1
  agentQuestionQuote）入槽，无 pending 态。
- **复述全程仅提交前一次**（recap-renderer）：覆盖全部 filled 槽位，渲染即落
  lastRecap（拿不到"只渲染不落账"的出口）；文案排成表单块形态与分段器兼容。
- "确认" → `applyRecapResult({affirmed})` 放行提交；"改 X" → corrections 只重开该格，
  新值当轮公证后直接提交，**同会话第二张全量确认清单在结构上不存在**。
- **自填模板直通**（self-filled-template，0827 产品裁定）：候选人在**一条消息里**逐行
  填满整表时，那条消息本身即提交前核对——`markSelfFilledConfirmed` 一次性落成已确认
  的 lastRecap（`source:'self_filled'`），nextAction 直接 `ready_to_book`，复述轮不发。
  核对人与作者重合、内容逐字就是他刚打的字，再发回去讨一次"对"是零信息增量。
  判据确定性且收得极紧，任一不满足即退回正常复述：契约 ≥2 格（一行作答不算誊表）/
  **同一条**消息覆盖全部契约字段（跨条拼的整表没有任何一屏被完整看过）/ 全部格本轮
  落值 / 无棘轮挡下（值分歧只能靠复述暴露）/ 无档案预填格（那些值候选人这屏没见过）。
  落账形状与正常复述一致，事后回「不对，电话错了」照走 corrections 精确重开——
  直通不牺牲可纠错性。命中与未命中各落一条 `collection_form_audit`（`recap_self_filled`
  / `recap_self_filled_missed` + 归因），直通率与拦截原因是这条捷径的唯一观测面。
- 同槽 2 轮问不中 / 疑似多人（新姓名+新手机号对）/ errorList 失配 → escalated 转人工，
  熔断内建。

## 6. 提交闭环（booking 工具）

- 入口闸：`verdictOf(form)==='ready' && form.lastRecap`，否则拒——提交资格由表单状态
  派生，无任何模型转抄的票据。
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
- **`fieldType` 同 id 分裂可容忍**：判决与提交每轮实时拉契约、按岗执行，单岗自洽；
  代价是跨岗复用退化（文本值对不上新岗选项集 → 重问一遍）与迁移窗口的
  errorList 往返，均有自愈，不产生数据错误。
- **`optionCode` 语义漂移低危**：跨岗/跨轮复用走**文本值回流 + 每轮重配选项**
  （sessionFacts 存 optionLabel 文本不存 code），code 只在单次提交的实时契约内使用；
  analytics 亦不按 code 聚合。后端自律「发布后不改语义」即可，AI 侧无需防护。

## 7. 与记忆的边界

- **记忆→表单预填**（archiveFacts）：只填空槽、只在本表首次见到该槽时生效，并经过与
  公证写入一致的字段答案词表门，无法适配当岗契约的旧值不 seed；
  **作用域＝同一托管账号**（候选人信息不跨账号共享，跨账号视为首次接触）；
  预填值仍过复述终审。
- **表单→记忆回写**：办结后身份字段以 `confidence:'high'/source:'candidate_quote'` 写
  sessionFacts 并 `writeFromBooking` 入长期画像（带 jobId/workOrderId 血缘）——记忆
  收资类事实的唯一 high 上游；轮末 LLM 抽取只负责表单外软事实（preferences 族）。

## 8. 存储与观测

- Redis 快照 `collection-form:{corpId}:{userId}:{botUserId}:{candidateRef}:{jobId}`，
  `botUserId` 取稳定企微 `wecomUserId`；整实体读写，回合租约（90s 心跳）单写者，无 CAS；
  列入「丢了算事故」key 清单。旧 key 不迁移、不兜底读，随 3 天 TTL 自然过期。
- 审计：labelTitle 定位失败、值适配/公证拒收 / slot_restated / slot_disqualified / escalated / config_debt /
  submitted 各落一条 `agent_execution_events`（同 traceId 可 join）；配置债经
  booking-card「收资配置备注」段披露给运营。

## 9. 红线（长期有效裁定）

- **判决单源**：收资/筛选判据只读标签契约；契约没带的判据＝该岗无此筛（仅字段级；
  整岗空标签＝数据异常转人工）。
- **词表禁判语义**：确定性第一档只做契约选项字面精确匹配（Map 级，含糊即 miss）；
  自然语言语义一律模型作证（LLM-as-judge + 公证出处），unknown 不得成为追问终点；
  禁以新增正则/别名追口语长尾。
- **作证主通道＝主聊模型随 precheck 提交统一 `formAnswers`**；labelTitle 只定位实时契约
  已有槽位，不能创建字段或控制 required/displayOrder；不设常驻第二语义读者（双通道判同值
  必打架）；小模型仅作轮末空槽收网与 shadow 审计。
- **公证零语义判断**；判定入账永远如实（委婉只在渲染层）；producer 署名如实。
- **D4 禁硬编码外系统 ID**：labelId/optionCode 字面量不进 src/；身份四槽识别走
  环境级 labelId 锚点（`COLLECTION_IDENTITY_LABEL_IDS`）+ labelTitle 每轮核验，
  核验不过告警降通用道（0826 裁定：原契约 systemField 诉求废弃，此机制即终态）。
- **披露分级**：契约 `disclosure` 优先 → 属性族兜底注册表 → 未知敏感族默认禁明说；
  禁说词表与出站守卫红线同源，禁另立副本。
- **候选人信息不跨托管账号共享**（预填与记忆召回同受约束）。

## 10. 不变量与验收断言（测试承载）

六防线（`tests/resolution/collection/`，含 0819 生产死循环实案回归
`deadlock-0819.spec.ts`）：filled 零重问（跨轮重放）；复述精确重开一格；命中 rejected
当轮即不合格；sourceText 回查失败零入账；errorList 回写后不存在永卡 ready；同槽 2 问
即熔断。指标口径：答后复问率 <10%（旧基线 31.5%）/ 报名死锁 0 / filled 被重问 0；
生产验收信号＝`handoff_events` 中 `system_blocked` 曲线归零。

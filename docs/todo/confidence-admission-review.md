# 置信度采信体系复盘专项

> **终态归档（2026-08-17 用户裁定：化零为整）**：本专项的诊断（shadow 前置事实、
> 私有闸门盘点、R1-R12、度量数字）作为档案长期有效；**全部余项修复不再散点执行**，
> 统一收编进「收资表单状态机」——根因裁定为「系统不持有收资状态、每轮从原文全量
> 重推」，根本解与逐项映射见 label-driven-collection-refactor.md §2.8。
> 本文档此后只读，作为状态机实施时的病灶对照底稿与验收指标来源。

> 立项：2026-08-17（用户裁定）。触发：生产反复问体感 + 简历方案评审中暴露的采信保守性讨论。
> 定位：独立于简历工具整改（resume-tool-overhaul.md）；简历方案插的是标准接口，本专项
> 校准结果它自动继承。
> 原则：**先度量后调阈**——收紧有账本（编造 badcase），放松没账本（反复问不可见），
> 本专项第一件事是把账本补齐。

## 1. 已有证据（立项依据）

历史 badcase（保守性已翻过车）：
- 身份溯源闸门死锁 6a448d09：作证白名单过窄，同题追问 4 遍，16 chat 受影响；
- invite 城市门字面过窄：刚报完顺义还被问"在北京吗"（档案有值、闸门不认）；
- 收资模板逐字重发：一 turn 两问只答其一 → 整发模板；
- P11 摘除 rule producer：确定性解析全体降级为提示便签（动机真实：72.3% 假阳）。

结构诊断：
- **棘轮效应**：编造错误可见（进报名表→建 case→收紧），反复问代价不可见（流失无账本），
  系统单向漂移向保守；
- **闸门割裂**：booking 姓名门/invite 城市门/身份门/precheck 各持私有判据，
  "档案里有、闸门不认"每个私有判据都是一个反复问来源；
- **确认覆盖疑点**（待代码盘点证实）：确定性确认产者仅 name/gender/city 三个，
  其余字段升级疑似只靠模型轨 context_confirmation。

## 2. 探针 v1 数字（2026-08-17，生产 14 天窗，message_processing_records.reply_preview 正则）

| 字段 | 问过的会话 | 问≥2次 | 问≥3次 | 单会话最高 | 复问率 |
|---|---|---|---|---|---|
| 城市 | 2184 | 303 | 24 | 5 | 13.9% |
| **健康证** | 498 | **120** | **36** | **6** | **24.1%** |
| 年龄 | 176 | 13 | 0 | 2 | 7.4% |
| 电话 | 28 | 3 | 0 | 2 | — |
| 姓名 | 12 | 2 | 1 | 3 | — |
| 学历 | 23 | 2 | 0 | 2 | — |

口径声明：reply 侧疑问句正则，含噪音——未答追问/市→区下钻/换城市/复聊按设计重发
都会计入。**v1 数字是上界**，v2 需换「答后复问」口径（两次询问之间存在候选人应答）。

### 抽样定性

**城市（2 chat 目检）：大头合法。** 样本一候选人始终未答区域（反问身份/品牌），追问正当；
样本二是"杭州→哪个区"下钻 + 候选人自己换苏州。城市 303 不能直接当病灶读。

**健康证（2 chat 目检）：真病灶，两个铁证。**

铁证 A（确认被丢弃，单人会话 6a826e8a，7 分钟同题三轮）：
候选人「没有健康证」→ Agent「帮你登记成'无'可以吗」→ 候选人「可以」→
Agent 下一轮「最后确认下：你目前有没有本地的食品健康证？」
——上下文确认（"可以"）没有被记账，闸门下一轮索要新鲜字面回答。

铁证 B（字面回答仍死锁，6a4229f2，报名死亡）：
候选人连给三种形态——「都有健康证，都是本地的」→「对确认」→ 按 Agent 明示要求
字面回「有」——precheck 仍返回 missingFields，终局 `handoff:system_blocked`，
资料全齐的报名单死掉。6a448d09 死锁家族复发。

铁证 C（五连问循环，chat 6a827105ce406a6aee0149a2，2026-08-17 当天，用户亲报；
**归因经两轮修正，最终根因 = 收资字段同义未归一，用户诊断正确**）：
候选人 02:37 一次性交齐全表（含「身高：157cm」「体重：50kg」「健康证：暂时没有，可以办」，
均逐字在候选人消息中），02:40-02:59 被连续要求确认身高/体重/健康证**五次**，第 11 轮
候选人质问「为什么问好几次这个啊」，Agent 道歉后又问第五遍，终局 `system_blocked`。

**循环驱动器（276571 回执实锤）**：岗位 529020 的报名表带三个自定义补充字段
「身高(cm)」「体重(kg)」「有无本地健康证」，与标准字段「身高/体重/健康证情况」**同义但
标签不同**；checklist 按字面标签匹配，标准字段已填（157/50/无但接受办理）而三个带
单位括号的同义格子永远空 → `missingFields=[体重(kg),有无本地健康证,身高(cm)]` 永不清空
→ `_replyInstruction` 每轮命令「只缺这三项，请一次性补问」→ 模型问成确认句式 →
「对的」填不进格子 → 循环 → 弃疗 handoff。**双方行为都合理**：模型经
candidateHeight/Weight/HasHealthCertificate 一等参数传了值，还正确填了另外五个补充字段
（住宿/上岗日期/站立/排班/调剂），唯独没重复填同义格子；缺的是归一层（→R12）。

本案同时录得（真实但非本循环驱动器）：
- isStudent claim quote 实录 `"你是社会人士（不是学生）对吧\n对的"`——模型把问句拼进
  quote 硬试 context_confirmation 被必然拒绝，R1 双重绑定的生产实况；
- 「姓名（真名）：宋子瑜」逐字 quote 在部分轮次被拒 no_candidate_evidence——
  72.3% 假阳家族（R10），根因仍待重放定谳；
- shadow 回执 note 携带行动指令文案（R9，卫生问题，非本案驱动）。

**铁证 B 归因同步修正**：王淼案被索要字面「有/无」的正是「有无本地健康证」这个
自定义补充字段——与铁证 C 同根（R12），非健康证 policy 本体。

**死锁规模旁证**：14 天全库 `handoff:system_blocked` 共 7 会话，其中 **4 个拦截话术
提及健康证**（57%）——死锁签名与复问热点收敛在同一字段族。绝对量小，但每单都是
资料收齐后的报名死亡，且与 24.1% 复问率同根。

铁证 B 附带暴露：该 chat 是**中介批量报多人**（同会话报了 4+ 个不同候选人），
整个 evidence/sessionFacts 体系假设一会话一候选人，多人会话下事实绑定必然错乱——
独立结构缺口，单列 §3.4。

## 2.5 度量 v2（2026-08-17，14 天窗，净口径）

**① confirm claim 出现率 = 0/359。** 全部 candidateClaims：缺省 set 348 + 显式 set 10 +
correct 1 + **confirm 0**；`agentQuestionQuote` 零出现。refactor todo :119 自设判据坐实：
现状直切 enforce 必死锁。（口径保留：tool_calls 落库可能是 zod 校验后的 args，
"模型没传"与"传了被剥"不可区分；但 operation 是合法键，confirm=0 是硬结论。）

**② 健康证答后复问率 = 31.5%（45/143）。** 496 个被问过健康证的会话中 143 个有可识别
应答；其中 **45 个在应答之后又被问了同一问题**。这 45 个里最终报名成功仅 13 个（28.9%）。
这是剔除"未答追问"后的净病灶规模：**每 3 个答了健康证的候选人就有 1 个被再问一遍**。

**③ 粗切口相关性反直觉，如实记录：** 复问会话报名率（25.2%）反而高于问一次（16.7%）和
没问过（1.2%）——深度混杂：走到健康证收资环节的本就是高意向会话。**不能用粗转化率
论证复问无害**，也不能反向论证伤害规模；因果要靠②切片的组内对照，当前只下结论到
"净复问率 31.5% + 死锁 4/7 集中于此字段族"。

## 3. 失败形态分类（v1）

1. **确认粘性失效**（铁证 A）：context_confirmation 未被采信或未持久化，
   候选人确认过的值下轮重新索要。
2. **闸门死锁**（铁证 B）：所有应答形态都过不了准入，precheck 永远 missingFields，
   终局只能转人工。比反复问更严重——是流程死刑。
3. **多候选人会话越界**（铁证 B 附带）：中介/带工头一会话报多人，
   单候选人事实模型下绑定错乱，复问与死锁都会被放大。
4. **合法复问**（城市样本）：未答追问/下钻/换城市——不是病，度量必须剔除，
   否则误导调阈。

## 4. 闸门盘点核验结论（2026-08-17，探索代理全量盘点 + 本会话三点抽查 + 一处矛盾定谳）

### 4.0 前置事实（改变全部读法）

`CANDIDATE_FACT_ADJUDICATION_MODE` 生产未设置，**默认 shadow**（tool-registry.service.ts:99-101，
注释明言「差异率稳定前勿切」）。evidence 底盘只观测不改行为；D1（确认带值进清单）/
D3（报名级确认网）/E1（判缺读账本）/E2（姓名闸门 quote 作证）/C4（回声路由）全部
enforce-only。**生产实际的采信体系 = 各消费点私有判据的拼图**，不是 claim 引擎。

### 4.1 生产活跃的保守机制（反复问的现役来源）

- 信任门：`trustedSessionFacts` 只收 high（tool-context.builder.ts:74-76）；
- sessionFacts 升级判据：medium→high 要求 quote 能**确定性复算出值**（policies.ts:104-127）——
  「对的/可以」复算不出任何值 ⇒ **上下文确认永远无法升级置信度，hint 永驻，逐轮重确认**
  （铁证 A 的代码级根因）；phone 永久锁 medium；
- precheck 私有删除族（每条都会把字段打回 missingFields→补问）：
  `nameFieldLooksSuspicious`（:1354-1379，不看裁决账本照删）、健康证本地资格状态机
  （:1257-1275）、`removeProfileOnlyCandidateFields`（:632-652）、出生日期反推覆盖（:1394-1418，
  与自家描述 :196「严禁推断」冲突）；
- 借阅身份字段强制 `collect_fields`：解锁只认 4 个私有识别器，整表确认句式
  （「姓名：张伟（如有误请改）」）不含「全名/真实姓名」关键词 ⇒ 永不解锁（precheck:1149-1177，
  注释 :1553-1556 自认不对称）；性别有专用 inline 识别器、姓名/电话/健康证没有；
- booking 姓名/电话闸门只读**原文正则**，不接收 EffectiveCandidateProfile
  （identity-gates.ts:89/199）；「档案有值、闸门不认」是设计现状；
- verdict-site 注册表覆盖缺口：以上 8 族裁决点全部不在册（registry 自述判据要求在册）。

### 4.2 结构性复问点 R1–R8（enforce 切换的前置修复清单）

| # | 结论 | 关键证据 |
|---|---|---|
| R1 | 整表确认对 age/education/healthCert/height/weight/householdProvince/isStudent **七字段结构上无效**：模型轨无法表达 context_confirmation | model-claims.ts:31 写死 interpretation:'direct'；CandidateClaimInputSchema（claim.types.ts:229-241）无 agentQuestionQuote 键；`operation:'confirm'` 全仓零测试 |
| R2 | 健康证/身份裸答双重绑定：引「有」→ quote_too_short（minContext=3）；连同问句引 → quote_not_found（问句不在候选人语料）。两条出口都堵死；判据还依赖标点（「是的」死、「是的！」活） | policies.ts:48,50；notary.ts:95-119、:44；precheck:358 的指导本身就是陷阱 |
| R3 | 可疑姓名删除（:1378）早于 E1 账本回填（:1495-1508），enforce 下回填会抹掉拦截 → precheck 放行、booking 拒——顺序倒置 | 待 enforce 回归实测确认 |
| R4 | 确认识别器不对称：性别有 inline confirm（认「如有误」句式），姓名/电话/健康证没有 → 表内确认死锁 | gender-confirmation.ts:29-34 vs name-confirmation.ts:164-181 |
| R5 | booking 双闸门与档案完全解耦；电话确认识别要求肯定应答**紧邻**（中间插一条表情即作废） | identity-gates.ts:165-183 的 break |
| R6 | 快照水位自杀：正常流程「precheck→发表→候选人回复→booking」中候选人回复必然改水位 → 快照过期 → D3 每次要求重新确认 | snapshot-gate.ts:57-59；snapshot.ts:46-52 |
| R7 | 「一次性传全已知字段」指令 × legacy claim 空 quote → 全部 rejected；shadow 是噪音，**enforce 会整表重问** | model-claims.ts:57 `quote:''`；notary.ts:41-43 |
| R8 | 出生日期反推绕过一切裁决且 shadow/enforce 行为相反 | precheck:1398-1418 |
| R9 | **shadow 行为泄漏**：shadow 承诺只观测，但回执 note 携带行动指令（"不要复述或提交…确认后重新提交"），模型服从 → shadow 期即产生确认循环。零行为变化契约不成立 | 铁证 C ②；precheck 回执 note 文案 |
| R10 | **no_candidate_evidence 假阳复发**：候选人逐字写过的 quote（「姓名（真名）：宋子瑜」）仍被拒，初始拒绝是循环点火器；根因待代码级复现（消息合并/截断/归一化差异候选） | 铁证 C ①；72.3% 假阳历史实测同族 |
| R11 | **确认循环无熔断**：同字段确认 ≥2 次仍不采信时没有任何确定性出口（停止追问/带值提交/早转人工）；booking 姓名门有限问熔断，确认循环没有 → 模型转五圈才弃疗 | 铁证 C |
| R12 | **收资字段同义未归一（铁证 B/C 的真根因）**：岗位自定义补充字段与标准字段同义但标签不同（身高(cm)/体重(kg)/有无本地健康证 vs 身高/体重/健康证情况），checklist 字面匹配 → 同义格子永空 → missingFields 死循环。与 feedback「screening label ≠ collection field」同族：岗位侧自由文本标签直进清单无归一层 | 铁证 C 276571 回执 templateText/missingFields 实录 |

### 4.3 定谳的文档-代码矛盾

candidate-fact-authority-refactor.md D2 状态「◐ 作证通道已通」**不成立**：
precheck:150 与 booking:607 的工具描述教模型「另附 agentQuestionQuote」，但 schema 无此键、
zod 静默丢弃；全仓唯一写入点是 adjudicate.ts:115（真名问答确定性轨，且 interpretation
仍是 'direct'）。notary.ts:54-57 与 :96-102 两条豁免生产不可达 = 死代码。该 todo 自设的
切换判据（:119「confirm claim 出现率为 0 就直接切会死锁」）在此现状下必然踩中。

### 4.4 铁证归因（§2 抽样 → 代码）

- 铁证 A（确认被丢弃）= sessionFacts 复算判据吃不下「可以」（§4.1 第 2 条）
  + R1（healthCert 无确认轨）+ R4（健康证无 inline confirm 识别器）；
- 铁证 B（字面回答仍死锁）= precheck 健康证本地资格状态机逐轮删字段 + R2 双重绑定，
  多候选人会话（§3.3）放大；
- 城市复问大头合法（§2 定性），invite 城市门经五档出处梯已修历史 badcase——
  城市不列入本专项止血目标。

### 4.5 盘点复核点（子代理自报不确定，7 条留档待人工）

claimId 硬编码唯一性 / hasSelfReportedPhoneProvenance 口径对齐 / R3 触发概率实测 /
corpus fallback 窗口差异 / gender_source='system' 写入方 / C4 误报率以
logs/observability/fact-adjudication-daily.md 为准 / R1R2 与 refactor todo 已知范围重叠度
（本会话已部分定谳：D2 状态不实，见 §4.3）。

## 5. 工作分解

- [x] **A. 闸门与确认粘性代码盘点**：完成（§4）；三条承重断言经本会话抽查实证，
  一处文档-代码矛盾定谳（§4.3），7 条复核点留档（§4.5）。
- [x] **B. 度量 v2**：主体完成（§2.5）——confirm 出现率 0/359、健康证答后复问率 31.5%、
  粗相关性反直觉已定性为深度混杂。残余：复问→流失的组内因果对照（低优先，
  净复问率已足够支撑提案排序）。
- [ ] **C. 调整提案（数据支撑版，2026-08-17 定稿；与 candidate-fact-authority-refactor
  协同推进，不另起炉灶）**

  **P0 止血（不等 enforce，全部并入 refactor D 工序治理）**：
  1. R1 schema 通道修复（chip 已建 task_e46c8322）：CandidateClaimInputSchema 补
     agentQuestionQuote + produceModelClaims 透传 context_confirmation——
     confirm 出现率从 0 解封是后续一切判据的前提；
  2. 健康证族确认识别：本地资格状态机 + 收资清单认「（如有误请改）+肯定应答」与
     上下文确认形态（对齐性别 inline confirm）——直接打 31.5% 答后复问与 4/7 死锁；
  3. sessionFacts 上下文确认升级通道：「对的/可以」绑定 Agent 问句后允许 medium→high
     （替代"quote 必须复算出值"对确认场景的误杀）——治 hint 永驻逐轮重确认；
  4. **R12【已撤销 2026-08-17】**——用户裁定「不要过渡期」：语义桥止血补丁不做，
     根因由海绵标签制接口在源头消灭（见 label-driven-collection-refactor.md）。
     以下勘定记录保留作历史依据：
     - 生产字面匹配三坐标（v10.43.0）：补充字段入口 precheck.tool:1150-1155
       （岗位报名表 labelName 进清单、按 labelName 字面取答案）；标准字段字典
       checklist.util:194-210（硬编码键 身高/体重/健康证情况）；判缺 checklist.util:280
       （`displayOrder.filter(f => !knownFieldMap[f])` 纯字符串比对）；
     - 在途修复（议题 9-1，工作树未提交，HEAD/v10.43.0 均无）：stripFieldAnnotations
       剥括号注记 + canonicalizeChecklistFields 去重——救得了 身高(cm)/体重(kg)；
     - **9-1 修复完稿后逐层重放（2026-08-17 二次核验）**：修复含三层——
       ①checklist 侧 canonicalize 去重（checklist.util:291）；②补充答案确定性回填环
       （precheck:1391-1398，模型漏传时从候选人「字段：值」表单回捞）；③键名归一
       `normalizeSupplementKey`（NFKC/去括号/剥语气前缀）+ 一行流表单解析 + 语义别名兜底
       （interview-booking-customer-label.builder.ts:253-331）。
       铁证 C 重放：**身高(cm)/体重(kg) 已消灭**（归一到「身高/体重」、knownFieldMap 已有值）；
       **「有无本地健康证」仍循环**——三条取值路径逐层核验全 miss：
       (a) 模型 supplementAnswers 没传该键；(b) 候选人答案行的键是「有没有上海本地的食品
       健康证」，归一后 ≠ 别名集 {本地健康证/健康证情况/健康证}（「有没有」不在语气前缀表，
       且即便剥掉仍剩「上海本地的食品健康证」，全等比对不中）；(c) 一行流解析按顿逗号切段，
       换行表单整体成一段，前缀比对不中。
     - **修法裁定**：不再加文本别名——9-1 自己的注释已判「补丁式别名表是本类死循环的
       历史成因」。「有无本地健康证」的答案权威在健康证 policy 状态机
       （健康证情况 × 本地资格，health-certificate-policy.util 已持有三态），
       R12 收窄为：**从状态机语义互填该类补充标签** + 铁证 B/C 重放验证 + 随 9-1 同批发版。
     - 附带发现（9-1 注释自证）：此类卡死的终态不只是复问——6a7e7846 里模型被逼到
       **谎称"资料已齐帮你提交"而 booking 从未调用**，比复问更恶性。
     待验证：健康证 24.1% 答后复问中带「有无本地健康证」补充字段岗位的占比（预期是大头）；
  5. R11 确认循环熔断：同字段确认 ≥2 次仍不采信 → 确定性出口（停止追问 + 带已复述值
     提交或早转人工），对齐 booking 姓名门限问熔断先例——R12 修不到的未知形态由它兜底；
  6. R9 shadow 措辞去指令化（卫生项）：shadow 回执不得下达"确认后重新提交"类行动指令；
  7. R10 假阳复现定位：用 6a827105 原始消息重放 runCandidateFactAdjudication，
     定谳「逐字 quote 仍拒」根因，修公证回查鲁棒性。

  **P1 enforce 切换前置**：R3（删除/回填顺序）、R6（快照水位判据放宽为字段级）、
  R7（legacy claim 空 quote 噪音清除）修复 + 修后 confirm 出现率脱离 0 且稳定 +
  R2 豁免通道实测生效。切换判据沿用 refactor todo §3 四结构量 + :119 两条。

  **P2 结构治理**：8 族私有闸门入 verdict-site 注册表并逐步收拢读账本；
  多候选人会话处置（识别 + 降级或产品侧分流）；D5 确认 producer 族退役随 refactor 原计划。

  **验收指标**：健康证答后复问率 31.5% → <10%；system_blocked 健康证族 4/14天 → 0；
  confirm claim 出现率 0 → 稳定 >0。松紧原则不变：候选人可见可改的先松，
  不可见的直接消费保持严。

## 5. 生产查询纪律（本专项所有探针遵守）

每条 `SET LOCAL statement_timeout` + 严格串行 + message_processing_records 用
received_at（无 created_at 索引）+ 大扫描用 MATERIALIZED 两段式；
chat_messages 侧如需用 "timestamp" 列。

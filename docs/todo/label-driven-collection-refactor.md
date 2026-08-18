# 收资域总纲：标签制 × 收资表单状态机（label-driven collection）

> **⚡ 2026-08-18 挂起解除**：统一契约已在生产兑现——全量 468 个在招岗位实测
> （§2.5-v2），**身份核已标签化且 468/468 全覆盖**（姓名769/手机号770/年龄687/性别771），
> 零标签岗位归零；entryUser 新版 required 只剩 jobId、身份一并走 labelList。
> 实体定名 **BookingCollectionForm**。状态机批可开工，实施蓝图为
> collection-form-machine-implementation.md（v2 修订随实测同步）。

> **本文档是收资域唯一权威文档**（2026-08-17 整合）。原三份独立文档已全文收编为附录，
> 旧文件名引用一律指向对应附录：
> - `confidence-admission-review.md` → **附录 A**（采信专项诊断档案，只读）
> - `candidate-fact-authority-refactor.md` → **附录 B**（claim 引擎 P11 改造底账；其 P1 切换判据由 §2.8 状态机承接）
> - `execution-checklist-20260817.md` → **附录 C**（0817 执行清单底账；任务 A 已完成并评审通过）
>
> 结构：正文 = 终态设计（§1 接口语义 → §2.5 生产实测 → §2.8 收资表单状态机【核心实体】
> → §3 架构 → §4-5 退役/存活清单 → §6 开放项与契约核对清单 → §7 在途关系）；
> 附录 = 历史底账与诊断档案。

> 立项：2026-08-17（下段为立项时底账）。**状态更新 0818：挂起已解除（见顶部声明），所提统一契约已兑现——身份核标签化，entryUser 新版 required 只剩 jobId。**
> 用户已向海绵后端提出（2026-08-17）：现 entryUser 的必填身份核
> （name/phone/age/gender + interviewTime）被排除在标签查询接口之外，
> 需要**一个接口统一返回岗位报名的全部筛选字段**（身份核与标签同构）；
> 同时所有岗位保证配有报名表单项（覆盖度缺口在源头关闭）。
> **cake 设计原则随之升级：契约驱动的字段集 + 按字段身份挂接的语义适配器注册表**——
> 收什么、必不必填、允许什么答案，全部由契约数据决定；cake 只保留无法数据化的
> 字段语义（真名闸/手机号出处闸/健康证状态机/年龄推导），按稳定字段键挂接，
> 契约里的未知字段走 fieldType 通用道。
> 既有两接口（batch-query labels / entryUser）生产已可用，实测记录见 §2.5。
> 用户裁定：①重叠以海绵侧配置规范为准，cake 不做防御性归并；②**不要过渡期**——
> 不做旧架构上的止血补丁（confidence-admission-review R12 语义桥已撤销），直切标签制。
> 背景铺垫见 confidence-admission-review.md（字面标签匹配病灶全解剖）。

## 1. 两接口语义

**批量查标签** `POST /ai/api/jobs/interview-labels/batch-query`（jobIds ≤100）：
每岗返回 `labels[]`：`labelId`（稳定键）/ `labelTitle` / `labelInstructions` /
`fieldType`（TEXT | SINGLE_OPTION | MULTIPLE_OPTION | FILE）/
`acceptedOptions[]` + `rejectedOptions[]`（{optionCode, optionLabel}）——
**筛选语义是数据结构**：答案命中 rejectedOption = 不允许报名。

**提交报名** `POST /ai/api/workorder/entryUser`（**0818 新版契约**；旧版
name/phone/age/gender 一等必填已废）：
必填仅 `jobId`，可选 `interviewTime`；身份核不再是一等参数——姓名(769)/手机号(770)/
年龄(687)/性别(771) 与其余字段一并走 `labelList[]`：`labelId` +
(`value`：TEXT/FILE 的值) | (`options[]`：optionCode，单选一多选多)。
labelTitle/optionLabel 可不传（仅辅助排查，服务端按 id/code 回读配置、不作校验）。
返回：`notice`（成功文案）/ `errorList[{field,msg}]`（**字段级校验错误**）/
`workOrder{workOrderId, signUpTime, 品牌/公司/项目/岗位, 状态文案, 薪资}`。

## 2. 结构性判定

1. **身份核标签化**（0818 新版契约定稿）：一等参数只剩 jobId，身份四件套也走
   labelList（769/770/687/771，全量 468 岗每岗必含）。学历/健康证/身高体重/身份/户籍
   从契约字段降级为"岗位配了标签才收"。固定词表 FIELD_ORDER 全体席位随之退役。
2. **文本匹配层整体消失**：labelId 是收集态的键，optionCode 是答案的通货。
   labelName 字符串匹配、单位归一、同义别名，全无存在必要。
3. **先筛后收成为结构**：收集时即刻判 accepted/rejected，不合格不再继续收资、
   不提交、走换岗/拉群。7-27「screening label ≠ collection field」裁定由数据结构承载。
4. **报名死锁类终结**：errorList 替代"missingFields 永不清空→system_blocked"，
   失败可解释、可精确补问。

## 2.5 生产实测（2026-08-17，两接口均已在生产；100 个近 14 天活跃岗位实查）

- **覆盖度：54/100 有标签，46 无标签**。对无标签岗位中有近期 precheck 数据的 37 个
  交叉比对旧通道：**18 个（49%）旧报名表仍带补充要求而新标签为空**
  （有无本地健康证/出生日期/体重(kg)/学信网是否在籍/纹身/身份证号…）——
  迁移滞后是真实存在的，"无标签"≠"无要求"。
- **labelId 全局词表证实**（样本内零 labelId→多标题冲突）：13=有无本地健康证
  （**52/54 岗配置，选项码 1/2/3 与 resolveLocalHealthCertificateEligibility 的
  spongeValue 完全同构**）、2=学历（optionCode=海绵 educationId，acceptedOptions
  只列达标学历=初筛内建）、4=身高(cm)、50=体重(kg)。头部 6 个标签覆盖绝大多数实例。
- **筛选语义的现实形态：acceptedOptions 白名单**——rejectedOptions 样本内 0 使用。
  闸门语义应为「选项类答案必须映射进 acceptedOptions，映射不进=不合格/求证」，
  rejectedOptions 只是显式负枚举的补充。
- **FILE 与 MULTIPLE_OPTION 样本内 0 使用**：简历暂不走标签，resume-tool 方案不动。
- 旧通道标签有隐私脏项（524916 配「身份证号」）与复合脏项（「有无健康证；有无分拣」
  一格两问）——标签制下若出现同类配置，cake 需要拒答策略（身份证号对齐视觉管线
  「刻意不设证件号 key」的裁定）。

**据此的方案调整**：①切换判据只能按岗（labels 非空即新世界），"无标签且旧报名表
非空"的滞后岗位需要政策裁定（见 §6-1'）；②初筛闸门改 acceptedOptions 白名单语义；
③头部标签建 per-labelId 确定性适配器（13→健康证状态机、2→学历解析器+achievable 校验、
4/50→数值形态门、出生日期→年龄推导转正），长尾走 fieldType 通用道。

## 2.8 收资表单状态机（2026-08-17 用户裁定：化零为整的主实体，本改造的核心）

> 采信专项全部余项不再作为散点任务执行，统一整合进本实体。根因裁定：旧体系的
> 一切病灶（逐字引文假阳/确认识别考古/快照自杀/反复问/死锁）源于**系统不持有收资
> 状态、每轮从聊天原文全量重推**；根本解=持久表单状态机，写入守卫、确认迁移、
> 办结即终审。

### 实体定义

`CollectionForm`，per（候选人身份 × jobId），槽位以稳定字段键为键
（身份核字段码 + labelId，来自统一契约）：

```
槽位状态机：
  空 ──值提案+写入公证──→ 已填(待确认) ──复述事件+肯定应答──→ 已确认（办结）
                              │                                    │
                        答案∉acceptedOptions                 显式失效事件才可重开
                              ↓                              （改口/换岗/errorList）
                           不合格（岗位级初筛判定）
  确认迁移尝试 ≥2 次未办结 → 升级态（带值提交或转人工）——熔断内建
```

### 五条构造性质（每条消灭一族旧病）

1. **写入公证一次、同轮完成**：值到达当轮即验（证据就在手边的当前消息里），复用
   简历 v4 内核模式（证据校验/形态/归属/置信授予）——跨轮引文搬运装置整体消失
   （R2/R10 病灶地基拆除）；claim 仍是模型→状态机的运输格式（R1 的 schema 通道
   并入运输规范）；
2. **复述由状态渲染、确认是状态迁移**：复述事件落账（槽位清单），下一条肯定应答
   迁移全部在案槽位——确认识别器族/肯定词表分叉整体退役（R4、原 B2 意图吸收，
   其文本匹配实现不再需要）；
3. **办结即终审**：已确认槽位不可被重推触碰，重问一个已确认槽位在结构上非法
   （需显式失效事件）——反复问从"识别器碰巧失灵"变为"不可能事件"；快照/水位
   机制退役（R6）；
4. **初筛在写入时判**：选项答案 ∉ acceptedOptions → 槽位不合格 → 岗位级判定，
   不合格不再收资不提交（先筛后收结构化；健康证 policy 状态机转岗为该槽位的
   写入适配器，吸收原 P0-2）。
   **不合格披露策略（2026-08-17 补，判定如实/披露分级/内外分离）**：
   账本永远落真实原因（labelId+命中项+证据），委婉只在渲染层——
   ①可明说族（年龄/性别/学历/健康证/身高体重等岗位硬性条件，PR #421 裁定口径）：
   直说要求+转岗；②禁明说族（户籍/民族/专业等守卫红线 + **未知新标签默认归此档**）：
   绝不披露真实原因，渲染为换岗/拉群承接（复用 noMatchScript 家族），且禁止在
   敏感答案紧邻回合触发拒绝（因果隔离）；③渲染器禁说词表与出站守卫红线规则
   同源引用，不得另立副本；
5. **一会话多表单**：中介批量报名 = 多个 CollectionForm 实体，槽位归属天然清晰
   ——多候选人问题首次可表达。

### 旧病灶 → 状态机部件的完整映射（采信专项余项收编清单）

| 原散点 | 归宿 |
|---|---|
| R1 confirm 作证通道（原任务 B + chip） | 写入运输规范的一部分，随状态机实施 |
| B2 sessionFacts 确认升级 | 被性质②取代（确认=迁移），撤销独立实施 |
| B3 R10 假阳复现 | 病灶地基被性质①拆除，降级为可选法证（不阻塞） |
| R9 shadow 措辞 | 旧双轨回执随重推装置退役，无需单独修 |
| R11 确认熔断 | 内建为升级态（构造性质，非补丁） |
| R3 删除/回填顺序、R7 legacy 空 quote | 随旧 precheck 收资核拆除消失 |
| enforce 切换 | 重定义：状态机账本**即** enforce——它由构造可信，无需开关 |
| R12 字段同义 | labelId 稳定键（源头已解决） |
| 采信验收指标 | 状态机 KPI：答后复问率 <10%、死锁 0、新增「已确认槽位被重问次数=0（结构保证，观测验证）」 |

### 表单与记忆系统的边界（2026-08-18 定稿）

表单是**事务底稿**（人×岗位、有终点、办结封存——与 active_booking/group-task 同类的
过程态实体），记忆是**对人的持续认知**（跨岗跨会话、无终点）。分界：岗位要什么归表单，
人是什么样归记忆。两者互相喂养：
- **记忆→表单预填**：开新表时人级事实按置信度语义带值进复述求证——跨岗不重复盘问
  （反复问的另一半由此解决）；
- **表单→记忆回写**：办结的已确认槽位以确认级署名回写 sessionFacts/画像——记忆最优质
  进货渠道（每值都经写入公证+本人终审）。
记忆系统一层不废：短期/长期不变；sessionFacts 收资字段主进货换为表单回写，LLM 轮末
抽取收窄为表单外软事实（preferences 族）；claim 底盘转岗写入守卫内核；标量扇出类
污染被写守卫挡在办结回写之外。

### 实施定位

设计现在定稿（本节）；实施随统一契约落地的重启批一次完成（槽位宇宙=契约字段集）。
存储形态（Redis 实体+审计事件 vs 表）留实施期定。聊天记录降级为审计日志，
不再是运行时的每轮重推来源。**存续资产**：全部解析器/公证内核/身份闸门/健康证
policy/肯定词表唯一居所——挪位为写入守卫与迁移判据，代码复用。

## 2.5-v2 生产实测第二轮（2026-08-18，全量 468 在招岗位 × 标签，枚举法=450 品牌逐一翻页）

- **覆盖度 468/468，零标签岗位 0**——"所有岗位都有报名表单项"兑现；每岗 4-13 个标签。
- **身份核标签化**：姓名(769,TEXT)/手机号(770,TEXT)/年龄(687,TEXT)/性别(771,SINGLE_OPTION)
  全部 468/468。**性别要求完全结构化**：accepted[男]34 / [男,女]413 / [女]21，
  rejected 成对出现——契约核对清单第 3 条已落地。
- **全局词表 109 个 labelId，零标题冲突**；fieldType：TEXT 2820 / SINGLE 1023 / MULTI 5 / FILE 9。
- **FILE=上传简历(49)×8 + 头像(6)×1**——简历工具 v4 的 output 即其 value 生产者。
- **rejectedOptions 已实用**（94 处）：健康证「不接受办理」拒 5 岗、通勤「不符合」拒 15、
  能做多久「3个月内」拒 4……筛选语义=命中 rejected 即不合格。
- **健康证(13) 409/468**，三态选项与状态机 spongeValue 同构不变；学历(2) 4 种按岗白名单。
- **⚠️ 配置卫生病在标签系统内复发**：学生/学信网语义分裂为 **12 个 labelId**
  （582/660/728/735/605/609/565/554/750/671/703/175），多为 TEXT 且标题携带筛选指令
  （「不要学生及暑假工」「不要暑假工！」）——需向海绵反馈配置治理（筛选应配
  SINGLE_OPTION+rejectedOptions，同义标签应合并）；cake 侧适配器须按「标题语义族」
  兜底而非仅 labelId 精确表。
- **敏感标签实存**：籍贯(3)、专业×2(544/659)、学信网族——披露策略兜底注册表 v1 必须随批交付。
- **契约缺口（对照核对清单）**：required 标志无（按"返回即须收"处理）、年龄边界未结构化
  （687 是无值域 TEXT，岗位年龄要求仍走既有岗位数据解析）、interviewTime 窗口语义未进契约、
  TEXT 值域校验无、披露级别无、缓存失效信号无——已消解（0818 裁定标签零缓存实时查询）。labelInstructions
  仅 22 处使用。

## 3. cake 侧目标架构

```
岗位聚焦（job_list / focusJob 确立）
  → sponge client 新方法 batchQueryInterviewLabels(jobIds)（零缓存、每轮实时查询——0818 裁定）
  → precheck 收资模型：
      身份核标签（769/770/687/771）——既有闸门（姓名真名闸/手机号出处闸/年龄边界）降为槽位写守卫
      + 标签集（labelId 为键）——每标签状态机：未答 → 已答(value|optionCodes) → 不合格
  → 答案解析按 fieldType 分道：
      SINGLE/MULTIPLE_OPTION：候选人自然语言 → 封闭选项集匹配
        （确定性词表直配优先；含糊时模型作证选 optionCode + 代码公证出处——claim 裁决体系复用）
      TEXT：自由文本，claim 轨照常
      FILE：附件通道（简历工具方案 resume-tool-overhaul 在此插入：附件 URL 即 value）
  → 初筛闸门：命中 rejectedOption → 本岗终止收资 → 换岗推荐/拉群话术
  → 提交 entryUser(身份核 + interviewTime + labelList)
  → errorList 非空 → 按 field 精确补问/修正后重试；workOrder 返回 → 落 ledger/记忆
```

### 健康证状态机的去向

resolveLocalHealthCertificateEligibility 不删——它从"改写 knownFieldMap['健康证情况']"
转岗为"把候选人自然语言裁决成健康证类标签的 optionCode"（三确定态→选项，
两不定态→留空追问）。裁决逻辑复用，输出端换轨。

## 4. 退役清单（终态下删除）

- checklist.util：FIELD_ORDER 大部分席位、buildKnownFieldMap 标准键字典、
  missingFields 字面过滤、FIELD_LABELS 展示映射的大部分；
- classifySupplementLabel 括号黑名单/反问式启发（筛选语义已结构化）；
- normalizeSupplementKey + 语义别名表 + 一行流表单解析（9-1 刚建成的归一层——
  它治的病在源头消失；表单回捞或可保留为"候选人答案捕获"的辅助，实施时定）；
- interview-booking-customer-label.builder 的 customerLabel 字符串拼装主体；
- 旧 booking 提交通道（待确认 entryUser 的覆盖范围后定，见 §6-1）。

## 5. 存活资产

- 身份核闸门全套：姓名真名/闸、手机号出处闸、年龄边界、身份粘性；
- claim 裁决体系（选项匹配的"模型作证+代码公证"就在它上面跑）；
- 健康证本地资格状态机（换输出端）；
- 面试时间窗口/等通知语义（interviewTime 仍是入参）；
- 简历附件识别与读取（FILE 标签的 value 生产者）。

## 6. 待海绵侧/产品确认的开放项（2026-08-17 实测后修订）

1'. **滞后岗位政策【已消解】**：统一契约 + 全岗位保证配报名表单项，覆盖度缺口
   在源头关闭。重启时第一件事：用统一契约接口复测覆盖度（同款 100 岗批查）。

1''. **统一契约核对清单**（0817 预契约版底账；新契约已到手，权威契约诉求单已另立
   `label-contract-change-requests.md`（10 条，已发后端）——本清单保留作核对痕迹）：
   1. 身份核与标签**同构**返回：每字段带稳定键、fieldType、required 标志——
      cake 不再硬编码"哪些字段存在"；
   2. **年龄边界结构化**（岗位 min/max 进契约）——替代 cake 从岗位文本解析年龄要求；
   3. **性别要求结构化**（acceptedOptions：男/女/不限）——岗位性别要求可对候选人明说，
      结构化后筛选与话术同源；
   4. interviewTime 的窗口/等通知语义是否进契约（不进则 precheck 窗口逻辑照旧）；
   5. 筛选语义定死：acceptedOptions 白名单为主、rejectedOptions 显式负枚举为辅；
      TEXT 字段的格式/数值范围校验若有也结构化（如身高 cm 值域）；
   6. labelInstructions 的语义（展示给候选人 vs 给 AI 的收集指引）；
   7. ~~岗位配置变更的缓存失效信号（updatedAt/版本号）~~——0818 已撤回（零缓存裁定）；
   8. 隐私字段口径：身份证号类是否可能出现、cake 拒答边界（对齐视觉管线裁定）；
   9. **每标签的拒绝披露级别**（可明说/禁明说）进契约——海绵配置规范为准；
      契约不带时 cake 按属性族兜底映射、未知默认禁明说。
2. 旧报名表/supplementAnswers 通道的退役时点：与滞后岗位补配进度挂钩。
3. FILE 标签的 value 形态确认（URL？与现简历附件 URL 域名关系）；当前生产 0 使用。
4. 服务端是否按标签配置校验提交（决定 acceptedOptions 本地拦截失误时 errorList
   能否兜底；无标签岗位服务端是否完全不校验补充项——决定 1'(b) 的真空面积）。
5. interviewTime 的窗口校验是否仍走岗位既有数据（precheck 窗口逻辑不动的前提）。
6. 身份证号类隐私标签的拒答口径（对齐视觉管线「不设证件号 key」裁定）。
【已关闭】生产环境上线：两接口均已在生产，gateway.duliday.com/sponge 实测可用。

## 6.5 实施蓝图

代码架构级执行计划（代码树/类型/签名/存储/接线/实现顺序/退役批/验收）：
**collection-form-machine-implementation.md**——1-4 步（纯状态机+适配器+披露策略+渲染器）
不等契约可先行，5 步起以契约落地为检查点。

## 7. 与在途工作的关系

- confidence-admission-review：R12 语义桥**已撤销**（不要过渡期）；R1（confirm 作证通道）、
  R9（shadow 措辞）、R11（确认熔断）仍有效——身份核与选项匹配照样需要确认语义与熔断；
  R2/R10 的公证问题在标签制下面积缩小但身份核仍在。
- resume-tool-overhaul：不变，FILE 标签是它的天然消费端。
- 9-1 归一层：已完稿的代码随发版照发（治现网旧岗位），标签制铺开后按 §4 退役。

---

# 附录 A（收编 2026-08-17）：采信专项诊断档案

> 原 confidence-admission-review.md 全文收编，只读；病灶对照底稿与验收指标来源。

## 置信度采信体系复盘专项

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

### 1. 已有证据（立项依据）

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

### 2. 探针 v1 数字（2026-08-17，生产 14 天窗，message_processing_records.reply_preview 正则）

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

#### 抽样定性

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
- 「姓名（真名）：王五」（化名，候选人原消息为其真实姓名逐字实录）逐字 quote 在部分轮次被拒 no_candidate_evidence——
  72.3% 假阳家族（R10），根因仍待重放定谳；
- shadow 回执 note 携带行动指令文案（R9，卫生问题，非本案驱动）。

**铁证 B 归因同步修正**：6a4229f2 案被索要字面「有/无」的正是「有无本地健康证」这个
自定义补充字段——与铁证 C 同根（R12），非健康证 policy 本体。

**死锁规模旁证**：14 天全库 `handoff:system_blocked` 共 7 会话，其中 **4 个拦截话术
提及健康证**（57%）——死锁签名与复问热点收敛在同一字段族。绝对量小，但每单都是
资料收齐后的报名死亡，且与 24.1% 复问率同根。

铁证 B 附带暴露：该 chat 是**中介批量报多人**（同会话报了 4+ 个不同候选人），
整个 evidence/sessionFacts 体系假设一会话一候选人，多人会话下事实绑定必然错乱——
独立结构缺口，单列 §3.4。

### 2.5 度量 v2（2026-08-17，14 天窗，净口径）

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

### 3. 失败形态分类（v1）

1. **确认粘性失效**（铁证 A）：context_confirmation 未被采信或未持久化，
   候选人确认过的值下轮重新索要。
2. **闸门死锁**（铁证 B）：所有应答形态都过不了准入，precheck 永远 missingFields，
   终局只能转人工。比反复问更严重——是流程死刑。
3. **多候选人会话越界**（铁证 B 附带）：中介/带工头一会话报多人，
   单候选人事实模型下绑定错乱，复问与死锁都会被放大。
4. **合法复问**（城市样本）：未答追问/下钻/换城市——不是病，度量必须剔除，
   否则误导调阈。

### 4. 闸门盘点核验结论（2026-08-17，探索代理全量盘点 + 本会话三点抽查 + 一处矛盾定谳）

#### 4.0 前置事实（改变全部读法）

`CANDIDATE_FACT_ADJUDICATION_MODE` 生产未设置，**默认 shadow**（tool-registry.service.ts:99-101，
注释明言「差异率稳定前勿切」）。evidence 底盘只观测不改行为；D1（确认带值进清单）/
D3（报名级确认网）/E1（判缺读账本）/E2（姓名闸门 quote 作证）/C4（回声路由）全部
enforce-only。**生产实际的采信体系 = 各消费点私有判据的拼图**，不是 claim 引擎。

#### 4.1 生产活跃的保守机制（反复问的现役来源）

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

#### 4.2 结构性复问点 R1–R8（enforce 切换的前置修复清单）

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
| R10 | **no_candidate_evidence 假阳复发**：候选人逐字写过的 quote（「姓名（真名）：王五」，化名）仍被拒，初始拒绝是循环点火器；根因待代码级复现（消息合并/截断/归一化差异候选） | 铁证 C ①；72.3% 假阳历史实测同族 |
| R11 | **确认循环无熔断**：同字段确认 ≥2 次仍不采信时没有任何确定性出口（停止追问/带值提交/早转人工）；booking 姓名门有限问熔断，确认循环没有 → 模型转五圈才弃疗 | 铁证 C |
| R12 | **收资字段同义未归一（铁证 B/C 的真根因）**：岗位自定义补充字段与标准字段同义但标签不同（身高(cm)/体重(kg)/有无本地健康证 vs 身高/体重/健康证情况），checklist 字面匹配 → 同义格子永空 → missingFields 死循环。与 feedback「screening label ≠ collection field」同族：岗位侧自由文本标签直进清单无归一层 | 铁证 C 276571 回执 templateText/missingFields 实录 |

#### 4.3 定谳的文档-代码矛盾

candidate-fact-authority-refactor.md D2 状态「◐ 作证通道已通」**不成立**：
precheck:150 与 booking:607 的工具描述教模型「另附 agentQuestionQuote」，但 schema 无此键、
zod 静默丢弃；全仓唯一写入点是 adjudicate.ts:115（真名问答确定性轨，且 interpretation
仍是 'direct'）。notary.ts:54-57 与 :96-102 两条豁免生产不可达 = 死代码。该 todo 自设的
切换判据（:119「confirm claim 出现率为 0 就直接切会死锁」）在此现状下必然踩中。

#### 4.4 铁证归因（§2 抽样 → 代码）

- 铁证 A（确认被丢弃）= sessionFacts 复算判据吃不下「可以」（§4.1 第 2 条）
  + R1（healthCert 无确认轨）+ R4（健康证无 inline confirm 识别器）；
- 铁证 B（字面回答仍死锁）= precheck 健康证本地资格状态机逐轮删字段 + R2 双重绑定，
  多候选人会话（§3.3）放大；
- 城市复问大头合法（§2 定性），invite 城市门经五档出处梯已修历史 badcase——
  城市不列入本专项止血目标。

#### 4.5 盘点复核点（子代理自报不确定，7 条留档待人工）

claimId 硬编码唯一性 / hasSelfReportedPhoneProvenance 口径对齐 / R3 触发概率实测 /
corpus fallback 窗口差异 / gender_source='system' 写入方 / C4 误报率以
logs/observability/fact-adjudication-daily.md 为准 / R1R2 与 refactor todo 已知范围重叠度
（本会话已部分定谳：D2 状态不实，见 §4.3）。

### 5. 工作分解

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

### 5. 生产查询纪律（本专项所有探针遵守）

每条 `SET LOCAL statement_timeout` + 严格串行 + message_processing_records 用
received_at（无 created_at 索引）+ 大扫描用 MATERIALIZED 两段式；
chat_messages 侧如需用 "timestamp" 列。

---

# 附录 B（收编 2026-08-17）：claim 引擎 P11 改造底账

> 原 candidate-fact-authority-refactor.md 全文收编；其 P1 权力切换判据由状态机（§2.8）承接。

## 候选人事实裁决权改造：执行清单

> **来源**：2026-08-12 全链路评审——shadow 观测第 4 天（累计抽样 53 单元、解析器口径假阳率 72.3%）
> ＋ 三案考古（马楠七字段重问 / 苏海龙岗位卡回声连坐 / 董泽民确认死锁）＋ 全库裁决点普查。
> **原则宪法**：[rules-vs-semantics-design-philosophy.md](../principles/rules-vs-semantics-design-philosophy.md) **P11**（模型作证、代码公证、本人终审）。
> **范围裁定（用户已定，勿扩大）**：只动 resolution 域及其消费面。岗位侧解析族（job-policy-parser 等）、
> 出站守卫 28 规则、critical-turn-guard **不动**；收资匹配双栈（precheck/booking 私有标签匹配 +
> field-normalize 与 resolution 同名函数双栈）**独立立项**（另见收资字段解析统一方案），本文只留会师点 §6。

### 0. 三条定理（改造从这推导，争议回宪法 P11 打）

1. **病理**：事故 = 开放语言 × 确定性判定 × 终审权落档，三者叠加才发病；全库只有 resolution 候选人字段轨三项全占。
2. **分权**：置信度是证据的属性不是产者的属性。语义作者=模型（必附 quote）；出处公证=代码（纯字符串/标记）；系统内终审=候选人（可归责自陈是聊天系统的天花板）。
3. **代价**：公证器是代价路由器不是真值裁判。判据不是准确率，是每种错法都有便宜出口（误拒→模型本轮重试；误疑→多问一句；误收→报名级确认流兜底）。

### 1. 工序清单

#### 工序 A：解析器转岗——能力保留，权力剥离

| # | 项 | 锚点 | 状态 |
|---|---|---|---|
| A1 | `AUTHORITATIVE_PRODUCERS` 摘除 `'rule'`（P9 教义现行法条，一行） | `src/resolution/candidate/types.ts` | ☑ |
| A2 | collected-fields 产物标签改真：`producer: 'candidate_quote'` → `'rule'` | `src/resolution/candidate/collected-fields.ts`（`parseCandidateFieldsFromText` 内 `put()`） | ☑ |
| A3 | `CandidatePrefillHint` 从 gender 一个字段推广到全字段（"带值求证"，注释里的三禁令原样继承：不得据此拒绝/提交/升级来源） | `src/resolution/candidate/types.ts` + `tool-context.builder` + precheck | ☑ |
| A4 | 解析结果渲染进模型上下文 hints section（与 job-policy-parser 同构：“解析线索：年龄24（出处‘今年24’），仅供参考”） | `turn-hints.section.ts` + `fact-lines.formatter`（出处截断 24 字） | ☑ |
| A5 | 值形状函数原地保留并转为公证第二问判据（`isPlausibleAgeValue` / `isStorableCandidatePhone` / `isDigitsOnlyName` / 称谓后缀 / 占位号族） | 各解析文件（原地未动）；**收拢点**改在 `evidence/normalize.ts` `isValidCandidateFieldShape` | ☑（解析文件零改动；见下方偏离说明①） |
| A6 | `normalize*ToId` 枚举映射照旧（提交侧值映射，合法） | 各解析文件 | ☑（未动） |

**纪律**：九个解析文件一行正则不删、不加。新口语形态一律不再补正则分支（冻结令），缺口由 B 通道吸收。

#### 工序 B：作者通道扶正——candidateClaims 从副通道变唯一通道

| # | 项 | 锚点 | 状态 |
|---|---|---|---|
| B1 | 改写 `candidateClaims` describe：从"需要归一化理解时（推荐）用"改为"候选人一切资料必经此提交、必附逐字 quote、指代必须是候选人本人"；工具 description（:134 段）同步 | `src/tools/duliday-interview-precheck.tool.ts` | ☑ |
| B2 | 裸字段（`candidateName` / `candidateAge` 等）降级：描述标注 deprecated，工具侧自动转为无 quote 低置信 claim（过渡期兼容，P2 阶段删） | 同上（九个裸字段全部标 deprecated） | ☑ |
| B3 | schema 零改动确认：zod `CandidateClaimInputSchema`（封闭字段枚举 / quote 1-200 强制 / 元数据工具侧填充）现状即目标形态 | `src/resolution/evidence/claim.types.ts` | ☑（已验收，schema 未改一行） |

#### 工序 C：公证器改造——evidence/ 只裁出处

| # | 项 | 锚点 | 状态 |
|---|---|---|---|
| C1 | 类型层删三个语义拒因：`no_candidate_evidence` / `value_not_derivable` / `strict_field_free_derivation`（删除即不可表达，P2 用于裁决器自身） | `src/resolution/evidence/claim.types.ts` `CandidateClaimRejectionReason` | ☑ |
| C2 | `conflicting_evidence` 改道：不 reject，路由 `needs_confirmation`（decision 联合类型里席位已就绪）；废除冲突连坐互杀 | `evidence/engine.ts` + `profile.ts`（新增 `needs_confirmation` 状态与 `pickNeedsConfirmationValues`） | ☑ |
| C3 | 裁决链重写为三问：①引文真伪（可作证语料 `extractCandidateTexts` 逐字查找）②值形状（A5 函数）③档案冲突（→转确认）。保留 `quote_not_found` / `invalid_value_shape` / `stale_after_correction` | **新件 `evidence/notary.ts`** + `engine.ts` 换血；`policies.ts` 删 `validateClaimValueAgainstQuote` | ☑（见偏离说明②） |
| C4 | 新增回声检查（唯一新件）：quote 同时存在于 Agent 已发消息全集 → 转确认（两边都是已知字符串，封闭）。苏海龙岗位卡回声在此拦截 | `notary.ts` `detectAgentEcho`（≥4 字才生效，短串同现属巧合） | ☑（shadow 只计数，enforce 才路由） |
| C5 | 短引文门：quote 长度 ≥ 值长度+2（按字段可调），防裸「有」退化 | `policies.ts` `MIN_QUOTE_CONTEXT_CHARS` + `notary.verifyQuoteContext` | ☑（见偏离说明③） |
| C6 | rule-track 降为影子观测员：继续跑、不产 claim，只记 coverage delta（"我能抓到而模型没提交的字段"）落观测事件——迁移期覆盖率仪表 | precheck `computeCoverageDelta` → `fact_adjudication.coverageDelta` | ☑（仪表已上；「不产 claim」属 P2 拆机） |

#### 工序 D：确认流——终审机制落地

| # | 项 | 锚点 | 状态 |
|---|---|---|---|
| D1 | `needs_confirmation` 消费端：转确认字段自动进收资清单，渲染一句复述（"体重75公斤对吧？"）；肯定→confirmation 级覆盖一切；否定/改值→`operation=correct` | precheck `confirmationSuffixByField` + `prefilledConfirmationFields`（与性别表内确认同一条协议） | ☑（enforce 档，见偏离说明④） |
| D2 | 确认的识别由模型完成（引确认对答原话提交 claim），肯定词表正则不再参与 | 工具描述写明 `operation=confirm` + `agentQuestionQuote` 用法；`就是X` 正则 enforce 下停用 | ◐（作证通道已通；三个确认 producer 与四份肯定词表随 D5 在 P2 删） |
| D3 | 报名级字段（name/phone/age）booking 前强制 confirmation 级（P7 本义；"指代错误"残余风险的兜底网） | `snapshot.confirmedFields` + `BOOKING_CRITICAL_FIELDS` + booking 闸门 | ☑（enforce 档；姓名/电话已有出处闸门，实际新增的是年龄那道） |
| D4 | 身份翻转闸路由保留（改口后显式再确认，与终审原则同构，7-28 裁定勿收紧豁免） | — | ☑（未动） |
| D5 | 【P2 阶段】三个确认 producer（name/gender/city-confirmation）+ 四份分叉肯定词表（含 `gender-confirmation.ts` 的 `INLINE_CONFIRM_AFFIRMATION_RE` 与 `dialogue.ts` 的 `AFFIRMATIVE_ANSWER_RE`）退役删除 | `src/resolution/evidence/producers/` + `src/resolution/signal/dialogue.ts` | ☐ |

#### 工序 E：消费面收编——取缔第二法庭

| # | 项 | 锚点 | 状态 |
|---|---|---|---|
| E1 | precheck 判缺改读账本：`missing = 必填 − {accepted, confirmed}`，删自跑解析器路径。I1（门不严于执行者）从测试性质变构造性质 | precheck 裁决段（账本既是过滤器也是**取值来源**，见偏离说明⑤） | ☑（enforce 档） |
| E2 | booking 姓名闸门按已批路线换 quote 作证：负向出处（打招呼语形态）保留、`就是X` 类确认识别正则删除、同题限问熔断保留 | `identity-gates.ts`（`attestedByClaim` / `allowLegacyConfirmRegex`）+ booking 提前载入快照 | ☑（见偏离说明⑥；2026-08-13 二轮评审已将 `attestedByClaim` 收紧为确认级且 enforce-only） |
| E3 | 【P2 阶段】双源对账机器拆除：`mergeRuleAndLlmFacts`、legacy superseded 双读 | `src/memory/services/session.service.ts` | ☐ |

#### 落地偏离说明（七条，均为执行中发现、按宪法就地裁定）

① **A5 收拢点换了地方。** 清单原写"值形状函数原地保留、无代码变化"。九个解析文件确实一行没动，但公证第二问需要一个统一入口，因此把 `isPlausibleAgeValue` / `isPlaceholderPhone` / `isDigitsOnlyName` / `hasHonorificSuffix` 接进了 `evidence/normalize.ts` 的 `isValidCandidateFieldShape`（原先它自己内联了一份年龄区间与姓名标点判据，属重复实现）。新增判据全是封闭形态，符合 P11 身份 2；顺带消掉了"占位号形态合规"这个既有缺口。

② **公证器独立成文件。** 清单把三问写在 `adjudicate.ts` 名下，实际拆成 `evidence/notary.ts`（三个 verify 函数 + 回声 + 串行编排），`engine.ts` 只做归并与物化。理由是三问要能被单独测（判据④要求三问分项精确率），塞在裁决主链里测不动。

③ **短引文门按字段查表，不是一刀切 +2。** 「值长度+2」对严格身份字段会直接复活 badcase 6a7446eb（Agent 索名 → 候选人单独回一条"张丽鑫"，3 字 < 3+2），对性别会打死裸答"男"。改为 `MIN_QUOTE_CONTEXT_CHARS` 逐字段表：只有 `healthCertificate` / `isStudent` 这类"裸答可以回答任何问题"的字段设 3 字语境，其余为 0；`context_confirmation` 且带 `agentQuestionQuote` 时整体豁免（语境由问句提供）。

④ **D1 挂在 enforce 档，不在 P0 直上。** 它消费的 `needs_confirmation` 是 C2 的产物，而 C2 在 shadow 期不改行为（旧路径下冲突同样什么都不做）。若 D1 无条件生效，冲突字段会在 shadow 期就多出「（如有误请改）」后缀与借值，P0「零行为变化」不成立。shadow 期仍把 `needsConfirmationFields` 回给模型（与既有 `rejectedClaims` 同待遇）。

⑤ **E1 的账本既是过滤器也是取值来源。** 只做"剔除账本里没有的值"会让带引文的 claim 根本进不了清单——模型得同时提交 claim 和裸字段，与 B1/B2 要退役裸字段直接矛盾。改为：accepted / needs_confirmation 的账本值经 `normalizeClaimValueForChecklist` 写进 `knownFieldMap`，其余删除。

⑥ **`就是X` 正则按开关停用，不是直接删。** 清单写"删除"。但 shadow 期模型尚未稳定提交 confirm claim，此刻删掉，"就是陈佩珊"这类明确确认将无人接管，直接复活 badcase g4ytra23（booking 连拒 5 次、重复索名 4 遍）。做法：`evaluateBookingNameGate` 新增 `attestedByClaim` 与 `allowLegacyConfirmRegex`（enforce 下传 false）。2026-08-13 二轮评审进一步收紧：`attestedByClaim` 只认 `operation=confirm` / `context_confirmation` 的确认级 accepted claim，且调用方仅在 enforce 传入；statement claim、session 基线与 shadow 均不借此短路负向证据。物理删除随 D5 在 P2 与三个确认 producer、四份分叉肯定词表一起做——它们本就是同一批要退役的东西。

⑦ **shadow 下 accepted claim 补位回灌。** B1/B2 已把裸字段降级为 deprecated，模型可只提交 claim；若 shadow 不认公证结果，claims-only 输入仍会被判缺并重复追问。现将带 `acceptedClaimId` 的 accepted claim 值补入 `knownFieldMap` 空位，且只补不覆盖、不删除；无 claimId 的 session 基线不走此路。enforce 下随后的 E1 账本重写仍是唯一权威取值源。这是 P0「零行为变化」的已声明例外，接住已发布的工具契约而不扩张 statement claim 的权限。

#### 已落地代码清单（PR #1000）

| 文件 | 改动 |
|---|---|
| `resolution/evidence/notary.ts` | **新增**——公证三问 + 回声 + 短引文门 |
| `resolution/evidence/engine.ts` | 裁决链换血：删产者信任表，冲突改道转确认，裸值同值判 superseded |
| `resolution/evidence/claim.types.ts` | 删三语义拒因，加 `quote_too_short` / `quote_echoes_agent_message` |
| `resolution/evidence/policies.ts` | 删 `validateClaimValueAgainstQuote`，加 `MIN_QUOTE_CONTEXT_CHARS` |
| `resolution/evidence/profile.ts` | `conflicted` → `needs_confirmation` 状态 + `pickNeedsConfirmationValues` |
| `resolution/evidence/normalize.ts` | 形状门接入 A5 函数族（占位号 / 纯数字姓名 / 称谓后缀） |
| `resolution/evidence/snapshot.ts` | `confirmedFields` + `BOOKING_CRITICAL_FIELDS` |
| `resolution/evidence/identity-gates.ts` | 姓名闸门 `attestedByClaim` / `allowLegacyConfirmRegex` |
| `resolution/evidence/producers/name-confirmation.ts` | `就是X` 识别改可关 |
| `resolution/candidate/types.ts` | A1 摘 `rule`；`CandidatePrefillHints` 推广全字段 |
| `resolution/candidate/collected-fields.ts` | A2 产物改标 `rule` |
| `agent/generator/preparation-utils/tool-context.builder.ts` | 弱来源 hint 从性别推广到九字段 |
| `agent/generator/context/sections/turn-hints.section.ts` | A4 提示便签口径 + 出处 |
| `memory/formatters/fact-lines.formatter.ts` | 出处渲染 + 截断参数 |
| `tools/duliday-interview-precheck.tool.ts` | B1/B2 描述、C6 delta、D1、E1、A3 消费 |
| `tools/duliday-interview-booking.tool.ts` | D3 报名级终审、E2 作证放行、快照提前载入 |
| `observability/observer.interface.ts` | `coverageDelta` / `echoDetections` |
| 测试 | 新增 `*.authority.spec.ts` ×2；改写 `policies.spec` 为三问矩阵；`engine`/`profile`/`collected-fields`/`turn-hints` 等按新教义更新 |

全量 `pnpm run ci:check` 通过（6990 passed / 6 skipped）。

### 2. 迁移三阶段（全程 shadow 保护）

| 阶段 | 内容 | 切换判据 | 状态 |
|---|---|---|---|
| **P0 影子双跑**（零行为变化，声明例外） | 三问裁决全量计算、判例落 `fact_adjudication`；C4 回声只计数（`echoDetections`）；C6 coverage delta 开始记。声明例外：A3/A4 hints 直上、偏离④ `needsConfirmationFields` 回传、P0-8 手机号门收紧、偏离⑦ claim 回灌补位 | 新旧 diff 可解释、无未知形态 | ☑ 代码就绪（开关默认 shadow） |
| **P1 权力切换**（开关分级放量） | C1/C2/C3/C5 + B1/B2 + D1/D3 + E1/E2，全部挂在既有 `CANDIDATE_FACT_ADJUDICATION_MODE=enforce` 上 | §3 四个结构量达标 + 下方「切换前必验」两条 | ☐ 待判据 |
| **P2 拆机** | D5 + E3 + rule-track 影子退休 | coverage delta ≤ 噪音水平持续两周 | ☐ 待数据 |

**切换前必验（P1 的额外闸口，均属死锁风险，勿跳）**：

1. **模型能不能稳定产 `operation=confirm` claim**。D3 让年龄在 enforce 下只认候选人明确表态，E2 让姓名解锁只认公证过的引文——两条都以"模型照工具描述提交确认 claim"为前提。shadow 期先从判例库统计 confirm claim 的出现率；出现率为 0 就直接切，会把年龄字段变成新的确认死锁（身份确认死锁家族的第 4 变体）。
2. **enforce 下 E1 的取值来源已经通了**。判缺读账本意味着裸字段不再回灌，账本里没有的值一律算缺。切换前确认 `model_` 通道 accepted 量已成主导（判据②），否则一切换全员卡 collect_fields。

### 3. enforce 判据（换血后）与观测口径

| # | 结构量 | 目标 |
|---|---|---|
| ① | 确定性开放语言裁决量/天（宪法 §7 第 5 指标） | → 0 |
| ② | 作证通道占比（带 quote 的 accepted / 全部 accepted） | 68:633 倒转为主导 |
| ③ | needs_confirmation 发问量与一次解决率 | 单会话单字段 ≤1 次复述（打扰上限） |
| ④ | 公证器三问分项精确率（回声误报、短引文误收单独盯） | 抽样达标，超阈调参 |

**配套（观测侧）**：
- ☑ 定时任务 `fact-adjudication-shadow-daily/SKILL.md` 判读口径重写：`no_candidate_evidence`＝"体系战果"的分类**废除**（已被 72.3% 假阳实测证伪，它是最大缺陷池）；判据表换为上四条；附带修正任务文件里已失效的文档路径（`candidate-fact-evidence-adjudication-plan.md` → `candidate-profile-domain.md`）。
- ◐ 中继会话（一会话多人，NEW-7）：观测侧已就位（SKILL.md 的 SQL-E 打标、冲突统计先剔中继）；「distinct 手机号≥3 → 转人工」是产品裁定项，按原议独立处置、不阻断主链，本次未做。

### 4. 风险对账（每个旧防线都有接盘者）

| 威胁 | 接盘者 | 强弱 |
|---|---|---|
| 模型编造值 | 公证第一问（编不出真实存在的引文） | **更强**（shadow 实证：真编造全被引文检查抓获） |
| 昵称当真名 | 打招呼语负向出处（保留）＋ D3 报名级确认 | 等强，死锁灭绝 |
| 截图第三方信息 | 传输来源标记剔除（PR #944/#1000 已有） | 不变 |
| 指代错误（"我姐今年24"） | D3 确认流终审 | 旧系统同输入照样中招（`parseAge` 的 `今年(\d{2})` 分支同样命中）且无兜底——新错误集是旧错误集的子集 |
| 覆盖率下降（模型漏报） | C6 delta 仪表 + A4 hints 提示 | 可测、可回退 |
| 快环裁定（不加实时 LLM） | 全程零新增 LLM 调用（模型本来就在回合里） | 守恒 |

### 5. 明确不动清单

岗位侧解析族（job-policy-parser / supplement-label-classifier / schedule-semantic / hard-requirements）、出站守卫 28 规则、critical-turn-guard、37 个工具闸门、红线词表、`normalize*ToId`、身份翻转闸、同题限问熔断、图片描述不作证、`invalid_value_shape` / `quote_not_found` / `stale_after_correction` 三拒因。

### 6. 与收资统一立项（领土 2）的会师点

- 收资共享域的"判缺"消费形态直接对接 E1 读账本——两项目在 I1 上合流；
- labelId 二期（海绵结构化标签契约）落地后，字段身份由构造消灭，公证第三问的归一化比对面随之收窄；
- field-normalize 与 resolution 同名函数双栈（`normalizeGenderValue` ×2、`inferIdentityFromAge` 藏于 precheck）在该立项内收敛，本改造不并行动它。

### 7. 工作约定

- 仓库多会话并发：commit 一律 pathspec 限定本改造文件；`src/resolution/brand/*` 等他人在途改动勿碰。
- 跑测试：`nvm use 22.16.0`，`pnpm run test -- <spec> --watchman=false`；收尾 `pnpm run ci:check`。
- 生产形态 fixture 纪律（PR #1000 遗产）：一切新 spec 必须喂带时间后缀 / debounce 拼接 / `[图片消息]` 占位 / 引用块的生产形态文本，不许只喂干净文本。
- 新增对开放语言的正则分支＝违宪（P11 冻结令），review 直接打回。

---

# 附录 C（收编 2026-08-17）：0817 执行清单底账

> 原 execution-checklist-20260817.md 全文收编；任务 A 已完成并评审通过，其余散点已撤编入状态机。

## 执行清单 2026-08-17（交接给执行 Agent）

> **2026-08-17 终版裁定（化零为整）**：任务 A（简历 v4）已由 GPT 完成；
> **B/B2/B3/C/B4 全部撤编，不再单独执行**——统一整合进「收资表单状态机」
> （label-driven-collection-refactor.md §2.8，采信专项余项→状态机部件的映射表在彼处），
> 随统一契约落地的重启批一次实施。R1 独立 chip 已撤销。
> 以下任务描述保留作历史底稿与状态机实施时的细节参考，**不作为独立派工依据**。
>
> 背景与完整设计见三份权威文档：
> `docs/todo/resume-tool-overhaul.md`（简历工具 v4，已实施）、
> `docs/todo/confidence-admission-review.md`（采信专项诊断档案）、
> `docs/todo/label-driven-collection-refactor.md`（**主蓝图**：标签制+表单状态机）。

### 0. 全局纪律（动手前必读）

1. **Node 版本**：shell 默认 node 可能是 16，先 `nvm use 22.16.0`。
2. **跑测试**：`pnpm run test <spec路径> --watchman=false`——**不要**在 pnpm 后加 `--`
   （字面 `--` 会原样传给 Jest 使 watchman 参数失效）；不带 watchman 参数会静默 0 测试。
3. **并发会话**：本工作树有多个 AI 会话并发改码，当前 ~79 个未提交改动文件**大多不是你的**。
   - commit **必须用 pathspec 限定自己创建/修改的文件**，严禁 `git add -A`；
   - 发现 stash 或他人改动**勿动**；
   - 特别红线：`src/tools/duliday/precheck/checklist.util.ts`、
     `src/tools/duliday-interview-precheck.tool.ts`、
     `src/tools/duliday/booking/interview-booking-customer-label.builder.ts`
     压着他人未提交成果（9-1 归一层），任务 A/B 均不需要碰它们。
4. **分支**：默认分支 develop（没有 main）；新工作分支自 develop 拉。pre-push 钩子跑全量
   CI 需 5+ 分钟，可自跑 `pnpm run ci:check` 后 `--no-verify`。
5. **测试资产禁真实 PII**：候选人 fixtures 一律用测试假身份**兮兮 / 18271421690**；
   生产真实姓名/手机号（如"杨美英/152…"）不得进仓库。
6. 代码规范：严格 TS 禁 any；禁 console.log（用 NestJS Logger）；DI 不手动 new；
   文件 kebab-case。提交信息 Conventional Commits。
7. 完成每项任务后：更新对应设计文档的状态行（一行即可），并在任务分支跑通
   `pnpm run lint:check && pnpm run typecheck && pnpm run test`。
8. **动任何文件前先 `git status --short <file>`**：若该文件已有非本任务产生的改动，
   停手上报，不得混改混提。

---

### 任务 A：简历工具 v4 重写（独立，可立即开工）

权威 spec：`docs/todo/resume-tool-overhaul.md`（v4 全文照做）。要点浓缩：

**架构**：`read-resume-attachment.tool.ts` 只留 I/O；新增
`src/tools/resume/{docx-text,resume-text,resume-extract,scanned-resume}.util.ts`；
`src/resolution/candidate/resume-fields.ts`（公证+兜底，纯函数零 LLM）。

**三层技术路线**：
- 主轨：`ModelRole.Extract` structured output，文本 → `{field, value, sourceText}[]`
  （LLM 调用留 tools 层，resolution 层零 LLM——eslint 分层规则强制）；
  模型只通过 Dashboard `extractModelId` / `AGENT_EXTRACT_MODEL` 共享角色路由选择，
  DeepSeek JSON Schema 兼容行为与等条件回放结论见
  `docs/knowledge-base/01-多模型三层容错架构.md`；业务 util 禁止写 `modelId`；
- 公证（resolution 纯函数）：①sourceText 必须是规整后原文的字面子串，失败丢整字段；
  value 须可由 sourceText 确定性推出；②形态校验复用既有解析器
  （`parsePhone`+占位剔除 / `isLikelyRealChineseName` / `normalizeEducationToId`）；
  ③phone 归属：sourceText ±15 字含「紧急联系人/推荐人/HR/店长」剔除，多号全列
  `phoneCandidates` 主值降 medium；④模型自报置信一概不采信，置信度由代码按
  「字段×证据形态」授予（label 锚定 high / 自由位置 medium / 简历 phone 封顶 medium）；
- 兜底轨（Extract 失败时）：姓名三级（`姓名：`标签 → 文件名剥
  「(个人|求职)?简历|resume|cv」后 2~4 汉字严格真名校验 → phone/「N岁」锚点邻行）+
  `parseHighestEducation`（education.ts 新增：按既有 EDUCATION_KEYWORDS 表序取最高，
  **不带**聊天语境的学校守卫——简历必提学校，现 parseEducation 的守卫会全拒）。

**字段集**：name/phone/gender/age/education/email + expectedCity/jobIntent/
expectedSalary/workYears/relevantExperience（餐饮相关经历摘录 ≤120 字）。

**格式分发（四容器一漏斗）**：`%PDF-`→pdf-parse v2（文字层过薄判据 <60 字符/页 即转
vision，防混合 PDF 静默漏正文）；`PK\x03\x04`→docx（**新依赖 fflate**，
`word/document.xml` + `header*.xml`/`footer*.xml`）；`FF D8 FF`/`89 50 4E 47`
（JPEG/PNG）→**长图简历支线**：Vision 逐行转写（超长图切片+重叠拼接，阈值按 spike ⑦）
→ 同一条主轨，置信度按 vision_transcription 封顶 medium；与被动图片描述链路分工
（那边自动环境摘要、这边按需深读带公证）；OLE `\xD0\xCF\x11\xE0`→新 errorType
`read_resume.unsupported_format` 引导转 PDF/拍照；`not_pdf` 语义收窄为"都不是"。

**闸门**：删除 `resumeRequired !== true` 拒读分支及 `READ_RESUME_NOT_REQUIRED`
错误类型（确认无外部引用后）；上传行为不归本工具管。

**回档（v3 裁定，署名如实）**：解析成功产 `FinalizedVisualFactSheet(kind='resume')`
经 `context.ledger.recordVisualFacts(sheet, {messageId})` 入账（fields 只填白名单键，
ownership 按 kind 规则补齐）；**必做承重件**：把简历摘要回写进该条 `[文件消息]` 的
chat_messages content（复用 image-description 一族 updateMessageContent/
appendResumeAttachmentLine 机制及其重试）——身份字段唯一的跨轮通道是会话窗口，
ledger sheet 的 rawDescription 抽取器不读（session-extraction.prompt.ts:229 实证）。
**严禁**把简历字段以 `source:'system'` 写 sessionFacts（虚假署名，已裁定否决）。
messageId 定位不到→降级为只出 output 不产 sheet 不回写（warn），禁合成 id。

**扫描件兜底（P2）**：EMPTY_TEXT 分支 → `getScreenshot({first:2, desiredWidth:1200,
imageBuffer:true})` → `ModelRole.Vision` 逐行转写 → 进同一条主轨；仅 text 为空触发，
失败回落现有 errorType，output 标 `sourceKind:'vision_transcription'`。
依赖注入：`buildReadResumeAttachmentTool(attachments, deps:{llm})`，registry 构造器
注入 LlmExecutorService。

**text 裁剪**：裁「主修课程/自我评价/获奖/证书」超长段；maxChars 默认 6000→3000；
档案块前置作为兜底轨/回写摘要的规整小函数（主轨对乱序免疫，不需要它）。

**先关 7 个 spike 再写码**（resume-tool-overhaul.md §10 + §3.5）：
①getScreenshot 本机 headless 渲染扫描件可行性；②upload_resume 规则事实携带
messageId（或 URL 回查）可靠性；③LlmExecutorService 在 ToolsModule 的 DI 可达性；
④fflate 对真实 docx 的抽取质量；⑤Extract 模型对简历文本的结构化质量与 sourceText
逐字忠实度（公证通过率为主轨可用性判据，不达标走兜底轨降级开关）；
⑥消息回写通道：查 save_image_description 的描述如何落 chat_messages content，
复用同一 biz/message 底层通道（禁 import channels，必要时小幅下沉）；
⑦【最高优先】图片简历道两问：简历图 URL 是否确实流入 upload_resume（须实证非假设）+
Vision 超长图转写质量与切片阈值（拿生产真实长图测）。
——优先级依据（2026-08-17 生产实测，30 天 n=18）：容器分布为图片 61% ＞ PDF 28% ＞
docx 11% ＞ 老 .doc 0，**图片是第一大简历容器**；且识别为简历的 11 张图仅 5 张有
结构化 sheet，现有覆盖仅半。图片道是本任务的主战场，不是附属支线。

**实现蓝图**（类型/函数签名/execute 流程/实现顺序）：resume-tool-overhaul.md **§3.5**，
照写；纯函数地基（resume-fields.ts + parseHighestEducation）先行并单测全覆盖，
再往上盖格式层→主轨→工具重组→sheet/回写。

**测试与验收**：假身份 fixtures（PDF/docx 各一，含一份模拟乱序 PDF）；公证规则全分支
单测（回查失败→重锚→丢字段三段路径：唯一锚定采纳/多锚点拒/零锚点拒、形态校验/
占位剔除/置信授予/phone 归属/兜底切换）；
mock Extract 喂**编造字段样本**验证公证拦截；验收=两条实证 case 形态重放：
「杨美英式」单页乱序 PDF 必须抽出 name 且带出处、docx 必须成功返回文本
（fixtures 用假身份复刻形态，不用真实数据）。

---

### 任务 B：R1 confirm 作证通道修复（独立，可与 A 并行）

背景：`confidence-admission-review.md` §4.2 R1/R2 与 §4.3。已定谳缺陷：
precheck（duliday-interview-precheck.tool.ts:150、:358）与 booking（:607）的工具描述
指示模型「候选人对确认问句作答用 operation=confirm，另附 agentQuestionQuote」，但
`CandidateClaimInputSchema`（src/resolution/evidence/claim.types.ts:229-241）**没有
agentQuestionQuote 键**（zod 静默丢弃），`produceModelClaims`
（src/resolution/evidence/producers/model-claims.ts:25-35）把 interpretation 写死
`'direct'`。导致 notary 两条 context_confirmation 豁免（notary.ts:54-57 出处基准换
问句、:96-102 短语境豁免）是生产不可达死代码；候选人裸答「有/是的」的确认对
age/education/healthCert/height/weight/householdProvince/isStudent 七字段结构性失效
（minContext=3 判 quote_too_short，连同问句引则 quote_not_found，双重绑定）。
生产 14 天实测 confirm claim 出现率 0/359。

**修法**（改动限 `src/resolution/evidence/` + 测试）：
1. `CandidateClaimInputSchema` 加可选 `agentQuestionQuote`（带 describe，长度上限对齐
   quote 的 200）；
2. `produceModelClaims` 透传：operation=confirm 且 agentQuestionQuote 非空时
   interpretation='context_confirmation'、evidence 带 agentQuestionQuote；
3. 补 `operation:'confirm'` 全链路测试（当前全仓零覆盖）：裸答「有」+问句 → notary
   以问句为出处基准、短语境豁免生效 → accepted；无问句的 confirm 维持现行为；
   问句伪造（问句不在 assistant 消息中）的负例——注意 notary 现有验证边界，
   如问句真伪当前不验，测试如实固化现状并注释留痕，勿自行扩权；
4. shadow/enforce 双模式行为一致性（裁决本体不分模式，消费才分）。

**不要**顺手改 precheck/booking 工具文件（描述已写对，且压着他人未提交改动）。
完成后更新 confidence-admission-review.md 的 R1/R2 行与
candidate-fact-authority-refactor.md 的 D2 状态行（后者标注「schema 通道已实修」）。
注：R2（裸答双重绑定）随本任务的豁免通道激活一并消解，无需单独任务。

---

### 任务 B2：sessionFacts 上下文确认升级通道（独立，可与 A/B 并行）

采信专项 P0-3（confidence-admission-review.md §5 提案）。病灶（铁证 A，chat 6a826e8a
7 分钟同题三轮）：sessionFacts 的 medium→high 升级判据要求「quote 能确定性复算出值」
（session.service.ts `applyExtractionProvenance` → policies.ts
`extractionQuoteSupportsCurrentValue`:104-127）——候选人答「可以/对的」复算不出任何值，
**上下文确认在数学上不可能升级置信度**，prefill hint 永驻、逐轮重挂「（如有误请改）」。

**修法**（memory 域 + policies）：为确认场景增设升级判据分支——满足全部条件才升级：
① 候选人本轮消息为肯定应答形态（复用 resolution/signal/dialogue 既有肯定词表，
不新造词表——词表收拢纪律）；② 紧邻的上一条 assistant 消息含该字段的复述
（「字段名：值」或「值…对吧/可以吗」形态，值与当前 medium 值一致）；③ 升级后
source 记 'candidate_quote'（候选人确认即亲证）、evidence 记「确认问答：<问句摘录>
+<应答>」——**署名如实，禁止记成 system**。phone 维持永久锁 medium 的现行纪律不变。
出生日期/年龄等推导值不走此通道（只有被完整复述过的值才可确认升级）。

**测试**：确认升级正例（复述+「对的」→high）；负例：无复述的裸「对的」不升级、
复述值与 medium 值不一致不升级、隔了多轮的确认不升级、phone 不升级；
铁证 A 形态重放（假身份）：「没有健康证」→登记确认→「可以」后健康证 hint 不再重挂。
动 session.service.ts 前按 §0-8 查占用。

---

### 任务 B3：R10 假阳复现定位（独立侦查任务，可并行）

采信专项 R10：候选人**逐字写过**的 quote（「姓名（真名）：王五」——化名，原文为候选人真实姓名，chat 6a827105
turn 276571，原文实证在 chat_messages 2026-08-17 02:37:56 那条）仍被 notary 拒
`no_candidate_evidence`——72.3% 假阳家族复发，且是确认循环的点火器。

**做法**：离线复现——用该 chat 的消息序列（从生产 chat_messages 拉原文，**测试代码里
换假身份复刻形态**）构造输入喂 `runCandidateFactAdjudication`
（src/resolution/evidence/adjudicate.ts），定位 quote 逐字在场却回查失败的环节。
候选嫌疑（逐一排除）：①`extractCandidateTextsFromCorpus` 的语料窗口/合并截断；
②corpusBlocks 缺失时 fallback 路径的语料差异（precheck:959-961）；③NFKC/空白折叠
不对称；④消息时间戳后缀剥离时序（历史同族：v10.13.0 被 `[消息发送时间：…]` 后缀
击穿）。产出：根因诊断写进 confidence-admission-review.md R10 行；若修复 ≤30 行且
限 resolution/evidence 域则一并修+测试，否则只交诊断不动码。

---

### 任务 B4（低优先，可选）：复问→流失因果对照

采信专项 B 线残项：答后复问会话（45 例口径见 confidence-admission-review.md §2.5）
与同漏斗深度对照组的完单率差异。纯生产只读 SQL（遵守：每条
`SET LOCAL statement_timeout` + 严格串行 + message_processing_records 用 received_at）。
产出数字写进专项文档 §2.5。不阻塞任何其他任务，闲时做。

---

### 任务 C：R9 shadow 措辞去指令化（**前置条件：9-1 改动已提交后才可动**）

precheck shadow 回执 note 现文案含行动指令（"不要当已确认资料复述或提交；向候选人
确认后重新提交"），模型服从 → shadow 期产生确认循环，违反"只观测零行为变化"契约
（confidence-admission-review.md R9，铁证 C ②）。修法：shadow 模式下回执不下达任何
行动指令——rejectedClaims 降级为纯观测数据或不下发给模型；enforce 文案不变。
改动点在 duliday-interview-precheck.tool.ts 的 factAdjudication note 组装处。
**该文件当前压着 9-1 未提交改动，必须等其入库后再动**；动前 `git status` 确认干净。

---

### D. 明确禁止执行的事项（防好心帮倒忙）

1. **R12 语义桥**（有无本地健康证→健康证状态机互填）：**已撤销**，勿实现——
   根因由海绵标签制接口在源头消灭。
2. **R11 确认循环熔断、enforce 切换（P1）**：与标签制改造强耦合（同改收资核），
   已裁定并入标签制重启批，勿单独实现。
3. **标签制收资改造**：挂起等海绵统一契约接口，勿动 precheck 收资核、勿写
   batchQueryInterviewLabels 客户端。
4. **9-1 归一层三文件**（§0-3 红线清单）：勿改勿提交。
5. 勿 drop 任何 stash；勿动 `.env.*`；勿跑写生产的脚本。
6. 简历字段勿以 `source:'system'` 入 sessionFacts（虚假署名，用户明确否决）。

### E. 执行顺序建议

1. A / B / B2 / B3 文件集互不相交，可各开自 develop 的分支并行
   （A：tools/resume + resolution/candidate + registry；B：resolution/evidence schema 侧；
   B2：memory/session.service + policies；B3：只读复现 + 至多 evidence 域小修）；
2. A 先跑 5 个 spike 并把结论记进 resume-tool-overhaul.md §10，再动码；
3. B 完成后可顺手核对 chip task_e46c8322（同一事项，避免重复领工）；
   B 与 B3 同域（resolution/evidence），若同人执行建议 B → B3 顺序做避免自相冲突；
4. C 等 9-1 提交，完成 A/B 后再看时机；B4 闲时做；
5. 一切合并目标 develop，发版由用户统一操作，**不要自行触发 release 流程**。

### F. 采信专项任务映射总览（对照 confidence-admission-review.md）

| 专项条目 | 本清单归属 |
|---|---|
| R1 confirm 作证通道 | 任务 B（立即） |
| R2 裸答双重绑定 | 随 B 消解 |
| P0-3 sessionFacts 确认升级 | 任务 B2（立即） |
| R10 假阳复现 | 任务 B3（立即，侦查优先） |
| R9 shadow 措辞 | 任务 C（等 9-1 提交） |
| B 线因果对照残项 | 任务 B4（低优先） |
| R12 语义桥 | 已撤销，禁做（D-1） |
| R11 熔断 / R3 / R6 / R7 / enforce 切换 | 并入标签制重启批，禁单独做（D-2） |
| P0-2 健康证族确认识别 | 并入标签制重启批（健康证标签适配器承接），禁单独做 |

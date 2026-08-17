# 标签制收资改造（label-driven collection）终态设计

> 立项：2026-08-17。**状态：挂起，等统一契约接口落地后按契约定稿实施。**
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

**提交报名** `POST /ai/api/workorder/entryUser`：
必填 `jobId + name + phone + age(10-100 int) + gender(^男|女$)`，可选 `interviewTime`；
`labelList[]`：`labelId` + (`value`：TEXT/FILE 的值) | (`options[]`：optionCode，单选一多选多)。
labelTitle/optionLabel 可不传（服务端按 id/code 回读配置）。
返回：`notice`（成功文案）/ `errorList[{field,msg}]`（**字段级校验错误**）/
`workOrder{workOrderId, signUpTime, 品牌/公司/项目/岗位, 状态文案, 薪资}`。

## 2. 结构性判定

1. **身份核收缩**：一等参数只剩身份四件套+jobId。学历/健康证/身高体重/身份/户籍
   从契约字段降级为"岗位配了标签才收"。固定词表 FIELD_ORDER 的大部分席位随之退役。
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
   写入适配器，吸收原 P0-2）；
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

### 实施定位

设计现在定稿（本节）；实施随统一契约落地的重启批一次完成（槽位宇宙=契约字段集）。
存储形态（Redis 实体+审计事件 vs 表）留实施期定。聊天记录降级为审计日志，
不再是运行时的每轮重推来源。**存续资产**：全部解析器/公证内核/身份闸门/健康证
policy/肯定词表唯一居所——挪位为写入守卫与迁移判据，代码复用。

## 3. cake 侧目标架构

```
岗位聚焦（job_list / focusJob 确立）
  → sponge client 新方法 batchQueryInterviewLabels(jobIds)（随岗位召回批量拉，缓存 per jobId）
  → precheck 收资模型：
      身份核（name/phone/age/gender）——沿用既有闸门（姓名真名闸/手机号出处闸/年龄边界）
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

1''. **统一契约核对清单**（新接口 spec 到手时逐项验收；缺项趁定稿前提给后端）：
   1. 身份核与标签**同构**返回：每字段带稳定键、fieldType、required 标志——
      cake 不再硬编码"哪些字段存在"；
   2. **年龄边界结构化**（岗位 min/max 进契约）——替代 cake 从岗位文本解析年龄要求；
   3. **性别要求结构化**（acceptedOptions：男/女/不限）——岗位性别要求可对候选人明说，
      结构化后筛选与话术同源；
   4. interviewTime 的窗口/等通知语义是否进契约（不进则 precheck 窗口逻辑照旧）；
   5. 筛选语义定死：acceptedOptions 白名单为主、rejectedOptions 显式负枚举为辅；
      TEXT 字段的格式/数值范围校验若有也结构化（如身高 cm 值域）；
   6. labelInstructions 的语义（展示给候选人 vs 给 AI 的收集指引）；
   7. 岗位配置变更的缓存失效信号（updatedAt/版本号）；
   8. 隐私字段口径：身份证号类是否可能出现、cake 拒答边界（对齐视觉管线裁定）。
2. 旧报名表/supplementAnswers 通道的退役时点：与滞后岗位补配进度挂钩。
3. FILE 标签的 value 形态确认（URL？与现简历附件 URL 域名关系）；当前生产 0 使用。
4. 服务端是否按标签配置校验提交（决定 acceptedOptions 本地拦截失误时 errorList
   能否兜底；无标签岗位服务端是否完全不校验补充项——决定 1'(b) 的真空面积）。
5. interviewTime 的窗口校验是否仍走岗位既有数据（precheck 窗口逻辑不动的前提）。
6. 身份证号类隐私标签的拒答口径（对齐视觉管线「不设证件号 key」裁定）。
【已关闭】生产环境上线：两接口均已在生产，gateway.duliday.com/sponge 实测可用。

## 7. 与在途工作的关系

- confidence-admission-review：R12 语义桥**已撤销**（不要过渡期）；R1（confirm 作证通道）、
  R9（shadow 措辞）、R11（确认熔断）仍有效——身份核与选项匹配照样需要确认语义与熔断；
  R2/R10 的公证问题在标签制下面积缩小但身份核仍在。
- resume-tool-overhaul：不变，FILE 标签是它的天然消费端。
- 9-1 归一层：已完稿的代码随发版照发（治现网旧岗位），标签制铺开后按 §4 退役。

# BookingCollectionForm · 实施蓝图（v3-lean）

> **v3-lean（2026-08-18）**：用户裁定"设计太重"成立，v2 瘦身重写。**砍掉的每一项都回查过
> 它当初防的 badcase——防线一条没少，少的是仪式、副本和没有数据支撑的子系统。**
> 仍然有效的既有裁定：身份核标签化（SlotKey=labelId 单形态；身份槽按契约 systemField
> 语义标记识别——**0818 裁定代码禁止硬编码外系统 labelId**，诉求 #3 已重写）；**收资判决单源=标签接口**（0818 与后端约定，岗位详情接口回归展示域）；
> 标签**零缓存实时查询**；D1 phone 作人键；漏斗优先；披露红线唯一不降级；
> FILE 标签 value 生产者=简历工具 v4；required 无标志期按「返回即须收」。
>
> **时序闸**：判决单源化的契约 v2 spec 后端 **0819 给到**——§8 实现顺序 1-4 步纯地基
> 不等契约；契约消费面（DTO/fetchCollectionContract/booking payload 定稿）等 spec 到货，
> 先对照 `label-contract-change-requests.md` 逐条核对，不一致处回用户裁定。

> 设计权威：`label-driven-collection-refactor.md`（总纲）§2.8；实施形态以本文 v3-lean 为准
> （确认态砍除、verdict 现算、审计复用既有事件表，总纲 §2.8 细节以此为准）。

## 0. 瘦身裁定清单（0818，用户挑战成立后逐项定案）

| 砍/简化 | 替代 | 防线回查 |
|---|---|---|
| 事件溯源全家桶（7 事件枚举+applyEvent 归约器+collection_form_events 新表） | 快照 + 4 个写路径纯函数；审计落**既有 agent_execution_events**（同 traceId 可 join，零新表零迁移） | 观测落库裁定照样满足 |
| 乐观锁 version+CAS | 消息处理 90s 租约锁已保证同会话单写者，表单只在回合内写 | 防的并发不存在 |
| 每槽位 constraint 契约快照+diff 失效 | 零缓存每轮拉最新契约现判；运营中途改配置由提交时 errorList 兜底（漏斗优先） | 审计"按什么判的"记日志一行即可 |
| 多人协议四条硬规则子系统 | v1 一条规则：检测疑似多人（新姓名+新手机号对）→ escalatedReason 转人工；**phone 人键保留** | 中介场景生产频率无数据，等数据再自动化（Spike S2 只读量化） |
| 受阻 8 形态代码枚举+周报聚合通道 | 映射不出→fieldType 通用道收集 + configDebts 记一行账（自由文本 note）；**errorList 失配转人工是唯一保留特判**；8 形态降级为运营沟通的分析语言（见总纲），代码不建枚举 | 漏斗优先原则不变；卡片披露保留 |
| pending_confirm/confirmed 两态 | **针对性问答即采信**：对着"你多大年龄"答"26"，这句话就是本人终审。复述只在**提交前发一次**，"不对"→改格子 | 听错/抽错由公证 sourceText 回查在写入时防；疑问句守卫在公证里；"对的"填不进格子靠 lastRecap 落账 |
| verdict 落盘 | `verdictOf()` 纯函数现算；表上只存两个不可推导事实：workOrderId / escalatedReason | 消灭"槽位与总评分裂"这一整类同步 bug |

**枚举封闭集纪律**：SlotState 三值、Verdict 五值是地板——每个值对应一种互不相同的
Agent 行为。加新值必须先回答"哪个既有值的处理逻辑覆盖不了它"，答不上来不许加。

## 1. 代码树（~10 文件，零新表零迁移）

```
src/
├── sponge/
│   ├── collection-contract.types.ts        契约 DTO（0819 spec 到货定稿）
│   └── sponge.service.ts                   +fetchCollectionContract(jobIds)：零缓存实时查询
│
├── resolution/collection/                   ★新子域：纯逻辑（零 LLM 零 IO）
│   ├── form.types.ts                       类型全集（见 §2）
│   ├── form-writes.ts                      4 个写路径纯函数 + verdictOf（见 §3；公证内联）
│   ├── option-matching.ts                  自然语言 → optionCode：第一档仅契约选项字面
│   │                                         精确匹配（Map 级，含糊即 miss→模型作证，
│   │                                         产物仍过公证；词表禁判语义，见 §11 红线）
│   ├── adapters/
│   │   ├── adapter.registry.ts             语义识别为主（标题语义族+fieldType）；labelId 锚点
│   │   │                                     一律走环境级配置非代码字面量（学生族/学信网族/
│   │   │                                     专业族生产实测 12 id 分裂）；未知走 fieldType 通用道
│   │   ├── identity-core.adapter.ts        身份四槽（按契约 systemField 识别，禁硬编码 ID）：
│   │   │                                     包装真名闸/手机号出处闸/年龄边界
│   │   │                                     （detectAgeBoundary 弹性保留，min/max 判据改读契约）
│   │   ├── education.adapter.ts            normalizeEducationToId × acceptedOptions 成员判定
│   │   └── health-certificate.adapter.ts   包装 resolveLocalHealthCertificateEligibility
│   │                                         （三确定态→optionCode 1/2/3，两不定态→留空追问）
│   └── disclosure-policy.ts                披露分级：契约字段优先→属性族兜底注册表→未知禁明说；
│                                             禁说词表与守卫红线同一常量
│
├── memory/
│   ├── stores/collection-form.store.ts     Redis 快照 `collection-form:{corpId}:{userId}:{candidateRef}:{jobId}`
│   │                                         回合租约内单写者，整实体读写，无 CAS
│   └── services/collection-form.service.ts loadOrCreate / persist / phone 到达 rebind
│
├── tools/duliday/collection/
│   ├── recap-renderer.ts                   提交前复述：filled 槽位 → 文案 + lastRecap 落账
│   └── rejection-renderer.ts               disqualified → 按披露级别渲染（禁明说档走
│                                             noMatchScript 换岗承接 + 因果隔离）
├── tools/duliday-interview-precheck.tool.ts  ★收资核重写（见 §5）
├── tools/duliday-interview-booking.tool.ts   ★提交切 entryUser
└── notification/renderers/booking-card.renderer.ts  +「收资配置备注」段（读 configDebts）
```

依赖方向（violate 即 eslint 拦）：tools → memory/resolution/sponge；memory → resolution；
resolution/collection → resolution 兄弟域 + sponge 类型，**不得** import memory/tools/llm。
LLM 只在 tools 层（选项含糊时模型作证选 optionCode，产物过公证）。

## 2. 核心类型（form.types.ts）

```ts
// 身份槽位识别：读契约语义标记 systemField（诉求 #3 重写版），代码禁止硬编码 labelId——
// 769/770/687/771 是生产实测值，只出现在诉求单作核对基准，不出现在代码里。
// 契约标记缺席期的兜底：环境级配置映射 + 每轮拿实时契约核验 labelTitle，核验不过
// 告警并降为普通槽位（身份闸门不挂、人键回退 session，漏斗优先不卡报名）。
type IdentityKey = 'name' | 'phone' | 'age' | 'gender';

type SlotState = 'empty' | 'filled' | 'disqualified';        // 封闭集（§0 纪律）

interface FormSlot {
  labelId: number;
  state: SlotState;
  value?: { value: string; optionCodes?: string[];
            sourceText: string;                              // 候选人原话逐字，公证回查锚点
            producer: Producer;                              // 全库唯一词表复用，署名如实
            confidence: 'high' | 'medium' };                 // 代码按证据形态授予，非模型自报
  askCount: number;                                          // ≥2 仍 empty → 表级 escalatedReason
}

interface BookingCollectionForm {
  candidateRef: string;              // phone 标签槽位值归一 11 位（D1）；未知期 'session'，到达即 rebind
  jobId: number;
  slots: Record<number, FormSlot>;
  workOrderId?: number;              // 提交成功的外部事实（不可从槽位推导）
  escalatedReason?: string;          // 转人工触发原因（同槽 2 问不中/疑似多人/errorList 失配）
  lastRecap?: { labelIds: number[] };          // 提交前复述在案——"不对"才能定位改哪格
  configDebts?: { labelId: number; note: string }[];   // 配置债台账，卡片披露直读
}

type Verdict = 'collecting' | 'disqualified' | 'ready' | 'escalated' | 'submitted';  // 封闭集

function verdictOf(form: BookingCollectionForm): Verdict {
  if (form.workOrderId) return 'submitted';
  if (form.escalatedReason) return 'escalated';
  if (anySlot(form, 'disqualified')) return 'disqualified';
  if (anySlot(form, 'empty')) return 'collecting';
  return 'ready';
}
```

不落盘任何可推导状态；表单实体五个业务成员 + 三个可选事实位，零副本。

## 3. 写路径纯函数（form-writes.ts —— 改表的唯一途径）

```ts
// 值写入（公证内联，一次同轮完成）：
//   ①sourceText 逐字回查本轮全文 ②解析器复算仅路由置信（可复算=high，否则 medium），
//     不否决——公证零语义判断（P11：公证器是代价路由器不是真值裁判；实现已如此，
//     与 §11「词表禁判语义」红线同源） ③归属/形态门
//   ④置信按证据形态查表授予 ⑤命中 rejectedOptions → 该槽 disqualified（先筛后收在此发生）
//   身份槽位（按契约 systemField 识别）额外挂真名闸/手机号出处闸/年龄边界（判据读契约 min/max）
proposeValue(form, contract: ContractFieldDef, proposal: RawProposal): BookingCollectionForm

// 提交前复述的结果回写："认" → 放行提交；"改某格" → 该格重开（state=empty, askCount 不清零）
applyRecapResult(form, result: { affirmed: true } | { corrections: number[] }): BookingCollectionForm

// entryUser errorList 回写：按 labelId 定位重开该槽；定位不到 → escalatedReason（唯一必转人工）
applyErrorList(form, errors: { labelId?: number; field: string; msg: string }[]): BookingCollectionForm

markSubmitted(form, workOrderId: number): BookingCollectionForm
```

全部纯函数，单测直测；持久化由 service 包一层。不变量（写成断言测试）：
**棘轮对系统单向、对本人双向**（0819 裁定，对齐总纲 §2.8「显式失效事件才可重开」）——
filled 槽位的合法重开路径只有三条：applyRecapResult 的 corrections / applyErrorList /
**候选人显式改口**（本人明确针对该字段的新自陈，走同一套公证，通过即替换并落审计事件；
askCount 不清零防"改一次刷新一次配额"绕过熔断；含糊提及不算改口——履历/排除语境
不覆盖既有值的既有判例继续适用，判不动归 judge）。系统/模型的重推**任何时候**触碰不到
filled 槽位，**任何路径不得对 filled 槽位重复发问**（反复问病根的类型级根治）。
⚠️ 实现缺口：当前 form-writes 对 filled 槽位提案一律拒收（slotAlreadyFilled），
显式改口分支随契约批补上（步骤 6 接线时一并做，归属+明确性判据复用公证闸）。

## 4. 存储与观测

- **Redis 快照**：整实体 JSON，key `collection-form:{corpId}:{userId}:{candidateRef}:{jobId}`；
  回合租约（90s 心跳续期）保证单写者，无版本锁。列入「丢了算事故」key 清单。
- **审计**：proposeValue 拒收/disqualify、escalated、config_debt、submitted 各落一条
  `agent_execution_events`（既有表，同 traceId 可 join）。零新表、零迁移。
- **配置债披露（用户裁定 0818）**：booking-card.renderer.ts 在报名成功卡片追加
  「收资配置备注」段，直读 form.configDebts 逐条渲染（标签名+labelId+note）；
  无债不加段。运营看到成功报名同时看到这单哪条配置在作妖。周报聚合暂不做——
  configDebts 已落库（audit 事件），数据在，何时聚合是后话。

## 5. precheck/booking 接线（最大改动面）

precheck 收资核：`buildKnownFieldMap + checklist + missingFields` 整体替换为
`collectionFormService.loadOrCreate → 本轮消息经适配器产 proposal → proposeValue* → 快照返回`；
`nextAction` 由 `verdictOf(form)` 唯一派生（collecting=问 empty 槽位 / disqualified=
rejection-renderer / ready=发提交前复述 / escalated=静默转人工 / submitted=停手）；
templateText 由 form 渲染。claim 轨保留为值提案的运输格式之一（R1 schema 补
agentQuestionQuote 随本批实施）。
booking：payload 由 form 生成——顶层仅 jobId + 可选 interviewTime，其余全部由
labelList[{labelId, optionCodes|value}] 承载（身份核即 769/770/687/771 四槽，0818 新版
契约无一等身份参数）→ entryUser → workOrder 落 markSubmitted / errorList 走 applyErrorList。

**收资判决单源（0818 与后端约定）**：
- **展示/判决分离**：岗位详情接口只服务"向候选人介绍岗位"；**收资与筛选判决的唯一
  判据源 = 报名筛选标签接口（batch-query）**——收什么、必不必填、选项筛、值域筛
  （minAge/maxAge 等）全部由该契约承载，precheck 全信契约。
- **判决零第二源**：契约没带的判据 = 该岗没有这道筛。不读岗位数据补筛、不走岗位
  自由文本解析兜底（漏斗优先，多报下游可截）。
- job-policy-parser 岗位侧解析族存活，职责收窄为**展示/话术/面试窗口**；其筛选消费面
  （screening-criteria 硬约束、age.util 岗位判据轨、健康证文本筛）随本批退役。

## 6. 设计决策（全部已定）

- **D1（已确认 0818：phone 作人键）**：candidateRef=phone 归一 11 位（与海绵人键同源）；
  未知期挂 'session' 默认表、到达时 rebind。多人报名 v1 不建自动化协议：检测到疑似
  多人（新姓名+新手机号对）→ escalatedReason 转人工。
- **D2 errorList 映射**：优先契约回传 labelId（契约诉求 #2）；只有展示名时按 labelTitle
  匹配，失配 → escalatedReason，不静默。
- **D4（0818 用户裁定）禁止硬编码外系统 ID**：labelId/optionCode 是海绵数据库主键，
  不是语义。语义锚点（身份核/敏感披露）一律要求契约标记（诉求 #3/#6）；确需 ID 锚点
  的场景（适配器加速表等）走环境级配置 + 每轮实时契约核验 labelTitle，核验不过
  告警+降通用道。测试/生产环境 ID 可能不同是硬约束。
- **D3 复述节流**：全程只在提交前复述一次，覆盖全部 filled 槽位；escalated 话术复用
  转人工既有口径（禁暴露 AI 身份纪律）。

## 7. 同批退役删除（总纲 §4 清单的执行面）

checklist.util 的 FIELD_ORDER 大部/buildKnownFieldMap/missingFields 字面过滤；
classifySupplementLabel 括号黑名单；normalizeSupplementKey+别名表+一行流解析；
customerLabel 拼装主体；快照水位（snapshot-gate）；确认识别器族与四份肯定词表分叉
（肯定词表收拢到 dialogue 唯一居所）；E1/E2 enforce 分支（账本对象已换）；
`allowLegacyConfirmRegex` 并跑；9 个 candidateXxx 裸字段（拆除判据已写在 precheck 注释）。
**删除纪律**：每删一族先 grep 消费面，测试期望同步改，禁留空壳。

## 8. 实现顺序（1-3 步不等契约）

1. form.types + form-writes 纯函数——公证/先筛后收/重开路径单测全覆盖 +
   六事故防线断言（见 §10 验收）；
2. option-matching + 三个适配器 + disclosure-policy（复用既有解析器与红线词表）；
3. recap/rejection renderer（纯文案层，快照测试）；
4. ——**0819 契约检查点**：spec 对照诉求单核对 → collection-contract.types 定稿 →
   覆盖度探针复测——
   **✅ 0820 已过（生产实测 9 岗，探针存档 scratchpad contract-v2-probe*.json）**：
   #1 required ✅（默认 true）；#5 valueSpec ✅ 含 genderRanges 分性别实测（528995）；
   #6 disclosure ✅（籍贯[3] RESTRICTED 实测）；#8 部分落地——**专业[659] 仍 PLAIN，
   披露兜底注册表必须随批交付**+回敬海绵补标；#8.5 无 optionUniverse 但
   rejectedOptions 实测被填（籍贯岗 rejected=并集法发现的 5 省）；**#3 systemField
   未进契约**→身份识别走既定兜底（环境级配置+labelTitle 每轮核验，核验不过告警降
   通用道）；#2 errorList labelId 随 S3 验。0819 案三字段全结构化（本地健康证[13]
   三态/社会身份[1]/具体住址[756]）。529020 返回 0 标签＝**数据问题**（0820 后端
   确认：正常在招岗必有标签，排查中）——**实施规则（0820 用户裁定）：空标签岗=
   数据异常，直接转人工（escalatedReason=空标签数据异常）+ 落告警；禁按「无筛」
   裸放行，也不做兜底续收**（"没带=无此筛"仅适用字段级缺失）。
   覆盖度全量复测列开工首项。#3 systemField/#8 专业补标/#2 errorList labelId 后端
   0820 承诺改，AI 侧兜底路径不变、不阻塞。步骤 5-7 解除阻塞。——
5. sponge 契约客户端（零缓存）+ memory store/service（Redis 快照读写）；
6. precheck/booking 接线重写（最大面）+ booking-card 配置债段；
7. §7 退役删除批 + 全量回归。**范围按 §8.5 覆盖度复测收窄**：年龄/健康证的岗位侧
   筛选可退役；**学生筛保留**（契约覆盖率仅 60%，退役即静默停筛）。

## 8.5 覆盖度全量复测（0820 执行，退役岗位侧筛选的前置闸门）

蓝图 §8 步骤 4 把「覆盖度全量复测」列为本批开工首项。0820 只读探针（生产，限速
250-400ms，不写不改），**结论直接改变了 §7 退役清单的范围**：

| 维度 | 契约覆盖 | 退役岗位侧筛选 |
|---|---|---|
| 年龄值域 | 30/30 有「年龄」标签且带 valueSpec；岗位侧有区间的 30 个 **全部被覆盖** | ✅ 安全退役 |
| 健康证 | 28/30 有健康证标签；岗位侧要求健康证的 28 个 **全部被覆盖** | ✅ 安全退役 |
| 籍贯/户籍 | 9/30 有该标签，且 **9 个全部 disclosure=RESTRICTED** | ✅ 披露标记可信，可依赖 |
| **学生/身份语义族** | **18/30（60%）** | ❌ **不得退役**（见下） |
| systemField | **0/30**（后端承诺改未落地） | 身份识别兜底继续生效 |
| required | 全 true；空标签岗 0/30 | 529020 是离群点，异常口径仍需保留 |

~~**⚠️ 学生筛不得随本批退役**~~ —— **本结论已被 §8.6 推翻（0820 用户与运营对齐）**。
当时的判据"契约身份族只覆盖 60%，退役会静默停筛"是拿标签缺失当证据凭空推的
（探针里真正的计数器是 0）；而判决单源本就规定"契约没带 = 该岗没有这道筛"。
裁定：三道岗位侧硬筛全部退役，数据欠账走补数据清单，见 §8.6。

**⚠️ 样本口径**：本次品牌接口只返回 10 个品牌，故是 **30 岗的品牌偏斜样本，不是全量普查**
（0818 那次是 450 品牌逐一翻页的全量 468 岗）。年龄/健康证的 100% 覆盖分母够且口径一致，
可作退役依据；学生的 60% 只用作**否定证据**（"不足以退役"），不得反过来当作
"40% 一定没有"的结论。退役学生筛前必须补一次全量普查。

## 8.6 岗位侧硬筛退役裁定（0820 用户与运营对齐后定案）

> **裁定原文**：「收资模块完全按照新的契约来。自由文本中有的、但收资接口没有返回的，
> 也没事，一切以这个收资的接口返回的标签为准。」

这条裁定**推翻了 §8.5 里"学生筛不得退役"的保留意见**，也取消了合成身份槽位的全部理由。
§8.5 当时的判据是"契约身份族只覆盖 60%，退役会静默停筛"——但那是拿标签缺失当证据凭空推的，
探针里真正的计数器是 0；而判决单源的原则本就是"契约没带 = 该岗没有这道筛"（§5 还明写
"多报下游可截"）。按裁定，这不是漏筛，是预期行为。

### 退役范围（三道岗位侧硬筛）

| 退役项 | 原判据来源 | 新判据 |
|---|---|---|
| `student_rejected` | `screeningCriteria.isStudent`（岗位自由文本解析） | 契约身份标签的 rejectedOptions |
| `household_rejected` | `hardRequirements.household`（岗位数据） | 契约籍贯标签的 rejectedOptions（实测 disclosure=RESTRICTED） |
| `age_rejected` | `ageBoundary`（岗位 ageRequirement 文本） | 契约年龄标签的 valueSpec（实测 30/30 覆盖） |

三者归一为 **`screening_rejected`**：判据统一到契约之后，"因为哪一项被筛掉"不再由
nextAction 承载——那是**披露层**的事，由 rejection-renderer 按 disclosure 分级决定说什么。
旧口径把"户籍不符禁止透露"写在提示词里管着，新口径是结构性的。
`booking-guards` 的提交前硬闸不在本次退役范围（那是进真实工单前的服务端兜底，另一个面）。

数据欠账另有清单交运营（`label-backfill-for-ops-20260820.csv`，276 条 / 199 岗）：
**补数据不补代码**。

### 已验证（0820 实测，未提交，实施时重做）

退役 + `deriveFormNextAction` 接线跑通并实测确认：学生岗位 + 候选人自报学生
→ `screening_rejected`（此前接线只处理 ready、其余一律 collect_fields，
**被筛掉的候选人还会被继续收资**，是接线期的真 bug，修法见下）。

⚠️ **接线必须覆盖全部五个 verdict**，一个都不能落进"其余算收资中"：
disqualified→screening_rejected / escalated→handoff / collecting→collect_fields /
ready+submitted→ready_to_book（再过日期对齐）。

### 阻塞项：precheck 主 spec 的 82 例改写

退役后 `tests/tools/tool/duliday-interview-precheck.tool.spec.ts` 有 82 例待改写，
**需逐例判断，无系统性捷径**（已试过三种批量手法，两种反而变多）。已定位的根因分类：

1. **字段名换契约 labelTitle**（联系电话→手机号、健康证情况→有无本地健康证）——批量可改；
2. **`*_rejected` 三值归一 screening_rejected**——批量可改；
3. **`studentEligibility`/`householdEligibility` 响应字段已删**——整块断言需删；
4. **夹具不现实**（最大一类）：用例只用 `candidateXxx` 工具入参传值、候选人在任何语料里
   都没说过。旧路径直接信任入参，新路径要求回查得到出处（臆造防线）。生产里模型能传
   candidateName 是因为候选人早前说过、值在 sessionFacts 里；**夹具当年省掉了这个前提，
   要逐例补回**。⚠️ 不能在 harness 里无差别补档案——那会把"应该还要问 X"那类用例
   一起填满（实测反而从 82 涨到 99）。

harness 本身已可用（注入 CollectionFormService + 按岗位夹具合成契约），其中一个坑值得记：
`fetchJobs` 用 `mockResolvedValue` 打桩时 `mock.results[].value` 是 **Promise**，
不 await 会让合成契约永远退化成默认四槽。

## 9. Spike 清单（写码前关）

**S1 契约实际返回形状 vs DTO**（0819；披露级别字段是否到位，没有则兜底注册表先行）
—— ⏳ 待契约 spec 到货。披露兜底注册表已随步骤 2 交付（`disclosure-policy.ts`
默认档=禁明说），契约带不带披露级别都不阻塞。

**S2 中介多人会话生产频率**（决定 v2 是否值得建自动化协议）—— ✅ **关闭：不值得，
v1 转人工够用**（2026-08-19 生产只读量化，两个角度互相印证）：
- 报名口径（严口径，90 天窗）：1100 个有成功报名的会话里，**5 个**（0.45%）出现
  「≥2 个不同手机号 **且** ≥2 个不同姓名」；7 个出现 ≥2 个不同姓名；单会话最多 3 个手机号。
- 会话口径（宽口径，14 天窗，`message_processing_records.memory_snapshot`）：260 个曾
  持有手机号的会话里，**5 个**（1.92%）手机号值变过；单会话最多 4 个不同号。
- 读法：宽口径把"改错号重填"也算进去了，所以严口径（姓名+手机号成对换新）才是多人判据
  ——这正是 D1 v1 采用的规则。**0.45% 的形态不配拥有一套自动化协议**；v1 检测到即
  escalatedReason 转人工，等数据涨上来再谈 v2。
- ⚠️ 两个口径都**只覆盖走到报名/落档的会话**，中介问完就走的不留痕，真实频率只会更高不会更低；
  但要高到值得建协议，得比现在高一个数量级。

**S3 errorList 字段映射实测**（测试环境 entryUser 假身份提交一次）—— ⏳ 待契约批。

**S4 Redis 快照读写延迟 + 整实体尺寸**—— ✅ **关闭：尺寸与延迟都不构成约束**
（2026-08-19 只读探针，PING/GET 各 10 次，限速 120ms，不写不删任何生产数据）：
- **尺寸**：按最坏档造满槽表单（13 槽全 filled + 长 sourceText + lastRecap + configDebt）
  序列化 **3.9 KB**。远低于 Upstash 单值上限，整实体读写不需要拆分或压缩；
- **延迟**：GET p50 433ms / p90 506ms，PING p50 517ms。⚠️ **这是从开发机经公网测到生产
  Upstash 的数字，不是生产服务器上的数字**——它被跨境 RTT 主导，只能当上界代理值读；
- **可行性结论**（不依赖绝对延迟）：表单给每回合新增 **1 次 GET + 1 次 SET**，与系统
  每回合已有的会话状态 hash 读写属同一量级、同一个 Redis。这是边际成本，不是新增量级。
  回合租约（90s 心跳续期）已保证同会话单写者，无需 CAS，故不引入额外往返。

**S5 复述文案与回复分段/拟人化投递兼容**（\n\n 分段协议）—— ✅ **关闭：兼容，结论已
固化为可执行断言**（`tests/tools/duliday/collection/recap-renderer.spec.ts` 的
「Spike S5」describe 块，随代码回归）：
- 复述排成「引导句以冒号收尾 + 连续 `标签：值` 行」的**表单块**形态，`MessageSplitter`
  认其为原子段——不按句拆散、不被 `coalesceToCap` 与别的话术粘合，段数上限收口时仍完整；
- 收尾提示另起一段单独投递（读感更自然）；
- ⚠️ 两个坑已在渲染器里防住：①每段**末尾标点会被投递层剥掉**，故文案不把语义押在句末
  标点上；②表单行的标签含逗号/句号或超 48 字时分段器**不认这一行**，整块随之失去原子性
  ——生产实测标题带筛选指令的脏配置不少（「是否学生（不要学生及暑假工）」），
  渲染前统一剥括号补充与句读。

## 10. 验收（六事故防线回归，全绿才算完）

| 防线 | 断言 |
|---|---|
| 反复问根治 | filled 槽位零重问（同会话重放：答过年龄后任何轮不再出现年龄提问） |
| 复述落账 | "不对，电话错了"能精确重开 770 一格，其余格不动 |
| 先筛后收 | 答案命中 rejectedOptions 当轮即 disqualified，不再收后续字段 |
| 臆造防线 | sourceText 回查失败的提案零入账（公证拒收落审计事件） |
| 死锁终结 | errorList 回写后 verdictOf 回到 collecting/escalated，不存在永卡 ready |
| 熔断 | 同槽 2 问不中 → escalated，第 3 问不存在 |

指标探针：答后复问率 <10%（基线 31.5%）/ 报名死锁 0 / filled 被重问 0。

### 10.1 实案回归：0819 确认死循环（用户裁定"本改造必须完全修复"，验收必测）

> 案例 chat `6a829f44ce406a6aee9369f0`（2026-08-19 17:02-17:28，v10.44.0 首日，
> `handoff_events.reason_code='system_blocked'` 公证死循环族 3 会话之一）。故障链：
> 候选人 17:07 一次给全住址/社会身份/健康证 → 复述确认后 booking 因模型未转抄
> `prechecked` 被拒 → 重跑 precheck 时"确认"无作证通道、跨轮原话进不了当轮证据窗、
> 补充标签在 claim 运输里无座位 → checklist 恒缺 → 整发清单再确认 ×2 → 断路器熔断
> 发人工卡。用户裁定（0819）：不做临时止血（违反"不要过渡期"），运营人工兜底至
> 本批上线；上线验收以下断言全绿，缺一不收：

| 环节 | 断言 |
|---|---|
| 确认即放行 | 复述后候选人回"确认" → `verdictOf==='ready'` 直接提交；同会话第二张全量确认清单在结构上不出现 |
| 修正精确重开 | "住址是X"+"其他的都正确" → applyRecapResult 只重开住址一格，其余保持 filled；修正值当轮公证后直接提交，不再全量重发清单 |
| 提交票据状态化 | booking payload 由 form 生成，提交资格=表单 ready，不存在"模型忘带 prechecked"类序列失败 |
| 确认可作证 | R1 agentQuestionQuote 通道：候选人对复述清单/针对性提问的肯定应答可折算为在案槽位的本人终审，无需候选人原话逐字含值 |
| 公证一次终身有效 | 一次性给全的值当轮入槽 filled，后续任何轮不再要求重新举证（跨轮不重推、不重验） |
| 补充标签全覆盖 | 具体住址/社会身份/有无本地健康证等契约标签全部有槽位与运输格式，不存在无座位字段 |

观测配套（§4 已含，此处点名）：escalated / proposeValue 拒收事件落
`agent_execution_events`——当前生产 `collectionStalled` 只有 logger.warn 无落库，
是本次排障实测的观测盲区，随本批一并补上。

## 10.5 铁证 D 回归（0819 追加；处理方案实施时裁定，不改旧架构）

> 来源：总纲 §2.9（chat `6a7ecef3ce406a6aee6e5830`，trace
> `batch_6a7ecef3ce406a6aee6e5830_1787126726984`，岗位 528966）。9-1 归一层发版后
> R12 族仍复发的最新生产实证，三条取值路径逐层 miss 实录见总纲。

**必做 fixture**（假身份改写后入状态机批单测/回归，PII 按红线脱敏）：

1. **粘连表单一行流**：候选人消息形态
   `具体住址：万达广场附近有无本地健康证（暂无）社会身份：宝妈`（三行粘成一行、答案在
   括号注记里）——断言：写入公证不产生脏值（住址槽不得吞其他字段答案）；健康证类槽位
   不得因字段名文本「有无本地健康证」被解析器 `/本地.{0,4}健康证/` 误读而写「有」入账。
2. **针对性问答即采信**：Agent 复述"本地健康证没有但可以办对吧？社会身份是社会人士对吧"
   → 候选人答「可以办，社会人士」——断言：健康证槽经 health-certificate.adapter 落
   optionCode 2（当轮消息即证据，公证通过）；身份族槽位（若该岗契约配有）由身份识别器
   语义族兜底填入；两槽 filled 后零重问、零 system_blocked。
3. **系统标签性别预填**：候选人全程未自陈性别、值来自系统标签——断言：预填带值求证，
   提交前复述一次；不产生 legacy 空 quote 的 `quote_not_found` 噪音裁决，更不得进
   任何转人工文案。

**实施时待裁定的两个点**：

- health-cert 解析器字段名误读（总纲 §2.9 附带发现①）：修法二选一——适配器输入端剥
  模板字段名/粘连段预处理，或解析器加负向断言（「有无」前缀不判有）。解析器动正则
  需先破冻结令，默认选适配器侧防。
- 覆盖度复测（§8 步骤 4）范围：必须含基线外新上架岗（528966 实例：0818 基线 468 岗
  不含它，0819 已在产线接客）。

## 11. 红线

- 判定入账永远如实（禁把披露层的委婉写进账本）；producer 署名如实（禁 system 冒名）；
- 未知标签披露默认禁明说；禁说词表禁止另立副本；
- fixtures 一律假身份（兮兮/18271421690）；生产探针只读+限速；
- 并发会话纪律：动文件先查占用，commit pathspec；
- SlotState/Verdict 封闭集纪律（§0）：加值先答"既有值为何覆盖不了"；
- 禁止硬编码外系统 ID（D4）：labelId/optionCode 字面量不进代码，语义走契约标记、
  ID 锚点走环境级配置+运行时核验；
- 审计事件落 agent_execution_events，不落库=没做。
- **候选人信息不跨托管账号共享（0820 运营+用户裁定，源 badcase dxymwoqb）**：
  表单预填与记忆召回（报名/收资信息含身份 PII）的作用域＝**同一托管账号**；
  跨账号接触视为首次，正常重新收集，禁止"之前登记的信息帮你带出来了"式跨账号
  披露（生产实证：同人跨账号被整段复述姓名手机号，候选人以为信息泄露）。
  蓝图"记忆→表单预填（跨岗不重复盘问）"的适用范围由此收窄为同账号内。
- **词表禁判语义（0819 用户裁定，P11 分工的收资域落地）**：确定性第一档只许做
  **契约选项字面与教科书短答的精确匹配**（"有/无/不接受办理"级，Map 查表；含糊即
  miss，不做正则语义推断）；未命中一律流二档**模型作证选 optionCode**（本质
  LLM-as-judge + 代码公证出处，extract 角色可路由小模型，产物仍过公证）——
  **unknown 不得成为追问终点**。禁止以新增正则/别名追口语语义长尾（"去办/刚拿到手/
  健康正式"类一律归模型作证）；既有解析器按"只削权不删码"处置：流程/状态逻辑存活，
  口语正则档冻结不再扩，权威让位二档。
  **作证主通道＝主聊模型随既有工具调用提交 claims（0819 追加裁定）**：主模型是全系统
  最好的语义读者（0819 实证：17:20 supplementAnswers 全对、被 check 丢弃后又被词表
  回填否决），其证词即语义判决，零额外调用；**不设常驻第二语义读者**（双通道判同值
  必打架，brands 双通道前车之鉴）。小模型仅作两用：轮末空槽收网扫描（主模型漏勤时的
  安全网，同轮证据窗内）与离线 shadow 审计；产物一律过公证。主模型漏作证的主修复
  路径是同轮多步循环补交（工具结果回报空槽→同轮再调）。0819 三会话 7 条生产原话
  （"刚刚拿到手的""明天去办""可以办，社会人士""有无本地健康证（暂无）"等）
  作为**二档作证的验收用例**进 fixtures——不是词表补丁。

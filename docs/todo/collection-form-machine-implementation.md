# BookingCollectionForm · 实施蓝图（代码架构级 v2）

> **v2（2026-08-18）**：实体定名 BookingCollectionForm；按全量生产实测（总纲 §2.5-v2）修订——
> ①身份核已标签化（姓名769/手机号770/年龄687/性别771，468/468），SlotKey 统一为 labelId 单形态，
> identity 适配器按这四个全局 labelId 挂接；candidateRef = 标签 770 的槽位值（归一 11 位）；
> ②适配器注册表改双层：labelId 精确表（13/2/4/50/49/769/770/687/771 等头部稳定项）+
> **标题语义族兜底**（学生族/学信网族/专业族——生产实测同义标签分裂 12 个 labelId 且持续新增，
> 纯 labelId 表接不住）；③披露策略兜底注册表随 v1 必须交付（契约无披露字段而敏感标签实存：
> 籍贯3/专业544,659/学信网族）；④年龄岗位边界仍走既有岗位数据解析（687 无值域）；
> ⑤FILE 标签(49 上传简历)的 value 生产者=简历工具 v4 output；
> ⑥required 无标志——按「契约返回即须收」处理；标签**零缓存实时查询**（0818 裁定，配置修改即刻生效）；筛选=答案命中 rejectedOptions 即不合格、
> 命中 acceptedOptions 通过、映射不出即求证。
> **挂起已解除，全部 9 步可执行。**

> 设计权威：`label-driven-collection-refactor.md`（总纲）§2.8 五条构造性质 + 披露策略。
> 本文是它的实施展开：代码树、类型、签名、接线点、实现顺序、退役批、验收。
> 契约已生产兑现（总纲 §2.5-v2 全量实测），无阻塞。

## 1. 代码树

```
src/
├── sponge/
│   ├── collection-contract.types.ts        统一契约 DTO：字段定义（稳定键/fieldType/
│   │                                         required/acceptedOptions/rejectedOptions/披露级别）
│   └── sponge.service.ts                   +fetchCollectionContract(jobIds)：**零缓存实时查询**
│                                             （用户裁定 0818；会话内单岗查询成本可忽略）
│
├── resolution/collection/                   ★新子域：状态机纯逻辑（零 LLM 零 IO；
│   │                                         依赖上限=sponge 类型 + resolution 兄弟域）
│   ├── form.types.ts                       类型全集（见 §2）
│   ├── form-machine.ts                     applyEvent(form, event) → form'  纯归约器
│   ├── write-guards.ts                     写入公证（复用 resume-fields 公证模式：
│   │                                         同轮证据校验/形态/归属/置信授予/notaryDrops）
│   ├── option-matching.ts                  自然语言 → optionCode 确定性直配层
│   │                                         （词表复用既有解析器，含糊→null 交模型作证）
│   ├── adapters/
│   │   ├── adapter.registry.ts             labelId/字段族 → 适配器；未知走 fieldType 通用道
│   │   ├── identity-core.adapter.ts        name/phone/age/gender（包装既有真名/手机号/
│   │   │                                     年龄边界解析器与闸门判据）
│   │   ├── education.adapter.ts            normalizeEducationToId × acceptedOptions 成员判定
│   │   └── health-certificate.adapter.ts   包装 resolveLocalHealthCertificateEligibility
│   │                                         （三确定态→optionCode 1/2/3，两不定态→留空追问）
│   └── disclosure-policy.ts                披露分级：契约字段优先，兜底按属性族注册表，
│                                             未知默认禁明说；禁说词表 import 守卫红线同一常量
│
├── memory/
│   ├── stores/collection-form.store.ts     Redis 实体（版本号乐观锁）+ 审计事件落库
│   └── services/collection-form.service.ts 生命周期：loadOrCreate / applyAndPersist /
│                                             多表单寻址（见 §5 D1）/ 跨轮存续
│
├── tools/
│   ├── duliday/collection/
│   │   ├── recap-renderer.ts               待确认槽位 → 复述文案；渲染同时产 recapIssued 事件
│   │   └── rejection-renderer.ts           不合格 → 按披露级别渲染（禁明说档复用
│   │                                         noMatchScript 承接家族 + 因果隔离）
│   ├── duliday-interview-precheck.tool.ts  ★收资核重写：checklist 体系 → 表单消费（见 §6）
│   └── duliday-interview-booking.tool.ts   ★提交切 entryUser；errorList → serverRejected 槽位事件
│
└── supabase/migrations/                    +collection_form_events 审计表（先测试后生产）
```

依赖方向（violate 即 eslint 拦）：tools → memory/resolution/sponge；memory → resolution；
resolution/collection → resolution 兄弟域 + sponge 类型，**不得** import memory/tools/llm。
LLM 只在 tools 层（选项含糊时模型作证选 optionCode，产物过 write-guards 公证）。

## 2. 核心类型（form.types.ts）

```ts
// v2：身份核已标签化（769/770/687/771），SlotKey 统一为 labelId 单形态；
// IDENTITY_LABEL_IDS 常量表标记身份核槽位（写守卫挂身份闸门用）
type SlotKey = { labelId: number };
const IDENTITY_LABEL_IDS = { name: 769, phone: 770, age: 687, gender: 771 } as const;

type SlotState = 'empty' | 'pending_confirm' | 'confirmed' | 'disqualified' | 'escalated';

interface SlotValue { value: string; optionCodes?: string[]; sourceText: string;
  producer: 'candidate_quote'|'rule'|'model'|'system';  // 复用全库唯一 producer 词表，署名如实
  confidence: 'high'|'medium'; }

interface FormSlot { key: SlotKey; state: SlotState; value?: SlotValue;
  constraint: ContractFieldDef;            // 契约原文：fieldType/required/options/披露级别
  confirmAttempts: number;                 // 熔断计数（≥2 未办结 → escalated）
  history: SlotEvent[]; }                  // 槽位级审计（失效/改口/服务端拒绝全留痕）

interface BookingCollectionForm { formId: string; candidateRef: CandidateRef; jobId: number;
  version: number;                          // 乐观锁
  slots: Record<string, FormSlot>;
  jobVerdict: 'collecting'|'disqualified'|'ready'|'submitted';
  pendingRecap?: { slotKeys: string[]; issuedAtTurn: string }; }  // 复述事件（在案待肯定应答）

type FormEvent =
  | { type: 'valueProposed'; slot; raw: RawProposal }        // 各来源的值提案
  | { type: 'recapIssued'; slotKeys: string[] }              // 复述落账
  | { type: 'affirmed' }                                     // 肯定应答→pendingRecap 全槽 confirmed
  | { type: 'corrected'; slot; raw }                         // 改口：单槽重开
  | { type: 'invalidated'; slot; reason }                    // 显式失效（换岗重筛/errorList）
  | { type: 'serverRejected'; slot; msg }                    // entryUser errorList 回写
  | { type: 'submitted'; workOrderId: number };
```

## 3. 关键签名

```ts
// form-machine.ts —— 全系统唯一裁决点，纯函数，转移表穷尽（Record 穷尽纪律）
applyEvent(form: BookingCollectionForm, event: FormEvent, guards: WriteGuardSet): BookingCollectionForm
// 不变量（写成断言测试）：confirmed 槽位仅接受 corrected/invalidated；
// affirmed 只作用于 pendingRecap 在案槽位；confirmAttempts>=2 → escalated。

// write-guards.ts —— valueProposed 的入口公证（一次、同轮）
notarizeProposal(raw: RawProposal, evidence: TurnEvidence, constraint: ContractFieldDef)
  : { verdict: 'accept'; value: SlotValue } | { verdict: 'reject'; reason: NotaryDropReason }
  | { verdict: 'disqualify'; hit: RejectedOptionHit }   // 先筛后收在此发生

// recap-renderer.ts —— 复述由状态渲染（不是模型自由发挥后再考古）
renderRecap(form): { text: string; recapEvent: FormEvent }

// rejection-renderer.ts —— 判定如实、披露分级
renderDisqualification(form, policy: DisclosurePolicy)
  : { mode: 'plain'; text } | { mode: 'generic_redirect' }   // generic 走换岗承接流程，本轮不提拒因
```

## 4. 存储（memory 域）

- **Redis 实体**：`collection-form:{corpId}:{userId}:{candidateRef}:{jobId}`，
  整实体 JSON + `version` 乐观锁（CAS 重试，复用 factsv2 字段级写的并发教训——
  PR #455 先例：读-改-写必带版本比对）；列入「丢了算事故」的 key 清单。
- **审计事件**：每次 applyEvent 落 `collection_form_events`
  （form_id/event_type/slot_key/payload/turn_id，与 trace_id 可 join——观测不落库=没发生）。
- **迁移纪律**：`IF NOT EXISTS` 幂等；先 db:push:test 真实写入验证再 prod；
  与代码发版同步（仓库事故史红线）。

## 5. 设计决策点（实施前定，D1 必须过用户）

- **D1 candidateRef 与多人报名协议**：candidateRef=phone 归一值（11 位，与海绵报名
  人键同源）；phone 未知期挂会话默认表单、到达时 rebind；新（姓名+手机号）对出现即
  开新表。**多人协议四条硬规则**：①模型当分拣员——值提案必须带归属标注；
  ②活跃表 >1 时无标注提案一律拒收，逼模型现场向中介问清（歧义不落账）；
  ③复述按人分组渲染=值与归属的双重终审（分拣错误由唯一知情人当场纠正）；
  ④筛选/披露/提交/失败全部按表隔离，禁止连坐。一名多号/一号多名歧义 → escalated
  交人工。**需用户确认建议或改**。
- D2 errorList 的 field（展示名）→ 槽位映射：优先契约回传稳定键（核对清单第 4 条）；
  只有展示名时按 labelTitle 匹配，失配 → 整单 escalated 不静默。
- D3 复述节流：一轮 recap 覆盖全部 pending 槽位（不逐槽问）；escalated 话术复用
  转人工既有口径（禁暴露 AI 身份纪律）。

## 6. precheck/booking 接线（最大改动面）

precheck 收资核：`buildKnownFieldMap + checklist + missingFields` 整体替换为
`collectionFormService.loadOrCreate → 本轮消息产 valueProposed* → form 快照返回`；
`nextAction` 从 form 派生（collecting=渲染缺口+recap / disqualified=rejection-renderer /
ready=放行 booking）；templateText 由 form 渲染。claim 轨保留为**值提案的运输格式之一**
（R1 schema 补 agentQuestionQuote 随本批实施）；身份闸门保留为 identity 槽位写守卫。
booking：payload 由 form 生成（身份核 + labelList[{labelId, optionCodes|value}]）→
entryUser → workOrder 落 submitted / errorList 逐条 serverRejected。

## 7. 同批退役删除（总纲 §4 清单的执行面）

checklist.util 的 FIELD_ORDER 大部/buildKnownFieldMap/missingFields 字面过滤；
classifySupplementLabel 括号黑名单；normalizeSupplementKey+别名表+一行流解析；
customerLabel 拼装主体；快照水位（snapshot-gate）；确认识别器族与四份肯定词表分叉
（D5，肯定词表收拢到 dialogue 唯一居所）；E1/E2 enforce 分支（账本对象已换）；
`allowLegacyConfirmRegex` 并跑；9 个 candidateXxx 裸字段（拆除判据已写在 precheck 注释）。
**删除纪律**：每删一族先 grep 消费面，测试期望同步改，禁留空壳。

## 8. 实现顺序（可测地基先行；1-4 步不等契约）

1. `resolution/collection` 类型 + form-machine 纯归约器——**转移表穷尽测试 +
   三铁证事件序列重放**（假身份复刻 A/B/C，断言：A 一轮确认即办结、B 双表单互不污染、
   C 不存在第二次同题追问）；
2. write-guards + option-matching + 三个适配器（复用既有解析器，单测全覆盖）；
3. disclosure-policy（守卫红线词表同源接线 + 未知默认禁明说测试）；
4. recap/rejection renderer（纯文案层，快照测试）；
5. ——契约落地检查点：覆盖度探针复测 + contract types 对齐实际返回——
6. sponge 契约客户端 + 缓存；memory store/service + 迁移 + 并发 CAS 测试；
7. precheck/booking 接线重写（最大面，铁证重放跑通后才进）；
8. §7 退役删除批 + 全量回归；
9. 验收：三铁证重放全绿 + 验收指标探针（答后复问率 <10%/死锁 0/已确认槽位被重问=0）。

## 9. Spike 清单（写码前关）

S1 契约实际返回形状 vs collection-contract.types（含披露级别字段是否到位，
   没有则 disclosure-policy 兜底注册表先行）；
S2 D1 candidateRef 方案在中介样本上的可行性（拉生产 3 个多人会话只读验证）;
S3 errorList 字段映射实测（测试环境 entryUser 打一次假身份提交）；
S4 Redis 实体读写与 CAS 在 Upstash REST 上的延迟/原子性（复用 factsv2 先例核对）；
S5 复述文案与既有回复分段/拟人化投递的兼容（\n\n 分段协议）。

## 9.5 收资受阻感知层（v3 终裁，2026-08-18）

**裁决原则（用户裁定）：漏斗优先——降级方向永远朝"能继续报名"倒。最坏结果=多报了
不符合要求的人（下游审核/面试/门店可截，可恢复）；绝不因配置债卡死报名
（候选人流失不可恢复）。唯一不降级项：披露红线（禁明说永不降级为明说）。**

脏配置长期存在是设计前提。八种受阻形态，每种=触发点+机内降级+落库事件：
B1 语义不明（只收不筛，照常提交）/ B2 同表同义槽位（**问一次族内互填**，绝不连问）/
B3 同 id 类型分裂（按本岗实际类型走通用道）/ B4 选项映射不出（熔断→带值提交优先，
转人工兜底）/ B5 子集筛选不可见（**不本地筛**，照常提交，服务端校验晚失败兜底——
拒绝权依据必须来自契约，不用推断行使拒绝权）/ B6 errorList 失配（唯一必转人工项：
提交已失败且无法定位）/ B7 敏感未标记（自动按禁明说）/ B8 候选人抗拒
（两次质疑即带已收值提交试探）。
事件统一落 collection_form_events（新增 config_debt / slot_escalated 事件类型，零新表）。

**运营回路**：config_debt 按 labelId×jobId 聚合进周报（weekly-ops-report 消费）——
"本周实际阻塞收资的 Top 标签/岗位"，把 1538 行静态修正清单变成按生产疼痛排序的
动态优先队列；运营增量修，债务曲线周度可见。检测器实现在
resolution/collection/config-debt-detectors.ts（纯函数，语义族匹配器复用适配器注册表）。

## 10. 红线

- 判定入账永远如实（禁把披露层的委婉写进账本）；producer 署名如实（禁 system 冒名）；
- 未知标签披露默认禁明说；禁说词表禁止另立副本；
- fixtures 一律假身份（兮兮/18271421690）；生产探针只读+限速；
- 并发会话纪律：动文件先查占用，commit pathspec；
- 转移表/词表 Record 穷尽，新增事件类型漏写处理分支必须编译期报错；
- 观测落库不落库=没做（collection_form_events 是验收项不是可选项）。

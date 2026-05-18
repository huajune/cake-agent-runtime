# Agent 架构重新设计 — 基于 63 条 badcase 反馈

> 状态：设计阶段（尚未启动落地）
> 创建日期：2026-05-18
> 适用范围：candidate-consultation 主链路（duliday-job-list / interview-precheck / interview-booking / invite-to-group 工具栈）

## 1. 背景：为什么打补丁走不通

### 1.1 本 session 这一波的修法回顾

针对 63 条 badcase（46 条 `待分析` + 17 条 `处理中`），本 session 累计动作：

- 主体 prompt（candidate-consultation.md）新增 / 调整红线 ≈ 15 条
- 工具 description 新增硬规则 ≈ 10 条
- 代码层新增 guard / sanitize / 字段 ≈ 12 处（reply-fact-guard.salary_fabrication / booking_form_field_mismatch、agent-preparation.invitedGroups 渲染、sanitize-brand-name、booking-reply-format、name-guard 放宽等）

完整覆盖 14 条 + 监控覆盖 3 条 + 副症状覆盖 10 条 = 27 条；剩余 36 条仍未消除根因。

### 1.2 问题观察

1. **红线越加越稀释**：candidate-consultation.md 主体 prompt 行数 200+，工具描述 prompt 行数 400+，新加红线被旧规则淹没，LLM 对单条规则的注意力下降。
2. **同类问题重复出现**：aalxnd77（阶梯薪资被说成固定）和 zt98hgy3（编造节假日浮动）属于同一根因（"Agent 自由发挥薪资文案"），打了两次补丁仍有第三次。
3. **修复路径越来越窄**：剩余的 36 条里，~15 条是 "prompt 已写过 LLM 没遵守" 的渗漏类，加更多 prompt 文字解不了；~8 条是数据/外部能力问题，工具描述加规则不顶用。

**结论：打补丁式修复进入边际收益递减区。需要从架构层重新设计。**

---

## 2. 上帝视角诊断：4 个系统性失败模式

把 63 条 badcase 站在上帝视角抽象，发现根因收敛到 4 个系统性失败模式，加上 3 条外部能力 + 3 条静默兜底 + 1 条边角问题（其他/已搁置）。

详细的 bid → 失败模式映射见 **附录 A**。

### 失败模式 ① · "对话驱动"取代了"槽位驱动"的收资 — 11 条（含本轮已修 5 条）

**症状**

| bid                      | 反馈                                                     |
| ------------------------ | -------------------------------------------------------- |
| `0a7ajj1a`               | 健康证必备没说清                                         |
| `p9a7a70l`               | 果蔬好不要天津人，Agent 没主动问户籍                     |
| `7ur8ohbs`               | 程鹏被微信兜底为男性，岗位限女性，Agent 没确认就 booking |
| `bk4ruwa2`               | 收资一次性收齐没做到，分批问                             |
| `tqhtnwey`               | 候选人发完整资料，Agent 不知道 ready_to_book             |
| `czxyl39k`               | 候选人帮朋友间接报名，Agent 未识别拒绝                   |
| `bi6ewy2w` ✅            | "身份："字段被候选人误为身份证号                         |
| `67o8y2ez` ✅            | 收资字段错位（少工作经验/多门店时间）                    |
| `3g1ruov9` `6vzw8oh3` ✅ | 同会话重复拉群                                           |
| `uw8ow1xw` ✅            | 少数民族姓名被拒                                         |

**根因**

当前架构里，"候选人信息收集"是 LLM 看着 `precheck.bookingChecklist.templateText` 自由写收资话术。槽位是 LLM 隐式拼出来的，没有显式状态机。岗位的硬条件（年龄/性别/户籍/学历/学生身份/健康证）被塞进 `screeningChecks` 文本字段，LLM 自己判断"要不要核对、什么时候核对"。`invitedGroups` 这种"已拉过群" 的状态字段直到本轮才被注入 prompt 上下文——之前一直是孤儿数据。

### 失败模式 ② · 候选人原话信号没结构化进 facts — 14 条

**症状**

| bid                                                                                     | 候选人输入                         | 解析失误                                          |
| --------------------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------- |
| `bcke8fnn` `8mi00bkq` `94p8zrcm` `2u3qurvp` `bq3mmyed` `u8vs7aub` `cnsrc8ej` `b3ixniri` | "区+镇"/"位置分享"/纯区名          | 区→城市白名单未应用（已部分修于 commit f6a12905） |
| `qvsj97jr` `n7xdgidr`                                                                   | "大米的万寿"/"成都你六姐"          | 缺品牌→城市锚定                                   |
| `vlmnf38y`                                                                              | 候选人只说"松江"没说具体路         | Agent 没主动追问具体路就推岗                      |
| `1y6b5mxg`                                                                              | "身份证 42 岁"                     | age=42 未识别，被当身份证号                       |
| `ctxj6r4v` `9znvnky1`                                                                   | "5 点下班 5:30 到"/"下午 4 点开始" | 时段窗口未识别为区间                              |

**根因**

候选人原话里的"地理 / 时段 / 年龄 / 品牌"等关键信号没有强制走"结构化抽取 → facts → tools"链路。Agent 直接看原话 + 工具结果做决策，加工失真。

当前 `high-confidence-facts` 已经在做一部分提取（已覆盖：城市/区/品牌别名 等），但深度不够（未覆盖：时段窗口区间、身份证 X 岁、代他人报名信号、品牌×城市锚定）。

### 失败模式 ③ · 工具返回字段不可信、含污染数据 — 5 条（含本轮已修 1 条）

**症状**

| bid           | 工具污染                                                                         |
| ------------- | -------------------------------------------------------------------------------- |
| `2xcajl7w`    | sponge 返回的 storeName 含内部编码"奥乐齐-1084 苏宁广场"，Agent 把 1084 当门牌号 |
| `xfo5ehnx`    | "消杀员"找不到史伟莎（缺 jobType → brand 倒排）                                  |
| `z1u2ntbg`    | 工具不返回 storeStatus，候选人问"X 店关了吗" Agent 编"可能关店调整了"            |
| `q2l5s971`    | 查询条件硬过滤太死板，"前厅"找不到时段方便的就空了                               |
| `wcyayxpf` ✅ | 工具字段值"独立日购买保险"，Agent 原样复述                                       |

**根因**

duliday-job-list 把 sponge 原始数据原样透传给 Agent，没有"对外口径净化"层。Agent 看到什么说什么，垃圾进 → 垃圾出。本轮的 `sanitize-brand-name` 是这层的开始，但只盖了品牌名一项。

### 失败模式 ④ · 推荐/收尾文案是 LLM 自由作文 — 27 条（含本轮已修/监控 7 条）

**症状**

| 子类                        | bid                                                                          |
| --------------------------- | ---------------------------------------------------------------------------- |
| 推荐缺门店名/地址           | `afdxytz0` `x189vplh` `mgqlhyd1` `03n3gv35`                                  |
| 班次没全列 / 每周天数没说   | `ctxj6r4v` `9znvnky1` `45fkfivu` `uyhffxit` `qkiygu5s` `bxobhhmy` `nndx2ctl` |
| 薪资偷懒/编造               | `6b0wknts` `znabv7ph` `aalxnd77` ✅ `zt98hgy3` ✅                            |
| 跨品牌乱推 / 软收尾不拉群   | `l2ftjgka` `vic2p8ok` `bb012h5c` `7k1fn8bu` `ohvvn4yw` `y7f3jqsh` `zsr7xj7h` |
| 上下文承接错 / 编造门店状态 | `8379efei` `vwz2w59x`                                                        |
| 输出粒度                    | `cc1fb40s` ✅                                                                |
| 约面收尾 三件套             | `keciu6u6` ✅ `waugdoxa` ✅ `2za5e0ek` ✅ `e4qdb7rl` ✅                      |

**根因**

工具返回结构化 jobs / booking outcome，但**对外文案靠 LLM 自由发挥**。所有"必须包含 X 字段"的约束都靠 prompt 红线，LLM 渗漏率经验值 20-30%。这一类是 badcase 最多的失败模式。

### 其他 — 7 条

- **外部能力**（3 条）：`aeyylr0m`（高德 geocode 解析错）/ `eie6ojmf`（图片识别）/ `u3aoxn28`（公交站点数据缺失）。本设计范围外。
- **J 簇静默兜底**（3 条）：`nq53za7z` `gay6j94c` `h6mq8r8g`。已搁置，需独立 idle-followup worker。
- 暂未归类（1 条）：见附录 A。

---

## 3. 重新设计草案（4 条主线 ↔ 4 个失败模式）

### 主线 1 · 显式槽位状态机 → 解决失败模式 ①

**动机**

当前 `sessionFacts.interview_info / preferences` 是 LLM 自由读写的结构，没有"必填"/"已校验"/"来源可信度"的元信息。导致 Agent 反复重问、缺字段就 booking、不该收的字段乱收。

**方案**

引入显式 `CandidateSlots` 表，每个槽位带 `source` / `confidence` / `verifiedAt`：

```typescript
interface CandidateSlot<T> {
  value: T | null;
  source: 'self-claimed' | 'wechat-fallback' | 'extraction' | 'unverified';
  confidence: 'high' | 'medium' | 'low';
  verifiedAt?: string;
}

interface CandidateSlots {
  // 身份槽（约面收资必填）
  name: CandidateSlot<string>;
  age: CandidateSlot<number>;
  gender: CandidateSlot<'male' | 'female'>;
  identity: CandidateSlot<'student' | 'social'>;
  household: CandidateSlot<string>; // 户籍省份
  education: CandidateSlot<string>;
  healthCert: CandidateSlot<'有' | '无'>;

  // 意向槽（推荐查岗必填）
  city: CandidateSlot<string>;
  district: CandidateSlot<string>;
  location: CandidateSlot<{ latitude: number; longitude: number }>;
  brand: CandidateSlot<string>;
  availableWindow: CandidateSlot<{ earliestStart: string; latestEnd: string }>;

  // 流程槽
  pickedJob: CandidateSlot<{ jobId: number; brandName: string; storeName: string }>;
  pickedTime: CandidateSlot<string>;
  bookingProxyTarget: CandidateSlot<string>; // 代他人报名识别
}
```

**stage 必填槽 + gate 表**（伪代码）：

```typescript
const STAGE_REQUIRED_SLOTS: Record<Stage, (slots: CandidateSlots) => SlotGap[]> = {
  job_recommendation: (s) => requireAny([s.city, s.location]),
  info_collection: (s) => requireAll([s.name, s.age, s.gender, s.identity, ...岗位 hardRequirements]),
  ready_to_book: (s) => requireAll(infoCollection(s)) && passedAllScreeningChecks(s),
  ...
};
```

工具层直接消费 slots，不再让 Agent 转译：

- `duliday-job-list` 不接受 `regionNameList` 字符串，只接受 slots.city + slots.location
- `duliday-interview-precheck` 不返回 templateText，返回 missing slot 列表 + 每个 missing slot 的"如何向候选人提问"建议
- `duliday-interview-booking` 入参从单字段改成 `slots: CandidateSlots`，工具内部读字段

**取舍**

- ✅ 强制 Agent 看到结构化状态，不再"凭印象记"候选人答过什么
- ✅ 工具层硬 gate，缺槽就拒，不依赖 LLM 自觉
- ❌ 改动大：现有 sessionFacts/interview_info schema 要升级 + 迁移；fact-extraction prompt 要重写；invite-to-group / advance-stage 等所有工具都要按新 schema 调整
- ⚠️ 过渡期：保留 sessionFacts 旧字段作为 read-only 兼容视图，逐工具改造

### 主线 2 · 候选人原话强制走结构化抽取 → 解决失败模式 ②

**动机**

当前 high-confidence-facts 只跑一次"实体提取"，且只覆盖城市/区/品牌等基础字段。时段窗口、身份证 X 岁、代他人报名等深度信号靠 Agent 在工具调用时自己解读，质量不稳定。

**方案**

把"候选人原话信号提取" 抽成独立的 pipeline 阶段（agent-preparation 之前/之中）：

```
候选人原话 → SignalExtractor （LLM 调用 / 规则混合） → CandidateSlots 部分填充
              ├── geo: { district, town, city, location }
              ├── availableWindow: { earliestStart, latestEnd }
              ├── age + ageSource: { value, isFromIdCard }
              ├── brand + brandConfidence
              └── proxyBooking: { detected, targetName, candidateRelation }
```

Agent 拿到结构化 facts 作为 turn-start state，不再从原话推断。

**关键覆盖**

- ✅ 已实现：city/district 白名单 + 品牌别名（commit f6a12905 等）
- ⬜ 待实现：
  - **时段窗口区间**："X 点下班 X+0.5 到 / X 点以后 / X 点之前 / 早上 X 到 Y" → `{ earliestStart, latestEnd }`
  - **身份证 X 岁** → age=X, source='self-claimed'（即使是身份证语境）
  - **代他人报名**："我朋友/她让我帮她/我同事也想报" + booking 字段 → proxyBooking.detected=true
  - **品牌×城市锚定**：候选人意向品牌只在某城市有店 → city 自动锁定（依赖品牌主营城市字典，独立决策点见 §6）

**取舍**

- ✅ Agent 决策路径变短：原话 → 提取层 → 结构化 slots → 工具 / 推荐
- ❌ 多一次 LLM 调用（如果走 LLM 提取），首 token 延迟 +200-500ms。是否值得换稳定性，需要 latency 测算

### 主线 3 · 数据契约层（工具层 sanitize）→ 解决失败模式 ③

**动机**

duliday-job-list 当前是"sponge 原始数据 + 字段 markdown 渲染"。Agent 看到的 storeName / brandName / 福利字段 都是上游"内部口径"——内部编码、废弃品牌名、内部福利描述。

**方案**

在 duliday-job-list 内部加 `sanitizeJobForAgent()` 净化层，对外只输出净化后的 `JobForAgent` 结构：

```typescript
interface JobForAgent {
  // 标识
  jobId: number;
  brandName: string; // canonicalBrand: '独立日' → '独立客'
  storeName: string; // cleanInternalCodes: '奥乐齐-1084 苏宁广场' → '奥乐齐苏宁广场店'
  storeAddress: string;
  distance: { km: number } | null;
  storeStatus: 'recruiting' | 'no_job_listed' | 'unknown'; // 派生字段，缺数据时 'unknown' 不让 Agent 编

  // 三件套：薪资
  salary: {
    base: { value: number; unit: '元/时' | '元/月' | '元/单' };
    steps: Array<{ threshold: string; value: number }>; // 满 40h → 26 / 满 80h → 28
    cycle: '日结' | '周结' | '月结';
    holidayBonus: null | { type: 'fixed' | 'multiplier'; value: number }; // 缺则 null，禁止 Agent 编节假日
    overtimeBonus: null | { type: 'fixed' | 'multiplier'; value: number };
  };

  // 三件套：班次
  shifts: Array<{ start: string; end: string; label?: string }>; // 必须全列
  workDaysPerWeek: number | string; // '6天/周' / '做六休一'
  scheduleFlexibility: 'fixed_by_store' | 'candidate_picks_from_options' | 'flexible_window';

  // 硬条件 enum 化（不再混在 markdown 里）
  hardRequirements: {
    age: { min: number; max: number } | null;
    gender: 'male' | 'female' | 'any';
    household: { include?: string[]; exclude?: string[] } | null; // '不要东北' → exclude: ['黑龙江','吉林','辽宁']
    education: string | null;
    student: 'accept' | 'reject' | 'unspecified';
    healthCert: 'before_interview' | 'before_onboard' | 'not_required';
  };

  // 福利（净化过的对话级描述）
  welfare: {
    meal: 'provided' | 'subsidy' | 'none' | 'unknown';
    insurance: 'provided' | 'none' | 'unknown';
    accommodation: 'provided' | 'subsidy' | 'none' | 'unknown';
    other: string[]; // 自由文本，但已过 sanitize
  };
}
```

**关键覆盖**

- ✅ 已实现：sanitize-brand-name（品牌名）
- ⬜ 待实现：
  - storeName 内部编码剥离（`奥乐齐-1084` 等）
  - storeStatus 派生（基于 jobs 数组是否为空、是否在招）
  - hardRequirements enum 化（从 `screeningChecks` / `customerLabel` 文本里解析）
  - salary.holidayBonus / overtimeBonus 字段化（reply-fact-guard.salary_fabrication 的代码层兜底，结构化后规则更精准）

**取舍**

- ✅ Agent 看到的字段都是"可信、净化、结构化"，再编造的成本变高（编不出 storeStatus 这种 enum 值）
- ❌ JobForAgent 类型设计需要严格 review，否则一旦上线很难改
- ⚠️ 上游 sponge API 数据补全（如果上游缺 storeStatus，下游派生不出来），需要数据治理层联动

### 主线 4 · 推荐/收尾文案模板化 → 解决失败模式 ④

**动机**

失败模式 ④ 占了 27 条 case（最大头）。所有"推荐文案三件套 / 班次全列 / 跨品牌乱推 / 软收尾不拉群 / 编造门店状态"等规则，都是在和 LLM 的"自由发挥"做拉锯战。每个规则都有渗漏率，叠加起来候选人收到的文案稳定性差。

**方案**

把"对外文案"从 Agent 自由发挥升级到"工具直接返回对话级 markdown 段"：

```typescript
// 当前：工具返回结构化 jobs[]，Agent 自己写每个岗位的推荐文案
result.markdown = formatJobsToMarkdown(jobs, ...);  // 字段堆叠式 markdown
// Agent 看到 markdown 然后用自己的话复述给候选人 → 失败模式 ④

// 重做：工具直接返回"可发送给候选人"的对话级文案
result.candidateMessage = renderCandidateMessage({
  intro: '附近 1.6km 有这两家在招：',
  jobCards: jobs.map(renderJobCard),   // 每张卡片是固定模板填值
  outro: '你看哪个时段方便？',
});
// Agent 工作变成：选 N 个 jobIds + 写 1 句开场 + 写 1 句收尾
```

JobCard 模板（固定结构，所有字段从 JobForAgent 槽位直填）：

```
1. {brandName}（{storeName}，{distance}km）
   班次：{shifts.map(s => `${s.start}-${s.end}`).join(' 或 ')}
   时薪：{salary.base.value} {salary.base.unit}{steps && `（满 40h→${steps[0]}/满 80h→${steps[1]}）`}，{salary.cycle}
   要求：{hardRequirements.age?.min}-{hardRequirements.age?.max}岁{hardRequirements.healthCert === 'before_interview' ? '，需食品健康证' : ''}
   {welfare.meal === 'provided' && '员工餐'}{welfare.insurance === 'provided' && '上保险'}
```

booking 成功收尾话术同理：本轮已部分做完（`_onSiteScript` / `_confirmedInterviewTimeHuman` / `_resultDisclaimer`），下一步是让工具直接组装完整 confirmation 段，Agent 退化为转发。

**关键覆盖**

- ✅ 已实现：booking outcome 字段 + sanitize-brand-name
- ⬜ 待实现：
  - JobCard 渲染函数（替代当前 `formatJobToMarkdown`）
  - 多门店警告 / 替代品牌建议 / 拉群兜底等"无岗动作链" 也走模板化输出
  - Agent prompt 大幅瘦身：删除"推荐文案三件套 / 班次必含每周天数 / 距离从近到远排序 / 同品牌优先 / 编造门店状态禁忌"等已被工具固化的规则

**取舍**

- ✅ 文案稳定性从 70-80% 跃迁到 95%+（模板字段都从工具结构化字段填值）
- ✅ prompt 文字大幅瘦身，关键剩下的红线注意力上升
- ❌ 损失一定的"个性化语感"。Agent 不能再为不同候选人微调措辞
- ⚠️ 模板设计需要充分迭代：第一版模板上线后可能需要 2-3 周打磨措辞

---

## 4. duliday-job-list.tool.ts 拆分草案（主线 3+4 的具体落地）

### 4.1 现状

- 单文件 **2050 行 / 45 个函数 / 6 个职责层**
- 同一文件混合：工具入口（DESCRIPTION + schema + execute）、检索过滤、距离计算、各 section 渲染、单字段格式化、品牌聚合、商业语义推断
- 测试集中在一个大 spec，无法单层验证

### 4.2 目标结构

```
src/tools/duliday-job-list/                       # 改成目录
├── index.ts                                       # tool({...}) + execute，~200 行
├── description.md                                 # DESCRIPTION 抽出，~400 行 prompt 文字
├── input-schema.ts                                # zod schema，~50 行
│
├── search/                                        # L2 检索过滤排序
│   ├── distance.ts                                # haversineDistance + sortByDistance
│   ├── schedule-filter.ts                         # applyScheduleConstraint
│   └── category-filter.ts                         # filterJobsByRequestedCategories + score
│
├── sanitize/                                      # L_NEW 主线 3 数据契约（核心新增）
│   ├── job-for-agent.ts                           # sanitizeJobForAgent + JobForAgent 类型
│   ├── store-name-clean.ts                        # 剥离内部编码
│   ├── salary-structurize.ts                      # 三件套 + holidayBonus enum
│   ├── hard-requirement-enumize.ts                # screeningChecks/customerLabel → enum
│   ├── welfare-canonicalize.ts                    # 福利字段净化
│   └── store-status-derive.ts                     # 营业中/无在招/未知
│
├── render/                                        # L_NEW 主线 4 模板化（核心新增）
│   ├── render-candidate-message.ts                # 顶层 intro + cards + outro
│   ├── render-job-card.ts                         # 单岗位卡片
│   ├── render-no-job-fallback.ts                  # 无岗动作链文案
│   └── render-multi-store-warning.ts              # 同品牌多门店强约束
│
├── brand-aggregation/                             # L6 同品牌门店逻辑
│   ├── build-brand-nearest-stores.ts
│   └── multi-store-warning-data.ts                # 结构化数据，render 层消费
│
└── helpers/                                       # L4-L5 通用工具
    ├── text-clean.ts
    ├── value-format.ts
    └── inferences.ts

src/tools/duliday/                                 # 跨工具共享 util 保持不动
├── booking-guards.util.ts
├── booking-reply-format.util.ts
├── enterprise-room-count.util.ts
├── format-shift-time.util.ts
├── job-policy-parser.ts
├── sanitize-brand-name.util.ts
├── schedule-semantic.util.ts
└── supplement-label-classifier.ts
```

### 4.3 拆分顺序

1. **Step A 机械搬运**（不改任何逻辑）
   - 按目录搬代码，所有 import 调整
   - 验收：现有 spec 全 ✅，单文件 <300 行
2. **Step B 引入 sanitize/** 层（主线 3）
   - 新增 `JobForAgent` 类型 + 净化函数
   - 工具内部 jobs 列表过一道 sanitize
   - 验收：新增单测覆盖 storeName 清洗 / hardRequirements enum 化 / storeStatus 派生
3. **Step C 引入 render/** 层（主线 4）
   - 新增 `renderJobCard` / `renderCandidateMessage`
   - 工具返回新增 `candidateMessage` 字段（保留旧 `markdown` 字段一段时间向后兼容）
   - 验收：badcase 回归 — afdxytz0 / mgqlhyd1 / 6b0wknts 等"推荐缺字段"类应自动通过

---

## 5. 落地路径

| Phase         | 主线                  | 周期   | 关键动作                                                                           | 验收                                                                                  |
| ------------- | --------------------- | ------ | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| **Phase 1.A** | duliday-job-list 拆分 | 1-2 天 | Step A 机械搬运                                                                    | 现有 spec 全 ✅；单文件 <300 行；blame 链最大化保留                                   |
| **Phase 1.B** | 主线 3 数据契约层     | 3-4 天 | Step B 引入 sanitize/                                                              | storeName/brand/salary/hardRequirements/storeStatus/welfare 6 字段净化；新加 30+ 单测 |
| **Phase 1.C** | 主线 4 文案模板化     | 4-6 天 | Step C 引入 render/；同步删主体 prompt 中已固化的红线                              | candidateMessage 字段稳定输出；20+ badcase 回归通过                                   |
| **Phase 2.A** | 主线 1 槽位 schema    | 3 天   | 定义 CandidateSlots / source / confidence；旧 sessionFacts 作为 read-only 兼容视图 | schema 评审通过；fact-extraction 跑通                                                 |
| **Phase 2.B** | 主线 1 stage gate     | 3-4 天 | STAGE_REQUIRED_SLOTS 表 + 工具入参改造                                             | 必填槽缺失时 booking 拒；新加 stage 流转单测                                          |
| **Phase 2.C** | precheck 工具改造     | 3 天   | 从 templateText 升级为 missing slot 列表 + 提问建议                                | precheck 输出 schema 升级；前端 dashboard 同步（如有）                                |
| **Phase 3**   | 主线 2 信号提取层加深 | 2-3 天 | high-confidence-facts 扩展时段窗口 / 身份证 X 岁 / 代他人报名                      | 各信号单测覆盖；fact 提取 LLM 调用延迟 <500ms                                         |

总工作量估算：**Phase 1 ~10 天 · Phase 2 ~10 天 · Phase 3 ~3 天**。Phase 1 即可消灭 30+ 条 badcase。

---

## 6. 关键决策点 / Open questions

1. **CandidateSlots 与现有 sessionFacts 的过渡：扩展 vs 重建？**
   - 选项 (a) 扩展 sessionFacts schema 加 source/confidence 元字段 — 兼容性好但 schema 越发臃肿
   - 选项 (b) 全新 CandidateSlots，sessionFacts 降级为 deprecated 内部字段，逐工具迁移 — 干净但过渡期 ≥ 1 个月
   - 推荐 (b)，需 RFC 单独讨论

2. **文案模板化后 Agent prompt 简化的程度：留多少自由发挥空间？**
   - 极端：Agent 只负责"选 N 个 jobIds + 1 句开场/收尾"，其余全模板
   - 折中：模板覆盖岗位卡片，但开场/收尾留 Agent 写 1-2 段；reply-fact-guard 兜底
   - 推荐折中——保留候选人侧个性化感觉，但收紧到 1-2 句

3. **reply-fact-guard 这一层在新架构下还需要吗？**
   - 现有规则：`group_full_without_invite` / `group_promise_without_invite` / `booking_form_field_mismatch` / `salary_fabrication`
   - 新架构下：booking_form_field_mismatch 由 precheck 强制 slot gate 替代；salary_fabrication 由 salary.holidayBonus enum 替代
   - 但 group_full / group_promise 仍需要（拉群语义是 Agent 主动承诺，难纯结构化）
   - 推荐：phase 1 保留所有规则；phase 2 后评估按规则下线

4. **品牌×城市锚定的字典从哪里来？**
   - 选项 (a) 工程侧维护静态字典（如"大米先生→[南京]"）— 数据更新滞后
   - 选项 (b) 从 sponge API 派生（同品牌所有门店的城市集合）— 实时性好但增加调用
   - 选项 (c) 运营在 dashboard 维护并发布到 strategy_config — 灵活但要 UI 支持
   - 推荐 (b) 优先，(c) 兜底；详细方案 RFC

5. **是否需要 LLM-judge 兜底**（reply 输出前再过一道事实校验）？
   - 不在本设计范围；视 Phase 1 后 badcase 复发率决定

6. **哪些 prompt 红线在 Phase 1.C 后可以删？**
   - 候选清单（在工具固化后可删）：
     - "推荐文案三件套 / 班次必含每周天数 / 距离从近到远排序"
     - "同品牌优先 / 编造门店状态禁忌"
     - "薪资三件套 / 薪资编造红线"
     - "约面三件套 / 到店脚本"
   - 需保留：品牌身份"独立客 = 独立日"、本平台仅兼职、敏感字段禁直问等真正全局原则

---

## 7. 不在本设计范围

避免 scope creep，以下议题需要独立 RFC / 不在 Phase 1-3 内：

- **模型升级 / LLM-judge 兜底层**：等 Phase 1.C 后看复发率再讨论
- **dashboard 端改动**：strategy_config / customerLabel 等运营字段的 UI / 入参变化
- **sponge API 数据治理**：storeStatus / hardRequirement 等上游字段补全
- **J 簇静默兜底**：idle-followup worker 独立模块
- **外部能力**：高德 geocode 准确率、图片识别、公交站点数据
- **观测/评估**：reply 质量打分、L1-L4 各层耗时埋点（应有但不在本设计）

---

## 附录 A · 63 条 badcase → 4 失败模式映射

> ✅ 表示本 session 已完整修或已加监控；其余为待处理

### 失败模式 ① · 对话取代槽位驱动收资（共 11 条，含已修 5 条）

**待处理 6 条**

| bid      | pool       | 标题                                           |
| -------- | ---------- | ---------------------------------------------- |
| 0a7ajj1a | pending    | 健康证是必备的这个得和候选人说清楚             |
| 7ur8ohbs | processing | 性别推断错误（程鹏被微信兜底为男，岗位限女性） |
| bk4ruwa2 | processing | 尽可能一次性把报名需要的信息收集全             |
| czxyl39k | pending    | 候选人想推荐别的人一起报名，应拒绝间接         |
| p9a7a70l | pending    | 果蔬好不要天津人，没有主动问户籍               |
| tqhtnwey | pending    | 候选人给了报名信息没有给候选人约面             |

**已修 5 条** ✅

| bid      | 修复方式                                                    |
| -------- | ----------------------------------------------------------- |
| 3g1ruov9 | agent-preparation 渲染 invitedGroups（B.1）                 |
| 67o8y2ez | reply-fact-guard.booking_form_field_mismatch（I.1）         |
| 6vzw8oh3 | 同 3g1ruov9                                                 |
| bi6ewy2w | precheck 模板字段名 `身份` → `身份（学生/社会人士）`（F.1） |
| uw8ow1xw | name-guard 上限 2-4 → 2-8 + 昵称提示字黑名单（G）           |

### 失败模式 ② · 候选人原话信号未结构化（共 14 条）

| bid      | pool    | 标题                                         | 信号类型        |
| -------- | ------- | -------------------------------------------- | --------------- |
| 1y6b5mxg | pending | 候选人说身份证上 42 岁没识别出来             | 身份证 X 岁     |
| 2u3qurvp | pending | 栖霞区候选人，反问哪个城市                   | 区→城市         |
| 8mi00bkq | pending | 浦东新区识别不到是上海                       | 区→城市         |
| 94p8zrcm | pending | 别问哪个城市（闵行开发区）                   | 区→城市         |
| 9znvnky1 | pending | 候选人下午 4 点开始上班未识别到时段窗口      | 时段窗口        |
| b3ixniri | pending | 奉贤属于上海，怎么无合适的群不能拉           | 区→城市         |
| bcke8fnn | pending | 闵行区加具体地址识别不出来是上海             | 区+镇→城市      |
| bq3mmyed | pending | 候选人发了具体位置还问在哪个城市             | 位置分享        |
| cnsrc8ej | pending | 具体区域识别不出来                           | 区→城市         |
| ctxj6r4v | pending | 5 点下班 5 点半到，推 17:00-22:00 说"赶得上" | 时段窗口        |
| n7xdgidr | pending | 成都你 6 姐被解析为"成都没有店"              | 品牌别名 + 城市 |
| qvsj97jr | pending | 大米的万寿，应锚定南京                       | 品牌×城市       |
| u8vs7aub | pending | 候选人已经说了具体区域，仍问城市             | 区→城市         |
| vlmnf38y | pending | 候选人只说"松江"没说路                       | 模糊地名        |

### 失败模式 ③ · 工具字段不可信（共 5 条，含已修 1 条）

**待处理 4 条**

| bid      | pool       | 标题                                                  |
| -------- | ---------- | ----------------------------------------------------- |
| 2xcajl7w | pending    | 给候选人发的定位错，storeName 含内部编码"奥乐齐-1084" |
| q2l5s971 | processing | 岗位查询的条件太死板                                  |
| xfo5ehnx | pending    | 岗位识别不准确（消杀员→史伟莎漏匹配）                 |
| z1u2ntbg | pending    | 别说关店调整了，应该说这边暂时招满了                  |

**已修 1 条** ✅

| bid      | 修复方式                                              |
| -------- | ----------------------------------------------------- |
| wcyayxpf | sanitize-brand-name 工具层 + prompt 品牌身份红线（G） |

### 失败模式 ④ · 推荐/收尾文案 LLM 自由作文（共 27 条，含已修/监控 7 条）

**待处理 20 条**

| bid      | pool       | 标题                                            | 子类         |
| -------- | ---------- | ----------------------------------------------- | ------------ |
| 03n3gv35 | processing | 薪资两个奥乐齐门店介绍不清楚                    | 薪资         |
| 45fkfivu | pending    | 未介绍一周需要出勤班次几天                      | 班次         |
| 6b0wknts | pending    | 未介绍阶梯薪资福利                              | 薪资         |
| 7k1fn8bu | pending    | 没有继续追问人选在哪个位置，没有穷尽推荐        | 推荐         |
| 8379efei | pending    | 没看上下文，候选人问看下定位 Agent 答"注意安全" | 上下文承接   |
| afdxytz0 | pending    | 岗位推荐没有具体门店或地址                      | 推荐缺地址   |
| bb012h5c | pending    | 找大米先生但推史伟莎销售/消杀员                 | 跨品牌乱推   |
| bxobhhmy | processing | 未介绍岗位一周需要出勤几天                      | 班次         |
| l2ftjgka | pending    | 指定门店无岗时跨品牌推                          | 替代品牌     |
| mgqlhyd1 | pending    | 未介绍岗位门店和地址                            | 推荐缺地址   |
| nndx2ctl | pending    | 让候选人和老板协调时间                          | 班次冲突     |
| ohvvn4yw | pending    | 候选人指定汉堡王无岗直接拉群                    | 拉群兜底     |
| qkiygu5s | processing | 没有和候选人说每周需要出勤几天                  | 班次         |
| uyhffxit | processing | 这岗位只需要周末上班平时不需要排班              | 班次         |
| vic2p8ok | pending    | 岗位不合适没有拉群                              | 软收尾       |
| vwz2w59x | processing | 不要东北的要委婉问，不能明确提问                | 敏感字段直问 |
| x189vplh | pending    | 岗位推荐未介绍岗位地址                          | 推荐缺地址   |
| y7f3jqsh | pending    | 候选人 10 分钟后不回复就直接拉群                | 静默误判     |
| znabv7ph | pending    | 一开始介绍薪资偷懒                              | 薪资         |
| zsr7xj7h | processing | 跨城市就不要问了，没有就没有放弃推荐            | 推荐扩张     |

**已修/监控 7 条** ✅

| bid      | 修复方式                                              |
| -------- | ----------------------------------------------------- |
| 2za5e0ek | booking outcome `_confirmedInterviewTimeHuman`（F.2） |
| aalxnd77 | reply-fact-guard.salary_fabrication（D.2 监控）       |
| cc1fb40s | delivery cap 8→4（H.1）                               |
| e4qdb7rl | booking outcome `_resultDisclaimer`（F.2）            |
| keciu6u6 | booking outcome `_onSiteScript`（F.2）                |
| waugdoxa | 同 keciu6u6                                           |
| zt98hgy3 | reply-fact-guard.salary_fabrication（D.2 监控）       |

### 其他（共 6 条）

**外部能力 3 条**

| bid      | 标题                                                               | 谁修                      |
| -------- | ------------------------------------------------------------------ | ------------------------- |
| aeyylr0m | "金地广场"应优先推同址 0km 门店而非 5.9km 远店（geocode 解析问题） | 高德 API / geocode 优先级 |
| eie6ojmf | 候选人发了别家奥乐齐照片说走错了                                   | OCR / 图像识别            |
| u3aoxn28 | 公共交通做到哪一站下，工具无此数据                                 | 外部地图 API              |

**J 簇静默兜底 3 条**（已搁置）

| bid      | 标题                             |
| -------- | -------------------------------- |
| gay6j94c | 聊完天不拉候选人进群             |
| h6mq8r8g | 半天不回复，餐饮兼职都需要健康证 |
| nq53za7z | 候选人没回复了没有拉群           |

---

## 附录 B · 本 session 已修 case 清单（避免重复）

| 簇                | bid                                       | 修复方式                                                                                                            |
| ----------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| G 品牌名          | wcyayxpf                                  | candidate-consultation.md 品牌身份红线 + sanitize-brand-name.util                                                   |
| H 消息粒度        | cc1fb40s                                  | delivery.service.ts MAX_SEGMENTS_PER_REPLY 8→4，收尾放宽 6                                                          |
| I 收资字段        | 67o8y2ez                                  | reply-fact-guard.detectBookingFormFieldMismatch（监控）                                                             |
| B 拉群幂等        | 3g1ruov9 / 6vzw8oh3                       | agent-preparation 渲染 invitedGroups                                                                                |
| D 薪资防编        | aalxnd77 / zt98hgy3                       | reply-fact-guard.detectSalaryFabrication（监控）                                                                    |
| F booking outcome | keciu6u6 / waugdoxa / 2za5e0ek / e4qdb7rl | booking-reply-format.util + booking 工具新增 `_confirmedInterviewTimeHuman` / `_onSiteScript` / `_resultDisclaimer` |
| F 字段歧义        | bi6ewy2w                                  | precheck FIELD_LABELS 加 `身份` → `身份（学生/社会人士）`                                                           |
| G 姓名豁免        | uw8ow1xw                                  | name-guard REAL_NAME_REGEX 2-4 字 → 2-8 字 + 昵称提示字黑名单                                                       |

---

**讨论入口**：本设计文档落档后等待讨论。下一步需要：

1. Phase 1.A（拆分）是否立即启动
2. 关键决策点（§6）每条的拍板
3. Open questions 是否需要拆出独立 RFC

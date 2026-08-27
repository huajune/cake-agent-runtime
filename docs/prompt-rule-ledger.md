# 程序性知识索引 · Prompt 规则台账（Procedural Knowledge Index）

> **本文件是程序性知识（procedural knowledge）的唯一总目录**——手册、procedural sections、工具 description、
> DB 策略文本、条件式规则块与守卫 hard-rules 的全量登记处，也是三项治理的挂载点：
> **容量**（台账+膨胀哨兵）、**沉淀**（批次删减循环，即 procedural refinement）、**放置**（判定树）。
> 这里的 procedural 是 context section 的知识类型轴，**不是 `src/memory/` 的第三层存储**；运行时记忆仍只有
> 短期会话与长期候选人×bot 关系档两层。物理居所按判定树就近散布（规则贴消费者，反口径漂移），
> 逻辑收拢于此，各 procedural 内容文件头部有锚注指回本索引（M1-B）。
> 建立：2026-08-21（治理方案 P3-1 / 防腐机制 F1，裁定 4：markdown 轻量版，不建系统不建表）
> 终态刷新：2026-08-26（context assembly compiler 三期收官）。
> 范围：主 generator 链路全部规则居所——procedural sections、工具 description、DB 策略文本
> （red-lines / thresholds / stage-strategy）、booking 规则片段、条件式尾部块、出站守卫 hard-rules。
> 维护纪律见文末；**新增/修改/删除任何 prompt 侧规则的 PR，必须同批更新本台账对应行**。

## 约束放置判定树（分类轴，2026-08-21 裁定 7；2026-08-26 补发送前防线分支）

```
新约束 →
├─ 出站结果形态可确定性判定（假宣称/泄漏词等）→ 守卫 hard-rule（只拦完成时态）
└─ 生成时行为约束：
   ├─ 与单一工具强绑定 → 该工具 description
   ├─ 与单一阶段强绑定 → stage-strategy（DB）
   ├─ 业务政策级人格/红线（业务不允许什么）→ red-lines（DB）
   ├─ 发送前反幻觉自检/禁令（常驻或按轮命中）→ final-check 统一规则表（trigger 属性区分 always/turn）
   └─ 跨工具的操作规程 → 手册
铁律：同一约束只准住一处；"教"（prompt）与"拦"（守卫）允许成对存在，但必须在本台账互链。
红线 vs final-check 的语义边界（2026-08-26 合居所裁定）：红线承载业务政策（对外承诺口径、业务底线），
运营语义、留 DB；final-check 承载反幻觉内部教（贴工具事实说话的自检与禁令），工程语义、住代码。
```

## 居所索引（终态）

| 居所                     | 载体                                                 | 变更纪律                                     | 终态快照（2026-08-26）                                                       |
| ------------------------ | ---------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------- |
| 仓内 procedural sections | `src/agent/generator/context/sections/procedural/`   | PR + review；每个 `.ts/.md` 必须带本台账锚点 | 手册 74,654B；final-check 统一规则表 27 条（18 always + 9 turn）；其余见下表 |
| 工具 description         | 各 tool 文件内 DESCRIPTION                           | 代码 PR；规则贴唯一工具消费者                | 13 个常挂工具；一期压缩基线 31,729→26,738 字符，后续随功能演进               |
| DB red-lines/thresholds  | `strategy_config.red_lines` / `thresholds`           | Dashboard 可改；变更须同批补台账/changelog   | 10 条现行红线 + 2 阈值                                                       |
| DB stage-strategy        | `strategy_config.stage_goals`                        | Dashboard 可改；released/testing 双行同步    | 5 阶段，当前阶段动态渲染                                                     |
| 条件式规则块             | booking 共享规则 / input-guard / proactive-directive | 代码 PR                                      | 都留在 system；按上下文条件出现                                              |
| 守卫 hard-rules（拦侧）  | `src/agent/guardrail/output/rules/`                  | 代码 PR                                      | 32 个 `ruleId`                                                               |

`PROMPT_SECTION_DOMAIN_REGISTRY` 是 teaching/evidence/tool_result 的语料域轴，用于指令—数据分离；
它与本台账的 procedural/semantic/working 知识类型轴正交，不合并、不互相替代。

## 零、现行 procedural sections 与装配位

`candidate-consultation` 的 section 终序如下：

`identity` → `base-manual` → `channel` → `stage-overview` → `red-lines` → `thresholds` →
`memory` → `turn-hints` → `hard-constraints` → `datetime` → `group-inventory` →
`stage-strategy` → `final-check`（复合 section）

section 清单到 `final-check` 结束，`critical-turn-guard` 已不是独立 section。`final-check`
复合 section（发送前防线统一规则表，2026-08-26 合居所）经 `buildBlocks` 固定产出
`final-check` 常驻块，并在规则命中时追加 `critical-turn-guard` 子块。所以 `promptBlocks`
的观测末尾在命中时仍是 `final-check → critical-turn-guard`；这是块级展开，不是两个 section。
块 id 与模型可见字节与合并前一致。
其中 `memory` 至 `group-inventory` 是 semantic/working 数据段，不是程序性规则的新居所；列在这里仅为说明
完整装配相对位置。所有段仍渲染到 system，动态内容不进入 messages。准备阶段若命中输入注入风险，
`input-guard` 插在 `critical-turn-guard` 块之前；主动修订指令 `proactive-directive` 作为条件式 system 尾块追加。

| section id            | 程序性知识职责                                                                       | 稳定档/装配依据                                                       |
| --------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| `identity`            | agent 人设、账号身份与边界                                                           | 开篇人设；低频配置档前置无缓存代价                                    |
| `base-manual`         | 跨工具操作规程与全局行为手册                                                         | 稳定静态段                                                            |
| `channel`             | 群聊/私聊渠道规范                                                                    | 稳定静态段                                                            |
| `stage-overview`      | 全阶段一览与推进协议                                                                 | 全阶段静态一览，不随当前阶段移动                                      |
| `red-lines`           | 跨阶段策略红线                                                                       | DB 配置段                                                             |
| `thresholds`          | 回复字数、推荐距离等策略阈值                                                         | DB 配置段                                                             |
| `stage-strategy`      | 当前阶段目标、必做与禁做                                                             | 随阶段变化的动态尾部                                                  |
| `final-check`（复合） | 发送前防线：常驻 recitation 自检块（次末位收口）+ 关键轮次命中式动态硬禁令块（末位） | `stage-strategy` 后；两块 id 为 `final-check` / `critical-turn-guard` |

### final-check turn 规则明细（本轮动态硬禁令）

载体：`src/agent/generator/context/sections/procedural/final-check.section.ts`
`FINAL_CHECK_RULES` 中 `trigger='turn'` 的条目。合居所前它们有独立 section 载体；合并后
规则 id、block id 与模型可见字节保持不变。

这些规则不是常驻 prompt：系统只对本轮消息（`current`）或“近 12 条消息 + 本轮”
（`combined`）做确定性匹配；命中后才在 system 末尾生成 `# 本轮动态硬禁令`。多条可同时命中。

- `job_detail_missing_field_lookup`
  - **命中**：`current`；候选人追问薪资、班次、福利、门槛、地址、工期等岗位字段。
  - **作用**：缺字段时按当前 `jobId` 重查；薪资、结算、福利、班次即使摘要已有也实时重查，禁止靠常识、旧话术或其他岗位推断。

- `schedule_constraint_precheck_first`
  - **命中**：`current`；候选人提出每周天数、做一休一、只周末、不上夜班、可下班时间等硬约束。
  - **作用**：先用 precheck 或 job-list 校验岗位，再确认可行性；校验前禁止说“没问题/资料收到了”或继续收资。

- `interview_date_precheck_first`
  - **命中**：`current`；候选人指定某天面试。
  - **作用**：必须以指定日期调用 precheck 后才能承诺；岗位不明确时先确认岗位，禁止擅自换日期或继续收整套资料。

- `interview_time_only_precheck_first`
  - **命中**：`current`；日期在上文，本轮只说“三点过去/三点吧”等钟点。
  - **作用**：重新按上文日期 precheck，防止沿用已过截止时间的旧承诺；不可约时给真实可约时段。

- `health_cert_is_not_major`
  - **命中**：`combined`；上下文同时出现健康证与专业筛选。
  - **作用**：阻止把健康证误当专业证明；先确认真实专业，禁止据此拒绝预约或虚报已拉群。

- `post_interview_no_rebook`
  - **命中**：`combined`；已面试、已通过、入职、报到、门店联系或只能保留一家店。
  - **作用**：禁止流程倒退到重新收资、约面或荐岗；状态异常与门店选择优先转人工。

- `submitted_form_no_refill`
  - **命中**：`current`；本轮已提交电话及年龄、学历、面试时间等资料。
  - **作用**：承接已给字段并原样保留时间，禁止让候选人重填整表或退回“发地址查岗”入口。

- `salary_account_no_fabricated_policy`
  - **命中**：`combined`；讨论银行卡、税务、发薪主体或本人卡异常。
  - **作用**：禁止编造“公司统一规定”或承诺门店可变通；本人卡存在异常时转人工确认，不继续强推约面。

- `location_reference_needs_grounding`
  - **命中**：`combined`；近邻上下文含位置、住处或地址线索。
  - **作用**：使用“这家/刚才那家/附近岗位”时必须写清门店或地址，并以本轮工具、焦点岗位或预约信息为依据。

---

## 一、手册 candidate-consultation.md

> 行号为 2026-08-21 快照；来源锚点均以 HTML 注释内联在手册对应行（`stripMaintainerComments` 加载时剥离）。
> 时效性未标注 = 常设。
> **手册批（2026-08-21）**：注入口径 28,357→27,366 字符。① B2 豁免细节/B6 重查机制/G4 regionNameList 细则归并 `duliday_job_list` 描述唯一居所——其中 B2 手册版"不传 range"与描述"保留 range 显式放大"**口径冲突且落后**，是双居所口径漂移实证；② B3 searchJobName 参数机制归 schema 说明；③ 结构件去重："阶段不压当前问题"4 遍→2、advance_stage 调用纪律 2 遍→1、"不暴露内部"3 遍→2、[本轮解析线索/待确认线索] 双重定义→1。B6 三居所一致性测试同步改锚。

### 决策栈与全局工作原则（G）

| #     | 规则摘要                                                                    | 来源                                     | 加入    | 备注                                                   |
| ----- | --------------------------------------------------------------------------- | ---------------------------------------- | ------- | ------------------------------------------------------ |
| D1    | 决策优先级栈（红线>硬约束>工具硬规则>全局原则>阶段策略>人格）+ 禁横跳反模式 | 架构设计                                 | —       | 结构件，非业务规则                                     |
| G1    | 先答候选人当前最明确的问题                                                  | 通用                                     | —       |                                                        |
| G2    | 事实信息必须工具获取；禁扭曲候选人意向假装匹配                              | 通用                                     | —       |                                                        |
| G2a   | 福利/薪资细则追问必须实时重查（记忆只用于定 jobId）；阶梯薪资照括注原文     | 2026-08-06 周报（阶梯算法 3 次误转人工） | 2026-08 |                                                        |
| G3    | 有岗/没岗判断必须先调 job_list，零查岗禁断言                                | badcase 6a32317a                         | —       | 工具 description 与主 Agent final-check 承担            |
| G4    | 位置线索处理链：坐标直用/文字先 geocode/行政区默认按位置/城市三步判定       | badcase 6a3356e2                         | —       | 教/拦配对：无                                          |
| G4a   | 城市一旦确认禁再反问城市                                                    | badcase 簇                               | —       |                                                        |
| G5    | 地址追问→send_store_location + 面试形式先核对                               | 工具语义                                 | —       | 与 BK6 成对（booking 场景）                            |
| G6/G7 | 阶段策略不压当前问题；跨阶段先判断再 advance_stage                          | 架构设计                                 | —       | 结构件                                                 |
| G8    | 流程问题正常化解释，不说"系统需要"                                          | 人设                                     | —       |                                                        |
| G9    | 先接情绪再解释                                                              | 人设                                     | —       |                                                        |
| G10   | 禁重复已告知信息；"答完就收"反模式                                          | badcase 簇                               | —       | 仅逐字长段落由 sanitizer 精确去重                       |
| G11   | 岗位推荐规格→job_list description 为准                                      | 分层裁定（05 文档）                      | —       | **指针条目，非重复**                                   |
| G12   | 收资/约面前置→precheck/booking description 为准                             | 分层裁定                                 | —       | **指针条目，非重复**                                   |
| G13   | 多问题合并一条消息分点答                                                    | 体验                                     | —       |                                                        |
| G14   | 禁旁白/舞台指示；不回复唯一合法动作是 skip_reply                            | badcase 6a5740ff                         | —       | 拦侧配对：`meta_narration_reply`                       |

### 昵称与称呼（N）

| #     | 规则摘要                                       | 来源                                 | 加入       |
| ----- | ---------------------------------------------- | ------------------------------------ | ---------- |
| N1-N3 | "我是XX"是验证语；裸句非品牌意图；中途才按字面 | 渠道机制                             | —          |
| N4    | 昵称字面非候选人事实；纯数字绝不当年龄         | badcase 6a69674e（昵称"18"读成年龄） | 2026-07-29 |
| N5/N6 | 禁称呼昵称；真名也不当称呼喊                   | badcase 簇                           | —          |
| N7    | 特殊形态姓名不质疑真伪                         | 口径                                 | —          |
| N8    | 开场白不自报家门，首问地址                     | 与 stage_goals trust_building 呼应   | —          |

### 品牌/品类粒度（B）

| #   | 规则摘要                                                 | 来源                         | 加入    | 时效                                 |
| --- | -------------------------------------------------------- | ---------------------------- | ------- | ------------------------------------ |
| B1  | 咖啡类默认 M Stand，不展开全品类                         | 业务配置（品类词仅咖啡开启） | 2026-08 | ⚠️ 随品类配置变化，配置变更时须同步  |
| B2  | 点名品牌豁免距离上限；0 条先放宽重查再下"无岗"结论       | badcase 簇                   | —       | 拦侧配对：`requested_brand_mismatch`（observe 哨兵，2026-08-26 恢复） |
| B3  | 点名门店/地标用 searchJobName 模糊召回，禁 storeNameList | storeNameList 精确匹配特性   | —       |                                      |
| B4  | 企微备注品牌 = 点名品牌同等待遇                          | 运营流程                     | —       |                                      |
| B5  | 跨门店转化用"连锁就近"暖话术                             | 体验                         | —       |                                      |
| B6  | Agent 主动推荐 ≠ 候选人品牌硬约束；不符时去品牌重查      | badcase 簇                   | —       |                                      |

### 性别识别与确认（S）

| #   | 规则摘要                                     | 来源                                   | 加入 | 备注                                                  |
| --- | -------------------------------------------- | -------------------------------------- | ---- | ----------------------------------------------------- |
| S1  | gender 双来源（自陈高信/系统兜底低信）       | 数据链路设计                           | —    |                                                       |
| S2  | 禁凭昵称/头像/文风推断性别                   | 口径                                   | —    |                                                       |
| S3  | 兜底性别只随收资表内顺带求证，禁单独确认问题 | 收资状态机（genderInlineConfirmation） | —    | ⚠️ 状态机 D5 退役观测中，契约 v2 落地后本条应随之收缩 |
| S4  | 兜底性别不得用于直接拒绝候选人               | badcase 簇                             | —    |                                                       |

### 事实一致性红线（F）

- `F1` — 「独立客」身份统一口径；独立日、杜力岱、DuLiDay 是同一主体。
  - **来源**：品牌裁定。

- `F2` — 关键事实以最新工具结果为准；说错后必须道歉并纠正。
  - **来源**：通用原则。

- `F3` — 禁止承诺保留名额或保证岗位未来仍可报名。
  - **来源**：badcase `6a266b51`（办证 3 天后岗位下架投诉）。
  - **拦侧配对**：`quota_promise`。

- `F4` — 候选人尚未报名时，不引导其自行到店。
  - **来源**：badcase `2cz1o1nd`、`wlterrb1`，回归 `P865-09`；**加入**：2026-08-04。

- `F5` — “组合排班”不等于周频；禁止虚构每周出勤门槛。
  - **来源**：回归 `SCN-P862-SCHEDULE-01`；**加入**：2026-08-05。
  - **拦侧配对**：`combination_schedule_weekly_generalization`。

- `F6` — 餐饮岗位一律需要健康证；禁止编造办理阶段比例。
  - **来源/加入**：2026-08-05 业务口径。
  - **关联**：拦侧 `health_certificate_generalization`；与 DB 红线 R3 成对。

- `F7` — 健康证费用约 100 元、自费、不免费，默认不报销。
  - **来源**：badcase `d29laq3e`、`kzut0et8`，08-06 运营口径；**加入**：2026-07-28。

- `F8` — 电子健康证与纸质健康证同等有效；默认需要应聘城市本地证。
  - **来源/加入**：2026-08-06 运营口径。

- `F9` — 查岗结论必须先查后说；“愿意帮查”不等于岗位存在性承诺。
  - **来源**：回归簇。

- `F10` — 禁止编造系统状态或报错；报名成败只看 booking 返回。
  - **来源**：badcase 簇。
  - **拦侧配对**：`booking_promise_without_booking`、`booking_receipt_mismatch`。

- `F11` — 禁止替候选人填写收资字段；年龄尤其不能拿岗位上下限兜底。
  - **来源**：badcase（把岗位上限 50 当成候选人年龄）。
  - **代码兜底**：状态机公证拒收；precheck 唯一答案入口 `formAnswers` 必须使用契约
    labelTitle，并以候选人 quote 作证。

- `F12` — 工作内容只按工具字段回答，禁止用行业常识泛化。
  - **来源**：badcase（“六姐洗碗”）。
  - **拦侧配对**：`ungrounded-generalizations` 族。

- `F13` — 备注里的时间限定按当前日期解析；过期内容不复述。
  - **来源**：业务口径。

- `F14` — 同一条 reply 禁止自相矛盾。
  - **来源**：badcase 簇。

- `F15` — 班次不得截短，也不得改写成岗位未列出的时段。
  - **来源**：badcase 簇。
  - **拦侧配对**：无；由岗位结构化字段与主 Agent final-check 承担。

- `F16` — 禁止臆测门店开业或筹建状态。
  - **来源**：badcase（新店未开却改派面试）。
  - **拦侧配对**：`unsupported_store_status_speculation`。

- `F17` — 按班次硬约束过滤岗位时必须向候选人解释；做一休一不等于低周频。
  - **来源**：badcase + v10.38.0 回归。

- `F18` — 岗位要求“每周 N 天”时，必须主动确认候选人的出勤能力。
  - **来源**：badcase。

- `F19` — 用工形式按两级字段如实介绍；不复述“正式工/临时工”标签；过滤为空时如实说明。
  - **来源**：业务口径。
  - **居所状态**：DB 红线 R13 已删，本条是唯一 prompt 居所。

- `F20` — 暑假工是单向硬约束：候选人拒绝后立即收口，禁止劝转。
  - **来源**：用户裁定；**加入**：2026-07。
  - **TTL**：2026 暑期语境，暑期结束（约 2026-09）复查是否降档。

- `F20a` — 暑假工状态默认“否”，禁止主动盘问。
  - **来源/加入**：同 F20。
  - **拦侧配对**：无；由 `labor_form_intent` 与主 Agent 承担。

- `F21` — 不主动反问“全职还是兼职”。
  - **来源**：体验原则。
  - **居所状态**：DB 红线 R13 已删，本条是唯一 prompt 居所。

- `F22` — 转正或转全职必须有岗位字段支撑，否则转人工。
  - **来源**：岗位数据缺口口径。

### 常见场景（C）

| #   | 规则摘要                                                             | 来源                                                        | 加入       |
| --- | -------------------------------------------------------------------- | ----------------------------------------------------------- | ---------- |
| C1  | 历史面试结果追问→立即 handoff(interview_result_inquiry)              | badcase 簇                                                  | —          |
| C2  | 先筛后推：可公开硬门槛推荐前对照、收资前确认；身份筛选不上卡片       | badcase fazpqciu + 2026-08-04 用户两次裁定                  | 2026-08-04 |
| C3  | 硬条件拒绝先承接再换岗；年龄按 ageBoundary.severity；禁通融话术      | badcase 簇                                                  | —          |
| C4  | 多品牌召回时推荐覆盖不同品牌                                         | badcase 028k7uuh                                            | —          |
| C5  | 候选人坚持申明不同城市→停下核实                                      | badcase fkl0frbr                                            | —          |
| C6  | 唯一选项禁复读"只有 X"；挖需求换轴或坦诚收口                         | badcase 43b1b6tq + 6a337d86                                 | —          |
| C7  | 面试方式严格按字段；线上面试不跳过不改线下；AI 面试预约时段≠到点开考 | badcase recvkB7fIV5IYb / recvlz8I1TqTM1 / recvpYfDLkx4Fz 等 | —          |
| C8  | 候选人自曝造假只引导如实；必须含"不能续假+更正登记"两点              | badcase scyjp2kx                                            | —          |
| C9  | 报名前必须确认具体工种                                               | badcase recvkHEkJ4HygC                                      | —          |

### 话术节奏与敏感约束（T）

- `T1` — 禁止分批收资；字段范围以 precheck 的 `requiredFieldsToCollectNow` 为准，发出时
  逐字照发同次返回的 `templateText`，不得改写标签、增删或重排行。
  - **来源**：报名率数据。
  - **状态**：2026-08-21 已对齐收资状态机，progressive 由状态机裁决。
    2026-08-26 精简 bookingChecklist：progressive 降级实测无任何启用路径，`starterFields`/`displayOrder`
    已从工具返回删除（守卫审查包读的 `collectionStrategy.starterFields` 是从不存在的幽灵形状，同批清理）；
    筛选字段集只保留 `bookingChecklist.screeningFields`（纯 labelTitle），顶层 `contractScreeningFields`
    双编码连同 labelId 一并删除（labelId 是内部主键，模型无权使用，见 §5.5 标签协议裁定）。

- `T2` — 发出收资表后，候选人插问岗位细节时不要重发整表。
  - **来源**：体验原则。

- `T3` — 不重复介绍同一岗位的信息。
  - **来源**：体验原则。

- `T4/T5` — 出现回避信号时软收尾；候选人给出收尾词后立即收尾。
  - **来源**：体验原则。

- `T6/T7` — 回复保持简洁；把封闭式追问改成开放式表达。
  - **来源**：体验原则。

- `T8` — 地域、籍贯、民族、专业、婚育等敏感门槛禁止询问和透露；拒绝理由保持中性，敏感拒绝后禁止翻案。
  - **来源**：badcase `weurg1xg`。
  - **拦侧配对**：`discriminatory_screening_leak`、`sensitive_origin_probe`。
  - **居所状态**：DB 红线 R11 已删，本条是唯一 prompt 居所。

- `T9` — 不主动提保险或社保；`haveInsurance` 与社保准入是两套概念。
  - **来源/加入**：2026-08-06 运营口径。
  - **拦侧配对**：`proactive_insurance_policy_mention`（observe 哨兵，2026-08-26 恢复）。

- `T10` — 关键用工事实无法确认时，必须当轮转人工；禁止只说“帮你确认下”却不转。
  - **来源**：badcase 簇。
  - **居所状态**：冲突旧口径 DB 红线 R2 已删，本条与 T11 承载现行口径。

- `T11` — 发薪和签约主体按“合作模式”字段结论回答；禁止提 BPO/RPO。
  - **来源/加入**：2026-08-06 运营口径 + 海绵 `cooperationMode` 字段。

- `T12` — 月薪岗位不折算时薪；每日工时按排班字段回答。
  - **来源/加入**：2026-08-06 运营口径。

- `T13` — 发薪方式的合规硬边界是仅使用本人银行卡；候选人不能接受时暂停推进。
  - **来源**：badcase `gg4x4eo7`、`1ujkxxm6`。

- `T14` — 改期必须先 precheck 再 modify；连续两轮时间硬冲突时调用 `handoff(modify_appointment)`。
  - **来源**：badcase `7jkfh83r`、`kjc5877z`。
  - **居所状态**：`stage_goals.interview_scheduling` 的重复末条已删；与 BK2 成对。

- `T15` — 已拒绝条件是跨轮硬负向约束；推进冲突岗位前必须显式提示。
  - **来源**：badcase `yno1y9ir`。

### 平台来源识别（P）

| #   | 规则摘要                                                 | 来源                        | 加入 |
| --- | -------------------------------------------------------- | --------------------------- | ---- |
| P1  | 平台名=渠道来源补充，不否认不澄清                        | 体验                        | —    |
| P2  | 截图归属用品牌+门店+班次+薪资比对，禁凭发布方否认        | badcase 6a38f7e6            | —    |
| P3  | 跃橙云服=我方发布主体                                    | 业务事实                    | —    |
| P4  | 截图信息是"候选人看到的版本"；截图联系方式永非候选人本人 | badcase vkikct39 / umr69uqq | —    |
| P5  | 截图他人信息不复述                                       | PII 纪律                    | —    |

### 裸查询承诺（Z）

| #   | 规则摘要                                                | 来源                      | 加入       | 备注                               |
| --- | ------------------------------------------------------- | ------------------------- | ---------- | ---------------------------------- |
| Z1  | 禁"我帮你查下"将来时单独成回复；完成时态+实质内容才合法 | badcase 6a69ba9f/6a69be5c | 2026-07-29 | 拦侧配对：`dangling_reply_promise`（observe 哨兵，2026-08-26 恢复） |

### 结构件（不逐条登记）

回合 SOP（5 步）、阶段策略使用规则、记忆使用规则三节是**流程结构教学**，随架构演进整节更新，不按规则粒度登记。

---

## 二、booking 上下文共享规则（条件式规则片段）

载体：`src/agent/generator/context/sections/semantic/memory.section.ts` `BOOKING_CONTEXT_SHARED_RULES`
（2026-08-21 P1-2 起 N 条 booking 只渲染一次）。它因依赖预约上下文随 memory 呈现，知识性质仍是程序性规则。

- `BK1` — 多岗可并行报名；同工单禁止重复提交。

- `BK2` — 改约先 precheck 后 modify；面试前放弃必须 cancel；**过时未到 = 爽约，禁止 cancel**。
  - **关联**：与 T14① 成对；BK 版在“有预约”轮次必然在场，是主承载。

- `BK3` — 「面试时间」已经给出时，禁止说仍在等排期；过期且状态未知时必须先核实。
  - **拦侧配对**：`interview_time_change_unconfirmed`。

- `BK4` — 预约可能并非当前 agent 本人经手；不要主动提及这一内部事实。

- `BK5` — 阻塞场景必须调用 `request_handoff`。
  - **关联**：与 `stage_goals.onboard_followup` 呼应。

- `BK6` — 先核对面试形式；线上面试禁止发送门店定位。
  - **拦侧配对**：`online_interview_location_claim`；与 G5、FC1 成对。

## 三、final-check always 规则（发送前自检，固定次末位 ≈ recitation）

载体：`src/agent/generator/context/sections/procedural/final-check.section.ts` `FINAL_CHECK_RULES`
中 `trigger='always'` 的条目（**2026-08-26 合居所裁定**：原 `candidate-consultation-final-check.md`
与 critical-turn-guard 规则表合并为同一张规则表，渲染字节与合并前逐字节一致；md 资产退役。
语义轴同判定树：红线=业务政策留 DB，本表=反幻觉内部教住代码）。18 条 always 规则按三分组渲染，
FC 编号保留为历史别名：

**普适元规则**

- `answer_current_question_first`（历史 FC17①）— 先答候选人当前最明确的问题。
- `obey_dynamic_red_lines_thresholds`（历史 FC17②）— 遵守动态注入的红线与业务阈值。
- `act_on_covering_rule_directly`（历史 FC17③）— 有明确覆盖条款时直接执行，不横跳权衡。

**承诺—工具一致性**

- `store_location_send_consistency`（历史 FC1）— 说发定位必须本轮真调 `send_store_location`，且先核面试形式。
- `future_booking_promise_grounding`（历史 FC3）— 未来预约保证须有工具证据；等证场景全部删除。
- `cert_flexible_job_existence`（历史 FC4）— “先面试后补证岗位”的存在性断言必须先查 job-list。
- `job_pool_vs_interview_group`（历史 FC5）— 兼职群不等于面试群；区分两群并保持本人连续口径。
- `quota_reservation_promise`（历史 FC6）— 删除名额保留与未来可用性保证。
- `distance_number_grounding`（历史 FC7）— 距离数字必须来自本轮工具结果。
- `salary_worktime_fact_grounding`（历史 FC8）— 结算周期、发薪日、工时等必须逐字对应本轮工具返回。
- `combo_schedule_two_dimensions`（历史 FC9）— 组合排班与每周天数是独立维度，禁止泛化。
- `health_cert_general_answer`（历史 FC10）— 一般询问使用健康证统一口径，禁止编造比例结论。
- `salary_told_before_collection`（历史 FC11）— 收资或推进约面前必须已经告知薪资、班次。
- `time_unsuitable_clarify_first`（历史 FC12）— “时间不合适”先澄清是工作班次还是面试时间。
- `residency_gate_no_leak`（历史 FC13）— 内部户籍、地域门槛不透露，也不改名泄漏。
- `walkin_without_signup_closure`（历史 FC14）— 暂不报名立即收口，不附和候选人自行到店。

**表达自检**

- `no_internal_terms_no_nickname`（历史 FC15）— 不出现系统、后台等内部表述，不复读昵称。
- `per_sentence_dedup`（历史 FC16）— 逐句扫描，删除上一轮已经说过的内容。

**装配裁定（2026-08-26）：场景清单以 `final-check` 复合 section 收口。它在 `stage-strategy` 之后固定产出常驻 recitation 自检块；命中本轮规则时，同一 section 再追加 `critical-turn-guard` 动态子块。精简须按 recitation 视角，勿并入稳定前缀。**
**P3-2 首批执行（2026-08-21，用户裁定跳过生产数据等待）**：✅ FC2 整条删除、FC5 完成时态前半删除——守卫 `booking_promise_without_booking`/`booking_receipt_mismatch`/拉群假宣称确定性拦侧在产 + 手册 F10 教侧仍在，三居所去其一（recitation 复核面）；context.service.spec 断言同步翻转。

## 四、DB red-lines（strategy_config.red_lines，Dashboard 可改零 review）

| #   | 规则摘要                              | 状态                                                                                                                      |
| --- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| R1  | 咖啡→M Stand 默认                     | ✅ **已删（2026-08-21 F5 裁定执行）**：与手册 B1 双居所重复，B1 为唯一居所（released+testing 双行同步，changelog 已补录） |
| R2  | 发薪/工资不确定只说"我帮你确认下"     | ✅ **已删（2026-08-21 F5 裁定执行）**：与 T10/T11 口径冲突的旧口径残留，现行口径以 T10/T11 为唯一居所                     |
| R3  | 健康证默认宽口径（先面试录用后办）    | 与手册 F6 成对：F6 已明确本红线只用于已确认岗位的约面流程。保留，边界互链                                                 |
| R4  | 结伴求职分流方案                      | 唯一居所，保留                                                                                                            |
| R5  | "店长会联系吗"→后续由我们跟进         | 唯一居所，保留                                                                                                            |
| R6  | 已约面阶段社保问题口径                | 与 T9 相邻不重复（T9 管主动提及，R6 管已约面被问）。保留                                                                  |
| R7  | "能直接到店报名吗"→线上流程引导       | 与手册 F4 相邻：F4 管"不引导到店"，R7 管被问时话术。保留，互链                                                            |
| R8  | "成都你六姐"是完整品牌名仅上海在招    | ✅ **TTL 已标注（2026-08-21 挂账批）**：DB 原文已加"开城即失效需更新本条"                                                 |
| R9  | 禁跨城市推荐                          | 唯一居所，保留                                                                                                            |
| R10 | 禁通融式推荐                          | ✅ **已删（2026-08-21 挂账批）**：手册 C3 为唯一居所（更全，含 ageBoundary 走向）                                         |
| R11 | 地域筛选对外中性婉拒                  | ✅ **已删（2026-08-21 挂账批）**：手册 T8 为唯一居所 + 拦侧 discriminatory_screening_leak 在产                            |
| R12 | 禁 markdown 输出                      | 唯一居所，保留                                                                                                            |
| R13 | 用工形式按字段如实介绍+不主动反问全兼 | ✅ **已删（2026-08-21 F5 裁定执行）**：与手册 F19+F21 逐字重复，手册为唯一居所                                            |
| R14 | 拟人化保密（禁 AI/系统/机器人词）     | 唯一居所（人格类），保留。拦侧配对：`human_service_phrase_leak`                                                           |
| R15 | 刑事/失信信号→立即 handoff            | 唯一居所，保留                                                                                                            |
| TH1 | 推荐距离上限 10km                     | 阈值，保留                                                                                                                |
| TH2 | 单次回复 120 字上限                   | 阈值，保留                                                                                                                |

## 五、DB stage-strategy（strategy_config.stage_goals，5 阶段）

| 阶段                 | 审计发现                                                                                                                                              |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| trust_building       | ✅ disallowed"渠道来源身份否认"**已删（2026-08-21 F5 裁定执行）**，手册 P1 为唯一居所；"首问地址"教学与手册 N8 呼应（各有侧重，保留）                 |
| qualify_candidate    | 无重复，健康                                                                                                                                          |
| job_consultation     | "无岗时 invite_to_group"与 job_list description 无岗动作链重叠（观察项）；包餐偏好重查是唯一居所                                                      |
| interview_scheduling | ✅ 收资字段范围已改为 `requiredFieldsToCollectNow`；✅ 末条“2 轮时间硬冲突→handoff”已删，T14 为唯一居所；✅ “今天可以吗必须先 precheck”段内重复已收敛 |
| onboard_followup     | 与 BK5 呼应（阶段管方向、BK 管动作），保留                                                                                                            |

> **F5 与挂账收官均已执行（2026-08-21）**：5 处铁律违例/旧口径删改及后续小项全部落地——
> `interview_scheduling` 字段范围/段内重复已修，R8 已标 TTL，R10/R11 已收敛；released+testing 双行同步，
> `strategy_config_changelog` 已留痕。当前 red-lines 为 10 条现行规则，无本批遗留挂账。长效机制裁定：
> 策略文本编辑主体只有我们（用户+AI 会话），不加 Dashboard 侧额外约束；AI 侧台账登记纪律（F1）覆盖。

## 六、工具 description（章节级登记）

| 工具                                           | 字符数                                       | 内容轮廓                                            | 台账备注                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------- | -------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| duliday_job_list                               | ~~13,144~~ **8,515**（三批累计 -35.2%）      | 召回策略/无岗动作链/展示纪律                        | ✅ 首批去重（→11,481）：regionNameList 三遍合一、展示要求围绕卡片铁律收敛、福利追问并入通用补查、阶梯原文/保险社保/同岗不重复归唯一居所、badcase 叙事压缩。✅ 二批接口化（→10,126）：**数据开关章节坍缩**——开关早已 schema default(true)（代码接管），提示词仍教手动开关是烂源四标本，删除开关表 + 4 处"必须开 includeX"无效指令；班次语义两条合一、阶梯口径两条合一、学生两条合一 |
| request_handoff                                | ~~4,388~~ **4,026**（2026-08-21 二批 -8.3%） | reasonCode 15 枚举语义/触发契约                     | ✅ 二批：两轮拉群协议 bullet 删除（invite 场景 2+禁止触发为唯一居所；job_list 653 无岗链保留自身步骤）、no_group_in_city 例外同文档内去重（归场景 8）、空头承诺禁令压缩（手册 T10 为教侧主居所）、场景 7 示例精简。15 枚举判别语义为主体，已是接口化形态                                                                                                                           |
| invite_to_group                                | 3,804+                                       | 拉群时机/两轮协议/城市门/群库操作约束               | 拉群时机簇 0820 新口径已入。**2026-08-26 收尾批**：group-inventory 的 4 条操作约束原文迁入本 description，动态 section 收窄为纯平台资源数据；拉群协议与 errorType 处置继续以此为唯一居所。                                                                                                                                                                                         |
| geocode                                        | 2,221                                        | 三态返回/通用后缀黑名单                             | 手册 G4 引用其黑名单（指针健康）                                                                                                                                                                                                                                                                                                                                                   |
| duliday_cancel_work_order                      | 2,000                                        | 取消契约                                            | 与 BK2 成对                                                                                                                                                                                                                                                                                                                                                                        |
| duliday_modify_interview_time                  | 1,810                                        | 改约契约                                            | 与 T14/BK2 成对                                                                                                                                                                                                                                                                                                                                                                    |
| skip_reply                                     | 974                                          | 沉默场景                                            | 与 G14 成对                                                                                                                                                                                                                                                                                                                                                                        |
| send_store_location                            | 829                                          | 定位发送                                            | 与 G5/BK6/FC1 成对                                                                                                                                                                                                                                                                                                                                                                 |
| duliday_interview_precheck                     | ~~807~~ **896**                              | 参数纪律/行动纪律（收资状态机接管后保持精简）       | **唯一 `formAnswers` 入参与逐字照发模板的公开契约**。2026-08-27 requestedDate 纪律补一句"期望面试时间只走 requestedDate、不进 formAnswers；定位失败条目见返回 unmatchedAnswers"（来源：0826 生产回放，5% 可判定答案把面试时间误投 formAnswers 被静默丢弃）；教侧这一句与代码侧确定性转运 + unmatchedAnswers 回执成对，长期有效。2026-08-26 返回体同步精简：bookingChecklist 删 displayOrder/starterFields，顶层 contractScreeningFields 双编码删除 |
| risk_alert / advance_stage / recall_history 等 | ≤620                                         | —                                                   | 健康                                                                                                                                                                                                                                                                                                                                                                               |

## 七、守卫 hard-rules（拦侧，19 ruleId）

本节是 Prompt 教侧与 Output 拦侧的**配对索引**，不是把 hard-rules 算进 Prompt 执行器。
完整防线有 Input / Prompt / Tool / Output 四个作用位：本台账治理 Prompt，下面 19 个 ruleId
由 `OutputGuardrailService` 执行；教/拦可以配对，但权限与唯一权威各自独立。

执行档（revise/block，14 条）：`invalid_model_output`、`internal_output_leak`、`meta_narration_reply`、
`identity_misregistration_coaching`、`experience_fraud_coaching`、
`discriminatory_screening_leak`、`sensitive_origin_probe`、`quota_promise`、
`online_interview_location_claim`、`unsupported_store_status_speculation`、
`booking_receipt_mismatch`、`interview_time_change_unconfirmed`、
`brand_alias_fuzzy_match_ignored`、`human_service_phrase_leak`。

observe 哨兵（只落档不拦截，5 条，2026-08-26 数据复核恢复）：`dangling_reply_promise`、
`requested_brand_mismatch`、`settlement_cycle_mismatch`、`proactive_insurance_policy_mention`、
`booking_done_claim_without_submission`（新哨兵，接替 `booking_promise_without_booking`
的完成时态缺口；将来时口径经生产抽样证实几乎全命中合法收资话术，不恢复）。

精确重复由 sanitizer 处理，handoff 承诺由 turn outcome/副作用对账处理，日期与结构一致性由
既有格式化与 repair regression gate 处理；它们不再登记为 Output ruleId。开放式事实、承诺、
岗位质量和语气判断由现有主 Agent 理解承担，不启用第二个 reviewer。

2026-08-26 恢复裁定：规则简化改造后按近 7 天生产数据逐条复核，`human_service_phrase_leak`
仍有真阳人设露馅（封闭词形零误报史）予以恢复执行档；4 条有信号量的 observe 哨兵恢复落档；
`job_detail_lookup_required`（宽口径噪音 200 次/周）、`date_reference_mismatch`（抽样全为
日期正确记录）、零命中规则族和语义审查器维持删除。

教/拦配对已在上文各表"拦侧配对"列互链。守卫规则的增删遵守既有裁定：只拦完成时态假宣称；大规模重加已被 7-10 月下线史否决。

---

## 维护纪律（F1~F3 落地条款）

1. **登记即门票**：任何往手册/description/DB 策略/守卫加规则的变更，必须同批在本台账登记：摘要、来源（badcase id / 裁定 / 运营口径 + 日期）、加入日期、时效性。无登记的规则变更 review 应打回。
2. **放置先过判定树**：登记前按文首判定树选唯一居所；发现将造成双居所的，先归并再登记。教/拦成对允许，必须互链。
3. **临时规则必须标 TTL**（F3）：带时效的口径（季节性、开城状态、活动期）必须写明"过期条件/复查日期"，过期即删。当前带 TTL 条目：F20/F20a（暑假工，≈2026-09 复查）、B1（随品类配置）、R8（随开城）。
4. **职责迁移必须回收**（F2）：代码/状态机接管某行为的 PR，必须同批删除 prompt 侧对应教学并更新本台账（先例：precheck 描述 13.5K→729）。
5. **删除也要留痕**：删规则时不删台账行，改标 `~~已下线（日期+原因）~~`，保留证据链。
6. **可导出规则 ID 必须全量入账**：测试会逐项核对 `FINAL_CHECK_RULES` 与 `OUTPUT_RULE_IDS`；
   不得用 `foo`(+`_bar`) 这类缩写代替真实 ID。

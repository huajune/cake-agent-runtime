# 程序记忆索引 · Prompt 规则台账（Procedural Memory Index）

> **本文件是程序记忆层（procedural memory）的唯一总目录**——手册、工具 description、DB 策略文本、
> booking 共享规则、final-check、守卫 hard-rules 六居所的规则全量登记处，也是该记忆层三项治理的挂载点：
> **容量**（台账+膨胀哨兵）、**沉淀**（批次删减循环，即 procedural refinement）、**放置**（判定树）。
> 物理居所按判定树就近散布（规则贴消费者，反口径漂移）；逻辑收拢于此，各居所头部有锚注指回本索引（M1-B）。
> 建立：2026-08-21（治理方案 P3-1 / 防腐机制 F1，裁定 4：markdown 轻量版，不建系统不建表）
> 范围：主 generator 链路全部内容居所——手册、工具 description、DB 策略文本（red-lines / thresholds / stage-strategy）、booking 上下文、final-check、出站守卫 hard-rules。
> 维护纪律见文末；**新增/修改/删除任何 prompt 侧规则的 PR，必须同批更新本台账对应行**。

## 约束放置判定树（分类轴，2026-08-21 裁定 7）

```
新约束 →
├─ 出站结果形态可确定性判定（假宣称/泄漏词等）→ 守卫 hard-rule（只拦完成时态）
└─ 生成时行为约束：
   ├─ 与单一工具强绑定 → 该工具 description
   ├─ 与单一阶段强绑定 → stage-strategy（DB）
   ├─ 跨工具跨阶段的人格/红线 → red-lines（DB）
   └─ 跨工具的操作规程 → 手册
铁律：同一约束只准住一处；"教"（prompt）与"拦"（守卫）允许成对存在，但必须在本台账互链。
```

## 居所索引（六居所三纪律）

| 居所 | 载体 | 变更纪律 | 规模（2026-08-21 实测） |
|---|---|---|---|
| 手册 | `src/agent/generator/context/sections/procedural/candidate-consultation.md` | PR + review | 76KB / ~90 条规则 |
| final-check | `candidate-consultation-final-check.md`（组装置末尾，≈ recitation） | PR + review | 6.5KB / 17 条自检项 |
| 工具 description | 各 tool 文件内 DESCRIPTION | 代码 PR（无尺寸压力） | 13 常挂合计 31,729 字符 |
| DB red-lines/thresholds | `strategy_config.red_lines`（Dashboard 可改，零 review） | ⚠️ 零审计 | 15 规则 + 2 阈值（1,580 字符） |
| DB stage-strategy | `strategy_config.stage_goals`（Dashboard 可改，零 review） | ⚠️ 零审计 | 5 阶段（6,282 字符） |
| 代码动态注入 | booking 共享规则 / hard-constraints / turn-hints / critical-turn-guard / 拦截说明；group-inventory 仅数据 | 代码 PR | booking 共享规则 ~2KB |
| 守卫 hard-rules（拦侧） | `src/agent/guardrail/output/rules/` | 代码 PR | 23 文件 / 29 ruleId |

---

## 一、手册 candidate-consultation.md

> 行号为 2026-08-21 快照；来源锚点均以 HTML 注释内联在手册对应行（`stripMaintainerComments` 加载时剥离）。
> 时效性未标注 = 常设。
> **手册批（2026-08-21）**：注入口径 28,357→27,366 字符。① B2 豁免细节/B6 重查机制/G4 regionNameList 细则归并 `duliday_job_list` 描述唯一居所——其中 B2 手册版"不传 range"与描述"保留 range 显式放大"**口径冲突且落后**，是双居所口径漂移实证；② B3 searchJobName 参数机制归 schema 说明；③ 结构件去重："阶段不压当前问题"4 遍→2、advance_stage 调用纪律 2 遍→1、"不暴露内部"3 遍→2、[本轮解析线索/待确认线索] 双重定义→1。B6 三居所一致性测试同步改锚。

### 决策栈与全局工作原则（G）

| # | 规则摘要 | 来源 | 加入 | 备注 |
|---|---|---|---|---|
| D1 | 决策优先级栈（红线>硬约束>工具硬规则>全局原则>阶段策略>人格）+ 禁横跳反模式 | 架构设计 | — | 结构件，非业务规则 |
| G1 | 先答候选人当前最明确的问题 | 通用 | — | |
| G2 | 事实信息必须工具获取；禁扭曲候选人意向假装匹配 | 通用 | — | |
| G2a | 福利/薪资细则追问必须实时重查（记忆只用于定 jobId）；阶梯薪资照括注原文 | 2026-08-06 周报（阶梯算法 3 次误转人工） | 2026-08 | |
| G3 | 有岗/没岗判断必须先调 job_list，零查岗禁断言 | badcase 6a32317a | — | |
| G4 | 位置线索处理链：坐标直用/文字先 geocode/行政区默认按位置/城市三步判定 | badcase 6a3356e2 | — | 教/拦配对：无 |
| G4a | 城市一旦确认禁再反问城市 | badcase 簇 | — | |
| G5 | 地址追问→send_store_location + 面试形式先核对 | 工具语义 | — | 与 BK6 成对（booking 场景） |
| G6/G7 | 阶段策略不压当前问题；跨阶段先判断再 advance_stage | 架构设计 | — | 结构件 |
| G8 | 流程问题正常化解释，不说"系统需要" | 人设 | — | |
| G9 | 先接情绪再解释 | 人设 | — | |
| G10 | 禁重复已告知信息；"答完就收"反模式 | badcase 簇 | — | 拦侧配对：`repeated_reply` / `repeated_reply_verbatim` |
| G11 | 岗位推荐规格→job_list description 为准 | 分层裁定（05 文档） | — | **指针条目，非重复** |
| G12 | 收资/约面前置→precheck/booking description 为准 | 分层裁定 | — | **指针条目，非重复** |
| G13 | 多问题合并一条消息分点答 | 体验 | — | |
| G14 | 禁旁白/舞台指示；不回复唯一合法动作是 skip_reply | badcase 6a5740ff | — | 拦侧配对：`meta_narration_reply` |

### 昵称与称呼（N）

| # | 规则摘要 | 来源 | 加入 |
|---|---|---|---|
| N1-N3 | "我是XX"是验证语；裸句非品牌意图；中途才按字面 | 渠道机制 | — |
| N4 | 昵称字面非候选人事实；纯数字绝不当年龄 | badcase 6a69674e（昵称"18"读成年龄） | 2026-07-29 |
| N5/N6 | 禁称呼昵称；真名也不当称呼喊 | badcase 簇 | — |
| N7 | 特殊形态姓名不质疑真伪 | 口径 | — |
| N8 | 开场白不自报家门，首问地址 | 与 stage_goals trust_building 呼应 | — |

### 品牌/品类粒度（B）

| # | 规则摘要 | 来源 | 加入 | 时效 |
|---|---|---|---|---|
| B1 | 咖啡类默认 M Stand，不展开全品类 | 业务配置（品类词仅咖啡开启） | 2026-08 | ⚠️ 随品类配置变化，配置变更时须同步 |
| B2 | 点名品牌豁免距离上限；0 条先放宽重查再下"无岗"结论 | badcase 簇 | — | 拦侧配对：`requested_brand_mismatch` |
| B3 | 点名门店/地标用 searchJobName 模糊召回，禁 storeNameList | storeNameList 精确匹配特性 | — | |
| B4 | 企微备注品牌 = 点名品牌同等待遇 | 运营流程 | — | |
| B5 | 跨门店转化用"连锁就近"暖话术 | 体验 | — | |
| B6 | Agent 主动推荐 ≠ 候选人品牌硬约束；不符时去品牌重查 | badcase 簇 | — | |

### 性别识别与确认（S）

| # | 规则摘要 | 来源 | 加入 | 备注 |
|---|---|---|---|---|
| S1 | gender 双来源（自陈高信/系统兜底低信） | 数据链路设计 | — | |
| S2 | 禁凭昵称/头像/文风推断性别 | 口径 | — | |
| S3 | 兜底性别只随收资表内顺带求证，禁单独确认问题 | 收资状态机（genderInlineConfirmation） | — | ⚠️ 状态机 D5 退役观测中，契约 v2 落地后本条应随之收缩 |
| S4 | 兜底性别不得用于直接拒绝候选人 | badcase 簇 | — | |

### 事实一致性红线（F）

| # | 规则摘要 | 来源 | 加入 | 时效 |
|---|---|---|---|---|
| F1 | 「独立客」身份统一口径；独立日/杜力岱/DuLiDay 同主体 | 品牌裁定 | — | |
| F2 | 关键事实以最新工具结果为准；说错要道歉纠正 | 通用 | — | |
| F3 | 禁名额保留/未来可用性保证 | badcase 6a266b51（办证 3 天岗位下架投诉） | — | 拦侧配对：`quota_promise` |
| F4 | 未报名不引导自行到店 | badcase 2cz1o1nd + wlterrb1 + 回归 P865-09 | 2026-08-04 | |
| F5 | "组合排班"≠周频，不虚构周频门槛 | 回归 SCN-P862-SCHEDULE-01 | 2026-08-05 | 拦侧配对：`combination_schedule_weekly_generalization` |
| F6 | 餐饮一律需健康证；不编办理阶段比例 | 2026-08-05 业务口径 | 2026-08-05 | 拦侧配对：`health_certificate_generalization`；与 DB 红线 R3 成对（见 R3 备注） |
| F7 | 健康证费用：自费约 100、不免费、默认不报销 | badcase d29laq3e/kzut0et8 + 08-06 运营口径 | 2026-07-28 | |
| F8 | 健康证电子=纸质有效；默认须应聘城市本地证 | 2026-08-06 运营口径 | 2026-08-06 | |
| F9 | 查岗结论先查后说；"愿意帮查"≠存在性承诺 | 回归簇 | — | |
| F10 | 禁编造系统状态/报错；报名成败只看 booking 返回 | badcase 簇 | — | 拦侧配对：`booking_promise_without_booking` / `booking_receipt_mismatch` |
| F11 | 禁替候选人填收资字段（年龄禁用岗位上下限兜底） | badcase（岗位上限 50 当年龄） | — | 状态机公证拒收兜底（claims 必须原话 quote） |
| F12 | 工作内容只按工具字段，禁通识泛化 | badcase（六姐洗碗） | — | 拦侧配对：`ungrounded-generalizations` 族 |
| F13 | 备注时间限定按当前日期解析，过期不复述 | 口径 | — | |
| F14 | 同 reply 禁自相矛盾 | badcase 簇 | — | |
| F15 | 班次禁截短/改写成未列时段 | badcase 簇 | — | 拦侧配对：`unsupported_schedule_window_claim` |
| F16 | 禁臆测门店开业/筹建状态 | badcase（新店未开改派面试） | — | 拦侧配对：`unsupported_store_status_speculation` |
| F17 | 班次硬约束过滤必须向候选人解释；做一休一≠低周频 | badcase + v10.38.0 回归 | — | |
| F18 | 岗位"每周 N 天"要求须主动确认出勤能力 | badcase | — | |
| F19 | 用工形式两级轴按字段如实介绍；正式工/临时工不复述；过滤空结果如实说 | 业务口径 | — | ⚠️ **与 DB 红线 R13 双居所重复**（见铁律违例①） |
| F20 | 暑假工单向硬约束：拒绝即收口，禁劝转 | 用户裁定 | 2026-07 | ⚠️ **季节性**：2026 暑期语境，暑期结束（≈2026-09）复查是否降档 |
| F20a | 暑假工状态默认"否"，禁主动盘问 | 同上 | 2026-07 | 同上；拦侧配对：`summer_worker_alternative_upsell` |
| F21 | 不主动反问"全职还是兼职" | 体验 | — | ⚠️ 同属 R13 重复段 |
| F22 | 转正/转全职须字段支撑，否则转人工 | 岗位数据缺口口径 | — | |

### 常见场景（C）

| # | 规则摘要 | 来源 | 加入 |
|---|---|---|---|
| C1 | 历史面试结果追问→立即 handoff(interview_result_inquiry) | badcase 簇 | — |
| C2 | 先筛后推：可公开硬门槛推荐前对照、收资前确认；身份筛选不上卡片 | badcase fazpqciu + 2026-08-04 用户两次裁定 | 2026-08-04 |
| C3 | 硬条件拒绝先承接再换岗；年龄按 ageBoundary.severity；禁通融话术 | badcase 簇 | — |
| C4 | 多品牌召回时推荐覆盖不同品牌 | badcase 028k7uuh | — |
| C5 | 候选人坚持申明不同城市→停下核实 | badcase fkl0frbr | — |
| C6 | 唯一选项禁复读"只有 X"；挖需求换轴或坦诚收口 | badcase 43b1b6tq + 6a337d86 | — |
| C7 | 面试方式严格按字段；线上面试不跳过不改线下；AI 面试预约时段≠到点开考 | badcase recvkB7fIV5IYb / recvlz8I1TqTM1 / recvpYfDLkx4Fz 等 | — |
| C8 | 候选人自曝造假只引导如实；必须含"不能续假+更正登记"两点 | badcase scyjp2kx | — |
| C9 | 报名前必须确认具体工种 | badcase recvkHEkJ4HygC | — |

### 话术节奏与敏感约束（T）

| # | 规则摘要 | 来源 | 加入 | 备注 |
|---|---|---|---|---|
| T1 | 禁分批收资；字段范围以 precheck `requiredFieldsToCollectNow` 为准 | 报名率数据 | — | 2026-08-21 已对齐收资状态机（progressive 由状态机裁决） |
| T2 | 发表后插问岗位细节不重发整表 | 体验 | — | |
| T3 | 同岗位信息不重复介绍 | 体验 | — | |
| T4/T5 | 回避信号软收尾；收尾词即收尾 | 体验 | — | |
| T6/T7 | 简洁原则；封闭式改开放式 | 体验 | — | |
| T8 | 敏感门槛（地域/籍贯/民族/专业/婚育）禁问禁透露；拒绝理由中性；敏感拒绝即终局禁翻案 | badcase weurg1xg | — | 拦侧配对：`discriminatory_screening_leak` / `sensitive_origin_probe`；与 DB 红线 R11 成对 |
| T9 | 不主动提保险/社保；haveInsurance vs 社保准入两分 | 2026-08-06 运营口径 | 2026-08-06 | 拦侧配对：`proactive_insurance_policy_mention` |
| T10 | 关键用工事实无法确认当轮转人工，禁"帮你确认下"却不转 | badcase 簇 | — | ⚠️ 与 DB 红线 R2 口径冲突（见铁律违例⑤） |
| T11 | 发薪/签约主体按「合作模式」结论答；禁提 BPO/RPO | 2026-08-06 运营口径 + 海绵 cooperationMode 字段 | 2026-08-06 | |
| T12 | 月薪岗不折算时薪；每日工时按排班字段 | 2026-08-06 运营口径 | 2026-08-06 | |
| T13 | 发薪方式合规硬边界：仅本人银行卡；不能接受即暂停推进 | badcase gg4x4eo7/1ujkxxm6 | — | |
| T14 | 改期必须先 precheck 再 modify；两轮时间硬冲突→handoff(modify_appointment) | badcase 7jkfh83r + kjc5877z | — | ⚠️ 与 stage_goals interview_scheduling 末条双居所重复（铁律违例③）；①段与 BK3 成对 |
| T15 | 已拒条件是跨轮硬负向约束，推进冲突岗前须显式提示 | badcase yno1y9ir | — | |

### 平台来源识别（P）

| # | 规则摘要 | 来源 | 加入 |
|---|---|---|---|
| P1 | 平台名=渠道来源补充，不否认不澄清 | 体验 | — |
| P2 | 截图归属用品牌+门店+班次+薪资比对，禁凭发布方否认 | badcase 6a38f7e6 | — |
| P3 | 跃橙云服=我方发布主体 | 业务事实 | — |
| P4 | 截图信息是"候选人看到的版本"；截图联系方式永非候选人本人 | badcase vkikct39 / umr69uqq | — |
| P5 | 截图他人信息不复述 | PII 纪律 | — |

### 裸查询承诺（Z）

| # | 规则摘要 | 来源 | 加入 | 备注 |
|---|---|---|---|---|
| Z1 | 禁"我帮你查下"将来时单独成回复；完成时态+实质内容才合法 | badcase 6a69ba9f/6a69be5c | 2026-07-29 | 拦侧配对：`dangling_reply_promise` |

### 结构件（不逐条登记）

回合 SOP（5 步）、阶段策略使用规则、记忆使用规则三节是**流程结构教学**，随架构演进整节更新，不按规则粒度登记。

---

## 二、booking 上下文共享规则（代码动态注入）

载体：`context/sections/semantic/memory.section.ts` `BOOKING_CONTEXT_SHARED_RULES`（2026-08-21 P1-2 起 N 条 booking 只渲染一次）。

| # | 规则摘要 | 备注 |
|---|---|---|
| BK1 | 多岗可并行报名；同工单禁重复提交 | |
| BK2 | 改约先 precheck 后 modify；面试前放弃必须 cancel；**过时未到=爽约禁 cancel** | 与 T14① 成对：BK 版在"有预约"轮次必然在场，是主承载 |
| BK3 | 「面试时间」已给出时禁说等排期；过期未知须先核实 | 拦侧配对：`interview_time_change_unconfirmed` |
| BK4 | 预约可能非本人经手；不主动提及 | |
| BK5 | 阻塞场景必须 request_handoff | 与 stage_goals onboard_followup 呼应 |
| BK6 | 面试形式先核对；线上面试禁发定位 | 拦侧配对：`online_interview_location_claim`；与 G5/FC1 成对 |

## 三、final-check（发送前自检，组装置末尾 ≈ recitation）

16 条自检项（FC1 定位发送一致性、~~FC2 报名完成时态~~、FC3 未来预约保证、FC4 健康证岗位存在性、FC5 两群区分（完成时态半段已删）、FC6 名额保留、FC7 距离数字接地、FC8 薪酬工时接地、FC9 组合排班两维、FC10 健康证一般询问、FC11 收资前薪资已告知、FC12 时间不合适先澄清、FC13 户籍门槛不改名泄漏、FC14 暂不报名即收口、FC15 内部表述、FC16 逐句查重、FC17 元规则）。
**行业对照裁定（2026-08-21）：final-check 位于末尾不碍前缀缓存，精简须按 recitation 视角，勿并入前缀。**
**P3-2 首批执行（2026-08-21，用户裁定跳过生产数据等待）**：✅ FC2 整条删除、FC5 完成时态前半删除——守卫 `booking_promise`/`booking_receipt`/拉群假宣称确定性拦侧在产 + 手册 F10 教侧仍在，三居所去其一（recitation 复核面）；context.service.spec 断言同步翻转。文件 6,505B→5,865B。

## 四、DB red-lines（strategy_config.red_lines，Dashboard 可改零 review）

| # | 规则摘要 | 状态 |
|---|---|---|
| R1 | 咖啡→M Stand 默认 | ✅ **已删（2026-08-21 F5 裁定执行）**：与手册 B1 双居所重复，B1 为唯一居所（released+testing 双行同步，changelog 已补录） |
| R2 | 发薪/工资不确定只说"我帮你确认下" | ✅ **已删（2026-08-21 F5 裁定执行）**：与 T10/T11 口径冲突的旧口径残留，现行口径以 T10/T11 为唯一居所 |
| R3 | 健康证默认宽口径（先面试录用后办） | 与手册 F6 成对：F6 已明确本红线只用于已确认岗位的约面流程。保留，边界互链 |
| R4 | 结伴求职分流方案 | 唯一居所，保留 |
| R5 | "店长会联系吗"→后续由我们跟进 | 唯一居所，保留 |
| R6 | 已约面阶段社保问题口径 | 与 T9 相邻不重复（T9 管主动提及，R6 管已约面被问）。保留 |
| R7 | "能直接到店报名吗"→线上流程引导 | 与手册 F4 相邻：F4 管"不引导到店"，R7 管被问时话术。保留，互链 |
| R8 | "成都你六姐"是完整品牌名仅上海在招 | ✅ **TTL 已标注（2026-08-21 挂账批）**：DB 原文已加"开城即失效需更新本条" |
| R9 | 禁跨城市推荐 | 唯一居所，保留 |
| R10 | 禁通融式推荐 | ✅ **已删（2026-08-21 挂账批）**：手册 C3 为唯一居所（更全，含 ageBoundary 走向） |
| R11 | 地域筛选对外中性婉拒 | ✅ **已删（2026-08-21 挂账批）**：手册 T8 为唯一居所 + 拦侧 discriminatory_screening_leak 在产 |
| R12 | 禁 markdown 输出 | 唯一居所，保留 |
| R13 | 用工形式按字段如实介绍+不主动反问全兼 | ✅ **已删（2026-08-21 F5 裁定执行）**：与手册 F19+F21 逐字重复，手册为唯一居所 |
| R14 | 拟人化保密（禁 AI/系统/机器人词） | 唯一居所（人格类），保留。拦侧配对：`human_service_phrase_leak` |
| R15 | 刑事/失信信号→立即 handoff | 唯一居所，保留 |
| TH1 | 推荐距离上限 10km | 阈值，保留 |
| TH2 | 单次回复 120 字上限 | 阈值，保留 |

## 五、DB stage-strategy（strategy_config.stage_goals，5 阶段 6,282 字符）

| 阶段 | 审计发现 |
|---|---|
| trust_building | ✅ disallowed"渠道来源身份否认"**已删（2026-08-21 F5 裁定执行）**，手册 P1 为唯一居所；"首问地址"教学与手册 N8 呼应（各有侧重，保留） |
| qualify_candidate | 无重复，健康 |
| job_consultation | "无岗时 invite_to_group"与 job_list description 无岗动作链重叠（观察项）；包餐偏好重查是唯一居所 |
| interview_scheduling | ①"收资料直接发 templateText…以 missingFields 为字段范围"——提案同步 T1 对齐：字段范围改 `requiredFieldsToCollectNow`（**未批，挂账**）；② ✅ 末条"2 轮时间硬冲突→handoff"**已删（2026-08-21 F5 裁定执行）**，T14 为唯一居所；③"今天可以吗必须先 precheck"段内自重复（**未批，挂账**） |
| onboard_followup | 与 BK5 呼应（阶段管方向、BK 管动作），保留 |

> **F5 已裁定并执行（2026-08-21）**：5 处铁律违例/旧口径删改全部落地（released+testing 双行同步，`strategy_config_changelog` 补录，changed_by=claude-context-governance-f5）。长效机制裁定：策略文本编辑主体只有我们（用户+AI 会话），不加 Dashboard 侧额外约束；AI 侧台账登记纪律（F1）已覆盖。剩余挂账小提案：interview_scheduling ①③、R8 TTL 标注、R10/R11 收敛——随后续批次顺手处理，不单独开批。

## 六、工具 description（章节级登记）

| 工具 | 字符数 | 内容轮廓 | 台账备注 |
|---|---|---|---|
| duliday_job_list | ~~13,144~~ **8,515**（三批累计 -35.2%） | 召回策略/无岗动作链/展示纪律 | ✅ 首批去重（→11,481）：regionNameList 三遍合一、展示要求围绕卡片铁律收敛、福利追问并入通用补查、阶梯原文/保险社保/同岗不重复归唯一居所、badcase 叙事压缩。✅ 二批接口化（→10,126）：**数据开关章节坍缩**——开关早已 schema default(true)（代码接管），提示词仍教手动开关是烂源四标本，删除开关表 + 4 处"必须开 includeX"无效指令；班次语义两条合一、阶梯口径两条合一、学生两条合一 |
| request_handoff | ~~4,388~~ **4,026**（2026-08-21 二批 -8.3%） | reasonCode 15 枚举语义/触发契约 | ✅ 二批：两轮拉群协议 bullet 删除（invite 场景 2+禁止触发为唯一居所；job_list 653 无岗链保留自身步骤）、no_group_in_city 例外同文档内去重（归场景 8）、空头承诺禁令压缩（手册 T10 为教侧主居所）、场景 7 示例精简。15 枚举判别语义为主体，已是接口化形态 |
| invite_to_group | 3,804+ | 拉群时机/两轮协议/城市门/群库操作约束 | 拉群时机簇 0820 新口径已入。**2026-08-26 收尾批**：group-inventory 的 4 条操作约束原文迁入本 description，动态 section 收窄为纯平台资源数据；拉群协议与 errorType 处置继续以此为唯一居所。 |
| geocode | 2,221 | 三态返回/通用后缀黑名单 | 手册 G4 引用其黑名单（指针健康） |
| duliday_cancel_work_order | 2,000 | 取消契约 | 与 BK2 成对 |
| duliday_modify_interview_time | 1,810 | 改约契约 | 与 T14/BK2 成对 |
| skip_reply | 974 | 沉默场景 | 与 G14 成对 |
| send_store_location | 829 | 定位发送 | 与 G5/BK6/FC1 成对 |
| duliday_interview_precheck | 729 | 参数纪律/行动纪律（收资状态机接管后瘦身 13.5K→729） | **"职责收进代码、描述自然变薄"的先例** |
| risk_alert / advance_stage / recall_history 等 | ≤620 | — | 健康 |

## 七、守卫 hard-rules（拦侧，29 ruleId）

`application_record_update_promise`、`booking_promise_without_booking`、`booking_receipt_mismatch`、`brand_alias_fuzzy_match_ignored`、`combination_schedule_weekly_generalization`、`dangling_reply_promise`、`date_reference_mismatch`、`discriminatory_screening_leak`、`example_value_leak`、`experience_fraud_coaching`、`health_certificate_generalization`、`human_service_phrase_leak`、`identity_misregistration_coaching`、`image_description_not_saved`、`interview_time_change_unconfirmed`、`invalid_model_output`、`job_detail_lookup_required`、`meta_narration_reply`、`online_interview_location_claim`、`proactive_insurance_policy_mention`、`quota_promise`、`repeated_reply`(+`_verbatim`)、`requested_brand_mismatch`、`sensitive_origin_probe`、`settlement_cycle_mismatch`、`summer_worker_alternative_upsell`、`unsupported_schedule_window_claim`、`unsupported_store_status_speculation`。

教/拦配对已在上文各表"拦侧配对"列互链。守卫规则的增删遵守既有裁定：只拦完成时态假宣称；大规模重加已被 7-10 月下线史否决。

---

## 维护纪律（F1~F3 落地条款）

1. **登记即门票**：任何往手册/description/DB 策略/守卫加规则的变更，必须同批在本台账登记：摘要、来源（badcase id / 裁定 / 运营口径 + 日期）、加入日期、时效性。无登记的规则变更 review 应打回。
2. **放置先过判定树**：登记前按文首判定树选唯一居所；发现将造成双居所的，先归并再登记。教/拦成对允许，必须互链。
3. **临时规则必须标 TTL**（F3）：带时效的口径（季节性、开城状态、活动期）必须写明"过期条件/复查日期"，过期即删。当前带 TTL 条目：F20/F20a（暑假工，≈2026-09 复查）、B1（随品类配置）、R8（随开城）。
4. **职责迁移必须回收**（F2）：代码/状态机接管某行为的 PR，必须同批删除 prompt 侧对应教学并更新本台账（先例：precheck 描述 13.5K→729）。
5. **删除也要留痕**：删规则时不删台账行，改标 `~~已下线（日期+原因）~~`，保留证据链。

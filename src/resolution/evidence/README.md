# evidence · 裁决工序（候选人档案的"信不信、冲突听谁的"唯一居所）

宪法与推导见 docs/architecture/candidate-profile-domain-refactor-plan.md §2.0。白话三条：
规则进 resolution（一字段一份）；事实进 memory（结论轮末落档）；一轮一判（结果挂回合上下文）。

## 文件地图（按职责分四组）

**通货与引擎**
- `claim.types.ts` — 主张（claim）与裁决结论的类型：全域唯一裁决通货
- `types.ts` — rule claim 裁决后的域外消费视图；与 memory 存储形状同构但不反向依赖存储类型
- `engine.ts` — 三道审（出处审 / 强度审 / 冲突审）
- `policies.ts` — Record<字段, 策略行>：编译期穷尽，加字段必须表态
- `brand-policy.ts` — 品牌策略行（复合槽值 + set/exclude/clear 替换语义，原 brand-state.reducer）
- `normalize.ts` — 值等价比较；`interop.ts` — 来源分类学互转表（唯一居所，禁私转）
- `profile.ts` — 裁决产物视图（EffectiveCandidateProfile）
- `adjudicate.ts` — 一次完整裁决的编排入口（组装 producers + 基线 → engine → profile）

**producers/ · 主张的生产（按信号渠道切分）**
- `rule-track.ts` — 规则轨全字段 claim producer：逐条命中并锚定 quote，不持有字段合并策略
- `direct-field.ts` / `model-claims.ts` / `student-identity.ts` — 逐条锚定 / 模型主张 / 学生身份识别器
- `name-confirmation.ts` / `city-confirmation.ts` — 问答确证（姓名 / 城市，对称成对）
- `city.ts` / `geo-preference.ts` / `location-share.ts` / `brand-intents.ts` — 城市多路 / 地理偏好清除 / 定位分享 / LLM 品牌极性

**入档准入（memory 写入前的门）**
- `admission.ts` — 准入主链 + 授权域（哪些消息允许写哪些字段）
- `admission-gates.ts` — 臆造门族 + 形状门（示例回声 / 出处断言 / 扇出熔断 / 城市年龄形状）
- `merge.ts` — rule claim 逐字段裁决与 rule×LLM 合并视图

**跨工序信号输入（所有权在 `resolution/signal/`，evidence 只消费）**
- `signal/self-report.ts` — 候选人自陈语料选择与手机号出处核验
- `signal/dialogue.ts` — user 文本、对话轮次、引用发言人及确认短答
- `signal/markers.ts` — 时间、引用、视觉、附件、位置等消息标记协议
- `signal/visual/` — 视觉 sheet schema、归属规则、脱敏与存储解析

**动作授权（tools 执行前的闸，判过即弃、不产事实）**
- `identity-gates.ts` — booking 姓名 / 手机号闸
- `snapshot.ts` / `snapshot-gate.ts` — precheck→booking 事务快照语义与对账闸

# evidence · 裁决工序（候选人档案的"信不信、冲突听谁的"唯一居所）

宪法与推导见 docs/architecture/candidate-profile-domain.md §1（域宪法）。白话三条：
规则进 resolution（一字段一份）；事实进 memory（结论轮末落档）；一轮一判（结果挂回合上下文）。

## 文件地图（按职责分四组）

**通货与引擎**

- `claim.types.ts` — 主张（claim）与裁决结论的类型：全域唯一裁决通货
- `types.ts` — rule claim 裁决后的域外消费视图；与 memory 存储形状同构但不反向依赖存储类型
- `engine.ts` — 三道审（出处审 / 强度审 / 冲突审）
- `policies.ts` — Record<字段, 策略行>：编译期穷尽，加字段必须表态
- `brand-policy.ts` — 品牌策略行（复合槽值 + set/exclude/clear 替换语义，原 brand-state.reducer）
- `normalize.ts` — 值等价比较；`claim.types.ts` 是全库唯一来源词汇定义点
- `profile.ts` — 裁决产物视图（EffectiveCandidateProfile）

**producers/ · 主张的生产（按信号渠道切分）**

- `rule-track.ts` — 规则轨全字段 claim producer：逐条命中并锚定 quote，不持有字段合并策略
- `direct-field.ts` / `student-identity.ts` — 逐条锚定 / 学生身份识别器；precheck 的模型答案由
  `tools/collection` 接收统一 `formAnswers` 并直接进入表单公证，不再在档案域生成第二份 model claim
- `city.ts` / `geo-preference.ts` / `brand-intents.ts` — 城市多路 / 地理偏好清除 / LLM 品牌极性

**入档准入（memory 写入前的门）**

- `admission.ts` — 准入主链 + 授权域（哪些消息允许写哪些字段）
- `notary.ts` — 确定性公证与来源核验
- `merge.ts` — rule claim 逐字段裁决与 rule×LLM 合并视图

**跨工序信号输入（所有权在 `resolution/signal/`，evidence 只消费）**

- `signal/self-report.ts` — 候选人自陈语料选择与手机号出处核验
- `signal/dialogue.ts` — user 文本、对话轮次、引用发言人及确认短答
- `signal/markers.ts` — 时间、引用、视觉、附件、位置等消息标记协议
- `signal/visual/` — 视觉 sheet schema、归属规则、脱敏与存储解析

**动作授权（tools 执行前的闸，判过即弃、不产事实）**

- `identity-gates.ts` — booking 姓名 / 手机号闸

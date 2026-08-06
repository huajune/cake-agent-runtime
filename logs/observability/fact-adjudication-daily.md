# 候选人事实裁决 shadow 日频观测

> 证据化方案 §18.2 观测期台账。每日一节，追加写入。
> 目的：积累 enforce 切换判据（rule/confirmation 轨零误拒、model 轨假阳占比明确、
> booking 水位假阳为 0、candidateClaims 采用率非零）。

---

## 2026-08-06（观测第 1 天 / 发版次日）

### 发版状态

- ✅ 已发版：`origin/master` 含 `fact_adjudication`，生产 tag **v10.39.0**（2026-08-05 16:33 部署 success）。
- 模式：**shadow**（`CANDIDATE_FACT_ADJUDICATION_MODE` 未配置，取默认值）。

### 规模（近 24h）

| 指标 | 值 |
|---|---|
| 裁决事件数 | 176 |
| 覆盖会话数 | 49 |
| precheck 阶段事件 | 158 |
| booking_gate 阶段事件 | 18 |
| claim 判决总数 | ~1055 |
| 出现冲突的会话 | 3 |

链路健康：precheck 有调用即有事件，无"有调用零事件"的断链迹象。

### SQL-A/C 合并：四轨 × 判决分布（按 claimId 前缀）

| 通道 | accepted | superseded | rejected | 拒因 |
|---|---|---|---|---|
| `rule_`（规则逐条锚定） | 433 | 53 | 11 | conflicting_evidence ×10、value_not_derivable ×1 |
| `legacy_`（旧裸字段转译） | 21 | 444 | 163 | **no_candidate_evidence ×157**、conflicting ×5、value_not_derivable ×1 |
| `model_`（显式 candidateClaims） | 3 | 29 | 12 | value_not_derivable ×12 |
| `identity_`（唯一识别器） | 56 | 0 | **0** | — |

> 注：SQL-A 按 `producer` 分组时 legacy 与 model 同归 `producer='model'`，故与本表分列口径不同；
> 两次查询间隔数分钟，24h 滑窗导致个位数差异，不影响结论。

### SQL-B：被拒字段分布

| 字段 | no_candidate_evidence | value_not_derivable | conflicting_evidence |
|---|---|---|---|
| age | 44 | 5 | — |
| name | 40 | — | — |
| healthCertificate | 23 | 4 | — |
| gender | 18 | 2 | — |
| education | 9 | 1 | — |
| phone | 3 | — | **9** |
| weight | 2 | 1 | — |
| isStudent | 2 | — | — |
| householdProvince | 1 | — | — |

### SQL-D：booking 快照对账差异（18 条事件全部有差异）

| 差异形态 | 次数 |
|---|---|
| `age:no_adjudicated_source` + `gender:no_adjudicated_source` | 3 |
| `healthCertificate`（值偏离） | 2 |
| `name:no_adjudicated_source` + `age:no_adjudicated_source` | 2 |
| 其余单/组合形态（name/phone/weight/healthCertificate） | 各 1 |

**`message_watermark_changed` 出现 0 次** —— 水位假阳（debounce 误触发）判据首日达标。
差异全部是 `:no_adjudicated_source`（模型提交了快照中无已裁决来源的字段）与 2 例值偏离。

---

### 判读结论

#### 🔴 P0-1（确认的实现缺陷）：rule 轨自相矛盾 —— quote 截断与推导输入不一致

- **现象**：`rule_age_1` 被判 `value_not_derivable`（规则轨自产的 claim 被自己的验证器拒掉）。
- **根因**（已读码确认，非推测）：[direct-field-claim.producer.ts](../../src/memory/facts/candidate/producers/direct-field-claim.producer.ts)
  用**全文** `trimmed` 推导值，却把 `evidence.quote` 存成 `trimmed.slice(0, 200)`；
  [candidate-fact-policy.ts](../../src/memory/facts/candidate/candidate-fact-policy.ts) 复算时只看截断后的 quote。
  字段信号出现在第 200 字之后即必然复算失败。
- **今日现场**：chat `6a714c00ce406a6aee9f24c8`，一条 442 字的图片描述消息（"任职要求：1.年满18周岁以上…"），年龄信号在截断点之后。
- **影响**：shadow 下为零（行为不变）。**enforce 下会把长消息里的合法字段判无据 → 字段回落 missingFields → 反复追问候选人（6a448d09 同型事故）**。
- **修复方向**：让"推导输入 = 存储证据"。最小正确改法是按存储的 quote 推导；但直接截到 200 字会丢掉长表单尾部字段（填好的报名表常 >200 字），
  更稳的做法是命中位置取窗口，或把 rule claim 的 quote 上限提高到覆盖整条消息再复算。**enforce 前必修。**

#### 🟠 P0-2（enforce 阻断项，新发现）：图片描述文本被当作"候选人亲证"

- **现象**：`phone` 的 `conflicting_evidence` ×9，集中在 chat `6a714c00ce406a6aee9f24c8`（3 个会话有冲突）。
- **根因**：该会话的用户消息里含多条 `[图片消息] …` 描述（BOSS 直聘截图转写），其中一条写着
  **"系统显示微信号-13788930869可复制"** —— 这是**招聘者**的号码。
  `extractCandidateTexts` 只按 `role === 'user'` 取文本，图片描述被回写进 user 消息后即成为 quote 验证基准，
  第三方号码因此获得"候选人原文"资格。
- **本次裁决器接住了**：候选人自己的号码与截图号码不等价 → 整字段判 `conflicting_evidence`，未静默采信（这是"异值不二选一"设计的兑现）。
- **但 enforce 下的真实风险**：若候选人**从未**自报号码，截图里的第三方号码零冲突 → 直接 `accepted` → 进快照 → 成为 booking 对账基准。
  这与 [[project_badcase_image_identity_hijack]] 同族（PR #870 在**抽取侧**收窄过身份字段，Claim 侧的文本基准没有同等门）。
- **修复方向**：`extractCandidateTexts` 剥离 `[图片消息]/[图片 messageId=…]` 描述块（或对图片来源文本降级为不可作证），
  与 PR #870 的抽取侧口径对齐。**enforce 前必修。**

#### 🟢 判据符合项

- **`identity_` 轨 56 条全 accepted、零拒绝** —— "识别器自产不被自己拒"判据首日达标。
- **`message_watermark_changed` 零次** —— booking 水位假阳判据首日达标（需持续观察，今日 booking 样本仅 18 条）。
- **`model_` 前缀已出现 44 条** —— 模型已开始使用 `candidateClaims` 新通道，采用率判据有苗头（非零）。

#### 🔵 体系战果（预期内，非异常）

- `legacy_` 轨 **157 条 no_candidate_evidence**：模型旧裸字段里"候选人原文推不出"的值被抓出，正是关闭 Prompt 旧值自证的目标行为。
  同时 **444 条 superseded** 说明绝大多数裸值只是规则轨已抓到的同值重复 —— §10 双读的预期形态。
- 字段分布上 age(44)/name(40)/healthCert(23) 居前，与"报名表预填族"badcase 的字段面吻合。

#### ⚪ 判据口径修正（重要）

原判读标准写的是"producer=rule 出现 rejected → P0"。今日数据显示 **`rule` + `conflicting_evidence` ×10 是设计行为**
（字段级冲突时该字段所有 active claim 一并判 rejected，见 adjudicator 归并段），不是缺陷。
**判据收窄为**：rule/confirmation 轨出现 `quote_not_found` / `value_not_derivable` / `strict_field_free_derivation` 才算 P0。
（明日起按此口径执行。）

### 待办清单

| 项 | 类型 | 状态 |
|---|---|---|
| 修 quote 截断与推导输入不一致（P0-1） | enforce 阻断 | 待修 |
| `extractCandidateTexts` 剥离图片描述块（P0-2） | enforce 阻断 | 待修 |
| `model_` 轨 12 条 `value_not_derivable` 抽样：是否同属截断/形态问题 | 假阳定性 | 待查 |
| `legacy_` 157 条 no_candidate_evidence 抽样判假阳（候选人是否真说过） | **enforce 核心判据** | 待查（需 ≥50 条样本） |
| booking `:no_adjudicated_source` 高发是否因 legacy 拒绝导致快照字段空缺（连带效应） | 机制核对 | 待查 |

### enforce 判据进度

| 判据 | 状态 |
|---|---|
| rule/confirmation 轨零误拒 | ❌ 未达标（P0-1 命中 1 例，需修复后重计） |
| model 轨假阳占比明确 | ⏳ 观测第 1/7 天，样本累积中 |
| booking 水位假阳为 0 | ✅ 首日达标（样本 18，需续观） |
| candidateClaims 采用率非零 | ✅ 已达标（44 条） |

**结论：今日不具备 enforce 条件。** 两个 enforce 阻断缺陷需先修复并重新观测。

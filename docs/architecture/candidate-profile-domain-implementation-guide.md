# 候选人档案域改造 · 代码实施指南

> **实施状态：✅ 已完成（2026-08-10，本分支）。** P0–P5 已按“一气呵成”模式落到终态：
> `memory/facts/`、旧 brand reducer、旧 visual policy 与 biz city normalizer 已物理删除；
> 候选人解析归 `resolution/candidate`，裁决/准入/producer 归 `resolution/evidence`，memory 只存取与观测。
> 裁决采用：D1 sheet 优先 + 文本兜底；D2 district/location 去重累积、明确“不限”才清；
> D3 LLM 裸 city=medium；城市/省名比较剥后缀、展示值保留来源形态。D4/D7 运行时开关未翻转。

> 本文是 [candidate-profile-domain-refactor-plan.md](./candidate-profile-domain-refactor-plan.md) 的施工手册：方案讲为什么，本文讲每一刀切在哪。执行者不需要读完方案也能按本文开工，但**改口径前必须回方案对应小节确认裁决**。
> 全程只记三条：①规则进 resolution（纯函数，一字段一份）②事实进 memory（结论轮末落档）③一轮一判（结果挂回合上下文）。
> 2026-08-08 定稿。行号基于当日代码，动手前用文中 grep 命令重新定位。

> **评审修复补记（2026-08-10 第二批）**：name-qa 拆三归 evidence（corpus / producers/name-confirmation / identity-gates）、parse.ts→collected-fields.ts、evidence 命名清理（brand 同名冲突 / run→adjudicate / admission-shape 并入 gates）、geocode 锚点装配挪 preparation-utils、CollectedField 信封别名化归一——下文 P0–P5 章节为历史施工记录，行号与部分路径是执行前状态。
> **执行状态更新（2026-08-11）：P6–P9 四章亦已执行完毕并通过验收（六个按工序 commit：c9eb8231→97299fcb；三大件全绿 7082 测试）。全部工序完工，本文整体转为施工历史记录。** 唯一遗留：消费权限表（P4-5）散点仅剩 2 处，见方案 §4 状态注记。

## 执行模式：一气呵成（2026-08-08 用户裁定，覆盖下文所有"分期发版"表述）

- **下文 P0–P5 是工序依赖顺序，不是发版节奏。** 全部在同一 campaign 分支连续完成，一次发版落地；代码库任何时刻不对外暴露"双轨并存/适配层/过渡期"形态。工序内部的先后（如某函数先暂放后归位）只是分支内的 commit 顺序，发版产物只有终态。
- **开工前置 = 把 blocker 裁决一次拍完**（见文末对照表：D1 简历判据口径、D2 district 累积语义、D3 LLM 城市置信度、归一剥「省」口径）。拍完即无任何中途停点。
- **brand 切换**：金测试全绿为切换闸（reducer spec 全集对新引擎回放，一条不许改语义）；shadow_diff 改为**发版后验证**（连续 7 天零分歧确认），不作为切换前置——这是"一气呵成"裁定买下的风险，回滚预案兜底。
- **回滚预案**：全程零存储迁移（方案 §6），回滚 = 应用版本整体回滚，无数据动作。
- **并发会话冻结**：campaign 期间其他 AI 会话勿动 `src/memory`、`src/resolution`、`src/tools/shared`、`src/tools/duliday` ——提前打招呼，工作树发现他人改动即停。
- **D4（claim shadow→enforce）不算中间态**：代码一次到终态，enforce 是运行时配置开关，何时打开是业务裁决，与代码形态无关。
- **发版闸门（五项缺一不发；本系统单实例部署，发版天然全量）**：① 全量单测 + 金测试 + 分歧句用例绿；② 策展回归集跑真实链路（test-suite 正式回归资产，端到端最后防线）；③ 低峰窗口发（已知特性：发版重启无 drain 丢在途消息，与本次改造无关但全量发版须避峰）；④ 回滚触发条件事先写死（各围观指标的越线值发版前定好，不临场辩论）；⑤ 运行时开关（D4 enforce / D7 县级市映射）不随本次发版翻转。
- **发版后围观清单**：`fact_adjudication` / `extraction_field_dropped` 事件量与拒因分布、brand shadow_diff 报表、booking/invite 拒绝率、守卫假阳率——异常即回滚，不修补带病版本。

## 0. 开工前置（通用）

**环境与工具链坑（血泪版）：**

```bash
nvm use 22.16.0          # shell 默认 node 可能是 16
pnpm run test -- <path> --watchman=false   # 不加 --watchman=false 会静默 0 测试
# 全量：npx jest --watchman=false（pnpm test -- --watchman=false 的 flag 会被当路径）
```

**提交纪律：** 仓库常有多个 AI 会话并发改码——commit 一律 pathspec 限定自己的文件；pre-push 钩子跑全量 CI 要 5+ 分钟，自己先跑 `pnpm run lint:check && pnpm run typecheck && npx jest --watchman=false` 全绿后可 `--no-verify`。发现 stash / 工作树有他人改动勿动。

**每道工序收尾三件套：** ① typecheck/lint/全量测试绿；② 该工序"验收命令"全过；③ 旧实现删除 + 防再生篱笆落位（删不完不进下道工序）。

**PR 纪律：** campaign 单分支推进，按工序切 commit（便于 review 与定位），最终一次合入发版；行为变更（口径合一）在 PR 描述里逐条列"分歧句 → 采用口径"。

---

## P0 · 八条止血修（工序一；随 campaign 一并落地）

### 0-1 `parseHealthCert` 补疑问句守卫 【真 bug】

- 文件：`src/tools/shared/candidate-field-parser.ts`（`parseHealthCert`，现 :99 附近）
- 病：无疑问句守卫，「都是需要有食品健康证是吗」→ `hasPositive` 命中 → 返回 1（有证），直进 booking 有证 gate。
- 修：对齐规则轨口径（`high-confidence-facts.ts:1207-1216` 的疑问句判据）——句含疑问标记（`吗/是吧/对吧/?/？`）且"有健康证"落在疑问范围内时返回 null（判不出，不猜）。
- 测试：`tests/tools/shared/candidate-field-parser.spec.ts` 加分歧句组：「需要有食品健康证是吗」→null、「我有健康证」→1、「没办过，可以办」→2、「没有，不想办」→3。

### 0-2 `parseHeight` / `parseWeight` 补要求语境守卫

- 文件：同上（:150/:157 附近）。
- 病：无「要求/限/不低于/以上」语境拒绝，「身高 165 以上能做吗」（复述岗位门槛）会当自陈身高，且产物是 user_text 权威档。
- 修：对齐 `high-confidence-facts.ts:892-908` 的守卫——匹配位点前后窗口出现要求语境词即返回 null。
- 测试：「身高要求165以上」「身高165以上可以吗」→null；「我身高165」「身高:165」→165。

### 0-3 `parseGender` 第三分支补排除档

- 文件：同上（:68 附近）。
- 病：`/(男|女)(生|士)/` 命中「要招男生吗」「女士优先」。
- 修：先跑排除档（对齐 hcf:1008：`/(?:要|招|找|限|收)\s*(?:男|女)/`、疑问句、第三人称），再走三分支。

### 0-4 `brand_ids` 合并丢弃修复 【真 bug】

- 文件：`src/memory/services/session.service.ts:1767-1783`（SCALAR_INFO_FIELDS / SCALAR_PREF_FIELDS / ARRAY_PREF_FIELDS 三份手抄清单）。
- 病：`brand_ids` 两份清单都不在，规则轨产出被静默丢弃。
- 修：按字段语义补进对应清单即可（一气呵成模式下不再造临时铁丝网——同 campaign 的 P3-5 会把三份清单整体替换为 Record 穷尽）。

### 0-5 守卫证据包改走 `finalizeVisualFactSheet`

- 文件：`src/agent/guardrail/output/llm/review-packet.builder.ts:262-288`。
- 病：从工具 raw args 手搓 sheet，白名单/ownership 默认/身份证脱敏三道保证全失效，而 `semantic-reviewer.service.ts:217-218` 的提示词要求按 ownership 判断。
- 修：`import { finalizeVisualFactSheet } from '@resolution/visual'`，对 `call.args` 过一遍 finalize 再入 packet；`review-packet.types.ts:127-134` 的松散类型收紧为 finalize 产物类型。
- 测试：构造带非法 key + 身份证号 + 缺省 ownership 的 args，断言 packet 里被过滤/补齐/脱敏。

### 0-6 `[位置分享]` 标记收进 message-markup

- 写入侧：`message-parser.util.ts:291`（渲染 `[位置分享] {title} [经纬度:lat,lng]`）；散装解析：`memory/facts/location-share.ts:16,39`、`high-confidence-facts.ts:1082,1722-1729`、`resolution/brand/brand-matcher.ts:91`、`agent/generator/preparation-utils/critical-turn-guard.rules.ts:102`。
- 修：`src/infra/utils/message-markup.util.ts` 加第 6 组（常量 + 渲染 + 坐标解析 + 整段剥除 + 含标记判定），五处消费点改 import。
- 附带：`.eslintrc.js:58-81` geo 专属 override 缺 `!@infra/utils` 例外（后写的 override 整体覆盖前一条），补上——与 resolution/** 那条对齐。
- 测试：`tests/infra/utils/message-markup.util.spec.ts` 加位置分享组。

### 0-7 `isPlausibleCityValue` 别名删除

- `src/memory/facts/fact-shape-gates.ts:49-51` 函数体就是 `isRecognizedCityName` 一行转发；唯一调用点 `session.service.ts:1204` 改直调 `@resolution/geo`，删函数。

### 0-8 memory 甩掉 channels 依赖

- 病：`short-term.service.ts` / `memory-lifecycle.service.ts` / `session.service.ts` import `MessageParser`（channels 层），用途只有时间标记与 `formatCurrentTime`。
- 修：时间标记已在 `@infra/utils/message-markup.util`；`formatCurrentTime`（上海时区格式化）下沉 `@infra/utils/date.util`，MessageParser 内改为转发。三个服务改 import，memory→channels 归零。
- 验收：`grep -rn "from '@channels" src/memory` 输出为空。

---

## P1 · 立域断环（resolution/candidate + labor-form）

### 1-A labor-form 平移（纯搬迁，零行为变更）

```bash
mkdir -p src/resolution/labor-form
git mv src/memory/facts/labor-form.ts src/resolution/labor-form/index.ts
```

改 16 个引用点的 import（`@memory/facts/labor-form` → `@resolution/labor-form`）：
memory 3 处（high-confidence-facts、session.service、formatters/fact-lines.formatter）；tools 5 处（duliday-interview-precheck.tool、duliday-job-list.tool、duliday/job-list/render.util、duliday/job-list/search.util、types/tool.types）；agent 6 处（preparation.service、tool-context.builder、memory-block.formatter、context.service、sections/section.interface、sections/hard-constraints.section）；guardrail 1 处（summer-worker-alternative-upsell.rule）。

验收：`grep -rn "memory/facts/labor-form" src tests` 为空；全量测试绿。

### 1-B resolution/candidate 立域（⚠️ 行为变更：两轨合一）

目标文件（**人话命名**，一字段一文件）：

| 新文件 | 合并来源 | 合一口径（分歧句全部写成用例） |
|---|---|---|
| `candidate/name.ts` | name-guard 纯函数族（extractAutoGreetingName/hasStructuredNameSubmission/stripSelfIntroPrefix/isLikelyRealChineseName/isStrictRealChineseName/HONORIFIC_SUFFIX）+ candidate-field-parser `parseName` + hcf `extractStructuredName`（:870-879，与 name-guard 正则逐字重复的那份删除） | 宽松 2-5 字（规则轨用）与严格 2-4 字（booking 用）保留**显式双档**并注明消费方；结构化姓名正则只留一份 |
| `candidate/phone.ts` | `parsePhone` + hcf `extractPhone`（:881，两份逐字同正则）+ placeholder-identity `isStorableCandidatePhone`（:133，口径修为同号段正则——现版 `/^1\d{10}$/` 连占位号都放行）+ 数字流子串出处比对原语（visual-description:65 与 placeholder-identity:104 两份合一） | 号段 `1[3-9]`；形态门与出处比对各一份 |
| `candidate/age.ts` | `parseAge` + hcf `extractAge`（:976）+ fact-shape-gates `isPlausibleAgeValue`（:54） | 守卫并集：结构化优先 + 剥岗位要求区间 + 14-70 区间校验收进解析器本体 |
| `candidate/gender.ts` | `parseGender`（P0-3 修后）+ hcf `extractGender`（:1002）+ `normalizeGenderValue`（:569，外部接口值归一，biz/user 在用） | 排除档并集 |
| `candidate/height-weight.ts` | `parseHeight/parseWeight`（P0-2 修后）+ hcf `extractHeight/extractWeight` | 要求语境守卫 + 区间，单份 |
| `candidate/health-cert.ts` | `parseHealthCert`（P0-1 修后）+ hcf `extractHealthCertificate` 全族（:1109-1258）+ placeholder-identity 健康证话题词表（:171） | 识别核心一份（分句 + 疑问句守卫 + 否定优先，输出五值语义），`toSpongeCode()` 提供 1/2/3 映射；两个旧出口变薄封装 |
| `candidate/education.ts` | 两份同名 `EDUCATION_KEYWORDS`（hcf:27 八值 vs candidate-field-parser:117 海绵标签）合一 | 输出海绵标准标签（下游 `normalizeEducationToId` 只认它）；「在读」形态归 student-identity |
| `candidate/household-province.ts` | hcf `extractHouseholdRegisterProvince`（:964，本地 34 项省名数组删除）+ `parseHouseholdProvince`（海绵省份词典版） | 锚点并集（户籍/籍贯/老家/户口）；省名权威源用海绵词典；省级后缀归一暂随迁，P3 归 geo |
| `candidate/student-identity.ts` | `tools/shared/identity-statement.util.ts` 全文（isStudent 唯一识别器 + 改口状态机 + stripMessageDecorations） | 原样迁移（它已是单一居所） |
| `candidate/name-qa.ts` | precheck-core 的真名问答族（resolveNameAnsweredToRealNameAsk / isNameProvidedAfterAsk / isNameConfirmedInDialogue / isNameOnlyQuotedSpeaker / extractQuotedSpeakers 包装） | 原样迁移；precheck-core 留闸门编排（调用这里） |
| `candidate/index.ts` | 桶出口 | — |

同期动作：
- `extractMessageText`（collection-strategy.util 里 19 行多模态扁平化）→ `infra/utils/message-markup.util.ts`。
- `sanitizeInterviewName`（吃 memory 类型 EntityExtractionResult）在本工序先随文件留在原地，P4 工序并入 admission——同一分支内完成，发版产物中 name-guard.ts 已不存在。
- hcf 的 FIELD_EXTRACTORS 注册表**本期不动**（P3 才变 producer），但其 extract* 函数体改为调 `@resolution/candidate`，正则本体从 hcf 删除。

ESLint（`.eslintrc.js` 新增 override）：

```js
{ files: ['src/memory/**/*.ts'],
  rules: { 'no-restricted-imports': ['error', { patterns: [
    { group: ['@tools/*', '@/tools/*'], message: 'memory 禁止依赖 tools（档案域宪法 P1）' },
  ]}]}},
```

验收命令：

```bash
grep -rn "from '@tools" src/memory                     # 必须为空
grep -rn "1\[3-9\]" src --include="*.ts" | grep -v resolution/candidate   # 手机号正则只剩一份
npx jest --watchman=false tests/resolution/candidate   # 分歧句用例全绿
```

### 1-C 分歧句用例清单（PR 验收物模板）

每字段一个 `describe('口径合一')`，把方案 §1.3 的分歧句逐条写入，断言采用口径。例：

```
「需要有食品健康证是吗」→ null（采规则轨疑问句守卫）
「老家是安徽」→ 安徽（采 tools 轨宽锚点）
「姓名：布买日也木」→ 宽松档过、严格档拒（双档并存，消费方注明）
```

---

## P2 · evidence 立域（裁决引擎迁出 memory）

文件迁移映射（git mv 保历史，**同步改成人话名**）：

| 源 | 目标 |
|---|---|
| `memory/facts/candidate/candidate-fact-claim.types.ts` | `resolution/evidence/claim.types.ts` |
| `memory/facts/candidate/candidate-fact-adjudicator.ts` | `resolution/evidence/engine.ts` |
| `memory/facts/candidate/candidate-fact-policy.ts` | `resolution/evidence/policies.ts` |
| `memory/facts/candidate/candidate-fact-normalizers.ts` | `resolution/evidence/normalize.ts`（内部改调 `@resolution/candidate`） |
| `memory/facts/candidate/candidate-effective-profile.ts` | `resolution/evidence/profile.ts` |
| `memory/facts/candidate/adjudication-runner.ts` | `resolution/evidence/run.ts` |
| `memory/facts/candidate/precheck-snapshot.types.ts` | `resolution/evidence/snapshot.ts` |
| `memory/facts/candidate/producers/*` | `resolution/evidence/producers/*` |
| `tools/duliday/booking/snapshot-gate.util.ts` | `resolution/evidence/snapshot-gate.ts` |
| precheck.tool 内 `CLAIM_FIELD_TO_CHECKLIST` 等三张映射表（:645-703） | `resolution/evidence/checklist-map.ts` |

同期动作：
- `HighConfidenceValue` 包装/解包 9 函数（ruleValue/unwrap/filter/assertRegistryFieldsMirrored 等，hcf:630-839）→ `memory/types/high-confidence.ts`；tools/agent 六个文件的 import 从 hcf 改到新居所（这是它们 import 1734 行大文件的唯一原因）。
- `confirmation-facts.ts` / `location-share.ts` 的 `stripQuotedBlocks` 改直连 `@infra/utils/message-markup`（不再为一行转发 import 整个 hcf）。
- `observability/observer.interface.ts` 的 claim 类型 import 改新路径（事件契约不变）。
- `CandidateSnapshotService` 留 memory，只剩 get/set；水位/版本计算改调 `evidence/snapshot.ts`。

ESLint：

```js
{ files: ['src/tools/**/*.ts'],
  rules: { 'no-restricted-imports': ['error', { patterns: [
    { group: ['@memory/facts/*', '@/memory/facts/*'], message: 'tools 禁止依赖 memory/facts（档案域宪法 P2）；服务经 DI' },
  ]}]}},
```

验收：`grep -rn "memory/facts/candidate" src tests` 为空；`fact_adjudication` 观测事件照常落库（跑一条 debug-chat 验证）。

---

## P3 · 字段策略收口（city 首发上底盘）

> ⚠️ blocker：本期 3/7 两项分别依赖裁决 D2（district 累积语义）、D1（简历判据口径），先拿裁决再动；其余五项无 blocker。

1. **city 策略行**（`evidence/policies.ts` 加 city 行 + `evidence/producers/city.ts`）：七条产生路径注册为 producer（规则扫描/LLM/白名单回填/定位分享/地图截图/确认问答/geocode 确权）；四份手写让位删除点——`session.service.ts:977-979`、`:1230-1232`、`:1523`、`saveToolAttestedCity :349-366`（后者整函数改为调策略行，保留污染自愈语义为策略参数）。同步试点「存量也是主张」（把 Redis 旧值包成 archive 主张送引擎）。定位分享改一次逆解析：prep 的 `seedLocationShareAnchor` 产出挂回合上下文，轮末入档消费同一实例（删 `buildLocationShareCityFact` 里的二次逆解析）。
2. **归一器合一**：`geo-name.normalizer.ts` 扩省级后缀（口径裁决：剥不剥「省」，对齐拉群匹配需求）；删 `biz/group-task/utils/city-normalize.util.ts`，5 个引用点（context.service、reply-repair、invite-to-group、invite-city-gate、invite-timing-gate）改 `@resolution/geo`；session.service 等 7 处内联 `.replace(/市$/,'')` 一并替换。
3. district/location 值域门 +（D2 裁决后）清除语义。
4. **11 道臆造门 → `evidence/admission.ts`**：session.service 现内联的门（纯数字姓名/引用发言人/第三方号码出处/健康证话题/is_student 话题/扇出熔断/城市形状/name 救援/……）逐一迁为 admission chain 步骤，输入 `(newFacts, previous, 语料)`，输出 `(facts, dropped[])`；session.service 只调用并把 dropped 发观测。`fact-shape-gates.ts` 与 `placeholder-identity.ts` 在此消失（拆进 admission 与 candidate）。
5. **合并策略 Record**（`evidence/merge.ts`）：`Record<FieldKey, MergePolicy>` 编译期穷尽，三份手抄清单删除（P0-4 的铁丝网同时拆除）；健康证 rule-覆盖-LLM 等特例成显式策略。
6. **来源互转表**（`evidence/interop.ts`）：五套「谁说的」枚举映射唯一居所，`toCollectedFieldProvenance` 迁入并标注有损项。
7. （D1 后）简历判据合一：三份语料过滤器（session 的 typedOrSelfMaterialMessages / run.ts 的 extractCandidateTexts / visual-description 的 keepSelfReportedMessages）合为 `evidence/corpus.ts` 单一实现，sheet 优先 + 文本兜底；`memory/facts/visual-description.ts` 删除（isDigitsOnlyName 已随 P1 进 candidate/phone|name）。
8. FIELD_EXTRACTORS 注册表 → `evidence/producers/rule-track.ts`，hcf 文件消失（信封工具已于 P2 迁出）。
9. **消息型 producer 前移 prep**：tool-context.builder 在 prep 跑 rule-track producer 产临时判决挂回合上下文；precheck 的 HC-2 就地解析、invite 门 userTexts 扫描改读共享实例。city 先行，P4 推广。

验收：

```bash
grep -rn "confidence === 'high'" src/memory/services/session.service.ts   # 让位判据 0 命中
grep -rn "SCALAR_PREF_FIELDS\|ARRAY_PREF_FIELDS" src                      # 手抄清单已删
grep -rn "city-normalize" src                                             # biz 归一器已删
```

---

## P4 · 终态归位

1. `resolveExtractionScope` 授权域并入 `evidence/admission.ts`；`resolution/visual/visual-fact.policy.ts` 删除（`mapLocationCityCandidates` 随 city producer 走）。
2. `memory/facts/` 收尾解散：`confirmation-facts.ts` → `evidence/producers/city-confirmation.ts`；`location-share.ts` → `evidence/producers/location-share.ts`；`fact-merge.util.ts` → memory/services 内部；`name-guard.ts` 残骸（sanitizeInterviewName）→ admission；目录删除。
3. 读模型收口：memory-block.formatter 的「已失效历史资料」裸字符串比对（formatProfile:181-184）改读裁决结果。
4. 消息型 producer 前移推广到全部字段（P3-9 的 city 试点验证后）。
5. 文档刷新：CLAUDE.md 架构树、memory README（现漏列 5 个在跑文件）、visual-fact-pipeline.md（附录 A 随 D6 裁决）、.eslintrc.js 注释、本文与方案的«已完成»标记。

---

## P5 · brand 上底盘（终态无例外）

1. 按方案 §3① 映射表把 reducer 八条行为写成 `evidence/policies.ts` 的 brand 行（复合槽值 currentBrand+excludedBrands、operation=set/exclude/clear、渠道优先序 user_text>image_description、履历语境闸、赦免规则、assertedAt 水位）。
2. 四条输入轨（hints/规则/LLM/昵称）收敛为 `evidence/producers/brand.ts`，预处理（剥引用块/时间后缀/位置分享段）统一收在 producer 入口——§19.2 的「调用方无法再漏」承诺自此对所有轨成立。
3. **金测试**：`tests/resolution/brand/brand-state-reducer.spec.ts` 现有全集改为对新引擎回放，一条不许改语义地全绿——这是切换闸；shadow_diff 为**发版后验证**（连续 7 天零分歧确认），不阻塞 campaign（执行模式节裁定）。
4. 删除：`brand-state.reducer.ts`；`validateBrandIntents`（session.service:1295-1350）与 `detectBrandAliasHints`（hcf 已亡，其迁移中转位置）并入 producer；`isSameBrandRef` 两份合一。BrandStateService 只剩存取（buildHashKey 自持副本在 P2 前后随手删，走 SessionService 出口）。
5. 存储格式（brand_state 字段形态）不迁。

验收：`git log --diff-filter=D` 里有 reducer；`grep -rn "brand-state.reducer" src` 为空；发版后 shadow_diff 报表连续 7 天零分歧（后验，异常即整体回滚）。

---

## 附 · blocker 对照表

| 裁决 | 卡住的动作 |
|---|---|
| D1 简历判据口径 | P3-7 语料过滤器合一、P4-2 visual-description 删除 |
| D2 district 累积语义 | P3-3 |
| D3 LLM 城市置信度 | P3-1 city 策略行的 producer 权重参数 |
| D4 shadow→enforce | 不卡工程，卡 booking 行为切换 |
| D6 visual 零读者 key | P4-5 附录 A 刷新 |
| 归一剥「省」口径 | P3-2 |

一气呵成模式下的唯一开工条件：上表四项代码 blocker（D1/D2/D3/剥省口径）一次拍完。D4/D6 不阻塞代码终态（前者是运行时开关，后者是词表增删的独立小改）。


---

## P6 · 回合账本（第二 campaign：轮内协调者立名，兑现判决时刻表 P3-9）

> 设计依据：方案 §2.0「协调者与工具契约的关系」与 §4 Phase 6。纪律照旧：单分支一气呵成、无别名期、旧写法物理删除、typecheck 全程护航。
> **步骤 0：从干净基线开工**——先把工作树现状按 pathspec 提交（campaign 主体一个 commit、评审修复一个 commit），全绿后再动第一刀。

### 6-1 `src/types/turn.types.ts` 立名

- 新建 `TurnLedger` 接口：列表条目用只读视图 + `record*()` 追加方法；单值标志（`bookingSucceeded` / `jobListExecuted` / `resolvedWorkOrderId`）保持可写属性。骨架：

```ts
export interface TurnLedger {
  readonly visualFactSheets: ReadonlyArray<{ messageId: string; sheet: FinalizedVisualFactSheet }>;
  readonly imageBrandResolutions: ReadonlyArray<{ messageId: string; resolutions: BrandResolution[] }>;
  readonly geocodeAnchors: readonly GeocodeResolvedAnchor[];
  readonly cityAttestation: CityAttestation | undefined;
  readonly fetchedJobs: readonly unknown[];
  readonly jobListQuery: { signature: string } | undefined;
  readonly invalidatedJobIds: readonly number[];
  readonly ruleFacts: HighConfidenceFacts | null;   // prep 时刻规则轨产物（消息型首批条目）
  bookingSucceeded: boolean;
  jobListExecuted: boolean;
  resolvedWorkOrderId?: number;
  recordVisualFacts(sheet: FinalizedVisualFactSheet, meta: { messageId: string }): void;
  recordImageBrands(resolutions: BrandResolution[], meta: { messageId: string }): void;
  recordCityAttestation(attestation: CityAttestation): void;   // 后到覆盖先到
  recordFetchedJobs(jobs: unknown[]): void;
  recordJobListQuery(query: { signature: string }): void;
  markJobInvalidated(jobId: number): void;
}
```

- `GeocodeResolvedAnchor` / `CityAttestation` / `GeocodeLocationAnchor` 三个条目类型自 `tool.types.ts` 迁入 `turn.types.ts`（`tool.types.ts` 瘦回工具契约），全库 import 路径同步。
- 实现放 `src/agent/generator/preparation-utils/turn-ledger.ts`（`createTurnLedger()` 工厂），prep 的匿名 `turnState` 对象删除、由工厂实例取代；turn-finalizer / memory-lifecycle 改为只读消费 ledger 属性（允许 `drain()` 快照式实现，但**禁止出现第二条写路径**）。

### 6-2 `ToolBuildContext` 五组化（完整改名账）

| 组 | 收编字段（现名 → 新名） |
|---|---|
| `session` | userId / corpId / sessionId / chatId / token / imContactId / imRoomId / apiType / botUserId / botImId / groupId / turnId / contactName（原名不变，仅入组） |
| `archive` | profile / sessionFacts / sessionBrandState / currentStage / availableStages / stageGoals / recalledJobIds / isRecalledJobId / lastJobListQuery / activeBookingJobIds / currentFocusJob / recentBrandPool / bookingCandidateFacts |
| `turnInput` | messages / currentUserMessage / currentLaborFormIntent / imageMessageIds / imageUrls / visualMessageTypes / contactBrandAliases / geocodeLocationAnchor |
| `ledger` | turnVisualFactSheets→`visualFactSheets`、geocodeResolvedAnchors→`geocodeAnchors`、jobListExecutedThisTurn→`jobListExecuted`、runtimeWorkOrderId→`resolvedWorkOrderId`、bookingSucceeded（不变）、highConfidenceFacts→`ruleFacts`；六个回调转正：onVisualFactsResolved→`recordVisualFacts` / onImageBrandResolved→`recordImageBrands` / onCityResolved→`recordCityAttestation` / onJobsFetched→`recordFetchedJobs` / onJobListQueryExecuted→`recordJobListQuery` / onJobInvalidated→`markJobInvalidated` |
| `runtime` | hasNewerUserInput / strategySource / thresholds |

命名四规则：①分组即作用域、`turn*` 前缀退役；②回调转正为写方法；③条目类型随账本迁居、名字不动；④无别名期一次改到位。改动面 = 全部工具文件 + tool-context.builder + preparation.service + turn-finalizer/memory-lifecycle + memory-block.formatter + 相关测试，全部机械替换（`context.userId`→`context.session.userId` 等），grep 驱动、typecheck 收敛。

### 6-3 消息型前移 + 工具内解析退役（一信号一判的最后兑现）

1. prep 构建 ledger 时跑规则轨一次 → `ledger.ruleFacts`；**轮末 `extractAndSave` 改消费 `ledger.ruleFacts`，删除自己那次规则轨重跑**（同轮第二判消灭）。⚠️ 前置核对：轮末语料与 prep 输入必须同源（debounce 合并后固定）；发现不一致以 prep 为准并在 PR 里说明。
2. 收资就地解析退役：`parseCandidateFieldsFromText` 的调用从 precheck/booking 工具内前移到 prep（产物挂 `ledger.collectedFields`），工具改读 ledger；`collected-fields.ts` 本体不动（它是解析器，动的是调用时刻）。
3. invite 城市门的 `inferCitiesFromGeoSignals`（userTexts 全量地名扫描）前移 prep 计算一次 → `ledger.geoSignalCities: ReadonlySet<string>`；门改消费共享集合。
4. guardrail review-packet 的视觉证据改读 `ledger.visualFactSheets`（彻底告别从工具 args 反解，P0-5 的 finalize 调用随之删除）。

### 6-4 验收命令

```bash
grep -rn "turnVisualFactSheets\|jobListExecutedThisTurn\|runtimeWorkOrderId\|onVisualFactsResolved\|onImageBrandResolved\|onCityResolved\|onJobsFetched\|onJobListQueryExecuted\|onJobInvalidated" src tests   # 必须为空
grep -rn "turnState" src/agent/generator   # 匿名对象消失
grep -rn "extractHighConfidenceFacts" src/memory/services   # 轮末重跑已删（只剩 prep 一处调用）
grep -rn "parseCandidateFieldsFromText" src/tools   # 工具内就地解析已退役
pnpm run typecheck && pnpm run lint:check && npx jest --watchman=false   # 三大件全绿
```

---

## P7 · 通货收尾（余款 P3-8：rule-track 的 claim 化）

> **必须在 P6 之后**：账本落地后 rule-track 的身份是"prep 时刻的 producer"，目标形态才清晰，避免改两遍。

1. `producers/rule-track.ts`（1375 行，原 hcf 形态整体寄居）改写为逐字段 claim producer：每字段调 `@resolution/candidate` 解析器、产出带 quote 的 `CandidateFactClaim`；FIELD_EXTRACTORS 注册表语义（first-scalar / last-scalar / union-array）翻译成对应字段策略行参数（`policies.ts`），不得在 producer 里私藏合并逻辑。
2. `HighConfidenceValue` 包装/解包设施（`memory/types/high-confidence.ts`）全量退役删除；admission / merge 的输入统一为 claim 流。§2.3 信封终态表最后两行"退役"落袋，不变式①在全字段完全兑现。
3. 行为等价守则：现有全量测试 + 分歧句用例回放全绿为闸；任何口径变化必须先在 PR 里逐条声明（同 P1 纪律）。
4. 验收：`grep -rn "HighConfidenceValue" src` 为空（历史注释除外）；`grep -rn "filterHighConfidenceFacts\|unwrapHighConfidenceFacts" src` 为空；三大件全绿。


---

## P8 · 信号轴归拢（登记工序立名；P6 落地后任意时点执行，零行为变更）

> 设计依据：方案 §2.1「两条正交轴的澄清」与 §4 Phase 8。登记处 = 每种信号唯一的"盖章+验章+归属先验"窗口；现散居三域，归拢为 resolution 第三道工序。

1. 建 `src/resolution/signal/`（文件名走人话，勿沿用 markup/corpus 两个行话名）：
   - `git mv src/infra/utils/message-markup.util.ts src/resolution/signal/markers.ts`，全库 `@infra/utils/message-markup.util` → `@resolution/signal/markers`（含 tests；写入侧 append*/format* 一并随迁——登记处有盖章权）。
   - `evidence/corpus.ts` **按消费者拆两份**迁入：`signal/self-report.ts`（自陈判定：isSelfReportedCandidateMessage / keepSelfReportedMessages / hasSelfReportedPhoneProvenance / extractCandidateTexts，供 rule-track/admission/adjudicate）；`signal/dialogue.ts`（对话读取原语：extractUserTexts / extractDialogueTurns / stripQuoteBlocks / extractQuotedSpeakers / normalizeShortAnswer / isAffirmativeAnswer，供 name-confirmation / city-confirmation / identity-gates）。corpus.ts 删除，引用面按符号归属改指。
   - `git mv src/resolution/visual src/resolution/signal/visual`，全库 `@resolution/visual` → `@resolution/signal/visual`（tsconfig 别名无需新增，路径直改）。
2. `stripMessageDecorations` 自 `candidate/student-identity.ts` 迁入 `signal/markers.ts`（它就是时间+引用的复合剥离），student-identity 改 import。
3. ESLint：核查 `grep -rn "@infra/utils" src/resolution` ——若仅剩 date.util 消费则保留窄例外、否则整条撤销 `!@infra/utils` 负向；`.eslintrc.js` 注释同步。检查 geo 专属 override 一致性。
4. 文档刷新：CLAUDE.md 架构树（登记/解析/裁决三工序 + infra/utils 回归四件套）、`src/resolution/evidence/README.md`（corpus 指针）、`docs/architecture/visual-fact-pipeline.md` 路径。
5. 验收：
```bash
grep -rn "infra/utils/message-markup\|evidence/corpus" src tests   # 为空
grep -rn "@resolution/visual'" src tests                # 为空（已全部改 signal/visual）
ls src/infra/utils                                      # 只剩 date/string/object/fetch-timeout
pnpm run typecheck && pnpm run lint:check && npx jest --watchman=false
```


---

## P9 · 域契约收口（types 约定；P8 之后执行，纯类型搬迁零行为）

> ⚠️ 反模式先立牌：不得造万能 `SignalResult<T>`/统一返回信封——跨工序通货只有 claim（不变式①）。本工序只统一**契约位置**与**共享词表居所**，不统一返回结构。

1. 约定：被域外 import 的 interface/type 必须住本域 `types.ts`；函数与域内中间形状不受限；labor-form 单文件域豁免。
2. `signal/types.ts` 新建：`DialogueTurn`（自 dialogue.ts）、`LocationShareCoordinates`（自 markers.ts）、`FieldOwnership` + `FIELD_OWNERSHIPS`（自 visual/visual-fact.types.ts 升入，visual 内改 import——"归谁"是信号轴公共先验）。
3. `candidate/types.ts` 新建：`CandidateFieldKey` / `CandidateFieldProvenance` / `CandidateCollectedField` / `AUTHORITATIVE_PROVENANCE`（自 collected-fields.ts），collected-fields 留函数；`memory/types/authoritative-session-state.types.ts` 的别名转发改指。
4. evidence 收口：`NameGateVerdict`（identity-gates → tools 消费）迁入 `claim.types.ts` 的 verdicts 段；`MessageExtractionScope` 若仍被域外消费则同迁，否则留 admission 内部。
5. 验收：
```bash
# 逐域抽查：域外 import 的类型定义处均为 types 文件
grep -rn "import type.*from '@resolution" src --include="*.ts" | grep -v "types\|@resolution/candidate'\|@resolution/geo'\|@resolution/signal'\|@resolution/labor-form'" | head
pnpm run typecheck && pnpm run lint:check && npx jest --watchman=false
```


---

## 收尾 · 两项交接任务（2026-08-11，当前唯一待执行）

### 收尾-1 消费权限表收口（P4-5 遗留，全库仅剩 2 散点）

- 新建 `src/tools/shared/action-confidence.ts`：一张「动作 → 允许消费的最低置信档」显式表 +
  判定函数（命名走人话，表用 `as const satisfies Record<...>`，加动作不表态即类型报错）：

```ts
import type { SessionFactConfidence } from '@memory/types/session-facts.types';

/** ④使用层唯一的置信消费权限表：哪个动作要求档案值至少什么档。加动作必须在此表态。 */
export const ACTION_MIN_CONFIDENCE = {
  /** 拉群门读 sessionCity（invite-to-group）。 */
  invite_city: 'high',
  /** 发门店定位时采信 geocode 候选（send-store-location；precision 条件留调用点，非置信语义）。 */
  store_location_geocode: 'high',
} as const satisfies Record<string, SessionFactConfidence>;
```

- 改两处消费点读表：`src/tools/invite-to-group.tool.ts:310`（`cityFact.confidence === 'high'` → 查表）、
  `src/tools/send-store-location.tool.ts:181`（仅置信半句换表，`precision !== 'road'` 原样留下）。
- 测试：`tests/tools/shared/action-confidence.spec.ts`（表完备 + 两动作档位断言）。
- 验收：`grep -rn "confidence === 'high'" src/tools --include="*.ts"` 仅剩 action-confidence.ts 自身（或为空）；三大件全绿。
- 提交（pathspec）：`git commit -m "refactor(candidate-profile): 消费权限表收口" -- src/tools/shared/action-confidence.ts src/tools/invite-to-group.tool.ts src/tools/send-store-location.tool.ts tests/tools/shared/action-confidence.spec.ts`

### 收尾-2 文档尾款提交

- 只提交这三个文件（pathspec，勿 `git add -A`）：
  `docs/architecture/candidate-profile-domain-refactor-plan.md`、
  `docs/architecture/candidate-profile-domain-implementation-guide.md`、
  `docs/architecture/diagrams/candidate-profile-domain-map.html`
- 建议信息：`docs(candidate-profile): 同步 P6-P9 执行状态与图解历史横幅`
- ⚠️ **`docs/releases/2026/weekly-2026-08-07.md` 的 staged 删除不是本 campaign 的改动，严禁提交或还原，原样留给仓库主人处置。**


### 收尾-3 岗位指代解析归位（独立债二清偿：session-job-matching 出 memory）

性质：`extractPresentedJobs`（助手回复→本轮展示的岗位）与 `resolveCurrentFocusJob`（候选人最新话→焦点岗位/清焦点）是**岗位指代的字段解析器**（文本→岗位集合/焦点，与 brand 同音回指、geo 地名扫描同性质），实现却寄居主权方 memory——宪法违章，纯搬迁清偿。

1. `git mv src/memory/services/session-job-matching.ts src/resolution/job/index.ts`（单文件域，index 即契约，labor-form 先例）。
2. **类型随迁（必做，否则 resolution→memory 违 ESLint）**：`RecommendedJobSummary` + `RecommendedJobSummarySchema`（session-facts.types.ts:810/839）迁入 `src/resolution/job/types.ts`；`session-facts.types.ts` 改为存储侧别名转发（CollectedField 同款注释："类型唯一定义在 @resolution/job/types，此处仅作存储侧转发"），既有 import 路径经转发继续有效，域外引用不必全改。
3. 消费者改指 `@resolution/job`：`src/memory/services/session.service.ts`、`src/agent/reengagement/anchor.service.ts`。job 域 import `@sponge/job-category.util` 合法（brand 先例）。
4. 测试镜像随迁：`git mv tests/memory/session-job-matching.spec.ts tests/resolution/job/index.spec.ts`，内部 import 改 `@resolution/job`。
5. 验收：`grep -rn "session-job-matching" src tests` 为空；`grep -rn "from '@memory" src/resolution` 为空；三大件全绿。
6. 提交（pathspec）：`refactor(candidate-profile): 岗位指代解析归位 resolution/job`。

### 收尾-4 active_booking 死字段清理 + 界碑注释（独立债一改判「暂住，带迁居触发条件」）

裁决（jiezhu，2026-08-11 两轮讨论）：**先打扫，再立碑；暂住不是定居。**

**A. 死字段清理（已验证零业务读者，零存储迁移）：**
1. `src/memory/types/long-term.types.ts` 的 `ActiveBooking`：删除四个 @deprecated 字段（interview_time / brand_name / store_name / job_name）——grep 全库唯一触点是 store 归一化行本身（fact-lines / checklist.util 命中的是 `interview_info.interview_time`，同名不同物，勿动）。
2. `src/memory/stores/supabase.store.ts:79-82`：删除对应四行 JSONB 归一化；老行里的死键从此被静默忽略。
3. 过时注释清理：类型文档块里「迁移 20260630120000 改名」沿革保留一句即可；「顶层字段仍指向最近一笔，兼容旧调用方」改写为准确现状——代码侧单数 API 已由 `bookings[]` 派生（supabase.store:383-384），顶层镜像仅为**老行 JSONB 形态兼容**而保留在写入侧，不再有「旧调用方」。

**B. 界碑注释（钉在清理后的 `ActiveBooking` 文档块）：**
- **出身沿革（一句写清，防止后人误判为寄居）**：前身独立表 `interview_booking_records` 是日期×品牌×门店的聚合统计表（`UNIQUE(date,brand_name,store_name)`+计数器，逐人身份是补丁），因聚合无逐人身份、bot_im_id 裂行等病于 20260625 DROP——当年是**按性质一拆为二**：统计漏斗归 `ops_events('booking.succeeded')`，逐人当前指针归档案本列（latest_booking→active_booking）。住进档案是拆分的结果，不是无意寄居。
- 暂住理由两条：①纯事务指针（清理后仅 work_order_id/linked_at/job_id/bookings），业务状态唯一权威是海绵；②访问模式与每用户一行的长期记忆表同构。
- **迁居触发条件（任一出现即迁 biz 独立表）**：出现「按工单反查候选人」需求；或工单状态回流（webhook）立项。**迁居形态要求：关系指针表（corp_id+user_id+work_order_id 一行一工单，身份口径用 wecomUserId），严禁复活聚合计数表形态——老表死因。**
- 硬纪律：**本结构禁止新增业务字段；任何「顺手存一下面试时间/门店」的提案一律拒绝。**

验收：`grep -n "interview_time\|brand_name\|store_name\|job_name" src/memory/types/long-term.types.ts src/memory/stores/supabase.store.ts` 为空；三大件全绿。同步方案 §6 状态。提交（pathspec）：`refactor(candidate-profile): active_booking 死字段清理与界碑`（long-term.types.ts + supabase.store.ts）。


### 收尾-5 D5 落地：enrichment 性别入档（gender_source='system'）

裁决（jiezhu，2026-08-11）：入档，认 `gender_source='system'` 语义。现状：`memory-enrichment.service.ts:57` 每轮在档案无性别时查客户详情接口，经 `mergeSupplementalGenderClaims` 只进本轮 ruleFacts（sidecar），不落档 → 同一候选人每轮重查。

1. 让补全性别沿正常裁决→落档链路持久化：`interview_info.gender` + `gender_source='system'`（producer/来源按 evidence 现行体系，出处记「客户详情接口」）。
2. 合并策略必须保持：**候选人自陈 > system**——system 值只填空，永不覆盖自陈；候选人此后自报性别可覆盖 system 值（gender 策略行显式表态）。
3. 验收：同一候选人第二轮日志不再出现「客户详情补充性别成功」（接口只查一次）；档案里 `gender_source='system'` 可见；自陈覆盖用例绿；三大件全绿。
4. 提交（pathspec）：`feat(candidate-profile): enrichment 性别入档 gender_source=system`。

### 收尾-6 D6 落地：visual 词表瘦身（砍 7 留 8——含两个分流槽，勿砍到 6）

裁决（jiezhu，2026-08-11）：砍死键、A2/B2 承诺解绑另行立项。⚠️ **执行修正**：`publisher`/`store` 虽零读者但是**分流槽**——R2 发布方剔除靠「模型有地方放发布方名」实现，砍掉会让发布方名流进 `brand` 键（发布方品牌劫持回归）。

1. `src/resolution/signal/visual/visual-fact.types.ts` 的 `VISUAL_FACT_FIELD_KEYS`：**砍 7**（name / age_range / brand_id / salary_text / shift_text / cert_type / cert_issue_date），**留 8**（phone / brand / city / address / candidate_address / other + 分流槽 publisher / store）。
2. 给 publisher/store 加注释：「零读者但为分流槽——保护 brand 键不被发布方名/门店名污染（R2），砍除即劫持回归」。词表 prompt（VISUAL_FACT_FIELD_KEY_PROMPT）由常量生成自动变短，无需另改。
3. 存量兼容说明：老 `visual_facts` 行里被砍 key 经 `parseStoredVisualFactSheet` 的 finalize 白名单静默丢弃——它们本就零读者，零行为影响。
4. 文档：`docs/architecture/visual-fact-pipeline.md` 附录 A 刷新（记录本裁决：A2 品牌ID直通 / B2 健康证补齐两条承诺与词表解绑，另行立项）。
5. 验收：vocabulary spec 更新绿；`grep -n "cert_type\|age_range\|salary_text\|shift_text\|brand_id" src/resolution/signal/visual/visual-fact.types.ts` 为空；三大件全绿。
6. 提交（pathspec）：`refactor(candidate-profile): visual 词表瘦身（砍7留8，分流槽保留）`。

### 收尾-7 D7 前置验证：县级市开关对照表（不翻开关，只出报告）

裁决（jiezhu，2026-08-11）：先测后开。**本任务不翻任何环境开关**，只产出对照证据供拍板：

1. 写对照 spec（如 `tests/resolution/geo/national-county-mapping-diff.spec.ts`）：同一批县级市输入（含「余姚」类历史补录案例）在 `GEO_NATIONAL_COUNTY_MAPPING_ENABLED` 开/关两态下跑 `administrative-area.resolver`，输出差异表（哪些输入从 unresolved → 命中、命中到哪个城市）。
2. 差异表贴进 PR 描述，作为用户拍「默认开启并删开关」的凭据；开关翻转与删除**留给用户终审后另行执行**。
3. 提交（pathspec）：`test(geo): 县级市映射开关对照表`。

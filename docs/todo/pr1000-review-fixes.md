# PR #1000 评审修复清单（候选人档案域重构）

> 来源：2026-08-12 对 PR #1000（`codex/candidate-profile-domain-refactor` → `develop`）的多轮审查+对抗验证。
> 每条都经过独立验证 agent 裁决（CONFIRMED = 已复现机制与触发条件；PLAUSIBLE = 机制成立、触发待证）。
> 修复目标分支：`codex/candidate-profile-domain-refactor`（在合入 develop 前修完 P0）。

## 修复状态（2026-08-12 回写，已推送至 `codex/candidate-profile-domain-refactor`）

> 六笔提交（cb8ee452..2d9b7f93）：
> `49084476` P0 数据管线（规则轨双时点/首写门/normalize/空轮门）
> `8add33c0` 字段解析器生产形态回归 + fixture 族
> `77470b2f` booking 身份闸门 + 性别表内确认 + 区县准入
> `cb989632` repair 逃生舱 + 降级 sheet 证据 + semantic_track_diff 落库
> `1ccd4495` 工具层小回归（invite 门 NPE/催填扣减/经验号污染/geo-name）
> `2d9b7f93` P3 清理（死表/死导出/ESLint 边界）
> ⚠️ 主工作树本地 codex 分支落后 origin 六个提交，并发会话提交前需先 pull。
> ⚠️ booking spec 的通用 fixture 手机号已从占位号 13800138000 换成 13812345678（占位号现被 P0-8 正确拦截）。

> 全部 P0/P1/P2 已修或已裁定；生产形态 fixture 族已落 `tests/helpers/production-message.fixture.ts` +
> `tests/resolution/production-form-regression.spec.ts`。逐项状态：
>
> | 项 | 状态 | 说明 |
> |---|---|---|
> | P0-1 规则轨 prep 整合 | ✅ 已修 | prep 改逐消息数组（`trailingUserMessages`）；轮末 extractFacts 恢复对当前会话段带 `visualSheetsByContent` 的规则轨重扫（develop 行为回归），enrichment 的 system 补充 claim 原样保留 |
> | P0-2 首写门视觉豁免 | ✅ 已修 | `applyExtractionProvenance` 语料换 `typedOrSelfMaterialMessages`（简历/证件自有材料保留）；self-report.ts 的 `record.visualFactSheet` 死读已删（无人挂载，留注释） |
> | P0-3 experience 出处 | ✅ 已修 | 新增 `experienceValueSupportedByQuote`（NFKC+去标点+中文数字折叠后二元组覆盖 ≥60%，短值退回包含），experience 保留在首写门内 |
> | P0-4 性别表内确认死锁 | ✅ 已修 | 新增 `producers/gender-confirmation.ts`（表内确认问句 + 肯定应答/同值复打，反值=纠正）；precheck 接线解锁 |
> | P0-5 quote 标点折叠 | ✅ 已修 | `normalizeEvidenceText` 回退 NFKC+去空白；「不，是学生」vs「不是学生」边界已加测 |
> | P0-6 健康证「没办过」 | ✅ 已修 | 裸「没办过」要求同子句含健康证上下文；terse/inherits 前缀路径召回不受损 |
> | P0-7 空轮短路门 | ✅ 已修 | `typedOrSelfMaterialMessages` 构造时剥时间后缀（连带净化 phone 出处数字流） |
> | P0-8 手机号门 | ✅ 已修 | 语料换 `extractCandidateTexts`（视觉非自有材料剔除）；`isStorableCandidatePhone`+`isPlaceholderPhone` 三处收紧（含确认对答不解锁占位号）；name-confirmation 改无尾边界的 `1[3-9]\d{9}`+占位拒绝（空白折叠粘连场景） |
> | P0-9 repair 逃生舱 | ✅ 已修 | `resolveJobEvidenceAvailability` 零查岗轮返回 `false`（原 undefined），诚实删幻觉的 rewrite 不再被回退 |
> | P1-10 gender 守卫 | ✅ 已修 | 疑问/要求/第三人称守卫全部改子句级；要求式恢复「男的/女的/男生…」完整搭配 |
> | P1-11 collected-fields | ✅ 已修 | 逐条 stripTimeContext+stripQuotedBlocks 后再 join |
> | P1-12 is_student | ✅ 已修 | STUDENT_CLAUSE_RE 并入 大一~大四/在校 |
> | P1-13 age 锚定 | ✅ 已修 | 取文档给的第二方案：structured 分支改对 scrub 后文本匹配（保留任意空白锚定，内联表单「性别男 年龄28」不丢召回；vkikct39 形态由 scrub 拦截） |
> | P1-14 身份翻转闸 | ⚪ 裁定不修 | 复核证伪：`producers/student-identity.ts:53` 已调用 `resolveIdentityFlipAfterRejection` 并经 adjudicate→precheck 生产消费，与 develop 的 identity-claim.producer 同构；policies.ts:24 注释属实 |
> | P1-15 semantic_track_diff | ✅ 已修 | 落库白名单已加 + spec 落库断言 |
> | P2 invite-city NPE | ✅ 已修 | requested 为 null 走 city_unverified 拒绝 |
> | P2 height-weight | ✅ 已修 | 允许 左右/上下/多 尾缀；要求语境按每次出现的子句内窗口判定 |
> | P2 区县准入 | ✅ 已修 | 白名单裁决改形状合法性（isPlausibleLocationValue），鼓楼类保留原值不派生 city |
> | P2 gender fallback | ✅ 已修 | system 兜底补 `!merged.interview_info.gender` 守卫 |
> | P2 不限地区 | ✅ 已修 | 对本轮全部 user 消息判定并取并集 |
> | P2 催填扣减 | ✅ 已修 | `buildProvidedFieldLabels`（collectedFields+sessionFacts）扣减模板缺口，全补齐返回 null |
> | P2 经验手机号污染 | ✅ 已修 | 补裸 `1[3-9]\d{9}` 检查覆盖去空白粘连 |
> | P2 geo-name 津市市 | ✅ 已修 | 剥「市/省」以余下 ≥2 字为限（津市市→津市、芒市不塌缩）；省折叠维持现口径待 D3 对齐 |
> | P2 降级 sheet 证据 | ✅ 已修 | review-packet builder 从 save_image_description 入参回退重建（kind=other，fields 空） |
> | P3 裁决引擎下沉 | ⚪ 裁定不随本轮 | session.service 本轮已大改并补测；IDENTITY_FIRST_WRITE_FIELDS 等下沉 policies 属纯重构，另起 PR 更稳 |
> | P3 FIELD_POLICIES 死表 | ✅ 已删 | FIELD_POLICIES/FieldPolicy/EVIDENCE_FIELDS/EvidenceField/EvidenceOperation 零消费者，删除并留注释 |
> | P3 品牌 memo 击穿 | ⚪ 裁定不动 | brand-intents/catalog-index/brand-matcher 均涉并发会话未提交改动，按工作约定跳过 |
> | P3 ESLint 边界 | ✅ 已修 | tools 的 `@memory/facts/*` 死规则删除；resolution 对 @memory 的 type-only 豁免收紧为全禁（已零使用者） |
> | P3 词表/助手收拢 | ⚪ 裁定不随本轮 | 属机制类立项（词表收拢审计已有结论：重心是机制不是逐个搬），本轮不扩面 |
> | P3 死导出 | ◐ 部分 | 全死的 `parseHealthCertificate` 包装器与 `hasPhoneDigitStream` 已删；「仅测试引用」类（normalize*ToId 等）保留——它们是被单测锁定的契约，删除收益低 |
> | P3 结构/效率（rule-track 拆分、TurnLedger、shim、memo） | ⚪ 裁定不随本轮 | 重构面大、与并发会话改动相邻，不在回归修复轮里做 |

## 2026-08-13 复裁：一步到位批（P3-R）

> 用户裁定：PR #1000 本就是重大调整、尚未 review，纯结构重构折进同一轮评审一步到位。
> 复裁依据：**工作树已完全干净**（并发会话 WIP 全部落盘）——下表前两行的原延期理由已不成立。
> 纪律：本批全部改动必须**行为保持**（结构移动/类型化/性能修复），任何行为变更不属于本批。

| 项 | 原裁定与理由 | 理由现状 | 新裁定 |
|---|---|---|---|
| P3 裁决引擎下沉（IDENTITY_FIRST_WRITE_FIELDS 等自 session.service 下沉 policies） | ⚪ "另起 PR 更稳" | PR 未 review，"另起 PR"已无意义 | **✅ 本批执行** |
| P3 品牌 memo 击穿 | ⚪ "涉并发会话未提交改动" | 工作树干净，占用解除 | **✅ 本批执行** |
| P3 结构/效率：rule-track 拆分、TurnLedger、shim | ⚪ "重构面大、与并发改动相邻" | 相邻占用解除；TurnLedger 具体做：四域分组（visual/geo/jobs/facts）＋ `fetchedJobs: unknown[]` 按消费点最小类型化 ＋ 删 `TurnLedger` 对 extends 已含三字段的冗余重声明 | **✅ 本批执行** |
| P3 词表/助手收拢 | ⚪ 机制类立项 | 与并发无关，立项理由仍成立 | ⚪ 维持（独立立项） |
| P3 死导出「仅测试引用」类保留 | ◐ 契约锁定、删除收益低 | 理由仍成立 | ◐ 维持 |
| P2 拆机（refactor 清单 D5 确认 producer 族删除 / E3 双源对账拆除 / C6 规则轨停产 claim） | 门槛：coverage delta 收敛 | **仍守门——这不是保守**：shadow 期规则轨是事实供给主力兼对照组基准，确认 producer 是模型稳定提交 confirm claim 前的活逃生舱（偏离说明⑥）；此刻物理删除会复活 g4ytra23 死锁并废掉 coverage delta 仪表。门是"作证通道成为主通道"这个生产事实，不是时间 | ⛔ 维持行为闸 |

## 工作约定（必读）

- ~~⚠️ 工作树里 `src/resolution/brand/*`、`src/resolution/geo/{administrative-division.data,geo.types,index}.ts`、`src/memory/services/brand-state.service.ts`、`src/tools/duliday/job-list/brand-query.util.ts` 有**另一并发会话的未提交改动，不要动、不要 stash、不要一起提交**。~~（2026-08-13 复核：工作树已干净，该占用解除。）commit 一律 pathspec 限定自己的文件。
- 跑测试：`nvm use 22.16.0`，`pnpm run test -- <spec路径> --watchman=false`（不加 --watchman=false 会静默 0 测试）。收尾跑 `pnpm run ci:check`。
- 多条缺陷的共因是「**单测喂干净文本，生产喂带时间后缀 + debounce 拼接 + 图片占位符的文本**」。修复时必须新增一组生产形态 fixture（消息带 `\n[消息发送时间：2026-…]` 后缀、多消息 `\n` 拼接、含 `[图片消息]` 占位、含 `[引用 …：…]` 块），用它回归所有字段解析器与规则轨。

---

## P0 —— 数据管线与 booking 门（合入前必修）

### 1. 规则轨 prep 期整合回归（根因项，修好它带动 #2/#7 的一半）
- 锚点：`src/agent/generator/preparation.service.ts:350`（detectRuleFacts → `produceRuleFactClaims([text], brandData)`）
- 机制：develop 在轮末对**逐消息数组 + DB 加载的 visualSheetsByContent + 全会话窗口**跑 `extractHighConfidenceFacts`；现在只在 prep 期对 **`trailingUserContent()` 拼接单串**跑一次，且 `visualSheetsByContent` 生产端零调用（仅测试传）。prep 的文本来自原始回调 DTO，图片只有 `[图片消息]` 占位符（写回只进 chat_messages，永远到不了 trailingUserContent）。
- 已证实的后果：
  - 「先图后文」合并批：拼接串以 `[图片消息]` 起头 → `resolveExtractionScope` 整体落入 `{identity:false}` 兜底 → 同批手打的「我叫X 138…」身份/手机号抽取被禁（`src/resolution/evidence/admission.ts:408-411`）。
  - 逐消息设计的判据被拼接击穿：如身份 fallback 的疑问号门 `/[？?]/`（`src/resolution/candidate/student-identity.ts:169-175`）——`['有什么兼职吗？','我目前待岗']` 丢 is_student=false。
  - sheet 作用域逻辑全部死代码：`rule-track.ts:371-385` 的 `sheetFor`、R2 发布方品牌剔除、resume/certificate 的 SCOPE_SELF_REPORTED 身份授权。
  - 跨轮自愈丢失：重启/timeout 丢的轮次规则事实永久丢（develop 下一轮全窗口重扫可恢复）。
- 修复方向：规则轨入口恢复**逐消息数组**输入（prep 拿得到分条消息，不要预 join）；轮末 `extractAndSave` 恢复对当前会话段的重扫或至少把 `visualSheetsByContent`（session.service.ts:799-820 已在构建）重新传入规则 producer。

### 2. 简历/证件图身份字段被首写出处门每轮误杀
- 锚点：`src/memory/services/session.service.ts:1420-1422`（strictCandidateCorpus）、`1373-1380`（IDENTITY_FIRST_WRITE_FIELDS）、`1540-1548`（置空循环）
- 机制：语料一刀切 `!isVisualDescriptionText` 剔除全部视觉文本，无简历/证件自有材料豁免；age/gender/education/height/weight/experience 六字段的 model 首写找不到出处 → 每轮置空 → 每轮重问。同文件 826-832 已有正确的 `typedOrSelfMaterialMessages`（含自有材料）却没被这个门用。
- 修复方向：首写门语料换用/并入 `typedOrSelfMaterialMessages`。
- 关联死分支：`src/resolution/signal/self-report.ts:60` 读 `record.visualFactSheet` 但全库无人给消息对象挂这个属性（sheet 优先自陈判定 dead；证件图永远进不了自陈语料）。修复时一并接上或删掉该分支。

### 3. 合成式 experience 永远过不了逐字出处门
- 锚点：`src/memory/services/session.service.ts:1430`（quoteSupportsCurrentValue 的 experience 分支 = normalizedIncludes 逐字包含）
- 机制：抽取提示词命令模型「合并为 公司+岗位+时长 短句」，合成值几乎不可能是单条消息连续子串 → 首写门每轮置空 → precheck「过往公司+岗位+年限」永远缺失反复追问，且 extraction_field_dropped 事件流污染日掉落率告警。
- 修复方向：experience 出处判据改为「quote 在语料中 + 值的 token 子集出现在 quote」或给 experience 加 deriveFieldValueFromQuote 解析器；或将 experience 移出 IDENTITY_FIRST_WRITE_FIELDS。

### 4. precheck 性别表内确认死锁
- 锚点：`src/tools/duliday-interview-precheck.tool.ts:1040`（flag 计算）、`1386`（强制 collect_fields）、`1569-1572`（自相矛盾指令）
- 机制：`genderNeedsInlineConfirmation` 的全部清除路径都要求字面「男/女」token 或反值纠正；「都对的」类肯定应答、模型传同值 candidateGender 都清不掉 → ready_to_book 永不可达。确认 producer 只有 name/city 没有 gender；裁决 shadow-only。
- 修复方向：给肯定应答放行（复用 signal/dialogue 的确证机制，参照 name-confirmation 对称加 gender 确认路径），或模型显式传同值时视为确认。

### 5. quote 出处校验标点折叠削弱反臆造边界
- 锚点：`src/resolution/evidence/normalize.ts:23`（normalizeEvidenceText 剥 `\p{P}`）；消费方 `engine.ts:57`、`session.service.ts:1431/1496/1528`
- 机制：develop 是「精确子串或仅去空白」；现在把标点全折叠，否定分界被抹掉——候选人「不，是学生」可被伪造 quote「不是学生」命中：识别器读得懂时双 claim 冲突字段判 conflicted（真值丢失）；读不懂时（「不是，学生证还没办」）反转值被干净接受。
- 修复方向：出处包含判定回退为 NFKC + 去空白（与 develop 对齐）；标点容差只用于展示/等价比较，不用于 quote 收录判定。

### 6. 健康证「没办过」跨子句翻转
- 锚点：`src/resolution/candidate/health-cert.ts:64`
- 机制：「无」分支新增裸 `没办过` 备选（不要求子句含健康证），子句循环 latest-wins → 「我有健康证，社保还没办过」终值记「无」（sponge code 2）。develop 同输入返回「有」。
- 修复方向：`没办过` 要求子句内出现 健康证/证 上下文，或无证上下文的子句不参与覆盖。

### 7. 空轮短路门被时间后缀撑死（P0 反臆造保护失效）
- 锚点：`src/memory/services/session.service.ts:882`（effectiveCandidateTextLength 语料只剥引用块）
- 机制：`[消息发送时间：…]` 后缀恒贡献约 20 有效字符，`<4` 永不成立，「空轮短路」在生产上从不触发（其原始 badcase「我是.」照样调抽取 LLM）。同函数 strictCandidateCorpus 有 stripTimeContextSuffix，此处漏了。
- 修复：该语料补 `stripTimeContextSuffix`。

### 8. booking 手机号门：视觉文本盲区 + 宽松正则
- 锚点：`src/resolution/evidence/identity-gates.ts:106-112`（isPhoneAuthoritative 语料）、`:108,:136`（`/^1\d{10}$/`）、`src/resolution/evidence/producers/name-confirmation.ts:39`（裸 `/1\d{10}/`）
- 机制：(a) 门的语料 = turnInput.messages 全部 user 文本，只剥引用块不滤视觉描述文本 → 窗口内截图写回描述里的发布方手机号可通过出处校验直接进 gateway 报名载荷（booking 工具无其他手机号校验；memory 侧 foreignPhone 门反而正确剔除了视觉文本——两边口径对齐即可）。(b) 三处宽松正则接受 `11111111111` 等占位形态，是进真实工单前最后一道形态检查；「Agent 复述占位号+候选人应答『对』」路径（gu2kra6p 族）可解锁。
- 修复方向：(a) 门语料复用 self-report 的视觉文本剔除；(b) 三处统一改用 `resolution/candidate/phone.ts` 的 `CANDIDATE_PHone_RE`/`isStorableCandidatePhone` + `isPlaceholderPhone`。

### 9. 零查岗轮的 repair 回退逃生舱消失（PLAUSIBLE）
- 锚点：`src/agent/guardrail/output/repair-regression.util.ts:190`
- 机制：随规则下线删掉 ZERO_EVIDENCE_RULE_IDS 逃生舱后，`removesUngroundedJobClaims` 只认 `jobEvidenceAvailable === false`，而本轮零岗位查询时该值是 undefined → 诚实删除编造岗位事实的 rewrite 被判 structure_collapsed 回退成编造原文投递（2026-07-29 事故形态）。被删注释本身记录了该缺口。
- 修复：零岗位查询轮视同 `jobEvidenceAvailable=false`（在 resolveJobEvidenceAvailability 收敛），或该形态下抑制回退。

---

## P1 —— 字段召回回归（建议随同修复）

### 10. 性别解析：任意问号杀全轮 + 要求式误压制
- 锚点：`src/resolution/candidate/gender.ts:6`（未锚定 `[？?]`）、`:5`（「要/招/找+男|女」的「的」改可选）
- 「我是女的，请问多少钱？」→ null；「找女装导购的工作，我是女的」→ 被压制。修复：问句守卫按子句/句尾判定（参照 health-cert 的做法），要求式守卫恢复必须带「的」或收窄。

### 11. collected-fields 入口丢了逐条清洗
- 锚点：`src/resolution/candidate/collected-fields.ts:33`
- join 前不剥时间后缀（旧 candidate-field-parser 有 clean()）也不剥引用块：$ 锚定判据生产全死（健康证紧凑答「没办过，可以办」dead-on-arrival，`health-cert.ts:125`）；`[引用 店长：…138…]` 内容被当候选人字段解析进 precheck 预填（引用前缀经理名 badcase 族新开口）。修复：逐条 stripTimeContextSuffix + stripQuotedBlocks 后再 join（或逐条解析）。

### 12. is_student 丢「大三/在校」类自陈
- 锚点：`src/resolution/evidence/producers/rule-track.ts:715` + `src/resolution/candidate/student-identity.ts`（STUDENT_CLAUSE_RE 名词表）
- 「我大三，找周末兼职」「目前在校」不再确定性写入 is_student=true（develop 直接命中）。修复：把 大一|大二|大三|大四|在校 并进 STUDENT_CLAUSE_RE 或 extractStudentInfo 分支。

### 13. 年龄结构化锚定放宽 + 先于 scrub
- 锚点：`src/resolution/candidate/age.ts:4`
- 锚定从行首放宽到任意空白且优先于要求文本清洗 →「岗位要求 年龄22以上可做吗」记 age=22（vkikct39 族重开）。修复：恢复行首锚定 `(?:^|[\n\r])\s*年龄`，或 structured 分支也过 scrub。

### 14. 身份翻转暂挂核验闸成死代码
- 锚点：`src/resolution/candidate/student-identity.ts:406`（resolveIdentityFlipAfterRejection 零生产消费者）；`src/resolution/evidence/policies.ts:24` 注释仍宣称其在承担职责
- PR 删了唯一消费者 identity-claim.producer.ts 未在新 producer（`producers/student-identity.ts`）重接 → 学生被拒后改口「社会人士」直接生效（6a50827c 教唆洗身份族防线拆除）。修复：在 student-identity producer 里重接 flipPendingVerification 暂挂逻辑；或若产品裁定放弃该防线，删函数+改注释并留档。

### 15. semantic_track_diff 事件永不落库
- 锚点：`src/observability/persisting-observer.ts:9-27`（ALWAYS_PERSISTED_EVENT_TYPES 缺 'semantic_track_diff'）
- labor-form 冻结令（2026-08-11，`src/resolution/labor-form/index.ts:150-154`）要求先查 agent_execution_events 双轨分歧档案，但事件被 shouldPersist 丢弃只进日志。修复：白名单加 `'semantic_track_diff'`；spec 补「落库」断言而非只断 tracer.emit。

---

## P2 —— 已确认的小回归（可批量小修）

- `src/tools/shared/invite-city-gate.ts:97` — normalizeCityName 返 null（旧版返 ''），`requested.length` NPE，被外层 catch 误分类 INVITE_API_FAILED 且 replyInstruction 错路由。加 null 守卫走 city_unverified 拒绝。
- `src/resolution/candidate/height-weight.ts:12` — 终止符前瞻拒绝「170左右/60多」（develop 两轨都能抓）；requirement 窗口只看首次出现压制混合句自报。
- `src/resolution/evidence/admission.ts:319-333` — 区县准入 drop-on-null 对着刻意窄的 UNIQUE_SUBDIVISION_TO_CITY，把规则轨故意保留「留给 LLM 处理」的白名单外区名（鼓楼类）也丢了。改为白名单外保留原值不派生 city。
- `src/memory/services/session.service.ts:1718` — hasSystemGenderFallback 分支无 `!merged.interview_info.gender` 守卫（rule 分支有），系统标签覆盖同轮 LLM 抽到的自陈。补守卫。
- `src/memory/services/session.service.ts:860,1070` — 「不限地区」清空只看窗口最后一条消息，合并轮「区域不限」+「工资多少」永不清空。改为对全部本轮 user 消息判定。
- `src/tools/duliday/precheck/collection-strategy.util.ts:150` — 催填缺口只从上次模板空行推导，不扣减此后（含触发消息）已提供字段。对 ledger.collectedFields/session facts 做扣减。
- `src/resolution/evidence/producers/rule-track.ts:776` — 经验字段手机号污染检查从裸 `/1[3-9]\d{9}/` 收窄为带边界断言的 parseCandidatePhone，去空白粘连的数字串漏网。补裸模式或 digit-stream 检查。
- `src/resolution/geo/geo-name.normalizer.ts:22` —（⚠️ 该文件有并发会话未提交改动，修前先确认）循环剥「市/省」：津市市→津（长度1不可识别）、吉林省≡吉林市（击穿冲突等价判定）。至少对 `X市市` 形态只剥一层；省折叠需与 D3 裁决对齐后再动。
- `src/tools/save-image-description.tool.ts:148-150` + `review-packet.builder.ts:48` — 降级 sheet 不进 ledger → 语义评审证据里看不到（develop 从工具入参能重建）。降级 sheet 也记 ledger（打降级标）或 builder 保留入参回退。

## P3 —— 清理与规范（独立提交，不阻塞）

- **memory 第二套字段裁决引擎**（altitude 最重项）：`session.service.ts:1373-1452` 的 IDENTITY_FIRST_WRITE_FIELDS/PROVENANCE_DERIVATION_FIELDS/quoteSupportsCurrentValue（含 experience 特判）下沉为 `resolution/evidence/policies.ts` 策略表属性，memory 只调用。与 #2/#3 修复同做最顺。
- **FIELD_POLICIES 死表链**：`policies.ts:45-89` + `claim.types.ts:39-46,115`（EVIDENCE_FIELDS/EvidenceField/EvidenceOperation）零消费者——要么引擎真读它，要么删（勿两套并存）。
- **品牌目录 memo 击穿**：`producers/brand-intents.ts:35,83` 循环内 `[...brandData]`。修法：resolveBrands/buildBrandCatalogIndex 签名放宽 `ReadonlyArray<BrandItem>`，删 spread（⚠️ catalog-index.ts 有并发会话改动，只动 brand-intents 侧或协调后再动）。
- **ESLint 边界**：`.eslintrc.js:84-85` tools 规则只封已删除的 `@memory/facts/*`（永不触发）——改为封运行时值导入类路径（如 `@memory/types/*` 值导入）或删；`:50-54` resolution 的 type-only `@memory` 豁免已无使用者且与 CLAUDE.md 矛盾——删豁免或 CLAUDE.md 补记例外。
- **词表/助手收拢**：肯定应答词表 3 份（signal/dialogue:54、student-identity:217、city-confirmation:38）；疑问句判据 3 份（health-cert:40、gender:6、student-identity:170）；置信度 rank 新副本 2 份（city.ts:53、merge.ts:156，权威在 memory/types/confidence-rank.ts 带 SQL 契约——建议权威迁入 resolution 由 memory 转发）；`hasPhoneDigitStream` 导出零调用但逻辑被 4 处内联；escapeRegExp 第 4 份副本；省份后缀正则 2 份；`admission-gates.ts:39` 包装器内重复被包装者的正则；`merge.ts:127` mergeNullableStringArrays 已被泛型版取代仅测试引用。
- **死导出**：candidate/ 7 个 prod-dead helper（parseHealthCertificate、hasPhoneDigitStream 全死；normalize*ToId×4 + isFieldAuthoritative 仅测试）；student-identity 5 个仅测试导出 + brand-policy.ts:18 EMPTY_BRAND_STATE。
- **结构**：rule-track.ts 1167 行（阈值 ~500）四职责混装，建议拆 preference 抽取器族；`turn.types.ts:60-62` TurnLedger 重复声明 3 个继承字段、jobListQuery 单字段对象包装；`memory/types/session-facts.types.ts:11` 岗位类型转发 shim（9 个旧路径消费者中 8 个本 PR 已改动，顺手切到 `@resolution/job/types` 后删 shim）；`producers/location-share.ts` 纯转发模块（1 消费者）与 `adjudicate.ts:72` 重复再导出。
- **效率**：prep 每轮全窗口 geo 白名单扫描只服务低频 invite 门（改懒加载挂 ledger）；`merge.ts:268` getRuleFact 每轮 ~15 次全量重裁决（WeakMap memo 或投影挂 TurnLedger）。

## 验证清单

- [x] 新增生产形态 fixture 族（时间后缀+拼接+占位符+引用块），覆盖 gender/health-cert/age/height-weight/is_student/collected-fields/规则轨 scope（`tests/helpers/production-message.fixture.ts` + `tests/resolution/production-form-regression.spec.ts`，13 例全绿）
- [x] `pnpm run ci:check` 全绿（2026-08-12；全量 jest 6900+ 用例通过）
- [x] 触碰 memory/evidence 后跑 `pnpm run test:di-smoke`（通过）
- [x] 提交按主题分组 pathspec 提交，避开并发会话文件（brand/geo 并发文件零改动；geo-name.normalizer.ts 经确认不在并发会话脏文件集内后才动）

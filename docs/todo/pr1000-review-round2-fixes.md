# PR #1000 评审第二轮修复执行清单（交接 GPT 执行）

> **来源**：2026-08-13 对 PR #1000（`codex/candidate-profile-domain-refactor` → develop）的全量二轮评审
> （R1-R7 七域 + 两生产案回放 + 宪法红线四条核验）。本清单是唯一交接物，自包含，不依赖评审会话。
> **执行分支**：直接在 `codex/candidate-profile-domain-refactor` 上改，合入 develop 前完成。
> **裁定纪律**：下列设计决策**已裁定，勿重新论证**；发现清单与本文冲突时以本文「已裁定决策」为准。

## 0. 已裁定决策（执行前通读，禁止重开）

1. **attestedByClaim 语义收紧为「确认级」**：booking 姓名闸门的 claim 作证只认
   `operation='confirm'` 或 `interpretation='context_confirmation'` 的 accepted claim
   （即快照 `confirmedFields` 口径）。理由：闸门是负向证据结构（无负向证据本就 allow），
   `attestedByClaim` 的唯一实际效果是**短路打招呼语昵称/引用前缀两条负向检查**——
   statement 级 claim（模型引「我是小玥」）短路它=复活昵称当真名 badcase 族；
   confirm 级短路它=候选人本人终审压过机器负向结论，恰是宪法 P11 防死锁条款的本义。
2. **attestedByClaim 在 shadow 不传**（`enforcing && …`）：保住 P0「零行为变化」；
   shadow 期负向证据的解锁继续由 legacy 正则（`allowLegacyConfirmRegex` 默认 true）承担，
   与偏离⑥迁移故事一致。
3. **identity 闸门语料切 corpus 旁路，采用「三元回退」既有模式**（有 `corpusBlocks` 用标签
   视图，无则回退裸 messages），与 booking 水位处（booking tool 744-748 行）同构。不重构
   闸门函数签名语义，只换喂给它们的消息数组。
4. **shadow 下 accepted claim 值回灌 knownFieldMap：只补空位、不覆盖、不删除**，双模式统一跑
   （enforce 下随后 E1 账本重写仍是权威）。这是把 B1/B2 已发布的「裸字段 deprecated」契约在
   运行时接住；风险严格小于 develop 直接信任裸模型入参（回灌值多了公证三问）。记偏离⑦。
5. **D1（needs_confirmation 借值+「如有误请改」后缀）维持 enforce-only**，偏离④理由不变，勿动。
6. **notary.ts / engine.ts / profile.ts / policies.ts 零改动**。公证器与裁决链本轮评审判定合宪，
   不在修复范围。
7. **section 注册表的 fail-fast throw 保留**（漏登记即 compose 抛错是刻意设计），只补/验 CI 守卫。
8. **两处判定「不修」**：finalPrompt 组装的空白字节差（语义无差）；echo 基底 fallback 含
   tool role（对话窗口现实无 tool role，零行为增量）——只在底账记录，不改代码。
9. **宪法红线**：本清单没有任何一项需要新增对开放自然语言的正则；执行中若发现「顺手加个正则
   就能修」的诱惑，一律停手记录，不得实施（P11 冻结令）。

## 1. 工程一（P0-A）：booking 姓名闸门 attested 判据收紧

**状态：☑ 已完成**

**缺陷机制**（修复对象）：`src/tools/duliday-interview-booking.tool.ts` ~517-531 行的
`nameAttestedByClaim` 只查 `precheckSnapshot?.effectiveProfile.fields.name?.status === 'accepted'`
+ 值等价，且不分模式传入 `evaluateBookingNameGate`。两个漏洞：
(a) statement 级 claim（quote=「我是小玥」，公证三问全过：引文逐字真、2-6 字过形状门
`src/resolution/evidence/normalize.ts` 282-290、非回声）也算作证，在
`src/resolution/evidence/identity-gates.ts:95` 第一步短路，`isFromAutoGreeting` 负向检查
（同文件 116 行）永不执行——develop 同输入必 reject_collect；
(b) `profile.ts` 132-143 行把 **session 基线值也标 status='accepted'**（source='session'、
无 acceptedClaimId），历史会话里的名字同值即可解锁，「公证器认过引文」前提不成立。
快照在 shadow 无条件落盘（precheck ~1800 行）、precheckId 无条件回传模型，故该放行路
**shadow 期即生效**，且被本 PR 自己的 `duliday-interview-booking.authority.spec.ts` ~182 行
用例锁定成了预期行为。

**改法**：

- booking tool ~517-531 行改为（以文件实际变量名为准）：

```ts
const enforcing = adjudicationDeps?.mode === 'enforce';
// E2 quote 作证收紧为确认级：confirmedFields 只含 operation=confirm /
// context_confirmation 的 accepted claim（precheck 快照构造处即该口径），
// acceptedClaimId 判据排除 session 基线（基线无 claimId）。候选人本人确认过的
// 名字可压过打招呼语负向结论（P11 终审条款）；statement 级 claim 不解锁负向证据。
const nameConfirmAttested =
  Boolean(precheckSnapshot?.confirmedFields.includes('name')) &&
  precheckSnapshot?.effectiveProfile.fields.name?.status === 'accepted' &&
  precheckSnapshot.effectiveProfile.fields.name.acceptedClaimId != null &&
  candidateValuesEquivalent('name', precheckSnapshot.effectiveProfile.fields.name.value, name);
const nameGate = evaluateBookingNameGate(name, /* 工程二的 evidenceMessages */, {
  // shadow 零行为：作证放行 enforce 起生效；shadow 期解锁由 legacy 正则承担（偏离⑥）。
  attestedByClaim: enforcing && nameConfirmAttested,
  allowLegacyConfirmRegex: !enforcing,
});
```

- `src/resolution/evidence/identity-gates.ts` 的 `BookingNameGateOptions.attestedByClaim`
  docstring 同步改写：明确「仅确认级 claim（operation=confirm / context_confirmation）作证；
  statement 级不解锁负向证据；shadow 期调用方不传」。闸门函数体本身不改。

**测试**（`tests/tools/tool/duliday-interview-booking.authority.spec.ts`）：

- **本清单全项中唯一允许修改既有期望的用例**：~182 行「打招呼语昵称经 claim 快照放行」——
  翻转为 shadow 下 statement claim **不**解锁、闸门按 develop 口径 reject_collect。
- 新增用例（生产形态 fixture，见 §7 纪律）：
  1. enforce + 快照 confirmedFields 含 name + 值等价 → allow（确认级作证生效）；
  2. enforce + statement 级 accepted claim（confirmedFields 不含 name）→ reject_collect
     （打招呼语负向证据仍拦）；
  3. 快照 name 为 session 基线（status='accepted' 但无 acceptedClaimId）→ 不解锁；
  4. shadow + confirm 级 claim → 仍走 legacy 路径判定（attested 不传，行为与 develop 一致）。

## 2. 工程二（P0-B）：identity 闸门与补充回填语料切 corpus 旁路

**状态：☑ 已完成**

**缺陷机制**：BL2 已把公证语料、回声基底、booking 水位切到 `corpusBlocks` 标签旁路，但
姓名/手机号出处闸门与若干对话识别器仍消费裸 `context.turnInput.messages`。revise 重写指令以
`role:'user'` transport 注入消息数组（`src/agent/generator/preparation-utils/revise-directives.ts`
~104 行起，内嵌被丢弃草稿原文最长 1200 字；对应 corpus 块已正确标 teaching，
`preparation.service.ts` ~338-346 行）。replan 型重写回合工具可用：草稿含臆造手机号或
「姓名：X」「字段：值」形态时，教学文本会被当候选人原文通过出处闸门/表单回填——
命中宪法红线 4（教学文本进证据语料）。develop 同样存在（存量缺口非本 PR 回归），但 BL2
宣称的分域收口没收干净，必须本轮补齐。

**改法**：

1. `src/resolution/signal/corpus.ts` 增加一个导出（封闭标签过滤，无语义判断）：

```ts
/**
 * 身份闸门与对话识别器的证据域视图：只保留 evidence 域的 user/assistant 消息。
 * teaching（如 revise 指令的 user transport）与 tool_result 永不进入
 * 出处判定、问答确认识别与「字段：值」表单回填。
 */
export function selectEvidenceDialogueMessages(
  blocks: readonly CorpusBlock[],
): Array<{ role: CorpusRole; content: unknown }> {
  return selectCorpusMessages(blocks, { domains: ['evidence'], roles: ['user', 'assistant'] });
}
```

2. **booking tool**（`src/tools/duliday-interview-booking.tool.ts`）：handler 内闸门段之前建一次

```ts
const evidenceMessages = context.turnInput.corpusBlocks
  ? selectEvidenceDialogueMessages(context.turnInput.corpusBlocks)
  : (context.turnInput.messages ?? []);
```

   然后把以下消费点全部换成 `evidenceMessages`：`evaluateBookingNameGate`（~528）、
   `countRealNameAsks`（~535 附近）、`evaluateBookingPhoneGate`（~558）。
   水位处（~744-748）已是 corpus 优先，不动。

3. **precheck tool**（`src/tools/duliday-interview-precheck.tool.ts`）：同样建一次
   `evidenceMessages`，替换以下消费点（执行时 grep `turnInput.messages` 全量核对，凡语义为
   「候选人证据 / 对话问答识别 / 候选人表单回填」的都换；`runCandidateFactAdjudication`
   已带 `corpusBlocks` 参数的**不改**）：
   - `isGenderConfirmedInline(...)`（~1220）
   - `isNameOnlyQuotedSpeaker(knownName, ...)`（~1358）
   - `detectRealNameInsistence(...)`（~1367）
   - `extractSupplementAnswerFromMessages(..., labelName)`（~1379）——防 revise 草稿里的
     模板预填行「出生日期：…」被当候选人表单确定性回填
   - `findLatestExplicitIdentityEvidence(...)` 的调用点（若直接吃 turnInput.messages）

4. **`src/tools/duliday/booking/interview-booking-customer-label.builder.ts`**：
   `resolveCustomerLabelValue` 内两处读 `params.context.turnInput.messages`
   （`extractSupplementAnswerFromMessages` ~138、`findLatestExplicitIdentityEvidence` ~175）
   套同一三元回退模式。

   分层合法性：tools → resolution/signal 方向合法；corpus.ts 已依赖
   `@shared-types/corpus.types`，无新增违规出向。

**测试**：

- 新增 spec（建议 `tests/tools/tool/duliday-interview-booking.corpus-isolation.spec.ts`，
  precheck 侧可并入既有 authority.spec 新 describe）：
  1. corpusBlocks 含一个 `domain:'teaching', role:'system'` 块（内容模拟 revise 指令：含
     「姓名：张三」与 11 位手机号、时间后缀等生产形态），同名/同号不在任何 evidence 块中
     → name/phone 闸门判无出处（reject_collect）；
  2. 同值出现在 evidence/user 块中 → 放行（证明过滤没误伤）；
  3. 不传 corpusBlocks（旧调用方回退）→ 行为与现状一致；
  4. precheck 补充标签回填：teaching 块内「出生日期：2000-01-01」不回填，evidence 块内同行回填。

## 3. 工程三（P1-1）：shadow 下 accepted claim 回灌 knownFieldMap

**状态：☑ 已完成**

**缺陷机制**：precheck 工具描述已把九个裸字段标 deprecated、宣称「一切资料必经
candidateClaims」，但 shadow 下 accepted claim **不**回灌 `knownFieldMap`（E1 是
enforce-only，precheck ~1452）。模型守新契约只发 claim 不发裸字段时（尤其「一米六三→163」
类需归一化、规则解析器抓不到的值），shadow 下该字段留在 missingFields，候选人被多问一轮。
契约先行、运行时不接权。

**改法**：precheck 的 `if (adjudicationDeps) { … }` 块内，`runCandidateFactAdjudication`
成功后、`if (adjudicationDeps.mode === 'enforce')` 分支**之前**，加双模式统一的补位回灌：

```ts
// 偏离⑦：B1/B2 契约下模型可只发 claim 不发裸字段，shadow 也必须认账——
// 公证过的 accepted 值补进 knownFieldMap 空位（只补不覆盖不删除），否则已作证
// 字段仍判缺、候选人被重复追问。acceptedClaimId 判据排除 session 基线
// （基线值另有既有回灌路径，不在此重复）。enforce 下随后的 E1 账本重写仍是权威。
for (const [claimField, checklistField] of Object.entries(CLAIM_FIELD_TO_CHECKLIST) as Array<
  [CandidateClaimField, ChecklistField]
>) {
  const entry = adjudicationResult.profile.fields[claimField];
  if (entry?.status !== 'accepted' || entry.acceptedClaimId == null) continue;
  if (knownFieldMap[checklistField]) continue;
  const normalized = normalizeClaimValueForChecklist(claimField, entry.value);
  if (normalized) knownFieldMap[checklistField] = normalized;
}
```

已知次序说明（接受，不修）：性别确认位 `genderNeedsInlineConfirmation` 在 ~1224 行先于
裁决计算，claim 回灌的性别值不会回头清确认位——不会死锁（P0-4 识别器与后续轮解锁路径都在），
在代码注释里写明即可。

**测试**（authority.spec 新增，均默认 shadow）：
1. 只发 candidateClaims（含需归一化值「一米六三」→163 类）不发裸字段 → 该字段不在
   missingFields，templateText 带值；
2. 裸字段已有值 + claim 同字段不同值 → 保留原值（只补空位不覆盖）；
3. rejected / needs_confirmation claim → 不回灌（needs_confirmation 借值仍 enforce-only）；
4. session 基线 accepted（无 acceptedClaimId）→ 本回灌不处理（防重复路径）。

## 4. 工程四（P1-3）：gender 表内确认裁决点登记 + shadow 观测

**状态：☑ 已完成**

**背景**：`src/resolution/evidence/producers/gender-confirmation.ts` 的
`INLINE_CONFIRM_AFFIRMATION_RE` 是第四份肯定词表，经 precheck ~1220 直接决定确认位清除、
确认位挡 ready_to_book——是一个真实裁决点，但未登记 `VERDICT_SITE_REGISTRY`、无落库观测。
定性：有授权的过渡违例（评审修复清单 P0-4 授权、D5 退役批成员），本工程补齐登记与观测，
**不**改识别器本身。

**改法**：

1. `src/resolution/verdict-site.registry.ts` 新增站点（字段形状照抄现有条目）：
   id `precheck_gender_inline_confirmation`、authority `closed_form`、source 指向
   `src/resolution/evidence/producers/gender-confirmation.ts`、rationale 注明
   「PR #1000 P0-4 表内确认死锁修复；D5 退役批成员，模型 confirm claim 稳定后随批拆除」。
2. `tests/resolution/verdict-site.registry.spec.ts`：站点精确集合 16 → 17。
3. 观测：precheck 的 `emitFactAdjudicationEvent` 调用处把确认位状态带进事件——
   `observer.interface.ts` 的 `fact_adjudication` 事件类型加**可选**字段
   `genderInlineConfirmation?: 'pending' | 'confirmed_inline'`（由
   `genderNeedsInlineConfirmation` / `genderConfirmedInline` 派生；无关轮次不带该键）。
   落库走既有 `ALWAYS_PERSISTED_EVENT_TYPES` 的 `fact_adjudication` 白名单，**不动白名单**。
   spec 断言相应轮次事件带该字段。（观测必须落库不能只打日志——项目既定纪律。）

## 5. 工程五（P2 批）

**状态：☑ 已完成**

| # | 项 | 改法 | 验收 |
|---|---|---|---|
| P2-1 | section 语料域 CI 守卫核验 | 先查 `tests/agent/generator/context/context.service.spec.ts` 是否已断言「全部生产 section 可解析语料域 / compose 全场景不抛」。已有则**不改代码只在底账记 pass**；没有则补一条 spec（遍历注册 section 或逐 scenario compose 冒烟）。运行时 throw 语义保留 | 往注册表临时删一行，spec 必红；恢复后绿 |
| P2-2 | E1 模式注释过时 | `duliday-interview-precheck.tool.ts` ~656-659 注释改写：enforce 判缺读账本=唯一取值源；上一轮 session 值经 sessionAccepted 以 accepted 身份保留；**当前轮规则轨值不在账本会被剔**，由 A4 hints + C6 coverage delta + 「切换前必验 2」兜底 | 纯注释，tsc 过 |
| P2-3 | A6 工具面文件系统棘轮 | `tests/agent/guardrail/prompt/prompt-example-shape.spec.ts`：新增断言——glob `src/tools/**/*.tool.ts` 文件名集合，减去显式豁免表（初始为空，加豁免必须写理由注释），必须 ⊆ TOOL_DESCRIPTION_BUILDERS 枚举面；新工具文件未登记即 fail。原 `>=13` 断言可保留或改精确数 | 临时新建一个空 `*.tool.ts`，spec 必红 |
| P2-4 | TurnLedger 快照域封装缝 | `src/types/turn.types.ts`：对快照域接口中**无内部写点**的字段补 readonly（至少 `jobs.currentFocusJob`）。执行前逐字段 grep 赋值点：零写者才标；`turn-ledger.ts` 内部若需写，用内部宽类型，不放宽公共接口 | `pnpm run typecheck` 过 |

## 6. 文档底账（三处，与代码同批提交）

**状态：☑ 已完成**

1. **`docs/todo/candidate-fact-authority-refactor.md`**：
   - 落地偏离说明加**⑦**（shadow claim 回灌，工程三原文）；
   - 迁移三阶段表 P0 行「零行为变化」改为「零行为变化，声明例外：A3/A4 hints 直上、
     偏离④ needsConfirmationFields 回传、P0-8 手机号门收紧、偏离⑦ claim 回灌补位」；
   - E2/偏离⑥处补注：attestedByClaim 已收紧为确认级且 enforce-only（2026-08-13 二轮评审）；
   - D5 行「三份分叉肯定词表」改「四份（含 gender-confirmation.ts 的
     INLINE_CONFIRM_AFFIRMATION_RE）」。
2. **`docs/todo/pr1000-review-fixes.md`**：新增「2026-08-13 全量评审第二轮」小节：
   逐项列 P0-A / P0-B / P1-1 / P1-3 / P2-1~P2-4 的发现一句话 + 修复状态；并记两条
   **裁定不修**项及理由（finalPrompt 空白字节差=语义无差；echo fallback 含 tool role=
   对话窗口无 tool role 零增量）。
3. **`docs/todo/prompt-guardrail-and-naming-alignment.md`** BL2 行补一句：
   「2026-08-13 二轮评审补切：identity 闸门（name/phone 出处与问答识别）与补充标签
   『字段：值』回填两处候选人语料消费点同样切至 corpus 证据域视图——原实现只切了
   公证、回声、booking 水位三处」。

## 7. 工作约定（必读，违反=返工）

- **环境**：`nvm use 22.16.0`（shell 默认 node 可能是 16，先 `node -v` 确认）。
- **跑单测**：`pnpm run test <spec路径> --watchman=false`——**不带字面 `--`**（带了会把
  watchman 参数原样传给 Jest 失效）。不加 `--watchman=false` 会静默 0 测试。
- **收尾**：`pnpm run ci:check` 全绿；触碰 evidence/memory 后加跑 `pnpm run test:di-smoke`。
- **fixture 纪律**：一切新 spec 必须喂生产形态文本（`\n[消息发送时间：…]` 后缀、多消息 `\n`
  拼接、`[图片消息]` 占位、`[引用 …：…]` 块），不许只喂干净文本。
- **既有测试期望**：除 §1 明确指定的 authority.spec ~182 一例外，**不得修改任何既有断言值**；
  若某项修复导致其它既有用例红，先停下核对是否改坏了行为，不许顺手改期望。
- **提交**：pathspec 限定本清单文件，Conventional Commits，建议分组：
  1. `fix(evidence): booking 姓名闸门 attested 判据收紧为确认级并挂 enforce 档`（工程一）
  2. `fix(tools): identity 闸门与补充回填语料切 corpus 证据域视图`（工程二）
  3. `feat(tools): shadow 下 accepted claim 回灌收资清单空位（偏离⑦）`（工程三）
  4. `chore(resolution): 裁决点注册表补 gender 表内确认 + fact_adjudication 观测字段`（工程四）
  5. `test/chore: P2 批（注释校准/A6 棘轮/TurnLedger readonly/section 域守卫核验）`（工程五）
  6. `docs(todo): 二轮评审底账与偏离声明面补齐`（§6）
- 仓库常有多会话并发：提交前 `git status` 发现非本清单文件的改动，勿动勿 stash，先停下确认。

## 8. 总验收标准

1. `pnpm run ci:check` 全绿 + `test:di-smoke` 过。
2. shadow 行为回到「与 develop 一致 + 已声明例外」：statement claim 不再解锁姓名负向证据
   （§1 用例 4 锁定）。
3. corpus 隔离：teaching 域文本（revise 指令形态）无法为 name/phone/补充标签提供出处
   （§2 用例 1、4 锁定）。
4. claims-only 提交在 shadow 不再多问一轮（§3 用例 1 锁定）。
5. registry spec 17 站点全绿；fact_adjudication 事件在性别确认轮带 `genderInlineConfirmation`。
6. §6 三处文档落笔；本文件各工程状态框回写（☑/◐/☐）。

## 9. 执行结果回写（2026-08-13）

- ☑ 工程一 authority spec 10/10；statement、session 基线与 shadow 均不再借 claim 作证解锁。
- ☑ 工程二相关工具 spec 36/36，customer-label builder spec 22/22；teaching/evidence 正反 fixture 全绿。
- ☑ 工程三 authority spec 16/16；claims-only 补位、只补不覆盖、拒绝态与 session 基线边界全绿。
- ☑ 工程四 registry/authority/持久化相关 spec 29/29；注册表精确集合为 17。
- ☑ 工程五两份守卫 spec 13/13 + typecheck；临时漏登记 section 与 tool 文件均按预期使 spec 报红，恢复后转绿。
- ☑ Node v22.16.0 下 `pnpm run ci:check` 退出码 0：431 suites passed（1 skipped），7057 tests passed（6 skipped）。
- ☑ Node v22.16.0 下 `pnpm run test:di-smoke` 退出码 0：1 suite / 1 test passed。

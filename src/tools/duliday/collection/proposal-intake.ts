/**
 * 收资值的**写入运输规范**：把本轮所有作证通道汇成统一的槽位提案流。
 *
 * 通道优先级（§11 0819 追加裁定：**作证主通道＝主聊模型随工具调用提交 claims**）：
 *  1. `candidateClaims` —— 主通道。主模型是全系统最好的语义读者，其证词即语义判决、
 *     零额外调用。claim 自带 quote，直接作 sourceText。
 *  2. 九个 `candidateXxx` 裸字段 —— 存量运输通道。**不是死码**：2026-08-20 生产
 *     14 天实测 1305 次 precheck 调用里，claims 只占 15%，而 candidateAge 67%、
 *     candidateName 61%、healthCert 61%——拆除判据（claims 覆盖率 100% 且裸字段 0 次）
 *     远未满足。裸值没有 quote，由适配器在本轮候选人语料里**回查出处**再提案：
 *     模型臆造的值回查不到即落不了地，候选人真说过的照常入账。
 *  3. `candidateSupplementAnswers` —— 补充标签答案（实测 29% 在用），按标签标题定位
 *     labelId。0819 死循环案里"补充标签在 claim 运输里无座位"正是缺这条。
 *  4. 适配器轮末扫描 —— 安全网。主模型漏作证时兜底（§11：小模型/确定性扫描只做
 *     轮末空槽收网，不设常驻第二语义读者）。只补**空槽**，不碰已填。
 *
 * 四条通道的产物一律过 `proposeValue` 公证，本文件不做任何判定——它只负责
 * "把话搬到正确的槽位并附上出处"。
 */

import { adapterFor, type ContractFieldDef, type ValueProposal } from '@resolution/collection';
import type { CandidateClaimField } from '@resolution/evidence/claim.types';
import {
  extractDialogueTurns,
  isAffirmativeAnswer,
  normalizeShortAnswer,
} from '@resolution/signal/dialogue';

/** 主通道 claim 的最小形状（与 precheck 入参 candidateClaims 同构）。 */
export interface IntakeClaim {
  field: string;
  value?: string | number | boolean | null;
  quote?: string;
  operation?: 'set' | 'correct' | 'confirm' | 'clear';
  /**
   * 绑定的 Agent 问句原文（R1 通道，§10.1「确认可作证」）。
   * 候选人对复述清单/针对性提问的肯定应答靠它折算成本人终审——此时值本体在**问句**里，
   * 不要求候选人原话逐字含值。
   */
  agentQuestionQuote?: string;
}

export interface IntakeInput {
  contract: readonly ContractFieldDef[];
  /** 本轮候选人可作证语料（已剥引用块/时间后缀）。 */
  candidateTexts: readonly string[];
  /** 完整消息序列，身份槽位归属门取证用。 */
  messages: readonly unknown[];
  claims?: readonly IntakeClaim[];
  /** 九个裸字段（值已 normalize，键为 claim 字段名）。 */
  legacyArgs?: Partial<Record<CandidateClaimField, string>>;
  /** 补充标签答案：键为标签标题原文，值为候选人答案。 */
  supplementAnswers?: Record<string, string> | null;
  /** 已 filled 的槽位（安全网只扫空槽，不碰已填）。 */
  filledLabelIds: ReadonlySet<number>;
}

/** claim 字段名 → 契约字段：身份四槽走 systemField，其余按标题语义族。 */
const CLAIM_FIELD_TITLE_PATTERNS: Partial<Record<CandidateClaimField, RegExp>> = {
  education: /学历|文化程度/u,
  healthCertificate: /健康证/u,
  height: /身高/u,
  weight: /体重/u,
  householdProvince: /籍贯|户籍/u,
  // 「身份」也要认：契约没带身份标签时 precheck 会合成一个标题为「身份」的槽位
  //（判决单源的唯一记录在案例外，见 precheck 的 SYNTHETIC_IDENTITY_LABEL_ID）。
  isStudent: /社会身份|是否学生|学生|学信网|在籍|身份/u,
};

const CLAIM_FIELD_TO_IDENTITY: Partial<Record<CandidateClaimField, string>> = {
  name: 'name',
  phone: 'phone',
  age: 'age',
  gender: 'gender',
};

/** 把 claim 字段名映射到当岗契约的某个槽位；映射不到返回 null（该岗不收这项）。 */
export function findFieldForClaim(
  contract: readonly ContractFieldDef[],
  claimField: CandidateClaimField,
): ContractFieldDef | null {
  const identity = CLAIM_FIELD_TO_IDENTITY[claimField];
  if (identity) {
    return contract.find((field) => field.systemField === identity) ?? null;
  }
  const pattern = CLAIM_FIELD_TITLE_PATTERNS[claimField];
  return pattern ? (contract.find((field) => pattern.test(field.labelTitle)) ?? null) : null;
}

/**
 * 按标签标题定位契约字段（补充标签答案 / errorList 展示名共用同一口径）。
 *
 * 两级匹配，**歧义即放弃**：
 * 1. labelTitle 全等——0818 全量实测 468 岗 × 109 标签**零标题冲突**，
 *    labelTitle → labelId 是干净的 1:1，这是"名字即键、无需翻译表"的依据；
 * 2. 剥括号后的主干相等——模板行会剥括号（既为分段兼容，也因为括号里往往是筛选指令，
 *    原样发给候选人等于泄露），所以候选人/模型回填时给的是主干。
 *
 * ⚠️ 主干**不唯一**：实测 `体重 → {20, 50}`、`专业 → {544, 659}`。当前之所以安全，
 * 只是因为匹配限定在单岗契约内、且实测同岗位内主干撞车数为 0——那是**数据碰巧安全，
 * 不是结构安全**，运营配一个同时挂两个「体重」的岗位就会翻车。
 * 故主干命中多于一个时**返回 null 而不是取第一个**：定位不到会走追问/转人工（可恢复），
 * 定位错了会把答案静默写进别的槽位（不可恢复，且正是旧翻译表那类失配事故的形态）。
 */
export function findFieldByTitle(
  contract: readonly ContractFieldDef[],
  title: string,
): ContractFieldDef | null {
  const target = normalizeTitle(title);
  if (!target) return null;

  const exact = contract.find((field) => normalizeTitle(field.labelTitle) === target);
  if (exact) return exact;

  // 括号要**两边都剥**：契约标题可能自带括号补充（"是否学生（不要学生及暑假工）"），
  // 而候选人回填时带的括号往往是**我们模板加上去的**枚举提示（"身份（学生/社会人士）："）。
  // 只剥一边就会出现「模板发的标签认不回自己的字段」这种荒唐失配。
  const targetTrunk = stripParenthetical(title);
  const byTrunk = contract.filter(
    (field) =>
      stripParenthetical(field.labelTitle) === target ||
      normalizeTitle(field.labelTitle) === targetTrunk ||
      stripParenthetical(field.labelTitle) === targetTrunk,
  );
  // 撞车即放弃：定位错会把答案静默写进别的槽位（不可恢复），定位不到只是多问一句。
  return byTrunk.length === 1 ? byTrunk[0] : null;
}

export interface IntakeProposal extends ValueProposal {
  labelId: number;
  /** 供审计事件区分"这条值从哪条通道来的"。 */
  channel: 'claim' | 'form_line' | 'legacy_arg' | 'supplement_answer' | 'adapter_sweep';
}

/**
 * 汇总本轮全部提案。同一槽位可能被多条通道命中——按通道优先级去重，
 * **主通道胜出**（主模型的证词优先于回查与扫描）。
 */
export function collectProposals(input: IntakeInput): IntakeProposal[] {
  const byLabel = new Map<number, IntakeProposal>();
  const put = (proposal: IntakeProposal): void => {
    if (!byLabel.has(proposal.labelId)) byLabel.set(proposal.labelId, proposal);
  };

  for (const proposal of fromClaims(input)) put(proposal);
  for (const proposal of fromFormLines(input)) put(proposal);
  for (const proposal of fromLegacyArgs(input)) put(proposal);
  for (const proposal of fromSupplementAnswers(input)) put(proposal);
  for (const proposal of fromAdapterSweep(input)) put(proposal);

  return [...byLabel.values()];
}

/** 通道 1：主聊模型 claims。quote 直接作 sourceText；confirm 类带 agentQuestionQuote。 */
function fromClaims(input: IntakeInput): IntakeProposal[] {
  const proposals: IntakeProposal[] = [];
  for (const claim of input.claims ?? []) {
    if (claim.operation === 'clear') continue;
    const value = claim.value === null || claim.value === undefined ? '' : String(claim.value);
    if (!value.trim()) continue;
    const field = findFieldForClaim(input.contract, claim.field as CandidateClaimField);
    if (!field) continue;

    proposals.push({
      labelId: field.labelId,
      value,
      sourceText: (claim.quote ?? '').trim(),
      producer: 'model',
      candidateTexts: input.candidateTexts,
      messages: input.messages,
      agentQuestionQuote: claim.agentQuestionQuote,
      // 显式改口只认作证者声明的 operation='correct'（§11：代码不推断"像不像改口"）。
      ...(claim.operation === 'correct' ? { restatement: true } : {}),
      channel: 'claim',
    });
  }
  return proposals;
}

/**
 * 通道 1.5：**表单回捞**——候选人按我们发的模板逐行回填。
 *
 * 这条通道是必需品不是兼容层：收资模板就是 `标签：值` 行，候选人的回复自然也是
 * `标签：值` 行。不拆行就等于把整行喂给字段识别器，两种错法都实测过：
 * - `身份（学生/社会人士）：社会` → 识别器拿到整行（含选项模板）判不出，返回 null；
 * - `是否是学信网在籍学生：否` → 识别器在整行里看到"学生"二字，判成"学生"，
 *   而正确答案是"否"＝社会人士。**判反**。
 * 拆行后只把**值**交给适配器，两种都对。
 *
 * 标签→字段用 `findFieldByTitle`（全等优先、主干撞车即放弃），与 errorList 映射同一口径。
 */
function fromFormLines(input: IntakeInput): IntakeProposal[] {
  const proposals: IntakeProposal[] = [];
  for (const text of input.candidateTexts) {
    for (const rawLine of text.split(/\r?\n/u)) {
      const matched = /^\s*([^：:\n]{1,48})\s*[：:]\s*(.+?)\s*$/u.exec(rawLine);
      if (!matched) continue;
      const [, label, value] = matched;
      const field = findFieldByTitle(input.contract, label);
      if (!field) continue;

      // 只把值交给适配器；适配器认不出时，TEXT 型直接收原值，选项型交模型作证。
      const adapted = adapterFor(field)({ field, candidateText: value });
      if (!adapted && field.fieldType !== 'TEXT') continue;

      proposals.push({
        labelId: field.labelId,
        value: adapted?.value ?? value,
        optionCodes: adapted?.optionCodes,
        // sourceText 取**整行**：整行才是候选人原文里逐字存在的东西，公证回查按它对。
        sourceText: rawLine.trim(),
        producer: 'candidate_quote',
        candidateTexts: input.candidateTexts,
        messages: input.messages,
        channel: 'form_line',
      });
    }
  }
  return proposals;
}

/**
 * 通道 2：九个裸字段。**出处回查**——用适配器在本轮语料里重新解析，
 * 解析结果与裸值等价才提案（此时 sourceText 是适配器给的真实原话片段）。
 * 对不上就丢：那要么是模型臆造，要么是它把岗位要求当候选人自陈了。
 */
function fromLegacyArgs(input: IntakeInput): IntakeProposal[] {
  const proposals: IntakeProposal[] = [];
  const corpus = input.candidateTexts.join('\n');
  for (const [rawField, rawValue] of Object.entries(input.legacyArgs ?? {})) {
    const value = String(rawValue ?? '').trim();
    if (!value) continue;
    const field = findFieldForClaim(input.contract, rawField as CandidateClaimField);
    if (!field) continue;

    const recovered = adapterFor(field)({ field, candidateText: corpus });
    if (recovered && valuesLooselyEqual(recovered.value, value)) {
      proposals.push({
        labelId: field.labelId,
        value: recovered.value,
        optionCodes: recovered.optionCodes,
        sourceText: recovered.sourceText,
        producer: recovered.producer,
        candidateTexts: input.candidateTexts,
        messages: input.messages,
        channel: 'legacy_arg',
      });
      continue;
    }

    // 原文里回查不到，再试**确认作证**（R1）：值可能在我方复述里，候选人只回了"对"。
    // 这是 0819 死循环的另一半——模型只传裸字段、不发 claim 时的同一处病灶。
    const confirmed = recoverByConfirmation(value, input.messages);
    if (!confirmed) continue;
    proposals.push({
      labelId: field.labelId,
      value,
      sourceText: confirmed.answer,
      producer: 'model',
      candidateTexts: input.candidateTexts,
      messages: input.messages,
      agentQuestionQuote: confirmed.question,
      channel: 'legacy_arg',
    });
  }
  return proposals;
}

/**
 * 通道 3：补充标签答案。键是标签标题原文，值是候选人答案。
 * 答案本身就是候选人说的话，故 sourceText 取答案在语料里的原样片段——
 * 回查不到（模型改写过）就交给公证拒收，这里不替它圆场。
 */
function fromSupplementAnswers(input: IntakeInput): IntakeProposal[] {
  const proposals: IntakeProposal[] = [];
  for (const [title, answer] of Object.entries(input.supplementAnswers ?? {})) {
    const value = String(answer ?? '').trim();
    if (!value) continue;
    const field = findFieldByTitle(input.contract, title);
    if (!field) continue;

    const adapted = adapterFor(field)({ field, candidateText: value });
    proposals.push({
      labelId: field.labelId,
      value: adapted?.value ?? value,
      optionCodes: adapted?.optionCodes,
      sourceText: adapted?.sourceText ?? value,
      producer: 'model',
      candidateTexts: input.candidateTexts,
      messages: input.messages,
      channel: 'supplement_answer',
    });
  }
  return proposals;
}

/** 通道 4：安全网。只扫**空槽**，且只用确定性适配器（不引入第二语义读者）。 */
function fromAdapterSweep(input: IntakeInput): IntakeProposal[] {
  const corpus = input.candidateTexts.join('\n');
  if (!corpus.trim()) return [];

  const proposals: IntakeProposal[] = [];
  for (const field of input.contract) {
    if (input.filledLabelIds.has(field.labelId)) continue;
    const swept = adapterFor(field)({ field, candidateText: corpus });
    if (!swept) continue;
    proposals.push({
      labelId: field.labelId,
      value: swept.value,
      optionCodes: swept.optionCodes,
      sourceText: swept.sourceText,
      producer: swept.producer,
      candidateTexts: input.candidateTexts,
      messages: input.messages,
      channel: 'adapter_sweep',
    });
  }
  return proposals;
}

/** 我方消息带求证语境的标记（在问、在核对，而不只是在播报）。 */
const CONFIRMATION_MARKER_RE = /对吧|对吗|对么|对不对|是吗|是么|是吧|核对|确认|[吗么？?]/u;

/**
 * 确认作证恢复：我方**求证**消息里出现过该值 → 紧随其后的第一条候选人消息是肯定应答。
 *
 * 与 `identity-gates.isPhoneConfirmedInDialogue` 同一判据形态（三条同时满足，宁漏不错）：
 * 值出现在我方消息 + 该消息带求证标记 + **紧随其后**的第一条候选人消息是肯定应答。
 * 只认紧随其后的第一条，避免远处无关的"嗯/对"被错误归因到这次求证。
 *
 * ⚠️ 肯定词表**只用现有的那一份**（`@resolution/signal/dialogue` 唯一居所），
 * 永远不在这里扩词：想让某个说法进确定性档，改的是那份词表（那里有收词纪律），
 * 不是这里。§11 红线仍在：口语长尾一律流二档由主聊模型作证。
 */
function recoverByConfirmation(
  value: string,
  messages: readonly unknown[],
): { question: string; answer: string } | null {
  const target = value.trim();
  if (!target) return null;
  const turns = extractDialogueTurns(messages);
  for (let i = 0; i < turns.length; i += 1) {
    if (turns[i].role !== 'assistant') continue;
    const question = turns[i].text;
    if (!question.includes(target)) continue;
    // 求证语境是硬判据（与 isPhoneConfirmedInDialogue 同口径）：我方只是**播报**了
    // 这个值（岗位卡、话术里顺带提到），候选人一句"好的"不构成对它的确认。
    // 0820 词表收了「好的/没问题」之后这条尤其要紧——没有它，一次泛泛的"好的"
    // 就能把我方说过的任何值洗成候选人亲证。
    if (!CONFIRMATION_MARKER_RE.test(question)) continue;
    for (let j = i + 1; j < turns.length; j += 1) {
      if (turns[j].role !== 'user') continue;
      const answer = turns[j].text;
      if (isAffirmativeAnswer(normalizeShortAnswer(answer))) return { question, answer };
      break;
    }
  }
  return null;
}

function normalizeTitle(title: string): string {
  return title.normalize('NFKC').replace(/\s+/gu, '').trim();
}

function stripParenthetical(title: string): string {
  return normalizeTitle(title.replace(/[（(][^）)]*[）)]/gu, ''));
}

/** 裸值与回查值的宽松等价：折全半角/空白/单位后比较，或一方包含另一方。 */
function valuesLooselyEqual(left: string, right: string): boolean {
  const fold = (text: string): string =>
    text
      .normalize('NFKC')
      .replace(/\s+/gu, '')
      .replace(/(?:岁|cm|厘米|kg|公斤|千克|省|市)$/u, '')
      .toLowerCase();
  const a = fold(left);
  const b = fold(right);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

/** 一条可用于预填的档案值（调用方已按 producer 白名单过滤）。 */
export interface ArchiveFact {
  claimField: CandidateClaimField;
  value: string;
  evidence?: string;
}

/**
 * 从会话档案里挑**可预填**的事实。
 *
 * ⚠️ **入参是裸值不是信封**（2026-08-20 修）：`context.archive.sessionFacts` 是
 * `unwrapSessionFacts(facts, { minConfidence: 'high' })` 的产物——工具上下文在
 * `tool-context.builder` 里已经拆过信封并按高置信过滤。此前本函数按信封形态读
 * `.value/.source/.confidence`，在生产里**永远匹配不到任何字段**，
 * 记忆→表单预填因此是死代码（联调 precheck 接线时才发现）。
 *
 * 过滤纪律仍在，只是**执行点在上游**：`minConfidence: 'high'` 已经把模型自报与
 * unknown 档挡在门外——高置信会话事实正是过了准入门的那批。badcase 6e9ar9gd 族
 *（"臆造档案经沿用洗白后进真实工单"）的入口由那道门守。
 * 为兼容直接传信封的调用方（单测/未来改动），两种形态都收。
 */
export function selectArchiveFacts(
  interviewInfo: Record<string, unknown> | null | undefined,
): ArchiveFact[] {
  if (!interviewInfo) return [];
  const facts: ArchiveFact[] = [];
  for (const [sessionKey, claimField] of Object.entries(SESSION_KEY_TO_CLAIM_FIELD)) {
    const raw = interviewInfo[sessionKey];
    if (raw === null || raw === undefined) continue;

    let value: string;
    if (typeof raw === 'object') {
      // 信封形态（调用方直接传 SessionFacts）：仍按产者白名单与置信度过滤。
      const envelope = raw as {
        value?: unknown;
        producer?: unknown;
        source?: unknown;
        confidence?: unknown;
      };
      const producer = String(envelope.source ?? envelope.producer ?? '');
      if (!PREFILLABLE_PRODUCERS.has(producer)) continue;
      const confidence = String(envelope.confidence ?? '');
      if (confidence !== 'high' && confidence !== 'medium') continue;
      value = envelope.value === null || envelope.value === undefined ? '' : String(envelope.value);
    } else {
      // 裸值形态（**生产主路径**）：信任由上游 unwrapSessionFacts 的高置信门给出。
      value = String(raw);
    }

    if (!value.trim()) continue;
    facts.push({ claimField: claimField as CandidateClaimField, value: value.trim() });
  }
  return facts;
}

/**
 * 可预填的产者白名单——与 `PERSISTABLE_CANDIDATE_FIELD_PRODUCERS` 同源口径：
 * 候选人原话来的、外部系统查来的可以带；模型提出来的、档案搬来的不再二次搬运。
 */
const PREFILLABLE_PRODUCERS: ReadonlySet<string> = new Set(['candidate_quote', 'system']);

/** sessionFacts.interview_info 的键 → claim 字段名。 */
const SESSION_KEY_TO_CLAIM_FIELD: Readonly<Record<string, string>> = {
  name: 'name',
  phone: 'phone',
  gender: 'gender',
  age: 'age',
  education: 'education',
  has_health_certificate: 'healthCertificate',
  height: 'height',
  weight: 'weight',
  household_register_province: 'householdProvince',
  is_student: 'isStudent',
};

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
  isStudent: /社会身份|是否学生|学生/u,
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

/** 按标签标题定位契约字段（补充标签答案 / errorList 展示名共用同一口径）。 */
export function findFieldByTitle(
  contract: readonly ContractFieldDef[],
  title: string,
): ContractFieldDef | null {
  const target = normalizeTitle(title);
  if (!target) return null;
  return (
    contract.find((field) => normalizeTitle(field.labelTitle) === target) ??
    // 标题带括号补充时按主干再试一次（"是否学生（不要学生及暑假工）" ←→ "是否学生"）。
    contract.find((field) => stripParenthetical(field.labelTitle) === target) ??
    null
  );
}

export interface IntakeProposal extends ValueProposal {
  /** 见 ValueProposal.agentQuestionQuote（R1 确认作证通道）。 */
  labelId: number;
  /** 供审计事件区分"这条值从哪条通道来的"。 */
  channel: 'claim' | 'legacy_arg' | 'supplement_answer' | 'adapter_sweep';
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
    if (!recovered || !valuesLooselyEqual(recovered.value, value)) continue;

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

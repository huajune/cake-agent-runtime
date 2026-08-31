/**
 * 收资值的**写入运输规范**：把本轮所有作证通道汇成统一的槽位提案流。
 *
 * 通道优先级：
 *  1. `fieldValueProposals` —— 主聊模型唯一作证通道。字段名直接使用实时契约 labelTitle，
 *     同时携带规范值、候选人原话与操作语义，零额外调用。
 *  2. `form_line` —— 候选人按模板逐行回填的确定性回捞。
 *  3. 适配器轮末扫描 —— 安全网。主模型漏作证时兜底（§11：确定性扫描只做
 *     轮末空槽收网，不设常驻第二语义读者）。只补**空槽**，不碰已填。
 *
 * 三条通道的产物一律过 `applyFieldValueProposal` 公证，本文件不做语义判定——它只负责
 * "把话搬到正确的槽位并附上出处"。
 */

import {
  adapterFor,
  genericAdapter,
  identitySlotKeyForTitle,
  type ContractFieldDef,
  type SlotProposal,
  type FieldValueProposal,
} from '@resolution/collection';
import type { CandidateFactField } from '@resolution/candidate/types';
import { normalizedIncludes } from '@resolution/notary/text-normalization';
import type { FieldValueProposalInput } from './field-value-proposal-input';
import {
  filePlaceholder,
  forcedOptionPlaceholder,
  optionPlaceholder,
} from './collection-template.renderer';

export interface IntakeInput {
  contract: readonly ContractFieldDef[];
  /** 本轮候选人可作证语料（已剥引用块/时间后缀）。 */
  candidateTexts: readonly string[];
  /** 主模型唯一收资入口；标题只能定位实时契约已有槽位。 */
  fieldValueProposals?: readonly FieldValueProposalInput[] | null;
  /** 已 filled 的槽位（安全网只扫空槽，不碰已填）。 */
  filledLabelIds: ReadonlySet<number>;
  /** 定位/无值提案等无法进入写入口的拒收，同样接入既有收资审计面。 */
  onAudit?: (audit: IntakeAudit) => void;
}

export interface IntakeAudit {
  kind: 'proposal_rejected';
  labelId?: number;
  reason: string;
  detail?: string;
  channel: 'form_answer';
}

/** 候选事实字段名 → 契约字段：身份四槽走 systemField，其余按标题语义族。 */
const FACT_FIELD_TITLE_PATTERNS: Partial<Record<CandidateFactField, RegExp>> = {
  education: /学历|文化程度/u,
  healthCertificate: /健康证/u,
  height: /身高/u,
  weight: /体重/u,
  householdProvince: /籍贯|户籍/u,
  // 「身份」也要认：契约没带身份标签时 precheck 会合成一个标题为「身份」的槽位
  //（判决单源的唯一记录在案例外，见 precheck 的 SYNTHETIC_IDENTITY_LABEL_ID）。
  isStudent: /社会身份|是否学生|学生|学信网|在籍|身份/u,
};

const FACT_FIELD_TO_IDENTITY: Partial<Record<CandidateFactField, string>> = {
  name: 'name',
  phone: 'phone',
  age: 'age',
  gender: 'gender',
};

/** 把候选事实字段名映射到当岗契约的某个槽位；映射不到返回 null（该岗不收这项）。 */
export function findFieldForCandidateFact(
  contract: readonly ContractFieldDef[],
  factField: CandidateFactField,
): ContractFieldDef | null {
  const identity = FACT_FIELD_TO_IDENTITY[factField];
  if (identity) {
    return contract.find((field) => field.systemField === identity) ?? null;
  }
  const pattern = FACT_FIELD_TITLE_PATTERNS[factField];
  return pattern ? (contract.find((field) => pattern.test(field.labelTitle)) ?? null) : null;
}

/**
 * 按标签标题定位契约字段（统一 fieldValueProposals / 表单行回捞共用同一口径）。
 *
 * 三级匹配，**歧义即放弃**：
 * 1. labelTitle 全等（NFKC + 去空白）——0818 全量实测 468 岗 × 109 标签**零标题冲突**，
 *    labelTitle → labelId 是干净的 1:1，这是"名字即键、无需翻译表"的依据；
 * 2. 剥括号后的主干相等——只作为模型/候选人天然改写漂移的容错，所有对外渲染仍
 *    100% 使用契约 labelTitle 原文；
 * 3. 身份四槽同义词回退——标题命中身份词表（contract-mapping 的
 *    IDENTITY_TITLE_PATTERNS，`^…$` 全匹配）时按 systemField 定位对应身份槽位。
 *    依据 0826 生产回放（272 会话 / 440 条字段值提案）：模型 labelTitle
 *    逐字命中 49%、剥括号主干救回 6%，持久性定位失败的最大类是身份字段同义词——
 *    「联系方式」19 条、「联系电话」5 条（均指手机号），此前一律拒收退化为重问。
 *    **封闭四槽**：词表只覆盖 name/phone/age/gender，动态标签仍只走前两级。
 *    第三级先试归一化原文、原文不中再试剥括号主干（「联系电话（本人）」由主干救回）。
 *
 * ⚠️ 主干**不唯一**：实测 `体重 → {20, 50}`、`专业 → {544, 659}`。当前之所以安全，
 * 只是因为匹配限定在单岗契约内、且实测同岗位内主干撞车数为 0——那是**数据碰巧安全，
 * 不是结构安全**，运营配一个同时挂两个「体重」的岗位就会翻车。
 * 故主干命中多于一个时**返回 null 而不是取第一个**：定位不到会走追问/转人工（可恢复），
 * 定位错了会把答案静默写进别的槽位（不可恢复，且正是旧翻译表那类失配事故的形态）。
 * 第 2 级主干撞车即终局弃权（**不落入第 3 级**）；第 3 级同 systemField 多槽
 * （契约异常态）同款弃权不猜。
 */
export function findFieldByTitle(
  contract: readonly ContractFieldDef[],
  title: string,
): ContractFieldDef | null {
  return resolveFieldByTitle(contract, title).field;
}

export type FieldTitleResolutionReason = 'label_title_not_found' | 'label_title_ambiguous';

/** 与 findFieldByTitle 同一匹配逻辑，但保留失败原因供审计。 */
export function resolveFieldByTitle(
  contract: readonly ContractFieldDef[],
  title: string,
): { field: ContractFieldDef | null; reason?: FieldTitleResolutionReason } {
  const target = normalizeTitle(title);
  if (!target) return { field: null, reason: 'label_title_not_found' };

  const exact = contract.find((field) => normalizeTitle(field.labelTitle) === target);
  if (exact) return { field: exact };

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
  if (byTrunk.length === 1) return { field: byTrunk[0] };
  if (byTrunk.length > 1) return { field: null, reason: 'label_title_ambiguous' };

  // 第三级：身份四槽同义词回退（词表唯一居所在 contract-mapping，此处只查询不复制）。
  // 先试归一化原文，再试剥括号主干；正则 `^…$` 全匹配，「电话费报销」这类包含式不触发。
  const identityKey = identitySlotKeyForTitle(target) ?? identitySlotKeyForTitle(targetTrunk);
  if (identityKey) {
    const byIdentity = contract.filter((field) => field.systemField === identityKey);
    if (byIdentity.length === 1) return { field: byIdentity[0] };
    // 同 systemField 多槽是契约异常态，与主干撞车同款处置：弃权不猜。
    if (byIdentity.length > 1) return { field: null, reason: 'label_title_ambiguous' };
  }
  return { field: null, reason: 'label_title_not_found' };
}

export interface RoutedFieldValueProposal extends FieldValueProposal {
  labelId: number;
  /** 供审计事件区分"这条值从哪条通道来的"。 */
  channel: 'form_answer' | 'form_line' | 'adapter_sweep';
}

/**
 * 汇总本轮全部提案。同一槽位可能被多条通道命中——按通道优先级去重，
 * **主通道胜出**（主模型的证词优先于回查与扫描）。
 */
export function collectFieldValueProposals(input: IntakeInput): RoutedFieldValueProposal[] {
  const byLabel = new Map<number, RoutedFieldValueProposal>();
  const put = (proposal: RoutedFieldValueProposal): void => {
    if (!byLabel.has(proposal.labelId)) byLabel.set(proposal.labelId, proposal);
  };

  for (const proposal of fromModelFieldValueProposals(input)) put(proposal);
  for (const proposal of fromFormLines(input)) put(proposal);
  for (const proposal of fromAdapterSweep(input)) put(proposal);

  return [...byLabel.values()];
}

/**
 * 通道 2：**表单回捞**——候选人按我们发的模板逐行回填。
 *
 * 这条通道是必需品不是兼容层：收资模板就是 `标签：值` 行，候选人的回复自然也是
 * `标签：值` 行。不拆行就等于把整行喂给字段识别器，两种错法都实测过：
 * - `身份（学生/社会人士）：社会` → 识别器拿到整行（含选项模板）判不出，返回 null；
 * - `是否是学信网在籍学生：否` → 识别器在整行里看到"学生"二字，判成"学生"，
 *   而正确答案是"否"＝社会人士。**判反**。
 * 拆行后只把**值**交给适配器，两种都对。
 *
 * 标签→字段用 `findFieldByTitle`（全等优先、主干撞车即放弃），与 applyErrorList 映射同一口径。
 */
function fromFormLines(input: IntakeInput): RoutedFieldValueProposal[] {
  const proposals: RoutedFieldValueProposal[] = [];
  for (const text of input.candidateTexts) {
    for (const line of parseTemplateLines(text, input.contract)) {
      // 只把值交给适配器。选项型认不出也生成提案，统一由值词表门拒收并落审计，
      // 不再在运输层静默丢弃。
      const adapted = adaptAnswerValue(line.field, line.value);

      proposals.push({
        labelId: line.field.labelId,
        value: adapted?.value ?? line.value,
        optionCodes: adapted?.optionCodes,
        // sourceText 取**整行**：整行才是候选人原文里逐字存在的东西，公证回查按它对。
        sourceText: line.rawLine,
        producer: 'candidate_quote',
        channel: 'form_line',
      });
    }
  }
  return proposals;
}

/** 一条成功定位到契约槽位的模板回填行。 */
export interface TemplateLine {
  field: ContractFieldDef;
  /** 冒号右侧的候选人原始作答（未经适配器规范化）。 */
  value: string;
  /** 整行原文（公证出处门按它逐字回查）。 */
  rawLine: string;
}

/**
 * 解析一条候选人消息里的模板回填行。它只是普通 `form_line` 提案通道；
 * 逐行填表与自然语言作答走同一写入规则，不再存在独立直通判据。
 */
export function parseTemplateLines(
  text: string,
  contract: readonly ContractFieldDef[],
): TemplateLine[] {
  const lines: TemplateLine[] = [];
  for (const rawLine of text.split(/\r?\n/u)) {
    const matched = /^\s*([^：:\n]+?)\s*[：:]\s*(.+?)\s*$/u.exec(rawLine);
    if (!matched) continue;
    const [, label, value] = matched;
    const field = findFieldByTitle(contract, label);
    if (!field) continue;
    if (isPlaceholderEcho(field, value)) continue;
    lines.push({ field, value, rawLine: rawLine.trim() });
  }
  return lines;
}

/**
 * 通道 1：主聊模型唯一字段值提案入口。labelTitle 只定位实时契约已有槽位；
 * value 是规范值，quote 是候选人原话，两者不再混为一个字符串。
 */
function fromModelFieldValueProposals(input: IntakeInput): RoutedFieldValueProposal[] {
  const proposals: RoutedFieldValueProposal[] = [];
  for (const answer of input.fieldValueProposals ?? []) {
    const resolution = resolveFieldByTitle(input.contract, answer.labelTitle);
    const field = resolution.field;
    if (!field) {
      input.onAudit?.({
        kind: 'proposal_rejected',
        reason: resolution.reason ?? 'label_title_not_found',
        detail: `labelTitle「${answer.labelTitle}」未能唯一定位当前岗位契约槽位`,
        channel: 'form_answer',
      });
      continue;
    }

    const operation = answer.operation ?? 'set';
    if (operation === 'clear') {
      const quote = answer.quote?.trim() ?? '';
      if (!quote || !input.candidateTexts.some((text) => normalizedIncludes(text, quote))) {
        input.onAudit?.({
          kind: 'proposal_rejected',
          labelId: field.labelId,
          reason: 'source_text_not_found',
          detail: 'clear 的 quote 未出现在候选人原文',
          channel: 'form_answer',
        });
      }
      continue;
    }

    const value = answer.value === null ? '' : String(answer.value).trim();
    if (!value) continue;

    const adapted = adaptAnswerValue(field, value);
    proposals.push({
      labelId: field.labelId,
      value: adapted?.value ?? value,
      optionCodes: adapted?.optionCodes,
      // 文件字段以真实附件 URL 自证；其它字段必须以候选人 quote 作出处。
      sourceText: field.fieldType === 'FILE' ? value : (answer.quote?.trim() ?? ''),
      producer: 'model',
      agentQuestionQuote: answer.agentQuestionQuote,
      ...(operation === 'correct' ? { restatement: true } : {}),
      channel: 'form_answer',
    });
  }
  return proposals;
}

/** 语义适配器优先；规范值恰为 optionLabel 时再走契约字面直配。 */
function adaptAnswerValue(field: ContractFieldDef, value: string): SlotProposal | null {
  // answerBound：值已由表单行标签 / fieldValueProposals 定位绑定到本槽位，
  // 适配器可解释裸短答（「无」「没有」）——绑定关系就是语境。
  const input = { field, candidateText: value, answerBound: true };
  return (
    adapterFor(field)(input) ?? genericAdapter(input) ?? adaptMultipleOptionLabels(field, value)
  );
}

/** 候选人原样回抄了模板的占位提示（枚举占位或 FILE 发文件提示），不是答案。 */
function isPlaceholderEcho(field: ContractFieldDef, value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  return [optionPlaceholder(field), forcedOptionPlaceholder(field), filePlaceholder(field)]
    .filter(Boolean)
    .includes(trimmed);
}

/** MULTIPLE_OPTION 的规范值可列多个 optionLabel；只做契约标签逐字拆分，不猜同义词。 */
function adaptMultipleOptionLabels(field: ContractFieldDef, value: string): SlotProposal | null {
  if (field.fieldType !== 'MULTIPLE_OPTION') return null;
  let remainder = value.normalize('NFKC');
  const candidates = [...field.acceptedOptions, ...field.rejectedOptions]
    .map((option) => ({ option, label: option.optionLabel.normalize('NFKC').trim() }))
    .filter(({ label }) => label)
    .sort((left, right) => right.label.length - left.label.length);
  const selected: typeof candidates = [];
  for (const candidate of candidates) {
    if (!remainder.includes(candidate.label)) continue;
    selected.push(candidate);
    remainder = remainder.replaceAll(candidate.label, '');
  }
  if (selected.length === 0) return null;
  if (remainder.replace(/[\s、/|,，;；]+/gu, '')) return null;
  return {
    labelId: field.labelId,
    value: selected.map(({ option }) => option.optionLabel).join('、'),
    optionCodes: selected.map(({ option }) => option.optionCode),
    sourceText: value,
    producer: 'candidate_quote',
  };
}

/** 通道 3：安全网。只扫**空槽**，且只用确定性适配器（不引入第二语义读者）。 */
function fromAdapterSweep(input: IntakeInput): RoutedFieldValueProposal[] {
  const corpus = input.candidateTexts.join('\n');
  if (!corpus.trim()) return [];

  const proposals: RoutedFieldValueProposal[] = [];
  for (const field of input.contract) {
    if (input.filledLabelIds.has(field.labelId)) continue;
    if (hasExactPlaceholderEcho(input.candidateTexts, input.contract, field.labelId)) continue;
    const swept = adapterFor(field)({ field, candidateText: corpus });
    if (!swept) continue;
    proposals.push({
      labelId: field.labelId,
      value: swept.value,
      optionCodes: swept.optionCodes,
      sourceText: swept.sourceText,
      producer: swept.producer,
      channel: 'adapter_sweep',
    });
  }
  return proposals;
}

function hasExactPlaceholderEcho(
  candidateTexts: readonly string[],
  contract: readonly ContractFieldDef[],
  labelId: number,
): boolean {
  for (const text of candidateTexts) {
    for (const rawLine of text.split(/\r?\n/u)) {
      const matched = /^\s*([^：:\n]+?)\s*[：:]\s*(.+?)\s*$/u.exec(rawLine);
      if (!matched) continue;
      const field = findFieldByTitle(contract, matched[1]);
      if (field?.labelId === labelId && isPlaceholderEcho(field, matched[2])) return true;
    }
  }
  return false;
}

function normalizeTitle(title: string): string {
  return title.normalize('NFKC').replace(/\s+/gu, '').trim();
}

function stripParenthetical(title: string): string {
  return normalizeTitle(title.replace(/[（(][^）)]*[）)]/gu, ''));
}

/** 一条可用于预填的档案值（调用方已按 producer 白名单过滤）。 */
export interface ArchiveFact {
  factField: CandidateFactField;
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
  for (const [sessionKey, factField] of Object.entries(SESSION_KEY_TO_FACT_FIELD)) {
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
    facts.push({ factField: factField as CandidateFactField, value: value.trim() });
  }
  return facts;
}

/**
 * 可预填的产者白名单——与 `PERSISTABLE_CANDIDATE_FIELD_PRODUCERS` 同源口径：
 * 候选人原话来的、外部系统查来的可以带；模型提出来的、档案搬来的不再二次搬运。
 */
const PREFILLABLE_PRODUCERS: ReadonlySet<string> = new Set(['candidate_quote', 'system']);

/** sessionFacts.interview_info 的键 → 候选事实字段名。 */
const SESSION_KEY_TO_FACT_FIELD: Readonly<Record<string, string>> = {
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

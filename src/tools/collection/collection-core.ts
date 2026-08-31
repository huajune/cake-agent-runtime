/**
 * 收资核：一轮消息进来 → 表单出去。precheck 的收资部分整体由本模块承担。
 *
 * 它替换掉的旧路径（蓝图 §5/§7）：`buildKnownFieldMap + buildChecklistTemplate +
 * missingFields 字面过滤`。旧路径每轮从聊天原文全量重推收资状态，是"反复问 / 确认
 * 考古 / 报名死锁"整族病灶的地基；新路径持有状态，只在**值到达的那一轮**判一次。
 *
 * 本模块不碰非收资域的判决（面试日期对齐、岗位级健康证闸门、暑假工守卫）——
 * 那些留在 precheck 主体，`deriveCollectionAction` 只回答收资这一维。
 */

import type { BookingCollectionForm, ContractFieldDef, Verdict } from '@resolution/collection';
import {
  adapterFor,
  ANSWERED_BUT_UNPARSEABLE_REASONS,
  detectSuspectedMultiPerson,
  escalate,
  ESCALATION_REASONS,
  isSensitiveAttribute,
  MAX_ASKS_PER_SLOT,
  orderForAsking,
  recordRejectedAttempts,
  recordUnansweredAsks,
  seedArchiveValue,
  applyFieldValueProposal,
  recordConfigDebt,
  routeOf,
  verdictOf,
  yieldRecoverableEscalationToScreening,
  genericAdapter,
} from '@resolution/collection';
import { extractMessageText } from '@resolution/signal/markers';
import {
  collectFieldValueProposals,
  findFieldForCandidateFact,
  type ArchiveFact,
} from './proposal-intake';
import type { FieldValueProposalInput } from './field-value-proposal-input';
import { renderCollectionTemplate, type CollectionTemplate } from './collection-template.renderer';

/** 收资维度的 nextAction 取值——与既有 Agent 契约同名，语义不变。 */
export type CollectionAction =
  | 'collect_fields'
  | 'ready_to_book'
  | 'screening_rejected'
  | 'handoff'
  | 'already_submitted';

/** verdict → Agent 动作。**唯一派生点**（蓝图 §5：nextAction 由 verdictOf 唯一派生）。 */
export function deriveCollectionAction(verdict: Verdict): CollectionAction {
  switch (verdict) {
    case 'collecting':
      return 'collect_fields';
    case 'ready':
      return 'ready_to_book';
    case 'disqualified':
      return 'screening_rejected';
    case 'escalated':
      return 'handoff';
    case 'submitted':
      return 'already_submitted';
  }
}

/** 一条待落库的审计事件（调用方转成 agent_execution_events，蓝图 §4）。 */
export interface CollectionAuditEvent {
  kind:
    | 'proposal_rejected'
    | 'slot_disqualified'
    | 'slot_restated'
    | 'config_debt'
    | 'escalated'
    | 'escalation_yielded';
  labelId?: number;
  reason?: string;
  detail?: string;
  channel?: string;
}

export interface CollectionCoreInput {
  form: BookingCollectionForm;
  contract: readonly ContractFieldDef[];
  candidateTexts: readonly string[];
  messages: readonly unknown[];
  fieldValueProposals?: readonly FieldValueProposalInput[] | null;
  /** 本轮是否允许继续向候选人发问；只控制待问清单，不参与上一轮实际问句的记账。 */
  askThisTurn?: boolean;
  /** 当前候选人回复的稳定回合 ID；问句入账与拒收入账都按它做同回合去重。 */
  askReceiptTurnId?: string;
  /**
   * 档案预填（蓝图「记忆→表单预填」：跨岗不重复盘问）。
   * 只填空槽、只在**本表首次见到该槽**时有意义；作用域同账号（表单 key 含 corpId）。
   */
  archiveFacts?: readonly ArchiveFact[];
}

export interface CollectionCoreResult {
  form: BookingCollectionForm;
  verdict: Verdict;
  action: CollectionAction;
  template: CollectionTemplate;
  /** 本轮实际可问的字段（熔断后为空）。 */
  askableFields: string[];
  audits: CollectionAuditEvent[];
  /** 本轮刚落值的字段——拒绝话术的因果隔离判据。 */
  answeredThisTurn: ContractFieldDef[];
}

/**
 * 跑一轮收资。
 *
 * 顺序刻意如此：先**写入**（本轮候选人说的话进槽位），再**发问**（还缺什么）。
 * 反过来会把候选人刚答的字段又问一遍——正是"答后复问率 31.5%"的机械成因。
 */
export function runCollectionCore(input: CollectionCoreInput): CollectionCoreResult {
  const { contract } = input;
  const audits: CollectionAuditEvent[] = [];
  const answeredThisTurn: ContractFieldDef[] = [];
  let form = input.form;

  const filledLabelIds = new Set(
    Object.values(form.slots)
      .filter((slot) => slot.state === 'filled')
      .map((slot) => slot.labelId),
  );

  // ── 写入：统一 fieldValueProposals + 两条既有安全网的提案逐条过公证 ──
  let proposals = collectFieldValueProposals({
    contract,
    candidateTexts: input.candidateTexts,
    fieldValueProposals: input.fieldValueProposals,
    filledLabelIds,
    onAudit: (audit) => audits.push(audit),
  });

  // ── 多人闸：新姓名+新手机号成对出现＝疑似中介代报第二人（D1 v1 只转人工不自动化）──
  // 必须拦在写入之前：带显式改口标记的提案能合法穿过棘轮，一旦写入就是跨人污染，
  // 办结后会连 sessionFacts 与长期画像一起写错人。检测命中即本轮零写入、直接转人工。
  if (detectSuspectedMultiPerson(form, contract, proposals)) {
    form = escalate(form, ESCALATION_REASONS.suspectedMultiPerson);
    audits.push({ kind: 'escalated', reason: ESCALATION_REASONS.suspectedMultiPerson });
    proposals = [];
  }

  const fieldById = new Map(contract.map((field) => [field.labelId, field]));
  // 本轮「真实作答但公证读不懂」的槽位（出处门已过、卡在值词表/形态）。
  // 这些轮次不算"没搭理"：不消耗发问配额、不触发同槽问满熔断，改记 rejectedAttempts。
  const unparseableAttemptIds = new Set<number>();
  for (const proposal of proposals) {
    const field = fieldById.get(proposal.labelId);
    if (!field) continue;
    const result = applyFieldValueProposal(form, field, proposal, {
      candidateTexts: input.candidateTexts,
      messages: input.messages,
    });
    form = result.form;

    switch (result.outcome) {
      case 'accepted':
      case 'restated':
        answeredThisTurn.push(field);
        if (result.outcome === 'restated') {
          audits.push({
            kind: 'slot_restated',
            labelId: field.labelId,
            detail: result.detail,
            channel: proposal.channel,
          });
        }
        break;
      case 'disqualified':
        answeredThisTurn.push(field);
        audits.push({
          kind: 'slot_disqualified',
          labelId: field.labelId,
          detail: result.detail,
          channel: proposal.channel,
        });
        break;
      case 'rejected':
        // 公证拒收必须落库：它是臆造防线的观测面，只打日志等于没发生（§11）。
        audits.push({
          kind: 'proposal_rejected',
          labelId: field.labelId,
          reason: result.reason,
          detail: result.detail,
          channel: proposal.channel,
        });
        if (result.reason && ANSWERED_BUT_UNPARSEABLE_REASONS.has(result.reason)) {
          unparseableAttemptIds.add(field.labelId);
        }
        break;
      case 'ignored':
        break;
    }
  }

  // ── 预填：本轮写完之后才轮到档案兜底 ──
  // 顺序**必须在写入之后**：`seedArchiveValue` 会把槽位填成 filled，而棘轮规定
  // filled 槽位不接受普通提案。先预填就等于让上周的档案值占住槽位、把候选人本轮
  // 亲口说的那句话当"已填"忽略掉——把最好的证据挡在门外。
  // 先写后填之下：本轮说了的走公证正常入账，没说的才用档案补，跨岗不重复盘问。
  for (const archived of input.archiveFacts ?? []) {
    const field = findFieldForCandidateFact(contract, archived.factField);
    if (!field) continue;
    const adapterInput = { field, candidateText: archived.value, answerBound: true };
    const adapted = adapterFor(field)(adapterInput) ?? genericAdapter(adapterInput);
    form = seedArchiveValue(form, field, {
      value: adapted?.value ?? archived.value,
      optionCodes: adapted?.optionCodes,
      evidence: archived.evidence,
    });
  }

  // ── 配置债：走通用道的槽位记一行账，报名卡片直读 ──
  for (const field of contract) {
    if (routeOf(field) !== 'generic' || field.fieldType === 'SINGLE_OPTION') continue;
    const before = form.configDebts?.length ?? 0;
    form = recordConfigDebt(
      form,
      field.labelId,
      `「${field.labelTitle}」无专用判据，走 ${field.fieldType} 通用道收集`,
    );
    if ((form.configDebts?.length ?? 0) > before) {
      audits.push({ kind: 'config_debt', labelId: field.labelId });
    }
  }

  // ── 作答账：真实作答被值词表/形态门拒收的槽位记 rejectedAttempts（读不懂两次转人工）──
  // 按候选人回合去重：模型同轮重试 precheck 重投同一句话时只记一次，
  // 「两次」必须是两轮真实作答，不是两次工具调用。
  const attemptReceipt = recordRejectedAttempts(
    form,
    [...unparseableAttemptIds],
    input.askReceiptTurnId,
  );
  form = attemptReceipt.form;
  if (attemptReceipt.exhausted.length > 0) {
    audits.push({
      kind: 'escalated',
      reason: form.escalatedReason,
      detail: `同槽连续真实作答仍无法适配：${attemptReceipt.exhausted.join(',')}`,
    });
  }

  // ── 问句回执：只登记上一轮真实送达、且本轮仍未补齐的槽位 ──
  // 本轮有真实作答（哪怕被拒收）的槽位不入账：作答轮不是"没搭理"，不烧发问配额。
  const actuallyAskedIds = askedLabelIdsBeforeLatestUser(input.messages, contract).filter(
    (labelId) => !unparseableAttemptIds.has(labelId),
  );
  const askReceipt = recordUnansweredAsks(form, actuallyAskedIds, input.askReceiptTurnId);
  form = askReceipt.form;
  if (askReceipt.exhausted.length > 0) {
    audits.push({
      kind: 'escalated',
      reason: form.escalatedReason,
      detail: `同槽实际问满上限仍空：${askReceipt.exhausted.join(',')}`,
    });
  }

  // 已经问满后因纠错/errorList 重开的槽位保留历史次数，禁止绕过配额发出第 3 问。
  // 本轮真实作答过的槽位豁免：配额烧完但人在认真答，重问一次（枚举提示）比熔断便宜。
  const emptyFields = orderForAsking(contract).filter(
    (field) => form.slots[field.labelId]?.state === 'empty',
  );
  if (verdictOf(form) === 'collecting') {
    const alreadyExhausted = emptyFields
      .filter((field) => !unparseableAttemptIds.has(field.labelId))
      .filter((field) => (form.slots[field.labelId]?.askCount ?? 0) >= MAX_ASKS_PER_SLOT)
      .map((field) => field.labelId);
    if (alreadyExhausted.length > 0) {
      form = escalate(
        form,
        ESCALATION_REASONS.askLimitExhausted + ': ' + alreadyExhausted.join('、'),
      );
      audits.push({
        kind: 'escalated',
        reason: form.escalatedReason,
        detail: '已问满的槽位重新变空：' + alreadyExhausted.join(','),
      });
    }
  }

  // ── 筛选终局优先：表内已判不合格时，可恢复型熔断让位，走拒绝话术+转岗而非转人工 ──
  const yielded = yieldRecoverableEscalationToScreening(form);
  if (yielded !== form) {
    audits.push({
      kind: 'escalation_yielded',
      detail: `熔断让位筛选终局：${form.escalatedReason ?? ''}`,
    });
    form = yielded;
  }

  // ── 生成本轮待问清单：这里只规划，不提前消耗下一次配额 ──
  let askableFields: string[] = [];
  if (input.askThisTurn !== false && verdictOf(form) === 'collecting') {
    // 按发问顺序取空槽；实际是否送达在候选人下一轮回来时核账。
    askableFields = emptyFields.map((field) => field.labelTitle);
  }

  const verdict = verdictOf(form);
  return {
    form,
    verdict,
    action: deriveCollectionAction(verdict),
    // 模板在回执核账之后渲染：核账只动 askCount/escalatedReason 不动槽位状态，
    // 但熔断会改 verdict，模板要反映最终状态。熔断后模板照返（内部可见），
    // askableFields 为空——调用方据此不再发问。
    template: renderCollectionTemplate(form, contract),
    askableFields,
    audits,
    answeredThisTurn,
  };
}

/**
 * 取最新候选人消息之前、上一条候选人消息之后的真实 assistant 回复，逐字段核对是否发问。
 * tool/system 消息不参与；更早的 assistant 历史不会在每轮被重复累计。
 */
export function askedLabelIdsBeforeLatestUser(
  messages: readonly unknown[],
  contract: readonly ContractFieldDef[],
): number[] {
  const records = messages.map(toDialogueRecord);
  let latestUserIndex = -1;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (records[index]?.role === 'user') {
      latestUserIndex = index;
      break;
    }
  }
  if (latestUserIndex <= 0) return [];

  let previousUserIndex = -1;
  for (let index = latestUserIndex - 1; index >= 0; index -= 1) {
    if (records[index]?.role === 'user') {
      previousUserIndex = index;
      break;
    }
  }

  const assistantTexts = records
    .slice(previousUserIndex + 1, latestUserIndex)
    .filter((record): record is { role: 'assistant'; text: string } => record?.role === 'assistant')
    .map((record) => record.text)
    .filter(Boolean);
  if (assistantTexts.length === 0) return [];

  return contract
    .filter((field) =>
      assistantTexts.some((text) => assistantAskedForField(text, field.labelTitle)),
    )
    .map((field) => field.labelId);
}

function toDialogueRecord(message: unknown): { role: 'user' | 'assistant'; text: string } | null {
  if (!message || typeof message !== 'object') return null;
  const record = message as Record<string, unknown>;
  if (record.role !== 'user' && record.role !== 'assistant') return null;
  return { role: record.role, text: extractMessageText(record.content) };
}

function assistantAskedForField(text: string, labelTitle: string): boolean {
  const normalizedText = text.normalize('NFKC');
  const normalizedTitle = labelTitle.normalize('NFKC').trim();
  if (!normalizedTitle || !normalizedText.includes(normalizedTitle)) return false;

  // 标准清单：只认空值或仅带选项提示的「字段：」行；已预填值不算再次发问。
  const escapedTitle = normalizedTitle.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const emptyTemplateLine = new RegExp(
    `(?:^|\\n)\\s*${escapedTitle}\\s*:\\s*(?:\\([^\\n]*\\))?\\s*(?=\\n|$)`,
    'u',
  );
  if (emptyTemplateLine.test(normalizedText)) return true;

  // 定向追问：如「你什么专业」「手机号是多少？」；纯陈述里偶然出现字段名不计。
  const titleIndex = normalizedText.indexOf(normalizedTitle);
  const nearby = normalizedText.slice(
    Math.max(0, titleIndex - 16),
    titleIndex + normalizedTitle.length + 16,
  );
  return /(?:什么|多少|几|哪|是否|有无|请问|补充|提供|填写|填下|发下|告诉|确认|[?？])/u.test(
    nearby,
  );
}

/** 本轮是否有**确凿敏感**字段刚落值（因果隔离判据；不是 disclosureLevelOf，见其注释）。 */
export function hasRestrictedAnswerThisTurn(answered: readonly ContractFieldDef[]): boolean {
  return answered.some(isSensitiveAttribute);
}

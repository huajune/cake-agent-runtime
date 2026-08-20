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
  isSensitiveAttribute,
  markAsked,
  seedArchiveValue,
  proposeValue,
  recordConfigDebt,
  routeOf,
  verdictOf,
} from '@resolution/collection';
import {
  collectProposals,
  findFieldForClaim,
  type ArchiveFact,
  type IntakeClaim,
} from './proposal-intake';
import { renderCollectionTemplate, type CollectionTemplate } from './collection-template.renderer';
import type { CandidateClaimField } from '@resolution/evidence/claim.types';

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
  kind: 'proposal_rejected' | 'slot_disqualified' | 'slot_restated' | 'config_debt' | 'escalated';
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
  claims?: readonly IntakeClaim[];
  legacyArgs?: Partial<Record<CandidateClaimField, string>>;
  supplementAnswers?: Record<string, string> | null;
  /** 本轮是否要向候选人发问（发问才计熔断次数；只读探查不计）。 */
  askThisTurn?: boolean;
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

  // ── 写入：四条作证通道的提案逐条过公证 ──
  const proposals = collectProposals({
    contract,
    candidateTexts: input.candidateTexts,
    messages: input.messages,
    claims: input.claims,
    legacyArgs: input.legacyArgs,
    supplementAnswers: input.supplementAnswers,
    filledLabelIds,
  });

  const fieldById = new Map(contract.map((field) => [field.labelId, field]));
  for (const proposal of proposals) {
    const field = fieldById.get(proposal.labelId);
    if (!field) continue;
    const result = proposeValue(form, field, proposal);
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
    const field = findFieldForClaim(contract, archived.claimField);
    if (!field) continue;
    form = seedArchiveValue(form, field, { value: archived.value, evidence: archived.evidence });
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

  // ── 发问：先写后问，熔断在此生效 ──
  let askableFields: string[] = [];
  if (input.askThisTurn !== false && verdictOf(form) === 'collecting') {
    const emptyIds = contract
      .filter((field) => form.slots[field.labelId]?.state === 'empty')
      .map((field) => field.labelId);
    const asked = markAsked(form, emptyIds);
    form = asked.form;
    const titleById = new Map(contract.map((field) => [field.labelId, field.labelTitle]));
    askableFields = asked.askable.map((id) => titleById.get(id) ?? String(id));
    if (asked.exhausted.length > 0) {
      audits.push({
        kind: 'escalated',
        reason: form.escalatedReason,
        detail: `同槽问满上限仍空：${asked.exhausted.join(',')}`,
      });
    }
  }

  const verdict = verdictOf(form);
  return {
    form,
    verdict,
    action: deriveCollectionAction(verdict),
    // 模板在发问之后渲染：markAsked 只动 askCount/escalatedReason 不动槽位状态，
    // 但熔断会改 verdict，模板要反映最终状态。熔断后模板照返（内部可见），
    // askableFields 为空——调用方据此不再发问。
    template: renderCollectionTemplate(form, contract),
    askableFields,
    audits,
    answeredThisTurn,
  };
}

/** 本轮是否有**确凿敏感**字段刚落值（因果隔离判据；不是 disclosureLevelOf，见其注释）。 */
export function hasRestrictedAnswerThisTurn(answered: readonly ContractFieldDef[]): boolean {
  return answered.some(isSensitiveAttribute);
}

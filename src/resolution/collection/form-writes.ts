/**
 * 收资表单的**写路径纯函数**——改表的唯一途径（蓝图 §3）。
 *
 * 全部纯函数、零 IO、零 LLM：入参是旧表单 + 一件事，出参是新表单 + 这件事的结论。
 * 持久化由 memory 侧 service 包一层，审计事件由 tools 侧按返回的 outcome/reason 落
 * `agent_execution_events`（蓝图 §4，零新表零迁移）。
 *
 * ── 类型级不变量（写成断言测试，蓝图 §3 / §10） ───────────────────────────────
 * `filled` 槽位只能被 `applyRecapResult` 的 corrections 或 `applyErrorList` 重开。
 * **任何路径不得对 filled 槽位重复发问**——反复问病根的类型级根治：不是"识别器
 * 碰巧没失灵"，是"在结构上不可能"。
 *
 * ── 与蓝图 §3 四函数清单的偏离（三处，均为落地必需，非扩权） ─────────────────
 * 1. `proposeValue` 返回**信封**而非裸表单：蓝图 §4 要求"拒收/disqualify 各落一条
 *    审计事件"，只返回表单则调用方无法区分"拒收了"与"什么都没发生"，审计写不出来；
 * 2. 新增 `markAsked` / `markRecapSent` / `recordConfigDebt` / `escalate` 四个写函数：
 *    `askCount` / `lastRecap` / `configDebts` / `escalatedReason` 是 §2 实体声明的字段，
 *    而"改表的唯一途径是本文件"意味着它们的写入必须在这里，不能散到 service；
 * 3. `applyErrorList` 多收一个 `contract` 参数：D2 规定 applyErrorList 只带展示名时按
 *    labelTitle 匹配，没有契约就匹配不了，只能一律转人工（比 D2 更粗暴）。
 */

import { detectAgeBoundary } from '@resolution/candidate/age';
import { normalizeGenderValue } from '@resolution/candidate/gender';
import {
  evaluateBookingNameGate,
  evaluateBookingPhoneGate,
  isAgentQuestionConfirmedInDialogue,
} from '@resolution/evidence/identity-gates';
import {
  candidateValuesEquivalent,
  deriveFieldValueFromQuote,
  isValidCandidateFieldShape,
  normalizedIncludes,
} from '@resolution/evidence/normalize';
import type { CandidateClaimField, CandidateFactProducer } from '@resolution/evidence/claim.types';
import {
  resolveValueRange,
  type BookingCollectionForm,
  type ContractFieldDef,
  type FormSlot,
  type IdentitySlotKey,
  type SlotConfidence,
  type SlotValue,
  verdictOf,
} from './form.types';

// ==================== 常量 ====================

/**
 * 同一槽位允许发问的次数上限。达到上限仍 empty → 转人工（熔断，蓝图 §10 防线 6）。
 * 「同槽 2 问不中 → escalated，第 3 问不存在」——2 是产品口径，不是技术上限。
 */
export const MAX_ASKS_PER_SLOT = 2;

export const ESCALATION_REASONS = {
  /** 同槽问满上限仍拿不到值。 */
  askLimitExhausted: 'ask_limit_exhausted',
  /** applyErrorList 的字段定位不到槽位（D2：失配不静默）。 */
  errorListUnmapped: 'error_list_unmapped',
  /** 疑似多人会话（新姓名 + 新手机号成对出现，D1 v1 不建自动化协议）。 */
  suspectedMultiPerson: 'suspected_multi_person',
} as const;

export type EscalationReason = (typeof ESCALATION_REASONS)[keyof typeof ESCALATION_REASONS];

// ==================== 提案与结论 ====================

export interface ValueProposal {
  /** 归一化后的值。 */
  value: string;
  /** 选项型字段命中的 optionCode；TEXT/FILE 型不带。 */
  optionCodes?: string[];
  /** 候选人原话逐字片段（公证第一问的回查对象）。 */
  sourceText: string;
  /**
   * 署名如实（红线）：确定性适配器从候选人原话复算出的值署 `candidate_quote`
   * （词表口径「自陈 quote 复算」），模型作证的选项署 `model`。禁 `system` 冒名。
   */
  producer: CandidateFactProducer;
  /** 候选人可作证语料（已剥引用块与时间后缀）——公证第一问的基准。 */
  candidateTexts: readonly string[];
  /**
   * 完整消息序列，身份槽位的归属门（真名闸/手机号出处闸）取证用。
   * 身份槽位缺此项即拒收（fail-closed）：闸门看不见语料时"放行"等于没有闸门。
   */
  messages?: readonly unknown[];
  /**
   * 绑定的 Agent 问句原文（R1 作证通道，§10.1「确认可作证」）。
   *
   * 候选人对复述清单 / 针对性提问的肯定应答（"确认""对"）是**本人终审**，但值本体
   * 在**问句**里而不在应答里。带上问句后，身份槽位的"值须逐字落在原话内"改以问句
   * 为基准——这正是 0819 确认死循环的病根：候选人已经确认过了，闸门却因为
   * "对"字里没有住址而判臆造，于是整发清单再问一遍、直到熔断。
   *
   * ⚠️ 出处门第一问不豁免：问句是我方发的，应答必须仍是候选人原话逐字命中，
   * 否则"模型自己编个问句再自己确认"就能绕过公证。
   */
  agentQuestionQuote?: string;
  /**
   * 本提案是候选人**显式改口**（§3 0819 裁定的第三条重开路径）。
   *
   * ⚠️ 只能由**作证者显式声明**（主聊模型 claim 的 `operation='correct'`），
   * 代码不得自行推断——"这句话像不像在改口"是开放语言裁决，属模型
   * （§11 词表禁判语义）。含糊提及不算改口：履历/排除语境不覆盖既有值的既有判例继续适用。
   *
   * 棘轮语义：**对系统单向、对本人双向**。系统/模型的重推任何时候触碰不到 filled 槽位；
   * 本人明确改口可以，但走同一套公证，且 askCount 不清零——防"改一次刷新一次配额"绕过熔断。
   */
  restatement?: boolean;
}

export type ProposalOutcome =
  /** 值已入账（槽位 filled）。 */
  | 'accepted'
  /**
   * 候选人显式改口，已公证并替换在案值（槽位仍 filled，askCount 不变）。
   * 与 accepted 分开是审计要求（§3）：覆盖一个已公证的值是棘轮的例外口，
   * 每一次都必须能单独查出来"谁在什么时候把什么改成了什么"。
   */
  | 'restated'
  /** 值合法但命中筛选条件，本岗不合格（先筛后收）。 */
  | 'disqualified'
  /** 公证不过，零入账。 */
  | 'rejected'
  /** 槽位已 filled 或不在契约内，本次提案不改表。 */
  | 'ignored';

export const PROPOSAL_REJECTION_REASONS = {
  sourceTextNotFound: 'source_text_not_found',
  valueNotInSourceText: 'value_not_in_source_text',
  invalidValueShape: 'invalid_value_shape',
  valueNotInContractVocabulary: 'value_not_in_contract_vocabulary',
  unknownOptionCode: 'unknown_option_code',
  confirmationEvidenceRejected: 'confirmation_evidence_rejected',
  missingAttributionCorpus: 'missing_attribution_corpus',
  identityGateRejected: 'identity_gate_rejected',
} as const;

export type ProposalRejectionReason =
  (typeof PROPOSAL_REJECTION_REASONS)[keyof typeof PROPOSAL_REJECTION_REASONS];

export const PROPOSAL_IGNORE_REASONS = {
  slotNotInContract: 'slot_not_in_contract',
  slotAlreadyFilled: 'slot_already_filled',
  slotDisqualified: 'slot_disqualified',
} as const;

export type ProposalIgnoreReason =
  (typeof PROPOSAL_IGNORE_REASONS)[keyof typeof PROPOSAL_IGNORE_REASONS];

export interface ProposeResult {
  form: BookingCollectionForm;
  outcome: ProposalOutcome;
  reason?: ProposalRejectionReason | ProposalIgnoreReason;
  /** 排障用人类可读说明。不进 PII 观测事件——调用方落审计前自行裁剪。 */
  detail?: string;
}

// ==================== 写路径 1：值写入（公证内联五步） ====================

/**
 * 值写入。公证一次、同轮完成（构造性质①）——证据就在手边的当前消息里，
 * 跨轮引文搬运装置整体不需要存在。
 *
 * 五步串行，任一步不过即短路：
 * ① **出处门**：sourceText 必须在候选人可作证语料里逐字命中（反臆造主力——模型编不出
 *    一段真实存在过的原话）；身份槽位追加"值本体须落在 sourceText 内"；
 * ② **形态门**：值形状封闭校验（手机号 11 位且非占位号、年龄 14-70、姓名非纯数字……）；
 *    选项型字段的 optionCode 必须是契约选项集的成员；
 * ③ **归属门**：身份槽位挂真名闸（打招呼语昵称/引用前缀经理名）与手机号出处闸；
 * ④ **置信授予**：按证据形态查表，不采信模型自报（宪法 P11）；
 * ⑤ **先筛后收**：命中 rejectedOptions、或年龄越出契约 min/max 硬区间 → 该槽
 *    disqualified，本岗不再收资。
 *
 * ⚠️ ②不复算值否决（宪法 P11：公证器是代价路由器，不是真值裁判）。"解析器能不能从
 * 原话复算出这个值"只用来**授予置信度**（第④步），不构成否决理由。
 */
export function proposeValue(
  form: BookingCollectionForm,
  field: ContractFieldDef,
  proposal: ValueProposal,
): ProposeResult {
  const slot = form.slots[field.labelId];
  if (!slot) {
    return {
      form,
      outcome: 'ignored',
      reason: PROPOSAL_IGNORE_REASONS.slotNotInContract,
      detail: `labelId ${field.labelId} 不在本表单的契约字段集内`,
    };
  }
  // 棘轮：对系统单向、对本人双向。filled 槽位只有三条合法重开路径——复述改格、
  // applyErrorList 重开、候选人**显式改口**（下方走同一套公证，通过即替换）。
  // 模型/系统的重推在这里被挡死，这是"反复问"的类型级根治。
  if (slot.state === 'filled' && !proposal.restatement) {
    return {
      form,
      outcome: 'ignored',
      reason: PROPOSAL_IGNORE_REASONS.slotAlreadyFilled,
      detail: `labelId ${field.labelId} 已办结，重写须走复述改格 / applyErrorList 重开 / 候选人显式改口`,
    };
  }
  if (slot.state === 'disqualified') {
    return {
      form,
      outcome: 'ignored',
      reason: PROPOSAL_IGNORE_REASONS.slotDisqualified,
      detail: `labelId ${field.labelId} 已判不合格，不再收资`,
    };
  }

  const identityKey = field.systemField;

  // ── ① 出处门 ──
  const sourceText = proposal.sourceText.trim();
  if (!sourceText) {
    return reject(form, PROPOSAL_REJECTION_REASONS.sourceTextNotFound, '证据文本为空');
  }
  if (!proposal.candidateTexts.some((text) => normalizedIncludes(text, sourceText))) {
    return reject(
      form,
      PROPOSAL_REJECTION_REASONS.sourceTextNotFound,
      'sourceText 未出现在候选人原文',
    );
  }
  // 值本体的基准文本：带 R1 问句时以问句为准（确认式作证），否则以候选人原话为准。
  const valueBearingText = proposal.agentQuestionQuote?.trim() || sourceText;
  const agentQuestionQuote = proposal.agentQuestionQuote?.trim();
  if (agentQuestionQuote) {
    if (
      !proposal.messages ||
      !isAgentQuestionConfirmedInDialogue(agentQuestionQuote, sourceText, proposal.messages)
    ) {
      return reject(
        form,
        PROPOSAL_REJECTION_REASONS.confirmationEvidenceRejected,
        '确认问句与候选人肯定应答未在真实相邻对话中找到',
      );
    }
  }
  if (identityKey && !valueContainedInSource(identityKey, proposal.value, valueBearingText)) {
    return reject(
      form,
      PROPOSAL_REJECTION_REASONS.valueNotInSourceText,
      proposal.agentQuestionQuote
        ? `身份槽位 ${identityKey} 的确认问句未逐字含该值`
        : `身份槽位 ${identityKey} 的原话未逐字含该值`,
    );
  }

  // ── ② 形态门 ──
  const contractValueRejection = validateContractValue(field, proposal.value, proposal.optionCodes);
  if (contractValueRejection) {
    return reject(form, contractValueRejection.reason, contractValueRejection.detail);
  }

  const claimField = identityKey ? IDENTITY_TO_CLAIM_FIELD[identityKey] : null;
  if (claimField && !isValidCandidateFieldShape(claimField, proposal.value)) {
    return reject(
      form,
      PROPOSAL_REJECTION_REASONS.invalidValueShape,
      `值形状非法: ${proposal.value}`,
    );
  }
  // ── ③ 归属门（身份槽位专属） ──
  if (identityKey === 'name' || identityKey === 'phone') {
    if (!proposal.messages) {
      return reject(
        form,
        PROPOSAL_REJECTION_REASONS.missingAttributionCorpus,
        `身份槽位 ${identityKey} 缺归属取证语料，闸门无法判定`,
      );
    }
    if (!agentQuestionQuote) {
      const gate =
        identityKey === 'name'
          ? evaluateBookingNameGate(proposal.value, proposal.messages)
          : evaluateBookingPhoneGate(proposal.value, proposal.messages);
      if (gate.decision !== 'allow') {
        return reject(form, PROPOSAL_REJECTION_REASONS.identityGateRejected, gate.reason);
      }
    }
  }

  // ── ④ 置信授予 ──
  const value: SlotValue = {
    value: proposal.value,
    ...(proposal.optionCodes?.length ? { optionCodes: [...proposal.optionCodes] } : {}),
    sourceText,
    producer: proposal.producer,
    confidence: grantConfidence(claimField, proposal.value, valueBearingText),
  };

  // ── ⑤ 先筛后收 ──
  const screening = screenValue(field, proposal.value, proposal.optionCodes, genderOf(form));
  if (screening) {
    return {
      form: withSlot(form, {
        labelId: field.labelId,
        state: 'disqualified',
        value,
        askCount: slot.askCount,
      }),
      outcome: 'disqualified',
      detail: screening,
    };
  }

  const wasFilled = slot.state === 'filled';
  return {
    form: withSlot(form, {
      labelId: field.labelId,
      state: 'filled',
      value,
      // askCount 不清零：改口不是"系统没问到"，重开后仍受同槽熔断约束。
      askCount: slot.askCount,
    }),
    outcome: wasFilled ? 'restated' : 'accepted',
    detail: wasFilled
      ? `labelId ${field.labelId} 候选人显式改口：「${slot.value?.value ?? ''}」→「${proposal.value}」`
      : undefined,
  };
}

/**
 * 表单在案的候选人性别（分性别值域筛的判据输入）。
 *
 * 只认已 filled 的性别槽位——正在收的、被筛掉的都不作数。取不到返回 null，
 * 此时分性别值域整体不参与判决（`resolveValueRange` 的漏斗优先取舍）。
 */
function genderOf(form: BookingCollectionForm): 'MALE' | 'FEMALE' | null {
  for (const slot of Object.values(form.slots)) {
    if (slot.systemField !== 'gender' || slot.state !== 'filled' || !slot.value) continue;
    const normalized = normalizeGenderValue(slot.value.value);
    if (normalized === '男') return 'MALE';
    if (normalized === '女') return 'FEMALE';
  }
  return null;
}

// ==================== 写路径 2：提交前复述的结果回写 ====================

export type RecapResult = { affirmed: true } | { corrections: number[] };

/**
 * 提交前复述的结果回写（构造性质②的落地面，D3 全程只复述一次）。
 *
 * - 「认」→ 表单不动，放行提交（verdict 保持 ready）；
 * - 「改某格」→ 该格重开（state=empty），**askCount 不清零**：候选人改口不是系统
 *   没问到，重开后仍受同槽熔断约束，避免"改一次刷新一次配额"绕过熔断。
 *
 * 只允许改 `lastRecap` 在案的槽位——复述里没出现过的格子不可能被这句"不对"指向
 * （蓝图 §10 防线 2：「不对，电话错了」精确重开一格，其余格不动）。
 */
export function applyRecapResult(
  form: BookingCollectionForm,
  result: RecapResult,
): BookingCollectionForm {
  if ('affirmed' in result) return form;

  const recapped = new Set(form.lastRecap?.labelIds ?? []);
  const targets = result.corrections.filter(
    (labelId) => recapped.has(labelId) && form.slots[labelId]?.state === 'filled',
  );
  if (targets.length === 0) return form;

  const slots = { ...form.slots };
  for (const labelId of targets) {
    const { systemField } = slots[labelId];
    slots[labelId] = {
      labelId,
      ...(systemField ? { systemField } : {}),
      state: 'empty',
      askCount: slots[labelId].askCount,
    };
  }
  return { ...form, slots };
}

// ==================== 写路径 3：entryUser applyErrorList 回写 ====================

export interface SubmissionError {
  /** 契约回传的 labelId（诉求 #2）。优先按它定位。 */
  labelId?: number;
  /** 只有展示名时的兜底匹配基准（D2）。 */
  field?: string;
  msg: string;
}

/**
 * 报名网关 applyErrorList 回写（蓝图 §10 防线 5「死锁终结」）。
 *
 * 每条错误按 labelId 定位重开该槽；定位不到 → escalatedReason，**不静默**
 * （D2：失配是唯一保留的必转人工特判）。回写后 verdictOf 必回到 collecting 或
 * escalated——"永卡 ready"在结构上不可能。
 */
export function applyErrorList(
  form: BookingCollectionForm,
  errors: readonly SubmissionError[],
  contract: readonly ContractFieldDef[],
): BookingCollectionForm {
  if (errors.length === 0) return form;

  const slots = { ...form.slots };
  const unmapped: string[] = [];
  let reopened = 0;

  for (const error of errors) {
    const labelId = resolveErrorLabelId(error, contract, slots);
    if (labelId === null) {
      unmapped.push(error.field ?? `labelId=${error.labelId ?? 'unknown'}`);
      continue;
    }
    const { systemField } = slots[labelId];
    slots[labelId] = {
      labelId,
      ...(systemField ? { systemField } : {}),
      state: 'empty',
      askCount: slots[labelId].askCount,
    };
    reopened += 1;
  }

  const next: BookingCollectionForm = reopened > 0 ? { ...form, slots } : { ...form };
  if (unmapped.length === 0) return next;
  return {
    ...next,
    escalatedReason: `${ESCALATION_REASONS.errorListUnmapped}: ${unmapped.join('、')}`,
  };
}

// ==================== 写路径 4：提交成功 ====================

/** 报名成功：落 workOrderId（不可推导的外部事实），verdict 随之变 submitted。 */
export function markSubmitted(
  form: BookingCollectionForm,
  workOrderId: number,
): BookingCollectionForm {
  return { ...form, workOrderId };
}

// ==================== 写路径 5-8：账面字段 ====================

/**
 * 登记本轮向候选人发问的槽位（熔断计数，蓝图 §10 防线 6）。
 *
 * 已问满 `MAX_ASKS_PER_SLOT` 仍 empty 的槽位不再计数、不再发问，整表转人工——
 * 「第 3 问不存在」。返回值同时给出本轮实际可问的槽位，调用方据此渲染问句。
 */
export function markAsked(
  form: BookingCollectionForm,
  labelIds: readonly number[],
): { form: BookingCollectionForm; askable: number[]; exhausted: number[] } {
  const slots = { ...form.slots };
  const askable: number[] = [];
  const exhausted: number[] = [];

  for (const labelId of labelIds) {
    const slot = slots[labelId];
    if (!slot || slot.state !== 'empty') continue;
    if (slot.askCount >= MAX_ASKS_PER_SLOT) {
      exhausted.push(labelId);
      continue;
    }
    slots[labelId] = { ...slot, askCount: slot.askCount + 1 };
    askable.push(labelId);
  }

  const next: BookingCollectionForm = { ...form, slots };
  if (exhausted.length === 0) return { form: next, askable, exhausted };
  return {
    form: {
      ...next,
      escalatedReason:
        form.escalatedReason ?? `${ESCALATION_REASONS.askLimitExhausted}: ${exhausted.join('、')}`,
    },
    askable,
    exhausted,
  };
}

/**
 * 档案预填（蓝图「记忆→表单预填」：跨岗不重复盘问）。
 *
 * 为什么不走 `proposeValue` 的公证：公证第一问验的是**本轮**证据窗里有没有这段原话，
 * 而档案值是**之前某一轮**收的——它当时已经过一次公证才进的记忆。拿本轮语料去验
 * 一句上周说的话，结论必然是"查无此话"，于是每开一张新表就把人重问一遍。
 *
 * 安全边界（缺一不可）：
 * 1. **只收已公证过的档案值**——调用方按 producer 白名单过滤（模型自报的、
 *    unknown 档的一律不进，防 badcase 6e9ar9gd 族"臆造档案经沿用洗白"）；
 * 2. **署名如实**：producer 记 `archive`、confidence 记 `medium`——它不是本人本轮
 *    说的，永远拿不到 high；sourceText 记原始出处并加 `档案：` 前缀，回查时一眼
 *    看出这不是本轮原话；
 * 3. **必经复述求证**：预填值落 filled，而提交前复述覆盖全部 filled 槽位——
 *    候选人一定会看到它并有机会说"不对"（这就是"带值求证"的兑现处）；
 * 4. **不覆盖任何已有值**：只填空槽。本轮亲口说的、已判不合格的都不动。
 * 5. **同账号内**（§11 红线）：作用域由表单 key 的 corpId 保证，跨托管账号是另一张表，
 *    档案带不过去——跨账号接触天然视为首次接触。
 */
export function seedArchiveValue(
  form: BookingCollectionForm,
  field: ContractFieldDef,
  archived: { value: string; optionCodes?: string[]; evidence?: string },
): BookingCollectionForm {
  const slot = form.slots[field.labelId];
  if (!slot || slot.state !== 'empty') return form;
  const value = archived.value.trim();
  if (!value) return form;
  if (validateContractValue(field, value, archived.optionCodes)) return form;

  return withSlot(form, {
    labelId: field.labelId,
    state: 'filled',
    value: {
      value,
      ...(archived.optionCodes?.length ? { optionCodes: [...archived.optionCodes] } : {}),
      sourceText: `档案：${archived.evidence?.trim() || value}`,
      producer: 'archive',
      confidence: 'medium',
    },
    askCount: slot.askCount,
  });
}

/** 该槽位的值是否来自档案预填（复述话术可据此加「如有误请改」语气）。 */
export function isArchiveSeeded(form: BookingCollectionForm, labelId: number): boolean {
  return form.slots[labelId]?.value?.producer === 'archive';
}

/** 提交前复述落账——「不对」才能定位改哪格。 */
export function markRecapSent(
  form: BookingCollectionForm,
  labelIds: readonly number[],
): BookingCollectionForm {
  return { ...form, lastRecap: { labelIds: [...labelIds] } };
}

/**
 * 配置债记一行账（蓝图 §0：受阻 8 形态不建代码枚举，自由文本 note 即可）。
 * 同一 labelId 已有账则不重复记，避免每轮追加。
 */
export function recordConfigDebt(
  form: BookingCollectionForm,
  labelId: number,
  note: string,
): BookingCollectionForm {
  const existing = form.configDebts ?? [];
  if (existing.some((debt) => debt.labelId === labelId)) return form;
  return { ...form, configDebts: [...existing, { labelId, note }] };
}

/** 转人工。首个原因胜出——后续原因不覆盖，转人工的归因不该被后面的噪音改写。 */
export function escalate(form: BookingCollectionForm, reason: string): BookingCollectionForm {
  if (form.escalatedReason) return form;
  return { ...form, escalatedReason: reason };
}

/**
 * 疑似多人会话检测：本轮提案里**同时**出现与在案值不同的新姓名与新手机号。
 *
 * 单个身份字段变更不算——候选人纠正自己的错别字、换个号码都是正常的；成对更换才是
 * 中介替第二个人报名的形态。生产频率暂无可靠数据，当前只转人工、不自动化。
 */
export function detectSuspectedMultiPerson(
  form: BookingCollectionForm,
  contract: readonly ContractFieldDef[],
  proposals: ReadonlyArray<{ labelId: number; value: string }>,
): boolean {
  const conflicting = new Set<IdentitySlotKey>();
  for (const proposal of proposals) {
    const field = contract.find((item) => item.labelId === proposal.labelId);
    const key = field?.systemField;
    if (key !== 'name' && key !== 'phone') continue;
    const slot = form.slots[proposal.labelId];
    if (slot?.state !== 'filled' || !slot.value) continue;
    const claimField = IDENTITY_TO_CLAIM_FIELD[key];
    if (!candidateValuesEquivalent(claimField, slot.value.value, proposal.value)) {
      conflicting.add(key);
    }
  }
  return conflicting.has('name') && conflicting.has('phone');
}

/** 表单是否已到终局（提交/转人工/不合格），调用方据此停手。 */
export function isTerminal(form: BookingCollectionForm): boolean {
  const verdict = verdictOf(form);
  return verdict === 'submitted' || verdict === 'escalated' || verdict === 'disqualified';
}

// ==================== 私有 ====================

const IDENTITY_TO_CLAIM_FIELD: Record<IdentitySlotKey, CandidateClaimField> = {
  name: 'name',
  phone: 'phone',
  age: 'age',
  gender: 'gender',
};

function reject(
  form: BookingCollectionForm,
  reason: ProposalRejectionReason,
  detail?: string,
): ProposeResult {
  return { form, outcome: 'rejected', reason, detail };
}

function withSlot(form: BookingCollectionForm, slot: FormSlot): BookingCollectionForm {
  return {
    ...form,
    slots: { ...form.slots, [slot.labelId]: { ...form.slots[slot.labelId], ...slot } },
  };
}

/** 身份槽位的值本体是否逐字落在原话内（手机号忽略非数字字符）。 */
function valueContainedInSource(key: IdentitySlotKey, value: string, sourceText: string): boolean {
  if (key === 'phone') {
    const digits = value.replace(/\D/gu, '');
    return digits.length > 0 && sourceText.replace(/\D/gu, '').includes(digits);
  }
  return normalizedIncludes(sourceText, value);
}

/** 提案里第一个不在契约选项集内的 optionCode；全部合法返回 null。 */
function firstUnknownOptionCode(
  field: ContractFieldDef,
  optionCodes: readonly string[] | undefined,
): string | null {
  if (!optionCodes?.length) return null;
  const known = new Set([
    ...field.acceptedOptions.map((option) => option.optionCode),
    ...field.rejectedOptions.map((option) => option.optionCode),
  ]);
  return optionCodes.find((code) => !known.has(code)) ?? null;
}

/**
 * 岗位字段答案词表门。模板与 recap 只负责显示已办结槽位，不在渲染层替候选人做
 * `false`→「否」一类语义转换；无法用实时契约答案形态表达的值必须在写入边界拒收。
 */
function validateContractValue(
  field: ContractFieldDef,
  value: string,
  optionCodes: readonly string[] | undefined,
): { reason: ProposalRejectionReason; detail: string } | null {
  const normalizedValue = value.normalize('NFKC').trim();
  if (!normalizedValue || /^(?:true|false)$/iu.test(normalizedValue)) {
    return {
      reason: PROPOSAL_REJECTION_REASONS.valueNotInContractVocabulary,
      detail: `值「${normalizedValue}」不属于 labelId ${field.labelId} 的候选人答案词表`,
    };
  }

  if (field.fieldType === 'FILE') {
    return /^https?:\/\/\S+$/iu.test(normalizedValue)
      ? null
      : {
          reason: PROPOSAL_REJECTION_REASONS.invalidValueShape,
          detail: `labelId ${field.labelId} 的 FILE 值不是候选人附件 URL`,
        };
  }

  if (field.fieldType !== 'SINGLE_OPTION' && field.fieldType !== 'MULTIPLE_OPTION') return null;
  if (!optionCodes?.length) {
    return {
      reason: PROPOSAL_REJECTION_REASONS.valueNotInContractVocabulary,
      detail: `值「${normalizedValue}」无法适配 labelId ${field.labelId} 的契约选项`,
    };
  }

  const unknownCode = firstUnknownOptionCode(field, optionCodes);
  if (unknownCode !== null) {
    return {
      reason: PROPOSAL_REJECTION_REASONS.unknownOptionCode,
      detail: `optionCode ${unknownCode} 不在 labelId ${field.labelId} 的契约选项集内`,
    };
  }

  const optionByCode = new Map(
    [...field.acceptedOptions, ...field.rejectedOptions].map((option) => [
      option.optionCode,
      option.optionLabel.normalize('NFKC').trim(),
    ]),
  );
  const selectedLabels = optionCodes.map((code) => optionByCode.get(code) ?? '');
  const labelsAgree =
    field.fieldType === 'SINGLE_OPTION'
      ? selectedLabels.length === 1 && normalizedValue === selectedLabels[0]
      : selectedLabels.every((label) => label && normalizedIncludes(normalizedValue, label));
  return labelsAgree
    ? null
    : {
        reason: PROPOSAL_REJECTION_REASONS.valueNotInContractVocabulary,
        detail: `值「${normalizedValue}」与 labelId ${field.labelId} 的 optionCode 不一致`,
      };
}

/**
 * 置信按证据形态授予（宪法 P11：置信度是证据的属性，不是产者的属性）。
 * `high`：值本体逐字落在原话里，或既有解析器能从原话复算出等价值；
 * `medium`：归一化产物 / 选项匹配结果，回查不到逐字等价。
 */
function grantConfidence(
  claimField: CandidateClaimField | null,
  value: string,
  sourceText: string,
): SlotConfidence {
  if (normalizedIncludes(sourceText, value)) return 'high';
  if (!claimField) return 'medium';
  const derived = deriveFieldValueFromQuote(claimField, sourceText);
  if (derived === null) return 'medium';
  return candidateValuesEquivalent(claimField, derived, value) ? 'high' : 'medium';
}

/**
 * 先筛后收：命中 rejectedOptions（选项筛）或越出契约值域（值域筛）即不合格。
 * 返回不合格原因（账本用真实原因，委婉只在渲染层），合格返回 null。
 *
 * 判决零第二源：契约没带的判据 = 该岗没有这道筛，不读岗位数据补筛（0818 约定）。
 * 值域筛口径统一走 `detectAgeBoundary` 的弹性档——它判的是"数值 vs 区间"，与字段
 * 是年龄还是身高无关；弹性带（差一点点）不判不合格，交人来推进（漏斗优先）。
 */
function screenValue(
  field: ContractFieldDef,
  value: string,
  optionCodes: readonly string[] | undefined,
  gender: 'MALE' | 'FEMALE' | null,
): string | null {
  const rejected = field.rejectedOptions.find((option) =>
    optionCodes?.length
      ? optionCodes.includes(option.optionCode)
      : option.optionLabel.trim() !== '' && option.optionLabel.trim() === value.trim(),
  );
  if (rejected) {
    return `labelId ${field.labelId} 命中 rejectedOption「${rejected.optionLabel}」`;
  }

  const range = resolveValueRange(field.valueSpec, gender);
  if (range) {
    const numeric = parseLeadingNumber(value);
    const signal = detectAgeBoundary({ candidateAge: numeric, range });
    if (signal.severity === 'hard_reject') {
      return `labelId ${field.labelId}「${field.labelTitle}」值域越界：${signal.reason}`;
    }
  }
  return null;
}

/** 从"26岁""170cm""60 kg"这类带单位的值里取数值；取不出返回 null（= 不判值域）。 */
function parseLeadingNumber(value: string): number | null {
  const matched = /-?\d+(?:\.\d+)?/u.exec(value.normalize('NFKC'));
  if (!matched) return null;
  const numeric = Number(matched[0]);
  return Number.isFinite(numeric) ? Math.round(numeric) : null;
}

/** applyErrorList 单条错误 → 槽位 labelId；定位不到返回 null（D2：失配转人工，不静默）。 */
function resolveErrorLabelId(
  error: SubmissionError,
  contract: readonly ContractFieldDef[],
  slots: Readonly<Record<number, FormSlot>>,
): number | null {
  if (error.labelId !== undefined && slots[error.labelId]) return error.labelId;
  const field = error.field?.trim();
  if (!field) return null;
  const matched = contract.find((item) => item.labelTitle.trim() === field);
  return matched && slots[matched.labelId] ? matched.labelId : null;
}

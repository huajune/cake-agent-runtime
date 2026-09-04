import { toErrorMessage } from '@infra/utils/error.util';
import type { CollectionFormService } from '@tools/collection/collection-form.service';
import { Logger } from '@nestjs/common';
import {
  applyRecapResult,
  contractFieldsEqual,
  escalate,
  isCollectionAuthorized,
  isSubmissionAuthorized,
  mapContractFields,
  needsRecap,
  parseIdentityAnchors,
  reconcileScheduleDraft,
  verdictOf,
  type BookingCollectionForm,
  type ContractFieldDef,
  type Verdict,
} from '@resolution/collection';
import {
  hasDeliveredCurrentRecapSnapshot,
  verifyRecapConfirmationBinding,
  type RecapConfirmationRejectionReason,
} from '@resolution/notary/recap-confirmation';
import { normalizedIncludes } from '@resolution/notary/text-normalization';
import { isStorableCandidatePhone } from '@resolution/candidate/phone';
import { selectEvidenceDialogueMessages } from '@resolution/signal/corpus';
import { extractCandidateTexts } from '@resolution/signal/self-report';
import { EMPTY_CONTRACT_ESCALATION_REASON } from '@sponge/collection-contract.types';
import type { SpongeService } from '@sponge/sponge.service';
import type { OpsEventsRecorderService } from '@biz/ops-events/services/ops-events-recorder.service';
import type { ToolBuilder } from '@shared-types/tool.types';
import type { AgentEvent } from '@/observability/observer.interface';
import {
  runCollectionCore,
  type CollectionAuditEvent,
  type CollectionCoreResult,
} from '@tools/collection/collection-core';
import {
  findFieldByTitle,
  resolveFieldByTitle,
  selectArchiveFacts,
} from '@tools/collection/proposal-intake';
import {
  FieldValueProposalsInputSchema,
  type FieldValueProposalInput,
} from '@tools/collection/field-value-proposal-input';
import { renderRecap, renderRecapRedeliveryText } from '@tools/collection/recap-renderer';
import { renderRejection } from '@tools/collection/rejection-renderer';
import {
  buildBookableSlots,
  buildScheduleRule,
  buildUpcomingTimeOptions,
  evaluateRequestedDate,
  type BookableSlot,
} from '@tools/booking/bookable-slot.util';
import {
  formatShanghaiDate,
  formatShanghaiTime,
  normalizeRequestedDate,
} from '@tools/booking/date.util';
import { normalizeHm } from '@tools/booking/interview-window.util';
import {
  buildJobPolicyAnalysis,
  isWaitNoticeInterview,
  normalizePolicyText,
} from '@tools/job-list/job-policy-parser';
import { buildSpongeTokenContext } from '@tools/shared/sponge-token-context.util';
import { buildToolError, TOOL_ERROR_TYPES } from '@tools/shared/tool-error-types';
import { stripNullish } from '@infra/utils/object.util';
import { tool } from 'ai';
import { z } from 'zod';

// 保留 age util 的符号 re-export，兼容独立边界单测；年龄是否筛退只读实时收资契约。
export { parseAgeRange, parseCandidateAge } from '@tools/job-list/age.util';
export {
  AGE_BOUNDARY_HANDOFF_FLOOR,
  AGE_BOUNDARY_LOWER_TOLERANCE_YEARS,
  AGE_BOUNDARY_UPPER_TOLERANCE_YEARS,
  detectAgeBoundary,
} from '@resolution/candidate/age';

const logger = new Logger('duliday_interview_precheck');

/**
 * description 与每次回执共用这一条照发指令，避免模型同时看到两套标签/模板口径。
 *
 * 照发的硬约束只在**标签与行结构**（标签逐字=契约 labelTitle，候选人回填才对得上槽位）；
 * 冒号右侧的值明确放行预填（用户裁定预填是正确行为）——会话已知答案不填进去，模型就被
 * 「勿重复追问」夹死，只能整句改写模板逃生。
 * 状态机的标准清单判定同口径：已预填值不算再次发问（见 collection-core）。
 */
export const COLLECTION_TEMPLATE_SEND_INSTRUCTION =
  '照发 bookingChecklist.templateText：标签逐字用原文，不得增删、重排字段行，不要另起一套收资清单；会话中候选人已明确说过的值可预填。首次收资时把 interview.bookableSlots 作为独立的「可约面试时间」区块一并展示，允许候选人一轮同时回复资料和时间。候选人发来值的**当轮**立即经 fieldValueProposals 提交本工具——提交字段值提案不等于提交预约；**禁止**在提交前自行复述资料向候选人讨确认。';

// 程序记忆层（procedural memory）工具绑定规则；总目录：docs/prompt-rule-ledger.md
export const PRECHECK_DESCRIPTION = `面试前置校验。实时读取岗位收资契约，推进候选人 × 岗位的持久表单，并返回可约时段。

参数纪律：
- jobId 必须来自本会话最近一次 duliday_job_list 的真实召回。
- mode 必须显式传，禁止靠是否携带其它参数猜调用意图：
  - mode="query"：查询/刷新岗位报名表单与预约时段。本轮没有候选人报名资料需要校验时使用；多人代报可带 candidatePhone，查询指定日期可带 requestedDate。
  - mode="validate"：校验候选人报名资料。本轮候选人已经明确给出任何报名字段答案时必须使用，并携带非空 fieldValueProposals；登记报名信息确认时携带 recapConfirmation=true。新表单会在同一次调用中建立实时契约快照并校验，禁止为了查询契约而丢掉本轮答案。
- validate 使用持久化契约快照；若返回 contract_changed，先用 mode="query" 刷新表单，再根据新 bookingChecklist 在同一轮用 mode="validate" 重投仍有原话依据的 fieldValueProposals。
- 如果 jobId 因无召回出处被拒，禁止把该数字放进 jobIdList 继续查。只从历史原话提取城市、品牌、门店、岗位，单次调用 duliday_job_list：cityNameList=城市、brandAliasList=品牌、searchJobName="门店关键词+岗位关键词"；用唯一返回的真实 jobId 重试本工具。
- candidatePhone 仅用于**同一会话代多人报名**：逐人传入当前正在办理者原话中的 11 位手机号，用它选择独立表单；单人报名不传。多人时严格按一人一条链路串行处理：本工具返回 ready_to_book 后立即 booking，booking 成功后才能 precheck 下一人；禁止并行调用多个 precheck。
- requestedDate 只在候选人明确表达时传：可传日期、interview.bookableSlots 中的精确 interviewTime，或候选人约定的窗口内具体时刻（YYYY-MM-DD HH:mm）；含糊就不传。面试时间不属于收资字段，不得写成 fieldValueProposals 条目。
- fieldValueProposals 是唯一收资字段入口。只在候选人原话明确支持最终契约值时提交；没提到、无法唯一映射、带保留或有歧义时不提交，让该槽位保持 empty。不得为了填满表单猜值，不得提交置信分、待复核标记或“先填后确认”值。
- 每项 labelTitle 必须逐字取自 bookingChecklist.requiredFields，value 传规范值，quote 必须逐字取自候选人完整原话。一条消息明确支持多个字段时全部提交。纠正用 correct、清除用 clear；confirm 只用于候选人对真实相邻字段问句的短答确认，不得把 recap 拆成全部 filled 字段重投。
- fieldValueProposals 只能填写实时契约已有槽位，不能增删字段，也不能控制 requiredFields 及其顺序。不得传岗位要求冒充候选人答案，不得补造字段或沿用旧 candidateXxx 裸参数。
- recapConfirmation=true 是报名信息确认的**唯一入账入口**：候选人明确表示报名信息无误时（包括「好的」「确认」等纯短答，也包括「没」这类语境化短答——回应「有不对的地方直接说改哪项」即表示没有要修改的信息），必须提交 true，不提交则确认永不入账、booking 会被拒。候选人原话和已发送的报名信息由系统自动绑定，不要复制 quote。**这只适用于确实需要确认报名信息的表单**：若回执给出 recap_not_required，说明本岗无需确认，不要卡在讨确认上。存在 correct/clear 时不要同时提交，纠正优先。
- 返回里出现 rejectedAnswers 表示这些答案**已被退回、没有入账**。逐项服从 action：retry_submission 才按 hint 修正重投；ask_candidate 必须按 hint 向候选人补问并等待新回复，禁止原值重投。
- 返回里出现 rejectedRecapConfirmation 表示本轮 recap 确认被公证退回、没有入账：按其 hint 修复后重投，不要把候选人已经确认过的内容再问一遍。

行动纪律：
- collect_fields：只收 bookingChecklist.requiredFieldsToCollectNow。${COLLECTION_TEMPLATE_SEND_INSTRUCTION}
- confirm_collection：返回 recap.candidateMessage 时必须照发；未返回表示当前 KV 已真实送达，只需简短请候选人确认。如尚未选时间，可同时并列展示 interview.bookableSlots。
- select_interview_time：资料已授权但尚未选择具体时段；interview.bookableSlots 是按 availabilityAuthority.evaluatedAt 和完整日期时间过滤后的唯一可约事实。只展示 bookingAllowed=true 的时段，不得根据 scheduleRule/processRemark 中“当天、前一天”等相对词二次计算或删减，不再复述资料。
- screening_rejected：只使用 rejection.candidateMessage，不自行披露内部筛选原因。
- handoff：停止收资并转人工。
- ready_to_book：才允许调用 duliday_interview_booking；booking 成功前禁止声称已报名。
- already_submitted：停止重复提交。`;

export const PRECHECK_INPUT_SCHEMA = z
  .object({
    mode: z
      .enum(['query', 'validate'])
      .describe('query=查询岗位报名表单/预约时段；validate=提交并校验候选人报名资料'),
    jobId: z.coerce.number().int().positive().describe('岗位 ID，必须来自本会话真实召回'),
    candidatePhone: z
      .string()
      .trim()
      .refine(isStorableCandidatePhone, '必须是候选人原话中的 11 位大陆手机号')
      .optional()
      .describe('仅多人代报时传：当前正在办理的候选人手机号，用于选择其独立表单'),
    requestedDate: z
      .string()
      .optional()
      .describe(
        '候选人明确提出的日期、上一轮 bookableSlots 中的精确 interviewTime，或候选人约定的窗口内具体时刻（YYYY-MM-DD HH:mm）',
      ),
    fieldValueProposals: FieldValueProposalsInputSchema.optional().describe(
      'mode=validate 的字段值提案：仅提交候选人原话明确支持的实时契约最终值；歧义、缺失或不能唯一映射时不提交',
    ),
    recapConfirmation: z
      .literal(true)
      .optional()
      .describe('mode=validate 的报名信息确认入口；候选人最新回复明确确认报名信息无误时传 true'),
  })
  .superRefine((input, ctx) => {
    if (input.mode === 'query') {
      if (input.fieldValueProposals !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['fieldValueProposals'],
          message: 'fieldValueProposals 属于收资校验，请改用 mode=validate',
        });
      }
      if (input.recapConfirmation !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['recapConfirmation'],
          message: 'recapConfirmation 属于资料确认，请改用 mode=validate',
        });
      }
      return;
    }

    if (!(input.fieldValueProposals?.length || input.recapConfirmation === true)) {
      ctx.addIssue({
        code: 'custom',
        path: ['mode'],
        message: 'mode=validate 必须携带非空 fieldValueProposals 或 recapConfirmation=true',
      });
    }
  });

export interface PrecheckAdjudicationDeps {
  observer?: { emit: (event: AgentEvent) => void };
  collectionForms?: CollectionFormService;
  identityAnchors?: string;
}

interface FormRun {
  form: BookingCollectionForm;
  contract: ContractFieldDef[];
  result: CollectionCoreResult;
  recapText?: string;
  verdict: Verdict;
  /** 误投字段值提案的期望面试日期，转运成功后作为本次 requestedDate（显式参数优先）。 */
  divertedRequestedDate?: string;
  /** labelTitle 定位失败/撞车弃权/面试时间族解析失败的条目——模型可见的纠错回执。 */
  unmatchedAnswers: UnmatchedAnswer[];
  /** 定位成功但被公证拒收的条目——模型可见的纠错回执。 */
  rejectedAnswers: RejectedAnswer[];
  /** 本轮 recapConfirmation 被公证拒收的原因——模型可见的纠错回执 + 审计落账。 */
  recapConfirmationRejection?: RecapConfirmationRejectionReason;
  /** true 表示本次没有提交任何候选人值，只读取/刷新表单契约。 */
  queryOnly: boolean;
}

class ContractStateError extends Error {
  constructor(
    readonly code: 'contract_changed',
    readonly details: Record<string, unknown>,
  ) {
    super(code);
    this.name = 'ContractStateError';
  }
}

interface UnmatchedAnswer {
  labelTitle: string;
  hint: string;
}

/**
 * recap 确认公证拒收 → 模型可见回执。没有它模型只看到 confirm_collection 原地踏步，
 * 会把"确认没入账"误诊成系统故障转人工，或者
 * 假宣称已提交。
 */
const RECAP_CONFIRMATION_REJECTION_HINTS: Record<RecapConfirmationRejectionReason, string> = {
  recap_not_required:
    '本岗表单无外部预填，**本就不需要复述确认**——资料不是「还没最终确认」。不要再向候选人讨确认，也不要重复提交 recapConfirmation；直接按本次 nextAction 行动（ready_to_book 即立刻调用 duliday_interview_booking）。',
  recap_missing_or_already_affirmed:
    '没有待确认的复述在案（尚未发出或已确认过），按本次 nextAction 行动即可。',
  recap_snapshot_mismatch:
    '此前复述没有按官方文本完整送达候选人。照发本次返回的 recap.candidateMessage 重新复述，候选人确认后再带 recapConfirmation 重调。',
  correction_takes_precedence:
    '本轮存在字段纠正，纠正优先入账；纠正落账后会重新发复述，勿在同轮提交确认。',
};

/**
 * 公证拒收对模型的回执。
 *
 * 此前拒收只落 `collection_form_audit` 给我们看，工具返回给模型的只有
 * `missingFields` ——**模型不知道自己为什么被拒**，于是要么原样重投、要么回头再问
 * 候选人一遍（年龄被拒后候选人被连问两遍）。
 * 与 0826 给 labelTitle 定位失败补 `unmatchedAnswers` 是同一类修法、同一种形状。
 */
interface RejectedAnswer {
  labelTitle: string;
  reason: string;
  hint: string;
  action: 'retry_submission' | 'ask_candidate';
}

/** 拒收原因 → 模型可执行的下一步。措辞只讲"怎么办"，不复述候选人隐私值。 */
interface RejectionGuidance {
  hint: string;
  action: RejectedAnswer['action'];
}

const REJECTION_HINTS: Readonly<Record<string, RejectionGuidance>> = {
  source_text_not_found: {
    hint: 'quote 必须是候选人原话里逐字存在的片段；请改用候选人真实说过的原文重投。',
    action: 'retry_submission',
  },
  value_not_in_source_text: {
    hint: '身份字段的值必须能在候选人原话里逐字找到、或由确定性解析器从原话复算出来。不要提交自行加工过的值；有真实原文就按原文重投，否则向候选人询问后等待新回复。',
    action: 'retry_submission',
  },
  invalid_value_shape: {
    hint: '值形状不合法（如手机号非 11 位、年龄超出 14-70）；核对后重投或向候选人澄清。',
    action: 'retry_submission',
  },
  value_not_in_contract_vocabulary: {
    hint: '值不在本岗契约的选项集内；必须逐字使用 enumHints/契约选项原文，不要自造同义表述。',
    action: 'retry_submission',
  },
  unknown_option_code: {
    hint: 'optionCode 不属于本岗契约；改用契约返回的选项原文。',
    action: 'retry_submission',
  },
  confirmation_evidence_rejected: {
    hint: 'confirm 操作要求 agentQuestionQuote 是你真实问过的那句话、且候选人紧接着作了肯定应答；两段证据对不上时改用候选人原话走 set。',
    action: 'retry_submission',
  },
  missing_attribution_corpus: {
    hint: '缺少可归属的对话语料，无法核验该值出自候选人本人；等待候选人本人提供后再提交。',
    action: 'ask_candidate',
  },
  deterministic_conflict: {
    hint: '确定性 parser/adapter 从原话明确得出了另一个值；不要覆盖候选人原话，核对规范值后重投，仍有歧义就保持该槽位 empty 并定向追问。',
    action: 'retry_submission',
  },
};

/**
 * FILE 型字段的 invalid_value_shape 专属提示，压过通用条目。通用提示的「核对后重投」
 * 对文件字段是死路：文字永远过不了附件 URL 形态门，重投只会烧掉「读不懂两次转人工」
 * 的熔断配额（候选人打字填「上传简历」，模型
 * 按通用提示同轮重投，一轮熔断转人工）。正确动作只有一个：让候选人把文件发过来。
 */
const FILE_SHAPE_HINT =
  '该字段是文件字段，只能录入候选人真实发来的附件链接（候选人发文件/图片后，消息里会出现「简历附件：URL」标注行，用那个 URL 提交）。' +
  '文字描述无法作为它的值，不要原样重投；请明确告诉候选人：这一项需要直接把简历文件或简历截图/照片发过来，打字发文字没法录入。';

function rejectionGuidance(
  audit: CollectionAuditEvent,
  field: ContractFieldDef,
): RejectionGuidance | undefined {
  if (field.fieldType === 'FILE' && audit.reason === 'invalid_value_shape') {
    return { hint: FILE_SHAPE_HINT, action: 'ask_candidate' };
  }
  if (audit.reason === 'identity_gate_rejected') {
    if (audit.detail?.includes('自动打招呼昵称')) {
      return {
        hint: '该值只是自动打招呼里的昵称，不是真实姓名。不要原值重投；请说明“门店登记需要真实姓名”并询问本人，收到候选人的新回复后再提交姓名。',
        action: 'ask_candidate',
      };
    }
    if (audit.detail?.includes('引用前缀')) {
      return {
        hint: '该姓名只来自引用消息中的他人署名。不要原值重投；请向候选人本人询问真实姓名，收到新回复后再提交。',
        action: 'ask_candidate',
      };
    }
    return {
      hint: '姓名/手机号没有候选人本人提供的证据。不要原值重投；请向候选人本人询问，收到新回复后再提交。',
      action: 'ask_candidate',
    };
  }
  if (audit.reason === 'social_insurance_dimensions_missing') {
    const missing = audit.detail?.replace(/^missing_dimensions:/u, '').split(',') ?? [];
    const labels = [
      ...(missing.includes('payer') ? ['由本人还是公司缴纳'] : []),
      ...(missing.includes('location') ? ['参保地是本地还是外地'] : []),
    ];
    return {
      hint: `社保答案还不能唯一落到契约选项。不要猜或原值重投；只向候选人补问：${labels.join('、') || '缴纳方和参保地'}。`,
      action: 'ask_candidate',
    };
  }
  return audit.reason ? REJECTION_HINTS[audit.reason] : undefined;
}

/**
 * 面试时间语义族封闭词表（NFKC + 去空白后整串匹配）。模型会把候选人期望面试时间误投成
 * labelTitle「面试时间」，定位失败即静默丢弃，可约性校验从未运行。
 * 只有**定位不到契约槽位**的条目才进本词表判定——真契约字段永远优先。
 */
const INTERVIEW_TIME_TITLE_PATTERN =
  /^(?:(?:期望|意向|预约)?面试(?:时间段|时间|日期)|预约(?:时间|日期)|到[面店](?:时间|日期)|想约的?时间)$/u;

const LABEL_TITLE_HINT = 'labelTitle 必须逐字取自 bookingChecklist.requiredFields';

interface FieldValueProposalIntake {
  proposals: FieldValueProposalInput[];
  divertedRequestedDate?: string;
  unmatched: UnmatchedAnswer[];
}

/**
 * fieldValueProposals 进收资核前的定向分流：
 * - 面试时间语义族 + 本次未显式传 requestedDate + 值可解析 → 转运为 requestedDate 并移出答案；
 *   解析失败**不**升级为 PRECHECK_INVALID_REQUESTED_DATE（那会把原本成功的调用变失败）；
 * - 其余定位失败条目原样传给收资核（既有 collection_form_audit 审计面不变），
 *   同时汇成 unmatchedAnswers 让模型在工具返回里直接看到失败原因并自我纠正。
 */
function intakeFieldValueProposals(params: {
  contract: readonly ContractFieldDef[];
  fieldValueProposals?: readonly FieldValueProposalInput[];
  hasExplicitRequestedDate: boolean;
}): FieldValueProposalIntake {
  const proposals: FieldValueProposalInput[] = [];
  const unmatched: UnmatchedAnswer[] = [];
  let divertedRequestedDate: string | undefined;

  for (const answer of params.fieldValueProposals ?? []) {
    const resolution = resolveFieldByTitle(params.contract, answer.labelTitle);
    if (resolution.field) {
      proposals.push(answer);
      continue;
    }

    const normalizedTitle = answer.labelTitle.normalize('NFKC').replace(/\s+/gu, '');
    if (INTERVIEW_TIME_TITLE_PATTERN.test(normalizedTitle)) {
      const value = answer.value === null ? '' : String(answer.value).trim();
      const alreadyHasDate = params.hasExplicitRequestedDate || Boolean(divertedRequestedDate);
      if (!alreadyHasDate) {
        const parsed = normalizeRequestedDate(value);
        if (parsed.date) {
          divertedRequestedDate = parsed.date;
          continue;
        }
      }
      proposals.push(answer);
      unmatched.push({
        labelTitle: answer.labelTitle,
        hint: alreadyHasDate
          ? '面试时间不是收资字段，本次已以 requestedDate 参数为准；期望面试日期一律走 requestedDate 参数传入'
          : `面试时间不是收资字段，且「${value}」无法解析为日期；与候选人确认具体日期后改用 requestedDate 参数传入`,
      });
      continue;
    }

    proposals.push(answer);
    // 把**本岗合法标题**逐字列进 hint，而不是只叫模型"去看 requiredFields"。
    // 生产实证（0831，… job 524240）：契约只有 5 个字段，模型每轮都额外
    // 提交「学历」「健康证」「身份（学生/社会人士）」三个不存在的标题，连续 4 轮
    // 收到同一句"该标题不在本岗契约"的回执仍原样重投——指路式提示没能让它自我纠正。
    // 直接给出可选集合，纠正动作就不再需要模型回头做一次交叉引用。
    const availableTitles = params.contract.map((field) => field.labelTitle).join('、');
    unmatched.push({
      labelTitle: answer.labelTitle,
      hint:
        resolution.reason === 'label_title_ambiguous'
          ? `该标题在本岗契约命中多个字段、已放弃写入；${LABEL_TITLE_HINT}。本岗合法标题只有：${availableTitles}`
          : `该标题不在本岗契约，本岗不收这一项——不要再提交它，也不要就它追问候选人。` +
            `${LABEL_TITLE_HINT}。本岗合法标题只有：${availableTitles}`,
    });
  }

  return { proposals, divertedRequestedDate, unmatched };
}

/** 模型把当前值再次标成 correct 时视为 no-op，避免无变化也作废 lastRecap。 */
function isSameValueCorrection(
  answer: FieldValueProposalInput,
  form: BookingCollectionForm,
  contract: readonly ContractFieldDef[],
): boolean {
  if (answer.operation !== 'correct' || answer.value === null) return false;
  const field = findFieldByTitle(contract, answer.labelTitle);
  const current = field ? form.slots[field.labelId]?.value?.value : undefined;
  if (current === undefined) return false;
  const normalize = (value: string | number): string =>
    String(value).normalize('NFKC').replace(/\s+/gu, '');
  return normalize(answer.value) === normalize(current);
}

type PrecheckAction =
  | 'collect_fields'
  | 'confirm_collection'
  | 'select_interview_time'
  | 'screening_rejected'
  | 'handoff'
  | 'ready_to_book'
  | 'already_submitted';

export function buildInterviewPrecheckTool(
  spongeService: SpongeService,
  opsEventsRecorder: OpsEventsRecorderService,
  deps?: PrecheckAdjudicationDeps,
): ToolBuilder {
  return (context) =>
    tool({
      description: PRECHECK_DESCRIPTION,
      inputSchema: PRECHECK_INPUT_SCHEMA,
      execute: async ({
        mode,
        jobId,
        candidatePhone,
        requestedDate,
        fieldValueProposals,
        recapConfirmation,
      }) => {
        if (!deps?.collectionForms) {
          return buildToolError({
            errorType: TOOL_ERROR_TYPES.PRECHECK_FAILED,
            outcome: '收资表单服务不可用',
            replyInstruction: '停止收资并调用 request_handoff 转人工，禁止回退到旧报名字段。',
            details: { jobId },
          });
        }

        const recalled = context.archive.recalledJobIds ?? [];
        if (context.archive.isRecalledJobId && !context.archive.isRecalledJobId(jobId)) {
          return buildToolError({
            errorType: TOOL_ERROR_TYPES.PRECHECK_JOB_NOT_PROVIDED,
            outcome: '前置校验拦截（jobId 无召回出处）',
            replyInstruction:
              recalled.length === 0
                ? '不要把这个无出处 jobId 放进 jobIdList。根据历史原话中的城市＋品牌＋门店＋岗位，单次调用 duliday_job_list：cityNameList=城市、brandAliasList=品牌、searchJobName="门店关键词+岗位关键词"；再用唯一返回的真实 jobId 调本工具。'
                : `只能使用本会话召回过的 jobId：${recalled.join('、')}。若都不符合历史岗位，禁止查询这个被拒数字；按历史城市＋品牌＋门店＋岗位单次调用 duliday_job_list（cityNameList＋brandAliasList＋searchJobName="门店关键词+岗位关键词"）精确召回。`,
            details: { jobId, recalledJobIds: recalled },
          });
        }

        const evidenceMessages = context.turnInput.corpusBlocks
          ? selectEvidenceDialogueMessages(context.turnInput.corpusBlocks)
          : (context.turnInput.messages ?? []);

        try {
          const { jobs } = await spongeService.fetchJobs(
            {
              jobIdList: [jobId],
              pageNum: 1,
              pageSize: 1,
              options: {
                includeBasicInfo: true,
                includeHiringRequirement: true,
                includeInterviewProcess: true,
              },
            },
            buildSpongeTokenContext(context),
          );
          const job = jobs[0];
          if (!job?.basicInfo) {
            context.ledger.markJobInvalidated?.(jobId);
            return buildToolError({
              errorType: TOOL_ERROR_TYPES.PRECHECK_JOB_NOT_FOUND,
              outcome: '前置校验失败（岗位已失效）',
              replyInstruction:
                '不要重试同一 jobId；重新调用 duliday_job_list 查在招岗位。对候选人只说这家目前排不上。',
              details: { jobId },
            });
          }

          const analysis = buildJobPolicyAnalysis(job);
          const interviewTimeWaitNotice = isWaitNoticeInterview(analysis);
          const windows = analysis.interviewWindows;

          const formRun = await runForm({
            deps: { ...deps, collectionForms: deps.collectionForms },
            spongeService,
            context,
            jobId,
            candidatePhone,
            fieldValueProposals,
            recapConfirmation,
            hasExplicitRequestedDate: Boolean(requestedDate?.trim()),
            contractAccess: mode,
            messages: evidenceMessages,
          });

          const rawScheduleRequest = requestedDate?.trim() || formRun.divertedRequestedDate;
          const normalizedScheduleRequest = normalizeRequestedDate(rawScheduleRequest);
          const requestedDateFromExactTime = rawScheduleRequest?.match(/^\d{4}-\d{2}-\d{2}/u)?.[0];
          const explicitRequestedDate =
            normalizedScheduleRequest.date ?? requestedDateFromExactTime ?? undefined;
          const effectiveRequestedDate =
            explicitRequestedDate ?? formRun.form.scheduleDraft?.requestedDate ?? null;
          // 本轮所有时段、截止时间与请求日期都基于同一上海时区时刻裁决，避免跨边界漂移。
          const availabilityEvaluatedAt = new Date();
          const bookableSlots = interviewTimeWaitNotice
            ? []
            : buildBookableSlots({
                windows,
                requestedDate: effectiveRequestedDate,
                now: availabilityEvaluatedAt,
              });
          const candidateTexts = extractCandidateTexts(evidenceMessages, {
            visualSheetsByContent: context.turnInput.visualSheetsByContent,
          });
          const selectedInterviewTime = selectRequestedInterviewTime(
            rawScheduleRequest,
            bookableSlots,
          );
          formRun.form = reconcileScheduleDraft(formRun.form, {
            waitNotice: interviewTimeWaitNotice,
            liveSlots: bookableSlots,
            candidateTexts,
            ...(explicitRequestedDate ? { requestedDate: explicitRequestedDate } : {}),
            ...(selectedInterviewTime ? { selectedInterviewTime } : {}),
            ...(rawScheduleRequest && candidateTexts.at(-1)
              ? { sourceText: candidateTexts.at(-1) }
              : {}),
          });
          formRun.result = {
            ...formRun.result,
            form: formRun.form,
            verdict: verdictOf(formRun.form),
          };
          formRun.verdict = verdictOf(formRun.form);
          await deps.collectionForms.persist(
            {
              corpId: context.session.corpId,
              userId: context.session.userId,
              botUserId: context.session.botUserId!.trim(),
              jobId,
            },
            formRun.form,
          );

          const selectedDraftTime = formRun.form.scheduleDraft?.selectedInterviewTime;
          const selectedTimeBookingAllowed = Boolean(
            selectedDraftTime &&
              bookableSlots.some(
                (slot) => slot.bookingAllowed && slot.interviewTime === selectedDraftTime,
              ),
          );
          const nextAction = actionForForm(
            formRun,
            interviewTimeWaitNotice,
            selectedTimeBookingAllowed,
          );
          context.ledger.jobs.collectionReadyJobId = undefined;

          const requestedDateCheck =
            !interviewTimeWaitNotice && effectiveRequestedDate
              ? evaluateRequestedDate({
                  date: effectiveRequestedDate,
                  windows,
                  now: availabilityEvaluatedAt,
                })
              : null;
          const rejection = renderRejection({
            form: formRun.form,
            contract: formRun.contract,
            fieldsAnsweredThisTurn: formRun.result.answeredThisTurn,
          });
          const scheduleRule = interviewTimeWaitNotice ? '' : buildScheduleRule(windows);
          const upcomingTimeOptions = interviewTimeWaitNotice
            ? []
            : buildUpcomingTimeOptions(windows, 7, 10, availabilityEvaluatedAt);

          if (nextAction === 'ready_to_book') {
            context.ledger.jobs.collectionReadyJobId = jobId;
            const turnId = context.session.turnId ?? Date.now().toString();
            void opsEventsRecorder.recordEvent({
              corpId: context.session.corpId,
              eventName: 'precheck.passed',
              idempotencyKey: `${context.session.sessionId}:precheck:${jobId}:${turnId}`,
              botImId: context.session.botImId,
              managerName: context.session.botUserId,
              sourceChannel: 'unknown',
              userId: context.session.userId,
              chatId: context.session.sessionId,
              payload: { job_id: jobId },
            });
          }

          return stripNullish({
            success: true,
            nextAction,
            collectionVerdict: formRun.verdict,
            candidateScope: formRun.form.candidateScope ?? 'primary',
            _replyInstruction: replyInstruction(nextAction, formRun),
            job: {
              jobId,
              brandName: normalizePolicyText(job.basicInfo.brandName),
              storeName: normalizePolicyText(
                typeof job.basicInfo.storeInfo?.storeName === 'string'
                  ? job.basicInfo.storeInfo.storeName
                  : undefined,
              ),
              jobName: normalizePolicyText(job.basicInfo.jobName || job.basicInfo.jobNickName),
            },
            interview: {
              method: analysis.interviewMeta.method,
              address: analysis.interviewMeta.address,
              interviewTimeMode: interviewTimeWaitNotice ? 'wait_notice' : undefined,
              interviewTimeModeNote: interviewTimeWaitNotice
                ? '该岗位提交时不选面试时间；资料确认后 booking 不传 interviewTime，面试官会电话联系。'
                : undefined,
              scheduleRule: scheduleRule || undefined,
              availabilityAuthority: interviewTimeWaitNotice
                ? undefined
                : {
                    evaluatedAt:
                      `${formatShanghaiDate(availabilityEvaluatedAt)} ` +
                      formatShanghaiTime(availabilityEvaluatedAt),
                    timezone: 'Asia/Shanghai',
                    authoritativeField: 'bookableSlots',
                    instruction:
                      'bookableSlots 已按完整日期时间与报名截止时间过滤。bookingAllowed=true 即表示在 evaluatedAt 时刻可约；禁止再用 scheduleRule/processRemark 的“当天、前一天”或当前钟点二次计算、删除时段。',
                  },
              upcomingTimeOptions: upcomingTimeOptions.length > 0 ? upcomingTimeOptions : undefined,
              bookableSlots,
              flowDescription: analysis.interviewMeta.demand,
              processRemark: analysis.normalizedRequirements.interviewRemark,
              timingHighlights:
                analysis.highlights.timingHighlights.length > 0
                  ? analysis.highlights.timingHighlights
                  : undefined,
              requestedDate: requestedDateCheck
                ? {
                    value: effectiveRequestedDate,
                    status: requestedDateCheck.status,
                    reason: requestedDateCheck.reason,
                  }
                : undefined,
              scheduleDraft: formRun.form.scheduleDraft,
            },
            bookingChecklist: {
              requiredFields: formRun.result.template.requiredFields,
              missingFields: formRun.result.template.missingFields,
              requiredFieldsToCollectNow: formRun.result.askableFields,
              knownFieldMap:
                Object.keys(formRun.result.template.knownFieldMap).length > 0
                  ? formRun.result.template.knownFieldMap
                  : undefined,
              templateText: formRun.result.template.templateText,
              screeningFields: formRun.result.template.screeningFields,
            },
            unmatchedAnswers: formRun.unmatchedAnswers,
            rejectedAnswers:
              formRun.rejectedAnswers.length > 0 ? formRun.rejectedAnswers : undefined,
            rejectedRecapConfirmation: formRun.recapConfirmationRejection
              ? {
                  reason: formRun.recapConfirmationRejection,
                  hint: RECAP_CONFIRMATION_REJECTION_HINTS[formRun.recapConfirmationRejection],
                }
              : undefined,
            recap:
              nextAction === 'confirm_collection'
                ? {
                    candidateMessage: formRun.recapText,
                    instruction: formRun.recapText
                      ? '只发 candidateMessage，不自行增删字段；候选人确认或纠正后重新调用 precheck。'
                      : '当前资料复述已真实送达，不要重发整张收资表；只需简短请候选人确认或指出要改的字段。',
                  }
                : undefined,
            rejection:
              nextAction === 'screening_rejected' && rejection
                ? {
                    candidateMessage: rejection.candidateMessage,
                    forbiddenActions: rejection.forbiddenActions,
                    deferred: rejection.deferred,
                  }
                : undefined,
            collectionConfigDebts:
              formRun.form.configDebts && formRun.form.configDebts.length > 0
                ? formRun.form.configDebts
                : undefined,
          });
        } catch (error) {
          if (error instanceof ContractStateError) {
            return buildToolError({
              errorType: TOOL_ERROR_TYPES.PRECHECK_CONTRACT_CHANGED,
              outcome: '报名表单契约已变化，旧表未校验',
              replyInstruction:
                '改用 mode=query 刷新并取得最新 bookingChecklist；再按新表用 mode=validate 重投仍有候选人原话依据的 fieldValueProposals，禁止继续提交旧表。',
              details: error.details,
            });
          }
          logger.error(`面试前置校验失败: ${toErrorMessage(error)}`);
          return buildToolError({
            errorType: TOOL_ERROR_TYPES.PRECHECK_FAILED,
            outcome: '前置校验接口异常',
            replyInstruction:
              '不要回退到旧字段或凭岗位描述自行判断；安抚候选人后调用 request_handoff 转人工。',
            details: { jobId, reason: toErrorMessage(error) },
          });
        }
      },
    });
}

async function runForm(params: {
  deps: PrecheckAdjudicationDeps & { collectionForms: CollectionFormService };
  spongeService: SpongeService;
  context: Parameters<ToolBuilder>[0];
  jobId: number;
  candidatePhone?: string;
  fieldValueProposals?: readonly FieldValueProposalInput[];
  recapConfirmation?: true;
  hasExplicitRequestedDate: boolean;
  contractAccess: 'query' | 'validate';
  messages: readonly unknown[];
}): Promise<FormRun> {
  const botUserId = params.context.session.botUserId?.trim();
  if (!botUserId) {
    throw new Error('缺少稳定 botUserId，无法定位收资表单');
  }
  const rawContract = await params.spongeService.fetchJobCollectionContract(
    params.jobId,
    buildSpongeTokenContext(params.context),
  );
  const mapped = mapContractFields(rawContract, parseIdentityAnchors(params.deps.identityAnchors));
  emitAnchorMismatches(params, mapped.anchorMismatches);

  const scope = {
    corpId: params.context.session.corpId,
    userId: params.context.session.userId,
    botUserId,
    jobId: params.jobId,
  };
  const candidateTexts = extractCandidateTexts(params.messages, {
    visualSheetsByContent: params.context.turnInput.visualSheetsByContent,
  });
  const groundedCandidatePhone =
    params.candidatePhone &&
    candidateTexts.some((text) => normalizedIncludes(text, params.candidatePhone!))
      ? params.candidatePhone
      : undefined;
  if (params.candidatePhone && !groundedCandidatePhone) {
    logger.warn(
      `[precheck] candidatePhone 在候选人原话中无出处，忽略多人表单路由: jobId=${params.jobId}`,
    );
  }
  let form = await params.deps.collectionForms.loadOrCreate(
    scope,
    mapped.fields,
    groundedCandidatePhone,
    groundedCandidatePhone ? { candidateScope: 'additional' } : undefined,
  );
  if (params.contractAccess === 'query') {
    form = params.deps.collectionForms.refreshContractSnapshot(form, mapped.fields);
  } else if (!form.contractSnapshot) {
    // validate 不依赖一次预先的空 query：本轮已经有候选人答案时，同次建立实时
    // 契约快照并校验，避免模型为了“先查表”把 fieldValueProposals 丢掉。
    form = params.deps.collectionForms.refreshContractSnapshot(form, mapped.fields);
  } else if (!contractFieldsEqual(form.contractSnapshot.fields, mapped.fields)) {
    throw new ContractStateError('contract_changed', {
      jobId: params.jobId,
      previousLabelIds: form.contractSnapshot.fields.map((field) => field.labelId),
      currentLabelIds: mapped.fields.map((field) => field.labelId),
    });
  }
  const contract = form.contractSnapshot?.fields ?? mapped.fields;
  const isValidation = params.contractAccess === 'validate';

  const intake = intakeFieldValueProposals({
    contract,
    fieldValueProposals: isValidation ? params.fieldValueProposals : undefined,
    hasExplicitRequestedDate: params.hasExplicitRequestedDate,
  });
  if (intake.divertedRequestedDate) {
    logger.log(
      `[precheck] 字段值提案中的面试时间条目转运为 requestedDate=${intake.divertedRequestedDate}: jobId=${params.jobId}`,
    );
  }

  if (contract.length === 0) {
    form = escalate(form, EMPTY_CONTRACT_ESCALATION_REASON);
    logger.warn(`[precheck] 岗位返回空标签契约，按数据异常转人工: jobId=${params.jobId}`);
    params.deps.observer?.emit({
      type: 'collection_empty_contract',
      userId: params.context.session.userId,
      jobId: params.jobId,
    });
  }

  const proposals = intake.proposals.filter(
    (answer) => !isSameValueCorrection(answer, form, contract),
  );
  const corrections = proposals
    .filter((answer) => answer.operation === 'correct' || answer.operation === 'clear')
    .filter(
      (answer) =>
        Boolean(answer.quote) &&
        candidateTexts.some((text) => normalizedIncludes(text, answer.quote ?? '')),
    )
    .map((answer) => findFieldByTitle(contract, answer.labelTitle)?.labelId)
    .filter((labelId): labelId is number => labelId !== undefined);
  if (corrections.length > 0 && form.lastRecap) {
    form = applyRecapResult(form, { corrections });
  }

  const recapBinding =
    isValidation && params.recapConfirmation
      ? verifyRecapConfirmationBinding({
          form,
          contract,
          recapRequired: needsRecap(form),
          messages: params.messages,
          hasValidatedCorrection: corrections.length > 0,
        })
      : undefined;
  const affirmedThisTurn = recapBinding?.accepted === true;
  const recapConfirmationRejection =
    recapBinding && !recapBinding.accepted
      ? ((recapBinding.reason ??
          'recap_missing_or_already_affirmed') as RecapConfirmationRejectionReason)
      : undefined;
  if (recapConfirmationRejection) {
    params.deps.observer?.emit({
      type: 'collection_form_audit',
      userId: params.context.session.userId,
      jobId: params.jobId,
      kind: 'recap_confirmation_rejected',
      reason: recapConfirmationRejection,
      channel: 'recap_confirmation',
    });
  }
  if (affirmedThisTurn) form = applyRecapResult(form, { affirmed: true });
  // 复述确认是跨轮事实：候选人先明确确认、下一轮再选面试时间时，仍应沿用在案
  // 复述确认回执。槽位变更或契约槽位
  // 对齐会整体作废 lastRecap，因此不会把旧确认带到新资料。
  const recapAffirmed = form.lastRecap?.affirmed === true;

  const result = runCollectionCore({
    form,
    contract,
    // query 是读/刷新协议，不消费自由聊天或字段提案；否则“查一下预约信息”仍会
    // 触发 adapter_sweep，把不属于本字段的裸“不是”写成身份拒绝。已经过公证的
    // 档案事实仍可安全预填，并由 recap 让候选人确认，避免跨岗位重复询问。
    candidateTexts: isValidation ? candidateTexts : [],
    messages: isValidation ? params.messages : [],
    fieldValueProposals: isValidation ? proposals : [],
    archiveFacts: selectArchiveFacts(
      params.context.archive.sessionFacts?.interview_info as Record<string, unknown> | null,
    ),
    askThisTurn: !recapAffirmed,
    askReceiptTurnId: params.context.session.turnId,
  });
  if (result.form.candidateScope !== 'additional') {
    await params.deps.collectionForms.saveFinalizedProgressFacts(
      { ...scope, sessionId: params.context.session.sessionId },
      result.form,
      contract,
      result.answeredThisTurn,
    );
  }

  const phoneField = contract.find((field) => field.systemField === 'phone');
  const phoneValue = phoneField ? result.form.slots[phoneField.labelId]?.value?.value : null;
  let persisted = phoneValue
    ? await params.deps.collectionForms.rebindToPhone(scope, result.form, phoneValue)
    : result.form;

  let recapText: string | undefined;
  if (verdictOf(persisted) === 'ready' && needsRecap(persisted) && !persisted.lastRecap) {
    const recap = renderRecap(persisted, contract);
    persisted = recap.form;
    recapText = recap.text ?? undefined;
  } else if (
    verdictOf(persisted) === 'ready' &&
    needsRecap(persisted) &&
    persisted.lastRecap &&
    !persisted.lastRecap.affirmed &&
    !hasDeliveredCurrentRecapSnapshot({
      form: persisted,
      contract,
      messages: params.messages,
    })
  ) {
    // lastRecap 只证明工具生成过复述；聊天历史里没有当前 KV 才补发官方文案。
    recapText = renderRecapRedeliveryText(persisted, contract) ?? undefined;
  }
  await params.deps.collectionForms.persist(scope, persisted);
  emitAudits(params.deps, params.context, params.jobId, result.audits, contract);

  return {
    form: persisted,
    contract,
    result: { ...result, form: persisted, verdict: verdictOf(persisted) },
    recapText,
    verdict: verdictOf(persisted),
    divertedRequestedDate: intake.divertedRequestedDate,
    unmatchedAnswers: intake.unmatched,
    rejectedAnswers: collectRejectedAnswers(result.audits, contract),
    recapConfirmationRejection,
    queryOnly: !isValidation,
  };
}

/** 公证拒收 → 模型可见回执。只保留能定位到契约字段、且有可执行下一步的拒收。 */
function collectRejectedAnswers(
  audits: readonly CollectionAuditEvent[],
  contract: readonly ContractFieldDef[],
): RejectedAnswer[] {
  const fieldById = new Map(contract.map((field) => [field.labelId, field]));
  const rejected: RejectedAnswer[] = [];
  const seen = new Set<string>();
  for (const audit of audits) {
    if (audit.kind !== 'proposal_rejected' || audit.labelId === undefined || !audit.reason)
      continue;
    const field = fieldById.get(audit.labelId);
    if (!field) continue;
    const guidance = rejectionGuidance(audit, field);
    if (!guidance) continue;
    const key = `${field.labelTitle}:${audit.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rejected.push({
      labelTitle: field.labelTitle,
      reason: audit.reason,
      hint: guidance.hint,
      action: guidance.action,
    });
  }
  return rejected;
}

function actionForForm(
  run: FormRun,
  waitNotice: boolean,
  selectedTimeBookingAllowed: boolean,
): PrecheckAction {
  switch (run.verdict) {
    case 'collecting':
      return 'collect_fields';
    case 'disqualified':
      return 'screening_rejected';
    case 'escalated':
      return 'handoff';
    case 'submitted':
      return 'already_submitted';
    case 'ready':
      if (!isCollectionAuthorized(run.form)) return 'confirm_collection';
      return isSubmissionAuthorized({
        form: run.form,
        waitNotice,
        interviewTime: run.form.scheduleDraft?.selectedInterviewTime,
        interviewTimeBookingAllowed: selectedTimeBookingAllowed,
      })
        ? 'ready_to_book'
        : 'select_interview_time';
  }
}

function replyInstruction(action: PrecheckAction, run: FormRun): string {
  switch (action) {
    case 'collect_fields': {
      // 有拒收时先讲清楚"你提交的被退回了、按 hint 改"，否则模型只看到字段还缺、
      // 会把已经答过的字段再问候选人一遍。
      const retryable = run.rejectedAnswers.filter((item) => item.action === 'retry_submission');
      const askCandidate = run.rejectedAnswers.filter((item) => item.action === 'ask_candidate');
      const rejectedNote = [
        retryable.length > 0
          ? ` 注意：${retryable.map((item) => item.labelTitle).join('、')} 的提交被公证退回；按 rejectedAnswers.hint 修正后重投，已有真实答案不要重复询问。`
          : '',
        askCandidate.length > 0
          ? ` 注意：${askCandidate.map((item) => item.labelTitle).join('、')} 必须向候选人补问；禁止原值重投，按 rejectedAnswers.hint 提问并等待新回复后再提交。`
          : '',
      ].join('');
      const modeNote = run.queryOnly
        ? ' 本次为 mode=query 回执；若当前候选人消息已经包含任何报名答案，立即改用 mode=validate 并携带对应 fieldValueProposals 校验，禁止丢弃答案后直接发问。'
        : '';
      return `${COLLECTION_TEMPLATE_SEND_INSTRUCTION} 只缺：${run.result.askableFields.join('、') || run.result.template.missingFields.join('、')}；已 filled 字段禁止重复问。${rejectedNote}${modeNote}`;
    }
    case 'confirm_collection': {
      if (run.recapConfirmationRejection === 'recap_snapshot_mismatch' && run.recapText) {
        return '候选人的确认没能入账：此前复述未按官方文本送达（见 rejectedRecapConfirmation）。照发 recap.candidateMessage 重新复述并请候选人确认，确认后带 recapConfirmation 重调本工具。';
      }
      if (run.recapText) {
        return '资料含外部预填。发送 recap.candidateMessage；若尚未选时间，同时并列展示 interview.bookableSlots，允许候选人一轮确认资料并选时间。确认前禁止 booking。';
      }
      const rejectionNote = run.recapConfirmationRejection
        ? ' 注意：本轮提交的 recapConfirmation 被公证退回，原因与改法见 rejectedRecapConfirmation。'
        : '';
      return `已发过提交前复述但尚未得到明确确认。候选人本轮已明确表态确认的，立即带 recapConfirmation 重调本工具登记确认——不登记则确认永不入账；候选人尚未表态的才简短请他确认或指出哪项要改；若尚未选时间可同时给出真实 bookableSlots，禁止重发整张收资表。${rejectionNote}`;
    }
    case 'select_interview_time':
      return '候选人资料已经授权，但尚未选择具体预约时段。interview.bookableSlots 已按 availabilityAuthority.evaluatedAt 和完整报名截止时间过滤；只展示 bookingAllowed=true 的时段，严禁根据“当天”或当前钟点二次计算、删除时段。保留已收资料，不得重新收资或签发 booking。';
    case 'screening_rejected':
      return '停止收资与 booking，只按 rejection.candidateMessage 承接；不得披露内部受限原因。';
    case 'handoff':
      return `表单已转人工：${run.form.escalatedReason ?? 'unknown'}。停止发问并调用 request_handoff。`;
    case 'ready_to_book':
      return run.form.candidateScope === 'additional'
        ? '当前这位追加候选人的独立表单已授权。立即调用 duliday_interview_booking 完成这一人；只有 booking success=true 后才能处理下一人，不得并行 precheck/booking。'
        : '候选人资料已授权，且非 wait_notice 岗位的预约草稿已通过本轮实时复验。可以调用 duliday_interview_booking；只有 booking success=true 后才能说已报名。';
    case 'already_submitted':
      return `当前表单已提交（工单 ${run.form.workOrderId ?? 'unknown'}），禁止重复 booking。`;
  }
}

function selectRequestedInterviewTime(
  requestedDate: string | undefined,
  slots: readonly BookableSlot[],
): string | undefined {
  const requested = requestedDate?.normalize('NFKC').trim();
  if (!requested) return undefined;
  const matched = slots.filter(
    (slot) =>
      slot.bookingAllowed &&
      slot.interviewTime &&
      (requested === slot.interviewTime || requested === slot.label),
  );
  if (matched.length > 0) {
    return matched.length === 1 ? matched[0].interviewTime : undefined;
  }
  return selectSlotContainingRequestedTime(requested, slots);
}

/**
 * 「窗口内时刻」→ 所在 slot 的窗口起点。
 *
 * slot 自带的 interviewTimeHint 教模型「候选人说了窗口内的具体时刻就按他说的提交，
 * 不要改写成窗口起点」，于是 requestedDate 常以 `YYYY-MM-DD 15:00(:00)` 形态到达；
 * 上面的逐字匹配只认窗口起点/label，而 reconcileScheduleDraft 的唯一 slot 兜底在
 * 同日多窗口岗位失效——两头落空时草稿永远没有 selectedInterviewTime，nextAction 卡死
 * select_interview_time、booking 永拒（chat 6a9679e2 同会话两次连环死锁）。
 * 草稿仍锁窗口起点（v11.1.3 约定），候选人的具体时刻由 booking 侧按窗口区间独立放行。
 */
function selectSlotContainingRequestedTime(
  requested: string,
  slots: readonly BookableSlot[],
): string | undefined {
  const match = requested.match(/^(\d{4}-\d{2}-\d{2})[T ]+(\d{1,2}:\d{2})(?::\d{2})?$/u);
  if (!match) return undefined;
  const [, date, rawTime] = match;
  const time = normalizeHm(rawTime);
  if (!time) return undefined;
  const containing = slots.filter((slot) => {
    if (!slot.bookingAllowed || !slot.interviewTime || !slot.interviewTimeFlexible) return false;
    if (slot.date !== date) return false;
    const start = normalizeHm(slot.startTime);
    const end = normalizeHm(slot.endTime);
    return start !== null && end !== null && start <= time && time <= end;
  });
  return containing.length === 1 ? containing[0].interviewTime : undefined;
}

function emitAudits(
  deps: PrecheckAdjudicationDeps,
  context: Parameters<ToolBuilder>[0],
  jobId: number,
  audits: readonly CollectionAuditEvent[],
  contract: readonly ContractFieldDef[],
): void {
  const fieldById = new Map(contract.map((field) => [field.labelId, field]));
  for (const audit of audits) {
    const field = audit.labelId === undefined ? undefined : fieldById.get(audit.labelId);
    deps.observer?.emit({
      type: 'collection_form_audit',
      userId: context.session.userId,
      jobId,
      kind: audit.kind,
      labelId: audit.labelId,
      labelTitle: field?.labelTitle,
      fieldType: field?.fieldType,
      reason: audit.reason,
      channel: audit.channel,
      detail: audit.detail,
    });
  }
}

function emitAnchorMismatches(
  params: {
    deps: PrecheckAdjudicationDeps;
    context: Parameters<ToolBuilder>[0];
    jobId: number;
  },
  mismatches: Array<{
    labelId: number;
    expected: string;
    labelTitle: string;
  }>,
): void {
  for (const mismatch of mismatches) {
    logger.warn(
      `[precheck] 身份锚点核验不过，降通用道: labelId=${mismatch.labelId} ` +
        `期望=${mismatch.expected} 实际标题="${mismatch.labelTitle}" jobId=${params.jobId}`,
    );
    params.deps.observer?.emit({
      type: 'collection_identity_anchor_mismatch',
      userId: params.context.session.userId,
      labelId: mismatch.labelId,
      expected: mismatch.expected,
      labelTitle: mismatch.labelTitle,
    });
  }
}

import { toErrorMessage } from '@infra/utils/error.util';
import type { CollectionFormService } from '@tools/collection/collection-form.service';
import { Logger } from '@nestjs/common';
import {
  applyRecapResult,
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
  verifyRecapConfirmationBinding,
  type RecapConfirmationRejectionReason,
} from '@resolution/notary/recap-confirmation';
import { normalizedIncludes } from '@resolution/notary/text-normalization';
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
import { normalizeRequestedDate } from '@tools/booking/date.util';
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
 * 冒号右侧的值明确放行预填——会话已知答案不填进去，模型就被「勿重复追问」夹死，
 * 只能整句改写模板逃生（batch 6a8fd314，2026-08-27 用户裁定：预填是正确行为）。
 * 状态机的标准清单判定同口径：已预填值不算再次发问（见 collection-core）。
 */
export const COLLECTION_TEMPLATE_SEND_INSTRUCTION =
  '照发 bookingChecklist.templateText：标签逐字用原文，不得增删、重排字段行，不要另起一套收资清单；会话中候选人已明确说过的值可预填。首次收资时把 interview.bookableSlots 作为独立的「可约面试时间」区块一并展示，允许候选人一轮同时回复资料和时间。候选人发来值的**当轮**立即经 fieldValueProposals 提交本工具——提交字段值提案不等于提交预约；**禁止**在提交前自行复述资料向候选人讨确认。';

// 程序记忆层（procedural memory）工具绑定规则；总目录：docs/prompt-rule-ledger.md
export const PRECHECK_DESCRIPTION = `面试前置校验。实时读取岗位收资契约，推进候选人 × 岗位的持久表单，并返回可约时段。

参数纪律：
- jobId 必须来自本会话最近一次 duliday_job_list 的真实召回。
- requestedDate 只在候选人明确选择日期或 interview.bookableSlots 中的精确 interviewTime 时传；含糊就不传。面试时间不属于收资字段，不得写成 fieldValueProposals 条目。
- fieldValueProposals 是唯一收资字段入口。只在候选人原话明确支持最终契约值时提交；没提到、无法唯一映射、带保留或有歧义时不提交，让该槽位保持 empty。不得为了填满表单猜值，不得提交置信分、待复核标记或“先填后确认”值。
- 每项 labelTitle 必须逐字取自 bookingChecklist.requiredFields，value 传规范值，quote 必须逐字取自候选人完整原话。一条消息明确支持多个字段时全部提交。纠正用 correct、清除用 clear；confirm 只用于候选人对真实相邻字段问句的短答确认，不得把 recap 拆成全部 filled 字段重投。
- fieldValueProposals 只能填写实时契约已有槽位，不能增删字段，也不能控制 requiredFields 及其顺序。不得传岗位要求冒充候选人答案，不得补造字段或沿用旧 candidateXxx 裸参数。
- recapConfirmation 是 recap 确认的**唯一入账入口**：候选人对提交前复述明确表态确认时（包括「好的」「确认」等纯短答，也包括「没」这类语境化短答——回应「有不对的地方直接说改哪项」即确认），必须提交它，不提交则确认永不入账、booking 永远被拒。candidateQuote 必须是本轮完整回复，recapQuote 必须逐字取自实际已发出的复述文案（允许隔轮：资料未变时此前发过的复述仍有效）。存在 correct/clear 时不要提交，纠正优先。
- 返回里出现 rejectedAnswers 表示这些答案**已被退回、没有入账**：按其 hint 改投，不要把候选人已经答过的字段再问一遍。
- 返回里出现 rejectedRecapConfirmation 表示本轮 recap 确认被公证退回、没有入账：按其 hint 修复后重投，不要把候选人已经确认过的内容再问一遍。

行动纪律：
- collect_fields：只收 bookingChecklist.requiredFieldsToCollectNow。${COLLECTION_TEMPLATE_SEND_INSTRUCTION}
- confirm_collection：照发 recap.candidateMessage；如尚未选时间，同时并列展示 interview.bookableSlots，允许候选人一轮确认资料并选择时间。
- select_interview_time：资料已授权但没有实时有效的预约草稿；只让候选人从 interview.bookableSlots 选择具体时间，不再复述资料。
- screening_rejected：只使用 rejection.candidateMessage，不自行披露内部筛选原因。
- handoff：停止收资并转人工。
- ready_to_book：才允许调用 duliday_interview_booking；booking 成功前禁止声称已报名。
- already_submitted：停止重复提交。`;

export const PRECHECK_INPUT_SCHEMA = z.object({
  jobId: z.coerce.number().int().positive().describe('岗位 ID，必须来自本会话真实召回'),
  requestedDate: z
    .string()
    .optional()
    .describe('候选人明确提出的日期，或上一轮 bookableSlots 中的精确 interviewTime'),
  fieldValueProposals: FieldValueProposalsInputSchema.optional().describe(
    '字段值提案：仅提交候选人原话明确支持的实时契约最终值；歧义、缺失或不能唯一映射时不提交',
  ),
  recapConfirmation: z
    .object({
      candidateQuote: z.string().trim().min(1).max(500).describe('候选人本轮完整回复'),
      recapQuote: z
        .string()
        .trim()
        .min(1)
        .max(500)
        .describe('实际已发出的复述文案中的逐字片段（资料未变时允许隔轮引用）'),
    })
    .optional()
    .describe('recap 确认的唯一入账入口；候选人明确表态确认时必须提交，否则确认不入账'),
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
}

interface RecapConfirmationInput {
  candidateQuote: string;
  recapQuote: string;
}

interface UnmatchedAnswer {
  labelTitle: string;
  hint: string;
}

/**
 * recap 确认公证拒收 → 模型可见回执。没有它模型只看到 confirm_collection 原地踏步，
 * 会把"确认没入账"误诊成系统故障转人工（生产 chat 6a951ac7ce406a6aeea1338c），或者
 * 假宣称已提交（chat 6a951cadce406a6aeed925e7）。
 */
const RECAP_CONFIRMATION_REJECTION_HINTS: Record<RecapConfirmationRejectionReason, string> = {
  recap_not_required: '当前表单无外部预填、不需要复述确认，不必提交 recapConfirmation。',
  recap_missing_or_already_affirmed:
    '没有待确认的复述在案（尚未发出或已确认过），按本次 nextAction 行动即可。',
  candidate_quote_not_full_latest_reply:
    'candidateQuote 必须逐字等于候选人本轮完整回复，不得截取、拼接或改写后重投。',
  recap_quote_not_delivered:
    'recapQuote 在实际发出的消息里找不到，必须逐字取自真实发出的复述文案。',
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
 * 候选人一遍（生产 chat `6a8d583bce406a6aee063e2b`：年龄被拒后候选人被连问两遍）。
 * 与 0826 给 labelTitle 定位失败补 `unmatchedAnswers` 是同一类修法、同一种形状。
 */
interface RejectedAnswer {
  labelTitle: string;
  reason: string;
  hint: string;
}

/** 拒收原因 → 模型可执行的下一步。措辞只讲"怎么办"，不复述候选人隐私值。 */
const REJECTION_HINTS: Readonly<Record<string, string>> = {
  source_text_not_found: 'quote 必须是候选人原话里逐字存在的片段；请改用候选人真实说过的原文重投。',
  value_not_in_source_text:
    '身份字段的值必须能在候选人原话里逐字找到、或由确定性解析器从原话复算出来。不要提交自行加工过的值；按候选人原话提交，或先问一句、等候选人自己说出该值再提交。',
  invalid_value_shape:
    '值形状不合法（如手机号非 11 位、年龄超出 14-70）；核对后重投或向候选人澄清。',
  value_not_in_contract_vocabulary:
    '值不在本岗契约的选项集内；必须逐字使用 enumHints/契约选项原文，不要自造同义表述。',
  unknown_option_code: 'optionCode 不属于本岗契约；改用契约返回的选项原文。',
  confirmation_evidence_rejected:
    'confirm 操作要求 agentQuestionQuote 是你真实问过的那句话、且候选人紧接着作了肯定应答；两段证据对不上时改用候选人原话走 set。',
  missing_attribution_corpus: '缺少可归属的对话语料，无法核验该值出自候选人本人。',
  identity_gate_rejected:
    '姓名/手机号未通过归属核验（可能取自昵称、引用块里的经理、或第三方截图）；请让候选人本人再说一遍。',
  deterministic_conflict:
    '确定性 parser/adapter 从原话明确得出了另一个值；不要覆盖候选人原话，核对规范值后重投，仍有歧义就保持该槽位 empty 并定向追问。',
};

/**
 * FILE 型字段的 invalid_value_shape 专属提示，压过通用条目。通用提示的「核对后重投」
 * 对文件字段是死路：文字永远过不了附件 URL 形态门，重投只会烧掉「读不懂两次转人工」
 * 的熔断配额（生产 chat 6a9117face406a6aee7f99c9：候选人打字填「上传简历」，模型
 * 按通用提示同轮重投，一轮熔断转人工）。正确动作只有一个：让候选人把文件发过来。
 */
const FILE_SHAPE_HINT =
  '该字段是文件字段，只能录入候选人真实发来的附件链接（候选人发文件/图片后，消息里会出现「简历附件：URL」标注行，用那个 URL 提交）。' +
  '文字描述无法作为它的值，不要原样重投；请明确告诉候选人：这一项需要直接把简历文件或简历截图/照片发过来，打字发文字没法录入。';

/**
 * 面试时间语义族封闭词表（NFKC + 去空白后整串匹配）。生产回放 2026-08-26：5% 可判定答案
 * 把候选人期望面试时间误投成 labelTitle「面试时间」，定位失败静默丢弃，可约性校验从未运行。
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
    // 生产实证（0831，chat 6a8e4e2c… job 524240）：契约只有 5 个字段，模型每轮都额外
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
      execute: async ({ jobId, requestedDate, fieldValueProposals, recapConfirmation }) => {
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
                ? '先调用 duliday_job_list 召回真实岗位，再用返回的 jobId 调本工具。'
                : `只能使用本会话召回过的 jobId：${recalled.join('、')}；都不合适就重新召回，禁止猜数字。`,
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
            fieldValueProposals,
            recapConfirmation,
            hasExplicitRequestedDate: Boolean(requestedDate?.trim()),
            messages: evidenceMessages,
          });

          const rawScheduleRequest = requestedDate?.trim() || formRun.divertedRequestedDate;
          const normalizedScheduleRequest = normalizeRequestedDate(rawScheduleRequest);
          const requestedDateFromExactTime = rawScheduleRequest?.match(/^\d{4}-\d{2}-\d{2}/u)?.[0];
          const explicitRequestedDate =
            normalizedScheduleRequest.date ?? requestedDateFromExactTime ?? undefined;
          const effectiveRequestedDate =
            explicitRequestedDate ?? formRun.form.scheduleDraft?.requestedDate ?? null;
          const bookableSlots = interviewTimeWaitNotice
            ? []
            : buildBookableSlots({ windows, requestedDate: effectiveRequestedDate });
          const candidateTexts = extractCandidateTexts(evidenceMessages);
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
              ? evaluateRequestedDate({ date: effectiveRequestedDate, windows })
              : null;
          const rejection = renderRejection({
            form: formRun.form,
            contract: formRun.contract,
            fieldsAnsweredThisTurn: formRun.result.answeredThisTurn,
          });
          const scheduleRule = interviewTimeWaitNotice ? '' : buildScheduleRule(windows);
          const upcomingTimeOptions = interviewTimeWaitNotice
            ? []
            : buildUpcomingTimeOptions(windows);

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
                    instruction:
                      '只发 candidateMessage，不自行增删字段；候选人确认或纠正后重新调用 precheck。',
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
  fieldValueProposals?: readonly FieldValueProposalInput[];
  recapConfirmation?: RecapConfirmationInput;
  hasExplicitRequestedDate: boolean;
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

  const intake = intakeFieldValueProposals({
    contract: mapped.fields,
    fieldValueProposals: params.fieldValueProposals,
    hasExplicitRequestedDate: params.hasExplicitRequestedDate,
  });
  if (intake.divertedRequestedDate) {
    logger.log(
      `[precheck] 字段值提案中的面试时间条目转运为 requestedDate=${intake.divertedRequestedDate}: jobId=${params.jobId}`,
    );
  }

  const scope = {
    corpId: params.context.session.corpId,
    userId: params.context.session.userId,
    botUserId,
    jobId: params.jobId,
  };
  let form = await params.deps.collectionForms.loadOrCreate(scope, mapped.fields);
  if (mapped.fields.length === 0) {
    form = escalate(form, EMPTY_CONTRACT_ESCALATION_REASON);
    logger.warn(`[precheck] 岗位返回空标签契约，按数据异常转人工: jobId=${params.jobId}`);
    params.deps.observer?.emit({
      type: 'collection_empty_contract',
      userId: params.context.session.userId,
      jobId: params.jobId,
    });
  }

  const candidateTexts = extractCandidateTexts(params.messages);
  const corrections = intake.proposals
    .filter((answer) => answer.operation === 'correct' || answer.operation === 'clear')
    .filter(
      (answer) =>
        Boolean(answer.quote) &&
        candidateTexts.some((text) => normalizedIncludes(text, answer.quote ?? '')),
    )
    .map((answer) => findFieldByTitle(mapped.fields, answer.labelTitle)?.labelId)
    .filter((labelId): labelId is number => labelId !== undefined);
  if (corrections.length > 0 && form.lastRecap) {
    form = applyRecapResult(form, { corrections });
  }

  const recapBinding = params.recapConfirmation
    ? verifyRecapConfirmationBinding({
        form,
        contract: mapped.fields,
        recapRequired: needsRecap(form),
        candidateTexts,
        messages: params.messages,
        candidateQuote: params.recapConfirmation.candidateQuote,
        recapQuote: params.recapConfirmation.recapQuote,
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
    contract: mapped.fields,
    candidateTexts,
    messages: params.messages,
    fieldValueProposals: intake.proposals,
    archiveFacts: selectArchiveFacts(
      params.context.archive.sessionFacts?.interview_info as Record<string, unknown> | null,
    ),
    askThisTurn: !recapAffirmed,
    askReceiptTurnId: params.context.session.turnId,
  });

  await params.deps.collectionForms.saveFinalizedProgressFacts(
    { ...scope, sessionId: params.context.session.sessionId },
    result.form,
    mapped.fields,
    result.answeredThisTurn,
  );

  const phoneField = mapped.fields.find((field) => field.systemField === 'phone');
  const phoneValue = phoneField ? result.form.slots[phoneField.labelId]?.value?.value : null;
  let persisted = phoneValue
    ? await params.deps.collectionForms.rebindToPhone(scope, result.form, phoneValue)
    : result.form;

  let recapText: string | undefined;
  if (verdictOf(persisted) === 'ready' && needsRecap(persisted) && !persisted.lastRecap) {
    const recap = renderRecap(persisted, mapped.fields);
    persisted = recap.form;
    recapText = recap.text ?? undefined;
  } else if (
    recapConfirmationRejection === 'recap_snapshot_mismatch' &&
    verdictOf(persisted) === 'ready'
  ) {
    // 在案复述从未按官方文本送达——给出同一快照的官方文案供照发重投，走出确认死锁。
    recapText = renderRecapRedeliveryText(persisted, mapped.fields) ?? undefined;
  }
  await params.deps.collectionForms.persist(scope, persisted);
  emitAudits(params.deps, params.context, params.jobId, result.audits);

  return {
    form: persisted,
    contract: mapped.fields,
    result: { ...result, form: persisted, verdict: verdictOf(persisted) },
    recapText,
    verdict: verdictOf(persisted),
    divertedRequestedDate: intake.divertedRequestedDate,
    unmatchedAnswers: intake.unmatched,
    rejectedAnswers: collectRejectedAnswers(result.audits, mapped.fields),
    recapConfirmationRejection,
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
    const hint =
      field?.fieldType === 'FILE' && audit.reason === 'invalid_value_shape'
        ? FILE_SHAPE_HINT
        : REJECTION_HINTS[audit.reason];
    if (!field || !hint) continue;
    const key = `${field.labelTitle}:${audit.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rejected.push({ labelTitle: field.labelTitle, reason: audit.reason, hint });
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
      const rejectedNote =
        run.rejectedAnswers.length > 0
          ? ` 注意：${run.rejectedAnswers.map((item) => item.labelTitle).join('、')} 这几项你提交的答案被公证退回了，原因与改法见 rejectedAnswers——先按 hint 改投，候选人已经答过的不要再问一遍。`
          : '';
      return `${COLLECTION_TEMPLATE_SEND_INSTRUCTION} 只缺：${run.result.askableFields.join('、') || run.result.template.missingFields.join('、')}；已 filled 字段禁止重复问。${rejectedNote}`;
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
      return '候选人资料已经授权，但当前没有实时有效的预约时段。只让候选人从 interview.bookableSlots 选择具体时间；保留已收资料，不得重新收资或签发 booking。';
    case 'screening_rejected':
      return '停止收资与 booking，只按 rejection.candidateMessage 承接；不得披露内部受限原因。';
    case 'handoff':
      return `表单已转人工：${run.form.escalatedReason ?? 'unknown'}。停止发问并调用 request_handoff。`;
    case 'ready_to_book':
      return '候选人资料已授权，且非 wait_notice 岗位的预约草稿已通过本轮实时复验。可以调用 duliday_interview_booking；只有 booking success=true 后才能说已报名。';
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
  return matched.length === 1 ? matched[0].interviewTime : undefined;
}

function emitAudits(
  deps: PrecheckAdjudicationDeps,
  context: Parameters<ToolBuilder>[0],
  jobId: number,
  audits: readonly CollectionAuditEvent[],
): void {
  for (const audit of audits) {
    deps.observer?.emit({
      type: 'collection_form_audit',
      userId: context.session.userId,
      jobId,
      kind: audit.kind,
      labelId: audit.labelId,
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

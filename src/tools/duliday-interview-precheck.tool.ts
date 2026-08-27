import { toErrorMessage } from '@infra/utils/error.util';
import type { CollectionFormService } from '@tools/collection/collection-form.service';
import { Logger } from '@nestjs/common';
import {
  applyRecapResult,
  escalate,
  mapContractFields,
  parseIdentityAnchors,
  verdictOf,
  type BookingCollectionForm,
  type ContractFieldDef,
  type Verdict,
} from '@resolution/collection';
import { normalizedIncludes } from '@resolution/evidence/normalize';
import { selectEvidenceDialogueMessages } from '@resolution/signal/corpus';
import { extractCandidateTexts } from '@resolution/signal/self-report';
import { isAffirmativeAnswerSequence, normalizeShortAnswer } from '@resolution/signal/dialogue';
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
import { FormAnswersInputSchema, type FormAnswerInput } from '@tools/collection/form-answer-input';
import { renderRecap } from '@tools/collection/recap-renderer';
import { renderRejection } from '@tools/collection/rejection-renderer';
import {
  buildBookableSlots,
  buildScheduleRule,
  buildUpcomingTimeOptions,
  evaluateRequestedDate,
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

/** description 与每次回执共用这一条照发指令，避免模型同时看到两套标签/模板口径。 */
export const COLLECTION_TEMPLATE_SEND_INSTRUCTION =
  '逐字照发 bookingChecklist.templateText，不得改写、增删、重排任何标签或行；不要另起一套收资清单。';

// 程序记忆层（procedural memory）工具绑定规则；总目录：docs/prompt-rule-ledger.md
export const PRECHECK_DESCRIPTION = `面试前置校验。实时读取岗位收资契约，推进候选人 × 岗位的持久表单，并返回可约时段。

参数纪律：
- jobId 必须来自本会话最近一次 duliday_job_list 的真实召回。
- requestedDate 只在候选人明确提出日期时传；不确定就不传。候选人的期望面试时间/日期只走本参数、不得写成 formAnswers 条目；定位失败的 formAnswers 条目会在返回的 unmatchedAnswers 中附纠正提示。
- formAnswers 是唯一收资答案入口；每项 labelTitle 必须逐字取自 bookingChecklist.requiredFields，value 传规范值，quote 传候选人原话。纠正用 correct、清除用 clear、确认用 confirm + 必要的 agentQuestionQuote；文件 value 传候选人真实附件 URL。
- formAnswers 只能填写实时契约已有槽位，不能增删字段，也不能控制 requiredFields 及其顺序。不得传岗位要求冒充候选人答案，不得补造字段或沿用旧 candidateXxx 裸参数。

行动纪律：
- collect_fields：只收 bookingChecklist.requiredFieldsToCollectNow。${COLLECTION_TEMPLATE_SEND_INSTRUCTION}
- confirm_collection：照发 recap.candidateMessage；候选人确认或纠正后重新调用本工具。
- screening_rejected：只使用 rejection.candidateMessage，不自行披露内部筛选原因。
- handoff：停止收资并转人工。
- ready_to_book：才允许调用 duliday_interview_booking；booking 成功前禁止声称已报名。
- already_submitted：停止重复提交。`;

export const PRECHECK_INPUT_SCHEMA = z.object({
  jobId: z.coerce.number().int().positive().describe('岗位 ID，必须来自本会话真实召回'),
  requestedDate: z
    .string()
    .optional()
    .describe('候选人明确提出的面试日期，如 明天、下周三、2026-08-25'),
  formAnswers: FormAnswersInputSchema.optional().describe(
    '唯一收资答案入口：labelTitle=实时契约标题原文，value=规范值，quote=候选人原话或真实附件 URL',
  ),
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
  recapAffirmed: boolean;
  verdict: Verdict;
  /** 误投 formAnswers 的期望面试日期，转运成功后作为本次 requestedDate（显式参数优先）。 */
  divertedRequestedDate?: string;
  /** labelTitle 定位失败/撞车弃权/面试时间族解析失败的条目——模型可见的纠错回执。 */
  unmatchedAnswers: UnmatchedAnswer[];
}

interface UnmatchedAnswer {
  labelTitle: string;
  hint: string;
}

/**
 * 面试时间语义族封闭词表（NFKC + 去空白后整串匹配）。生产回放 2026-08-26：5% 可判定答案
 * 把候选人期望面试时间误投成 labelTitle「面试时间」，定位失败静默丢弃，可约性校验从未运行。
 * 只有**定位不到契约槽位**的条目才进本词表判定——真契约字段永远优先。
 */
const INTERVIEW_TIME_TITLE_PATTERN =
  /^(?:(?:期望|意向|预约)?面试(?:时间段|时间|日期)|预约(?:时间|日期)|到[面店](?:时间|日期)|想约的?时间)$/u;

const LABEL_TITLE_HINT = 'labelTitle 必须逐字取自 bookingChecklist.requiredFields';

interface FormAnswerIntake {
  answers: FormAnswerInput[];
  divertedRequestedDate?: string;
  unmatched: UnmatchedAnswer[];
}

/**
 * formAnswers 进收资核前的定向分流：
 * - 面试时间语义族 + 本次未显式传 requestedDate + 值可解析 → 转运为 requestedDate 并移出答案；
 *   解析失败**不**升级为 PRECHECK_INVALID_REQUESTED_DATE（那会把原本成功的调用变失败）；
 * - 其余定位失败条目原样传给收资核（既有 collection_form_audit 审计面不变），
 *   同时汇成 unmatchedAnswers 让模型在工具返回里直接看到失败原因并自我纠正。
 */
function intakeFormAnswers(params: {
  contract: readonly ContractFieldDef[];
  formAnswers?: readonly FormAnswerInput[];
  hasExplicitRequestedDate: boolean;
}): FormAnswerIntake {
  const answers: FormAnswerInput[] = [];
  const unmatched: UnmatchedAnswer[] = [];
  let divertedRequestedDate: string | undefined;

  for (const answer of params.formAnswers ?? []) {
    const resolution = resolveFieldByTitle(params.contract, answer.labelTitle);
    if (resolution.field) {
      answers.push(answer);
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
      answers.push(answer);
      unmatched.push({
        labelTitle: answer.labelTitle,
        hint: alreadyHasDate
          ? '面试时间不是收资字段，本次已以 requestedDate 参数为准；期望面试日期一律走 requestedDate 参数传入'
          : `面试时间不是收资字段，且「${value}」无法解析为日期；与候选人确认具体日期后改用 requestedDate 参数传入`,
      });
      continue;
    }

    answers.push(answer);
    unmatched.push({
      labelTitle: answer.labelTitle,
      hint:
        resolution.reason === 'label_title_ambiguous'
          ? `该标题在本岗契约命中多个字段、已放弃写入；${LABEL_TITLE_HINT}`
          : `该标题不在本岗契约；${LABEL_TITLE_HINT}`,
    });
  }

  return { answers, divertedRequestedDate, unmatched };
}

type PrecheckAction =
  | 'collect_fields'
  | 'confirm_collection'
  | 'screening_rejected'
  | 'handoff'
  | 'ready_to_book'
  | 'already_submitted'
  | 'confirm_date'
  | 'date_unavailable';

export function buildInterviewPrecheckTool(
  spongeService: SpongeService,
  opsEventsRecorder: OpsEventsRecorderService,
  deps?: PrecheckAdjudicationDeps,
): ToolBuilder {
  return (context) =>
    tool({
      description: PRECHECK_DESCRIPTION,
      inputSchema: PRECHECK_INPUT_SCHEMA,
      execute: async ({ jobId, requestedDate, formAnswers }) => {
        if (!deps?.collectionForms) {
          return buildToolError({
            errorType: TOOL_ERROR_TYPES.PRECHECK_FAILED,
            outcome: '收资表单服务不可用',
            replyInstruction: '停止收资并调用 request_handoff 转人工，禁止回退到旧报名字段。',
            details: { jobId },
          });
        }

        const normalizedDate = normalizeRequestedDate(requestedDate);
        if (normalizedDate.error) {
          return buildToolError({
            errorType: TOOL_ERROR_TYPES.PRECHECK_INVALID_REQUESTED_DATE,
            outcome: '前置校验失败（日期非法）',
            replyInstruction: '先和候选人确认具体日期，再用候选人确认后的原话重新调用。',
            details: { detailedReason: normalizedDate.error },
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
            formAnswers,
            hasExplicitRequestedDate: Boolean(normalizedDate.date),
            messages: evidenceMessages,
          });

          // 误投 formAnswers 的期望面试日期经转运后与显式参数同权参加可约性校验；显式参数优先。
          const effectiveRequestedDate =
            normalizedDate.date ?? formRun.divertedRequestedDate ?? null;
          const requestedDateCheck =
            !interviewTimeWaitNotice && effectiveRequestedDate
              ? evaluateRequestedDate({ date: effectiveRequestedDate, windows })
              : null;

          let nextAction = actionForForm(formRun);
          if (
            (nextAction === 'ready_to_book' || nextAction === 'confirm_collection') &&
            requestedDateCheck?.status === 'unavailable'
          ) {
            nextAction = 'date_unavailable';
          } else if (
            nextAction === 'ready_to_book' &&
            requestedDateCheck?.status === 'needs_confirmation'
          ) {
            nextAction = 'confirm_date';
          }

          const rejection = renderRejection({
            form: formRun.form,
            contract: formRun.contract,
            fieldsAnsweredThisTurn: formRun.result.answeredThisTurn,
          });
          const bookableSlots = interviewTimeWaitNotice
            ? []
            : buildBookableSlots({ windows, requestedDate: effectiveRequestedDate });
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
            _replyInstruction: replyInstruction(nextAction, formRun, requestedDateCheck?.reason),
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
  formAnswers?: readonly FormAnswerInput[];
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

  const intake = intakeFormAnswers({
    contract: mapped.fields,
    formAnswers: params.formAnswers,
    hasExplicitRequestedDate: params.hasExplicitRequestedDate,
  });
  if (intake.divertedRequestedDate) {
    logger.log(
      `[precheck] formAnswers 面试时间条目转运为 requestedDate=${intake.divertedRequestedDate}: jobId=${params.jobId}`,
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
  const corrections = intake.answers
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

  const latestCandidateText = candidateTexts.at(-1) ?? '';
  const recapAffirmed = Boolean(
    form.lastRecap &&
      corrections.length === 0 &&
      isAffirmativeAnswerSequence(normalizeShortAnswer(latestCandidateText)),
  );
  if (recapAffirmed) form = applyRecapResult(form, { affirmed: true });

  const result = runCollectionCore({
    form,
    contract: mapped.fields,
    candidateTexts,
    messages: params.messages,
    formAnswers: intake.answers,
    archiveFacts: selectArchiveFacts(
      params.context.archive.sessionFacts?.interview_info as Record<string, unknown> | null,
    ),
    askThisTurn: !recapAffirmed,
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
  if (verdictOf(persisted) === 'ready' && (!persisted.lastRecap || corrections.length > 0)) {
    const recap = renderRecap(persisted, mapped.fields);
    persisted = recap.form;
    recapText = recap.text ?? undefined;
  }
  await params.deps.collectionForms.persist(scope, persisted);
  emitAudits(params.deps, params.context, params.jobId, result.audits);

  return {
    form: persisted,
    contract: mapped.fields,
    result: { ...result, form: persisted, verdict: verdictOf(persisted) },
    recapText,
    recapAffirmed,
    verdict: verdictOf(persisted),
    divertedRequestedDate: intake.divertedRequestedDate,
    unmatchedAnswers: intake.unmatched,
  };
}

function actionForForm(run: FormRun): PrecheckAction {
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
      return run.recapAffirmed ? 'ready_to_book' : 'confirm_collection';
  }
}

function replyInstruction(
  action: PrecheckAction,
  run: FormRun,
  requestedDateReason?: string,
): string {
  switch (action) {
    case 'collect_fields':
      return `${COLLECTION_TEMPLATE_SEND_INSTRUCTION} 只缺：${run.result.askableFields.join('、') || run.result.template.missingFields.join('、')}；已 filled 字段禁止重复问。`;
    case 'confirm_collection':
      return run.recapText
        ? '资料已收齐。只发送 recap.candidateMessage，等待候选人确认；确认前禁止 booking。'
        : '已发过提交前复述但尚未得到明确确认。只简短请候选人确认或指出哪项要改，禁止重发整张收资表。';
    case 'screening_rejected':
      return '停止收资与 booking，只按 rejection.candidateMessage 承接；不得披露内部受限原因。';
    case 'handoff':
      return `表单已转人工：${run.form.escalatedReason ?? 'unknown'}。停止发问并调用 request_handoff。`;
    case 'ready_to_book':
      return '候选人已确认提交前复述，可以调用 duliday_interview_booking。只有 booking success=true 后才能说已报名。';
    case 'already_submitted':
      return `当前表单已提交（工单 ${run.form.workOrderId ?? 'unknown'}），禁止重复 booking。`;
    case 'confirm_date':
      return `资料已确认，但面试日期仍需人工确认：${requestedDateReason ?? ''}。确认前禁止 booking。`;
    case 'date_unavailable':
      return `候选人请求的日期不可约：${requestedDateReason ?? ''}。请从 interview.bookableSlots 提供其它真实时段，禁止编造。`;
  }
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

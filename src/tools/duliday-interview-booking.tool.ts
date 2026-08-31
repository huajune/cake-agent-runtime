/**
 * 面试预约提交边界。
 *
 * booking 不再接收候选人裸字段：唯一取数口是 precheck 已办结并完成资料授权的
 * BookingCollectionForm，唯一外发形状是 `{ jobId, interviewTime?, labelList }`。
 */

import type { OpsEventsRecorderService } from '@biz/ops-events/services/ops-events-recorder.service';
import type { UserHostingService } from '@biz/user/services/user-hosting.service';
import { toErrorMessage } from '@infra/utils/error.util';
import type { CollectionFormService } from '@tools/collection/collection-form.service';
import type { LongTermService } from '@memory/long-term/long-term.service';
import type { SessionStateService } from '@memory/short-term/session-state.service';
import { sessionFactValue } from '@memory/short-term/short-term.types';
import type { ActiveBookingEntry } from '@memory/long-term/long-term.types';
import { Logger } from '@nestjs/common';
import type { PrivateChatMonitorNotifierService } from '@notification/services/private-chat-monitor-notifier.service';
import {
  applyErrorList,
  escalate,
  isSubmissionAuthorized,
  mapContractFields,
  markSubmitted,
  parseIdentityAnchors,
  verdictOf,
  type BookingCollectionForm,
  type ContractFieldDef,
} from '@resolution/collection';
import type { InterviewBookingLabelValue, JobDetail } from '@sponge/sponge.types';
import type { SpongeService } from '@sponge/sponge.service';
import type { ToolBuildContext, ToolBuilder } from '@shared-types/tool.types';
import {
  buildOnSiteScript,
  formatInterviewTimeForReply,
  isOnlineInterview,
  resolveManualInterviewGroupHandling,
} from '@tools/booking/booking-reply-format.util';
import { runBookingScheduleAndNameGuards } from '@tools/booking/booking-guards.util';
import { isTestPiiPhoneAllowed, maskPhoneForDetails } from '@tools/shared/test-pii-gate';
import { buildJobPolicyAnalysis, isWaitNoticeInterview } from '@tools/job-list/job-policy-parser';
import { buildSpongeTokenContext } from '@tools/shared/sponge-token-context.util';
import {
  buildToolError,
  STALE_INPUT_SHORT_CIRCUIT,
  TOOL_ERROR_TYPES,
} from '@tools/shared/tool-error-types';
import { tool } from 'ai';
import { z } from 'zod';

const logger = new Logger('duliday_interview_booking');
const INTERVIEW_TIME_REGEX = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u;
const BOOKING_DEDUP_WINDOW_MS = 30 * 60 * 1000;

// 程序记忆层（procedural memory）工具绑定规则；总目录：docs/prompt-rule-ledger.md
const DESCRIPTION = `提交面试报名。候选人资料全部来自已授权的收资表单，本工具只接收 jobId 与可选 interviewTime。

调用前必须在**本轮**调用 duliday_interview_precheck 并得到 nextAction=ready_to_book；其它 action 一律禁止 booking。
- 有面试时段的岗位：interviewTime 必须逐字取自 precheck 的 bookableSlots，格式 YYYY-MM-DD HH:mm:ss。
- wait_notice 岗位：不要传 interviewTime。
- 不得传姓名、手机号、年龄、性别或补充标签；这些值只能由持久表单生成 labelList。
- booking success=true 前禁止声称已报名。`;

const inputSchema = z.object({
  jobId: z.coerce.number().int().positive().describe('本轮 precheck 已确认可提交的岗位 ID'),
  interviewTime: z
    .string()
    .regex(INTERVIEW_TIME_REGEX)
    .optional()
    .describe('precheck 返回的可提交面试时间；wait_notice 岗位不传'),
});

export interface BookingAdjudicationDeps {
  collectionForms?: CollectionFormService;
  sessionFacts?: SessionStateService;
  identityAnchors?: string;
}

export function buildInterviewBookingTool(
  spongeService: SpongeService,
  privateChatNotifier: PrivateChatMonitorNotifierService,
  userHostingService: UserHostingService,
  longTermService: LongTermService,
  opsEventsRecorder: OpsEventsRecorderService,
  deps?: BookingAdjudicationDeps,
): ToolBuilder {
  return (context) =>
    tool({
      description: DESCRIPTION,
      inputSchema,
      execute: async ({ jobId, interviewTime }) => {
        const fail = <T extends Record<string, unknown>>(result: T): T => {
          context.ledger.jobs.bookingSucceeded = false;
          return result;
        };

        if (!deps?.collectionForms) {
          return fail(
            buildToolError({
              errorType: TOOL_ERROR_TYPES.BOOKING_REJECTED,
              outcome: '预约未提交（收资表单服务不可用）',
              replyInstruction: '停止重试并调用 request_handoff，禁止回退到旧报名字段。',
              details: { jobId },
            }),
          );
        }
        if (context.archive.isRecalledJobId && !context.archive.isRecalledJobId(jobId)) {
          return fail({
            ...buildToolError({
              errorType: TOOL_ERROR_TYPES.BOOKING_JOB_NOT_PROVIDED,
              outcome: '预约拦截（jobId 无召回出处）',
              replyInstruction:
                'runtime 已短路本轮，禁止继续生成回复或调用其他工具；该会话需要人工确认 jobId 来源。' +
                ((context.archive.recalledJobIds ?? []).length === 0
                  ? '本会话还没有通过 duliday_job_list 召回过任何岗位，当前 jobId 没有合法来源，禁止凭空 booking。'
                  : `当前 jobId=${jobId} 不在本会话召回过的岗位里（合法的只有：${(
                      context.archive.recalledJobIds ?? []
                    ).join('、')}），禁止凭空 booking。`) +
                '先调 duliday_job_list 召回岗位拿真实 jobId，再走 duliday_interview_precheck，nextAction=ready_to_book 后才能调本工具。',
              details: { jobId, recalledJobIds: context.archive.recalledJobIds ?? [] },
            }),
            shortCircuited: true,
            gateRejected: true,
            reasonCode: 'job_id_not_recalled',
          });
        }
        if (context.ledger.jobs.collectionReadyJobId !== jobId) {
          return fail(
            buildToolError({
              errorType: TOOL_ERROR_TYPES.BOOKING_REJECTED,
              outcome: '预约未提交（本轮没有已确认的 precheck 凭据）',
              replyInstruction:
                '先调用 duliday_interview_precheck。只有资料已授权、非 wait_notice 岗位的时间草稿实时可约且工具返回 ready_to_book 后，才能在同一轮调用 booking。',
              details: { jobId },
            }),
          );
        }

        const botUserId = context.session.botUserId?.trim();
        if (!botUserId) {
          return fail(
            buildToolError({
              errorType: TOOL_ERROR_TYPES.BOOKING_REJECTED,
              outcome: '预约未提交（缺少稳定托管账号身份）',
              replyInstruction:
                '停止重试并调用 request_handoff，禁止在 bot 身份缺失时读写收资表单。',
              details: { jobId },
            }),
          );
        }

        const tokenContext = buildSpongeTokenContext(context);
        const scope = {
          corpId: context.session.corpId,
          userId: context.session.userId,
          botUserId,
          sessionId: context.session.sessionId,
          jobId,
        };
        let committedBookingFallback: Record<string, unknown> | null = null;

        try {
          const rawContract = await spongeService.fetchJobCollectionContract(jobId, tokenContext);
          const mapped = mapContractFields(rawContract, parseIdentityAnchors(deps.identityAnchors));
          const form = await deps.collectionForms.loadOrCreate(scope, mapped.fields);
          const verdict = verdictOf(form);
          if (verdict !== 'ready') {
            return fail(
              buildToolError({
                errorType: TOOL_ERROR_TYPES.BOOKING_REJECTED,
                outcome: `预约未提交（收资表单状态=${verdict}）`,
                replyInstruction:
                  '回到 duliday_interview_precheck，按其 nextAction 继续收资、确认外部预填、选择时间或转人工；禁止绕过表单提交。',
                details: { jobId, verdict },
              }),
            );
          }

          const identity = readIdentity(form, mapped.fields);
          if (!identity.name || !identity.phone || !identity.age || !identity.gender) {
            const blocked = escalate(form, 'booking_identity_anchor_unavailable');
            await deps.collectionForms.persist(scope, blocked);
            return fail(
              buildToolError({
                errorType: TOOL_ERROR_TYPES.BOOKING_REJECTED,
                outcome: '预约未提交（身份标签无法定位）',
                replyInstruction:
                  '实时契约缺少可核验的姓名/电话/年龄/性别语义锚点，停止重试并调用 request_handoff 人工补录。',
                details: { jobId },
              }),
            );
          }
          assertIdentity(identity);

          if (
            context.runtime.strategySource === 'testing' &&
            !isTestPiiPhoneAllowed(identity.phone)
          ) {
            return fail(
              buildToolError({
                errorType: TOOL_ERROR_TYPES.TEST_LINK_REAL_PII_BLOCKED,
                outcome: '测试链路拦截：手机号不在测试白名单，未执行真实报名',
                replyInstruction:
                  '测试用例必须使用统一假身份（兮兮/18271421690）；不得声称已报名。',
                details: { phone: maskPhoneForDetails(identity.phone) },
              }),
            );
          }

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
            tokenContext,
          );
          const job = jobs[0];
          if (!job?.basicInfo) {
            context.ledger.markJobInvalidated?.(jobId);
            return fail(
              buildToolError({
                errorType: TOOL_ERROR_TYPES.BOOKING_REJECTED,
                outcome: '预约未提交（岗位已失效）',
                replyInstruction: '重新调用 duliday_job_list 查询在招岗位，不要重试同一 jobId。',
                details: { jobId },
              }),
            );
          }

          const analysis = buildJobPolicyAnalysis(job);
          const waitNotice = isWaitNoticeInterview(analysis);
          if (waitNotice && interviewTime) {
            return fail(
              buildToolError({
                errorType: TOOL_ERROR_TYPES.BOOKING_INVALID_INTERVIEW_TIME,
                outcome: '预约未提交（等待通知岗位不得填写面试时间）',
                replyInstruction: '去掉 interviewTime 后重新调用；不得编造具体时间。',
                details: { jobId },
              }),
            );
          }
          if (!waitNotice && !interviewTime) {
            return fail(
              buildToolError({
                errorType: TOOL_ERROR_TYPES.BOOKING_INVALID_INTERVIEW_TIME,
                outcome: '预约未提交（缺少面试时间）',
                replyInstruction:
                  '重新调用 precheck 取得 bookingAllowed=true 的时段，并在候选人确认后提交。',
                details: { jobId },
              }),
            );
          }

          const guardFailure = runBookingScheduleAndNameGuards({
            job,
            name: identity.name,
            interviewTime,
          });
          if (guardFailure) return fail(guardFailure);

          if (
            !isSubmissionAuthorized({
              form,
              waitNotice,
              interviewTime,
              interviewTimeBookingAllowed: waitNotice || Boolean(interviewTime),
            })
          ) {
            return fail(
              buildToolError({
                errorType: TOOL_ERROR_TYPES.BOOKING_REJECTED,
                outcome: '预约未提交（资料或面试时间尚未获得最终授权）',
                replyInstruction:
                  '回到 duliday_interview_precheck：外部预填资料须先确认；非 wait_notice 岗位须让候选人选择当前 bookableSlots 中的具体时间，并以同一 interviewTime 提交。',
                details: { jobId },
              }),
            );
          }

          const duplicate = (
            await longTermService.getActiveBookings(scope.corpId, scope.userId)
          ).find((entry) => isRecentSameJobBooking(entry, jobId));
          if (duplicate) {
            context.ledger.jobs.bookingSucceeded = true;
            return buildToolError({
              errorType: TOOL_ERROR_TYPES.BOOKING_ALREADY_BOOKED,
              outcome: '近期已有当前岗位的预约工单，跳过重复提交',
              replyInstruction:
                '不要重复 booking。改时间用 duliday_modify_interview_time，取消用 duliday_cancel_work_order。',
              details: { existingWorkOrderId: duplicate.work_order_id },
            });
          }

          if (context.runtime.hasNewerUserInput && (await context.runtime.hasNewerUserInput())) {
            return fail({
              ...buildToolError({
                errorType: TOOL_ERROR_TYPES.BOOKING_REJECTED,
                outcome: '预约未提交（候选人有更新消息，当前表单视图已过期）',
                replyInstruction: '立即停止，不要回复或重试；runtime 会合并最新消息重新处理。',
                details: { jobId },
              }),
              ...STALE_INPUT_SHORT_CIRCUIT,
            });
          }

          const payload = await buildLabelList({
            form,
            contract: mapped.fields,
            spongeService,
            tokenContext,
          });
          if ('errorLabelId' in payload) {
            const reopened = applyErrorList(
              form,
              [
                {
                  labelId: payload.errorLabelId,
                  field: payload.errorField,
                  msg: payload.message,
                },
              ],
              mapped.fields,
            );
            await deps.collectionForms.persist(scope, reopened);
            return fail(
              buildToolError({
                errorType: TOOL_ERROR_TYPES.BOOKING_REJECTED,
                outcome: '预约未提交（表单值无法按实时契约编码）',
                replyInstruction:
                  '对应字段已精确重开。重新调用 precheck，只补 bookingChecklist.requiredFieldsToCollectNow 返回的字段。',
                details: { labelId: payload.errorLabelId, field: payload.errorField },
              }),
            );
          }

          const result = await spongeService.bookInterview(
            { jobId, interviewTime, labelList: payload.labelList },
            tokenContext,
          );
          context.ledger.jobs.bookingSucceeded = result.success;

          const baseToolOutput = {
            ...result,
            requestInfo: {
              jobId,
              interviewTime: interviewTime ?? null,
              labelIds: payload.labelList.map((item) => item.labelId),
            },
            collectionConfigDebts: form.configDebts ?? [],
          };
          if (result.success) {
            // 外部 success=true 是不可回滚提交点。任何后处理异常都只能降级回这份成功回执，
            // 绝不能落入下方通用失败 catch 后谎报“预约失败”。
            committedBookingFallback = {
              ...baseToolOutput,
              _outcome: '预约成功，可以告知候选人资料已提交',
              _replyInstruction:
                '预约已真实成功。即使本地后处理异常，也必须告知候选人报名成功；禁止改口为预约失败。',
            };
          }

          const jobInfo = readJobInfo(job);
          const interviewType = resolveInterviewType(job);

          if (!result.success) {
            const rewritten = applyErrorList(form, result.applyErrorList ?? [], mapped.fields);
            await deps.collectionForms.persist(scope, rewritten);
            recordBookingEvent(opsEventsRecorder, context, 'booking.failed', jobId, interviewTime, {
              reason: result.message ?? null,
            });
            pauseUserHostingAsync(userHostingService, context.session.sessionId, '预约失败');

            const toolResult = {
              ...baseToolOutput,
              ...buildToolError({
                errorType: TOOL_ERROR_TYPES.BOOKING_REJECTED,
                outcome:
                  verdictOf(rewritten) === 'escalated' ? '预约失败，字段错误无法映射' : '预约失败',
                replyInstruction:
                  verdictOf(rewritten) === 'escalated'
                    ? '停止重试并调用 request_handoff；不要向候选人透露接口字段或报错。'
                    : '后端退回的字段已精确重开。回到 precheck 只补缺项；不要声称已报名。',
                details: {
                  apiCode: result.code,
                  apiMessage: result.message ?? null,
                  applyErrorList: result.applyErrorList ?? [],
                },
              }),
              hostingPaused: true,
            };
            void notifyBooking(
              privateChatNotifier,
              context,
              identity,
              jobInfo,
              interviewTime,
              interviewType,
              toolResult,
            );
            return toolResult;
          }

          let submitted: BookingCollectionForm;
          if (result.workOrderId != null) {
            submitted = markSubmitted(form, result.workOrderId);
            await runPostBookingWrite('active booking 指针写入', () =>
              longTermService.setActiveBooking(
                scope.corpId,
                scope.userId,
                result.workOrderId as number,
                { job_id: jobId },
              ),
            );
          } else {
            submitted = escalate(form, 'booking_success_missing_work_order_id');
            logger.warn('[booking] 预约成功但缺少 workOrderId，表单转人工以阻止重复提交');
          }
          await runPostBookingWrite('收资表单办结写入', () =>
            deps.collectionForms!.persist(scope, submitted),
          );

          if (result.workOrderId != null) {
            await runPostBookingWrite('会话身份事实写入', async () => {
              const formFact = (value: string, evidence: string) =>
                sessionFactValue(value, {
                  confidence: 'high',
                  source: 'candidate_quote',
                  evidence,
                  extractedAt: new Date().toISOString(),
                });
              await deps.sessionFacts?.saveCompletedCollectionFacts(
                scope.corpId,
                scope.userId,
                scope.sessionId,
                {
                  name: formFact(identity.name, '收资表单办结：姓名'),
                  phone: formFact(identity.phone, '收资表单办结：手机号'),
                  age: formFact(identity.age, '收资表单办结：年龄'),
                  gender: sessionFactValue(identity.gender, {
                    confidence: 'high',
                    source: 'system',
                    evidence: '收资表单办结：性别',
                    extractedAt: new Date().toISOString(),
                  }),
                },
              );
            });
            const botUserId = context.session.botUserId?.trim();
            if (botUserId) {
              await runPostBookingWrite('长期身份档案写入', () =>
                longTermService.writeFromBooking(
                  scope.corpId,
                  scope.userId,
                  botUserId,
                  {
                    name: identity.name,
                    phone: identity.phone,
                    age: Number(identity.age),
                    gender: identity.gender,
                    jobId,
                    workOrderId: result.workOrderId as number,
                  },
                  { sessionId: scope.sessionId, botImId: context.session.botImId },
                ),
              );
            }
          }
          recordBookingEvent(
            opsEventsRecorder,
            context,
            'booking.succeeded',
            jobId,
            interviewTime,
            {
              work_order_id: result.workOrderId ?? null,
              candidate_name: identity.name,
              phone: identity.phone,
              candidate_age: Number(identity.age),
              candidate_gender: identity.gender,
              brand_name: jobInfo.brandName,
              store_name: jobInfo.storeName,
              job_name: jobInfo.jobName,
            },
            result.workOrderId,
          );

          const manualGroup = resolveManualInterviewGroupHandling({
            interviewRemark: analysis.normalizedRequirements.interviewRemark,
            flowDescription: analysis.interviewMeta.demand,
          });
          const online = isOnlineInterview({
            interviewType,
            interviewRemark: analysis.normalizedRequirements.interviewRemark,
            flowDescription: analysis.interviewMeta.demand,
          });
          const toolResult = {
            ...baseToolOutput,
            _outcome: '预约成功，可以告知候选人面试安排',
            _replyInstruction:
              '本轮必须明确告诉候选人报名成功，并照实复述面试安排；不得静默或只回答其它问题。',
            _confirmedInterviewTimeHuman: interviewTime
              ? formatInterviewTimeForReply(interviewTime)
              : '未指定面试时间：面试官会直接电话联系候选人确认',
            ...(interviewTime && !online
              ? {
                  _onSiteScript: buildOnSiteScript({
                    candidateName: identity.name,
                    jobName: jobInfo.jobName,
                  }),
                }
              : {}),
            ...(online
              ? {
                  _onlineInterviewGuide:
                    '本轮不需要到店；按 precheck 的流程说明提醒候选人留意线上/电话面试通知。',
                }
              : {}),
            ...(!interviewTime
              ? {
                  _waitNoticeReplyGuide:
                    '告知候选人资料已提交，面试官会电话联系；请保持电话畅通，禁止编造时间。',
                }
              : {}),
            ...(manualGroup
              ? {
                  interviewGroupHandling: manualGroup,
                  sideEffect: {
                    kind: 'general_handoff' as const,
                    source: 'agent_tool' as const,
                    alertLabel: '预约成功待补发面试群',
                    reasonCode: 'interview_group_invite_required',
                    reason: '预约成功，岗位流程要求使用当前企微账号手动补发面试群邀请。',
                    actionAdvice: manualGroup.candidateGuide,
                    workOrderId: result.workOrderId ?? null,
                    jobId,
                    idempotencyKey: `${context.session.sessionId}:interview_group_invite:${result.workOrderId ?? jobId}`,
                    recordHandoff: true,
                  },
                }
              : {}),
          };
          if (!manualGroup) {
            void notifyBooking(
              privateChatNotifier,
              context,
              identity,
              jobInfo,
              interviewTime,
              interviewType,
              toolResult,
            );
          }
          return toolResult;
        } catch (error) {
          if (committedBookingFallback) {
            logger.error(
              `[booking] 外部预约已成功，回执后处理异常（保持成功口径）: ${toErrorMessage(error)}`,
            );
            context.ledger.jobs.bookingSucceeded = true;
            return committedBookingFallback;
          }
          logger.error(`预约面试失败: ${toErrorMessage(error)}`);
          context.ledger.jobs.bookingSucceeded = false;
          recordBookingEvent(opsEventsRecorder, context, 'booking.failed', jobId, interviewTime, {
            reason: toErrorMessage(error),
          });
          pauseUserHostingAsync(userHostingService, context.session.sessionId, '预约异常');
          return {
            ...buildToolError({
              errorType: TOOL_ERROR_TYPES.BOOKING_REQUEST_FAILED,
              outcome: '预约失败',
              replyInstruction:
                '用真人招募者口吻简短说明会让同事确认，并停止继续推进；不要透露接口错误。',
              details: { jobId, reason: toErrorMessage(error) },
            }),
            hostingPaused: true,
          };
        }
      },
    });
}

function readIdentity(
  form: BookingCollectionForm,
  contract: readonly ContractFieldDef[],
): Partial<Record<'name' | 'phone' | 'age' | 'gender', string>> {
  const identity: Partial<Record<'name' | 'phone' | 'age' | 'gender', string>> = {};
  for (const field of contract) {
    if (!field.systemField) continue;
    const slot = form.slots[field.labelId];
    if (slot?.state === 'filled' && slot.value?.value) {
      identity[field.systemField] = slot.value.value;
    }
  }
  return identity;
}

async function buildLabelList(params: {
  form: BookingCollectionForm;
  contract: readonly ContractFieldDef[];
  spongeService: SpongeService;
  tokenContext: ReturnType<typeof buildSpongeTokenContext>;
}): Promise<
  | { labelList: InterviewBookingLabelValue[] }
  | { errorLabelId: number; errorField: string; message: string }
> {
  const labelList: InterviewBookingLabelValue[] = [];
  for (const field of params.contract) {
    const slot = params.form.slots[field.labelId];
    if (slot?.state !== 'filled' || !slot.value) {
      return {
        errorLabelId: field.labelId,
        errorField: field.labelTitle,
        message: '槽位未填',
      };
    }
    if (field.fieldType === 'SINGLE_OPTION' || field.fieldType === 'MULTIPLE_OPTION') {
      if (!slot.value.optionCodes?.length) {
        return {
          errorLabelId: field.labelId,
          errorField: field.labelTitle,
          message: '选项字段缺 optionCodes',
        };
      }
      labelList.push({
        labelId: field.labelId,
        options: slot.value.optionCodes.map((optionCode) => ({ optionCode })),
      });
      continue;
    }

    let value = slot.value.value;
    if (field.fieldType === 'FILE' && /^https?:\/\//iu.test(value)) {
      const upload = await params.spongeService.uploadAttachmentFromUrl(
        { fileUrl: value },
        params.tokenContext,
      );
      value = upload.cloudStorageKey;
    }
    if (!value.trim()) {
      return {
        errorLabelId: field.labelId,
        errorField: field.labelTitle,
        message: '文本字段为空',
      };
    }
    labelList.push({ labelId: field.labelId, value });
  }
  return { labelList };
}

function isRecentSameJobBooking(entry: ActiveBookingEntry, jobId: number): boolean {
  const linkedAt = Date.parse(entry.linked_at);
  return (
    Number.isFinite(linkedAt) &&
    Date.now() - linkedAt < BOOKING_DEDUP_WINDOW_MS &&
    (entry.job_id == null || entry.job_id === jobId)
  );
}

function pauseUserHostingAsync(service: UserHostingService, chatId: string, reason: string): void {
  void service
    .pauseUser(chatId, { source: 'interview_booking', reason })
    .catch((error: unknown) => logger.error(`[booking] 暂停托管失败: ${toErrorMessage(error)}`));
}

/**
 * 海绵已返回 success=true 后，外部工单已是不可回滚事实。后续本地/记忆写入失败
 * 必须告警并交给修复机制，不能穿透到外层 catch 将真实成功改口为“预约失败”。
 */
async function runPostBookingWrite(
  label: string,
  operation: () => Promise<unknown>,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    logger.error(`[booking] 工单已创建，${label}失败（不回滚预约）: ${toErrorMessage(error)}`);
  }
}

function recordBookingEvent(
  recorder: OpsEventsRecorderService,
  context: ToolBuildContext,
  eventName: 'booking.failed' | 'booking.succeeded',
  jobId: number,
  interviewTime: string | undefined,
  payload: Record<string, unknown>,
  workOrderId?: number | null,
): void {
  const suffix =
    workOrderId != null
      ? String(workOrderId)
      : `${context.session.sessionId}:${eventName}:${jobId}:${interviewTime ?? 'wait_notice'}`;
  void recorder.recordEvent({
    corpId: context.session.corpId,
    eventName,
    idempotencyKey: suffix,
    botImId: context.session.botImId,
    managerName: context.session.botUserId,
    userId: context.session.userId,
    chatId: context.session.sessionId,
    payload: { job_id: jobId, interview_time: interviewTime ?? null, ...payload },
  });
}

interface IdentityValues {
  name: string;
  phone: string;
  age: string;
  gender: string;
}

interface JobInfo {
  brandName?: string;
  storeName?: string;
  jobName?: string;
}

function readJobInfo(job: JobDetail): JobInfo {
  const storeInfo =
    job.basicInfo?.storeInfo && typeof job.basicInfo.storeInfo === 'object'
      ? job.basicInfo.storeInfo
      : null;
  return {
    brandName: normalizeText(job.basicInfo?.brandName),
    storeName: normalizeText(storeInfo?.storeName) ?? normalizeText(job.basicInfo?.storeName),
    jobName: normalizeText(job.basicInfo?.jobName) ?? normalizeText(job.basicInfo?.jobNickName),
  };
}

async function notifyBooking(
  notifier: PrivateChatMonitorNotifierService,
  context: ToolBuildContext,
  identity: IdentityValues,
  job: JobInfo,
  interviewTime: string | undefined,
  interviewType: string | undefined,
  toolOutput: Record<string, unknown>,
): Promise<void> {
  try {
    await notifier.notifyInterviewBookingResult({
      candidateName: identity.name,
      contactName: context.session.contactName,
      phone: identity.phone,
      genderLabel: identity.gender,
      ageText: `${identity.age}岁`,
      interviewTime: interviewTime ?? '等待通知（面试官电话联系）',
      interviewType,
      brandName: job.brandName,
      storeName: job.storeName,
      jobName: job.jobName,
      botUserName: context.session.botUserId,
      botImId: context.session.botImId,
      toolOutput,
    });
  } catch (error) {
    logger.error(`面试预约通知发送异常: ${toErrorMessage(error)}`);
  }
}

function normalizeText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** 从岗位详情读取面试方式，仅用于回执展示，不参与收资判决。 */
export function resolveInterviewType(job: JobDetail): string | undefined {
  const process =
    job.interviewProcess && typeof job.interviewProcess === 'object'
      ? (job.interviewProcess as Record<string, unknown>)
      : null;
  const first =
    process?.firstInterview && typeof process.firstInterview === 'object'
      ? (process.firstInterview as Record<string, unknown>)
      : null;
  const description = normalizeText(first?.firstInterviewDesc);
  if (description && /ai/iu.test(description)) return 'AI面试';
  return normalizeText(first?.firstInterviewWay);
}

function assertIdentity(values: ReturnType<typeof readIdentity>): asserts values is IdentityValues {
  if (!values.name || !values.phone || !values.age || !values.gender) {
    throw new Error('identity fields missing');
  }
}

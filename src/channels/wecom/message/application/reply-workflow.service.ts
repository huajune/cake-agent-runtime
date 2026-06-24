import { Injectable, Logger } from '@nestjs/common';
import { CallerKind, ScenarioType } from '@enums/agent.enum';
import { MessageType } from '@enums/message-callback.enum';
import { MonitoringMetadata } from '@shared-types/tracking.types';
import { TurnRunnerService } from '@agent/runner/turn-runner.service';
import { FollowUpSchedulerService } from '@agent/reengagement/follow-up-scheduler.service';
import { MessageTrackingService } from '@biz/monitoring/services/tracking/message-tracking.service';
import { ReplyNormalizer } from '../utils/reply-normalizer.util';
import { MessageParser } from '../utils/message-parser.util';
import { EnterpriseMessageCallbackDto } from '../ingress/message-callback.dto';
import { DeliveryContext, AgentInvokeResult } from '../types';
import type { AgentError } from '@shared-types/agent-error.types';
import { MessageDeduplicationService } from '../runtime/deduplication.service';
import { MessageRuntimeConfigService } from '../runtime/message-runtime-config.service';
import { MessageDeliveryService } from '../delivery/delivery.service';
import { SimpleMergeService } from '../runtime/simple-merge.service';
import { WecomMessageObservabilityService } from '../telemetry/wecom-message-observability.service';
import { MessageProcessingFailureService } from './message-processing-failure.service';
import { PreAgentRiskInterceptService } from './pre-agent-risk-intercept.service';
import { ReplyFactGuardService } from './reply-fact-guard.service';
import { ImageDescriptionService } from './image-description.service';
import { OpsEventsRecorderService } from '@biz/ops-events/ops-events-recorder.service';
import { InterventionService } from '@biz/intervention/intervention.service';
import { HandoffRecorderService } from '@biz/handoff-events/handoff-recorder.service';
import type { HandoffWriteOutcome } from '@biz/handoff-events/handoff-events.types';
import type { AgentThinkingConfig } from '@agent/agent-run.types';

/**
 * Vision 描述等待上限。Vision 调用通常 3-6s；15s 给 ~2.5x 余量。
 * 超时仍未完成时放行，Agent 用占位文本继续——避免单次 vision 卡死整个回合。
 */
const VISION_AWAIT_TIMEOUT_MS = 15_000;

/**
 * 触发后会产生不可逆副作用的工具集合。
 *
 * 首次 Agent 调用若命中其中任一工具（无论 result.success 如何），
 * 视为"本轮副作用已固化"，直接投递首次回复，跳过 replay 检测：
 * - `invite_to_group` 企业级 addMember 外部 API + session facts 直写 invitedGroups
 * - `duliday_interview_booking` 杜力岱预约外部 API + recruitment_cases 建行 + 失败侧暂停托管
 *
 * 若 replay 丢弃首次回复，上述副作用已落地但用户未收到回复，会造成严重错乱：
 * - 阶段错位（procedural 被推进但 Agent 二次生成以为还在前一阶段）
 * - 群邀请已发但无解释
 * - 面试已预约但 Agent 二次生成重复尝试
 *
 * Agent 生成期间到达的新消息会留在 Redis pending list 里，
 * 由 MessageProcessor.handleProcessJob 末尾的 `checkAndProcessNewMessages`
 * 补建 follow-up job 在下一轮独立处理。
 *
 * 注意：`advance_stage` 不属于这里的不可逆副作用。阶段推进只影响内部程序记忆；
 * 如果因此跳过 replay，会把 Agent 生成期间到达的候选人补充信息拆成下一轮，
 * 造成先回复旧问题、再处理新约束的错位体验。
 */
const REPLAY_BLOCKING_TOOL_NAMES: ReadonlySet<string> = new Set([
  'invite_to_group',
  'duliday_interview_booking',
]);

function collectBlockingTools(toolCalls: AgentInvokeResult['toolCalls']): string[] {
  if (!toolCalls || toolCalls.length === 0) return [];
  const hit = new Set<string>();
  for (const call of toolCalls) {
    if (REPLAY_BLOCKING_TOOL_NAMES.has(call.toolName)) {
      hit.add(call.toolName);
    }
  }
  return Array.from(hit);
}

function isShortCircuitedToolCall(
  call: NonNullable<AgentInvokeResult['toolCalls']>[number],
): boolean {
  if (call.toolName === 'skip_reply') return true;
  return (call.result as { shortCircuited?: unknown } | undefined)?.shortCircuited === true;
}

function isBookingGateRejectedToolCall(
  call: NonNullable<AgentInvokeResult['toolCalls']>[number],
): boolean {
  if (call.toolName !== 'duliday_interview_booking') return false;
  const result = call.result as { shortCircuited?: unknown; gateRejected?: unknown } | undefined;
  return result?.shortCircuited === true && result.gateRejected === true;
}

@Injectable()
export class ReplyWorkflowService {
  private readonly logger = new Logger(ReplyWorkflowService.name);

  constructor(
    private readonly deduplicationService: MessageDeduplicationService,
    private readonly deliveryService: MessageDeliveryService,
    private readonly runner: TurnRunnerService,
    private readonly monitoringService: MessageTrackingService,
    private readonly wecomObservability: WecomMessageObservabilityService,
    private readonly runtimeConfig: MessageRuntimeConfigService,
    private readonly processingFailureService: MessageProcessingFailureService,
    private readonly preAgentRiskIntercept: PreAgentRiskInterceptService,
    private readonly replyFactGuard: ReplyFactGuardService,
    private readonly simpleMergeService: SimpleMergeService,
    private readonly imageDescription: ImageDescriptionService,
    private readonly opsEventsRecorder: OpsEventsRecorderService,
    private readonly interventionService: InterventionService,
    private readonly handoffRecorder: HandoffRecorderService,
    private readonly followUpScheduler: FollowUpSchedulerService,
  ) {}

  async processSingleMessage(messageData: EnterpriseMessageCallbackDto): Promise<void> {
    const parsed = MessageParser.parse(messageData);
    const { chatId, content, contactName, messageId } = parsed;
    const scenario = MessageParser.determineScenario();
    const traceId = messageId;

    try {
      // trace 通常已在入口 acceptInboundMessage.prepareForDispatch 创建。
      // 若仍不存在（异常兜底），此处补建。
      if (!(await this.wecomObservability.hasTrace(traceId))) {
        await this.wecomObservability.startRequestTrace({
          traceId,
          primaryMessage: messageData,
          scenario,
          content,
        });
      }
      await this.wecomObservability.updateDispatch(traceId, 'direct');
      await this.wecomObservability.markWorkerStart(traceId);
      await this.processMessageCore({
        primaryMessage: messageData,
        traceId,
        chatId,
        content,
        contactName,
        scenario,
        parsed,
        isSingleMessage: true,
      });
    } catch (error) {
      const errorType = this.processingFailureService.inferErrorType(error, 'message');
      await this.processingFailureService.handleProcessingError(error, parsed, {
        errorType,
        scenario,
        traceId,
        dispatchMode: 'direct',
        processedMessageIds: [messageData.messageId],
      });
    }
  }

  async processMergedMessages(
    messages: EnterpriseMessageCallbackDto[],
    batchId: string,
    initialSnapshotSize: number,
  ): Promise<void> {
    if (messages.length === 0) return;

    const scenario = MessageParser.determineScenario();
    const lastMessage = messages[messages.length - 1];
    const parsed = MessageParser.parse(lastMessage);
    const { chatId, contactName } = parsed;
    const content = this.wecomObservability.buildMergedRequestContent(messages);
    const traceId = batchId;

    this.logger.log(`[聚合处理][${chatId}] 处理 ${messages.length} 条消息`);

    try {
      await this.wecomObservability.startRequestTrace({
        traceId,
        primaryMessage: lastMessage,
        scenario,
        content,
        batchId,
        allMessages: messages,
        mergeWindowMs: this.runtimeConfig.getMergeDelayMs(),
      });
      // 把各条源消息 trace 里的前置埋点合并到 batch trace，避免 Queue 把前置耗时吞掉
      await this.wecomObservability.mergePrepTimingsFromSources(
        traceId,
        messages.map((message) => message.messageId),
      );
      await this.wecomObservability.updateDispatch(traceId, 'merged', batchId);
      await this.wecomObservability.markWorkerStart(traceId);
      await this.processMessageCore({
        primaryMessage: lastMessage,
        traceId,
        chatId,
        content,
        contactName,
        scenario,
        parsed,
        isSingleMessage: false,
        batchContext: { batchId, allMessages: messages },
        pendingAckSize: initialSnapshotSize,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`聚合消息处理失败:`, errorMessage);

      const errorType = this.processingFailureService.inferErrorType(error, 'merge');
      await this.processingFailureService.handleProcessingError(error, parsed, {
        errorType,
        scenario,
        traceId,
        batchId,
        dispatchMode: 'merged',
        processedMessageIds: messages.map((message) => message.messageId),
      });

      throw error;
    }
  }

  private async processMessageCore(params: {
    primaryMessage: EnterpriseMessageCallbackDto;
    traceId: string;
    chatId: string;
    content: string;
    contactName: string;
    scenario: ScenarioType;
    parsed: ReturnType<typeof MessageParser.parse>;
    isSingleMessage: boolean;
    batchContext?: { batchId: string; allMessages: EnterpriseMessageCallbackDto[] };
    /**
     * 聚合路径上 worker 初次抓取到的 pending 条数。所有终态分支（投递成功 / 主动沉默）
     * 在退出前会调用 ackPendingMessages 一次性裁掉 `pendingAckSize + replay 期间补抓的条数`；
     * 任何异常往上抛都会跳过 ack，让 pending 保持原样以供 Bull stalled retry 重放。
     * 单消息直发路径不走 pending 队列，传 undefined。
     */
    pendingAckSize?: number;
  }): Promise<void> {
    const { traceId, chatId, contactName, scenario, parsed, isSingleMessage, batchContext } =
      params;
    let consumedPending = params.pendingAckSize ?? 0;

    const logPrefix = isSingleMessage ? '' : '[聚合处理]';
    // 重跑会扩展本轮消息集合，这几个字段需要是 let。
    let allMessages: EnterpriseMessageCallbackDto[] = batchContext?.allMessages ?? [
      params.primaryMessage,
    ];
    let content = params.content;
    let imageUrls = this.collectImageUrls(allMessages);
    let imageMessageIds = this.collectImageMessageIds(allMessages);
    let visualMessageTypes = this.buildVisualMessageTypes(allMessages);
    let shortTermEndTimeInclusive = this.resolveShortTermEndTimeInclusive(allMessages);

    const { overrideModelId, thinking } = await this.runtimeConfig.resolveWecomChatModelSelection();

    // 前置风险同步预检：命中高置信度关键词即同步执行暂停+告警，
    // 但不短路 Agent——本轮安抚回复仍由 Agent 以招募者身份自主生成，
    // 避免任何预设话术暴露机器人/托管身份。
    const precheckResult = await this.preAgentRiskIntercept.precheck({
      messageData: params.primaryMessage,
      content,
      messages: allMessages,
    });
    if (precheckResult.hit) {
      this.logger.warn(
        `${logPrefix}[${contactName}] 前置风险预检命中: label=${precheckResult.label}, chatId=${chatId}`,
      );
    }

    const agentCallParams = {
      sessionId: chatId,
      scenario,
      messageId: traceId,
      recordMonitoring: true,
      userId: this.resolveAgentUserId(params.primaryMessage, parsed),
      corpId: this.resolveCorpId(params.primaryMessage),
      botUserId: params.primaryMessage.botUserId,
      contactName: parsed.contactName,
      botImId: params.primaryMessage.imBotId,
      groupId: params.primaryMessage.groupId,
      externalUserId: parsed.externalUserId,
      token: parsed.token,
      imContactId: parsed.imContactId,
      imRoomId: parsed.imRoomId,
      apiType: parsed._apiType,
      modelId: overrideModelId,
      thinking,
    } as const;

    // Vision 描述同步等待：accept-inbound 已 fire-and-forget 触发了 vision，
    // 此时若描述还没回写到 chat_messages.content，Agent 读短期记忆只能拿到占位文本。
    // awaitVision 等待本批所有图片/表情的描述 settle 后再调 Agent。超时则放行。
    await this.ensureVisionDescriptionsReady(imageMessageIds, contactName, logPrefix);

    // 首次调用延迟 turn-end：若随后检测到新消息会走 replay 丢弃本次回复，
    // 记忆投影/事实提取也必须一同被丢弃，否则会把「未发出的回复」污染到 session 记忆里。
    let agentResult = await this.callAgent({
      ...agentCallParams,
      userMessage: content,
      imageUrls: imageUrls.length > 0 ? imageUrls : undefined,
      imageMessageIds: imageMessageIds.length > 0 ? imageMessageIds : undefined,
      visualMessageTypes:
        Object.keys(visualMessageTypes).length > 0 ? visualMessageTypes : undefined,
      shortTermEndTimeInclusive,
      deferTurnEnd: true,
    });

    this.logger.log(
      `${logPrefix}[${contactName}] Agent 处理完成，耗时 ${agentResult.processingTime}ms，` +
        `tokens=${agentResult.reply.usage?.totalTokens || 'N/A'}`,
    );

    // 回合收尾（记忆投影/事实提取/沉淀）与后续投递并行执行，但必须在本方法返回前
    // 完成（见末尾 finally）：方法返回即 MessageProcessor 释放 chat 处理锁，若收尾
    // 仍在异步写 session state，会与下一个 job 的读写并发，整份覆盖写互相丢更新。
    let turnEndPromise: Promise<void> | undefined;
    const startTurnEnd = (result: { runTurnEnd?: () => Promise<void> }) => {
      const run = result.runTurnEnd;
      if (!run) return;
      result.runTurnEnd = undefined;
      turnEndPromise = run().catch((err) => {
        const errorMessage = err instanceof Error ? err.message : String(err);
        this.logger.warn(`[${contactName}] turn-end lifecycle 执行失败: ${errorMessage}`);
      });
    };

    try {
      // 副作用工具短路：首次调用若命中 advance_stage / invite_to_group /
      // duliday_interview_booking 中任一个，就视为本轮已经在外部系统留下了
      // 不可撤销的痕迹——不去 drain pending，直接投递首次回复。
      // Agent 生成期间到达的新消息仍留在 Redis pending list 里，由
      // MessageProcessor 末尾的 checkAndProcessNewMessages 补建 follow-up
      // job 在下一轮独立处理。
      const blockingTools = collectBlockingTools(agentResult.toolCalls);
      const replayBlocked = blockingTools.length > 0;

      if (replayBlocked) {
        this.logger.warn(
          `${logPrefix}[${contactName}][Replay-Skip] 首次调用命中不可逆工具 [${blockingTools.join(
            ',',
          )}]，跳过 replay 检测，直接投递首次回复 (chatId=${chatId})`,
        );
        startTurnEnd(agentResult);
      } else {
        // 投递前重跑：Agent 生成期间若用户又发了新消息，丢弃本次回复，合并新消息重跑一次。
        // 只允许一次重跑——第二次生成期间到的新消息交给投递后的 follow-up job 处理，避免无限重跑。
        // 注意 fromIndex 必须是 worker 持有的 consumedPending 偏移，否则会把已经在 allMessages
        // 里的消息再读一遍。
        const { messages: newMessages, snapshotSize: replaySnapshotSize } =
          await this.fetchPendingSinceAgentStart(chatId, consumedPending);
        consumedPending += replaySnapshotSize;
        if (newMessages.length > 0) {
          this.logger.warn(
            `${logPrefix}[${contactName}][Replay] 检测到 ${newMessages.length} 条新消息，丢弃首次回复并重新调用 Agent (chatId=${chatId})`,
          );
          // 丢弃首次的 runTurnEnd——它承载了将首次回复写入 session 记忆的副作用。
          // 第二次 callAgent 同样 deferTurnEnd，结果必然被采纳，返回后立即 startTurnEnd。
          agentResult.runTurnEnd = undefined;

          allMessages = [...allMessages, ...newMessages];
          content = this.wecomObservability.buildMergedRequestContent(allMessages);
          imageUrls = this.collectImageUrls(allMessages);
          imageMessageIds = this.collectImageMessageIds(allMessages);
          visualMessageTypes = this.buildVisualMessageTypes(allMessages);
          shortTermEndTimeInclusive = this.resolveShortTermEndTimeInclusive(allMessages);
          await this.wecomObservability.updateRequestMessages(traceId, {
            messages: allMessages,
            content,
            mergeWindowMs: this.runtimeConfig.getMergeDelayMs(),
          });

          // Replay 合入的新消息在 intake 时已写了一条 processing 流水，本轮的终态只会
          // 回写到 traceId 那一行。若不在这里回收，这些源记录会一直停在「处理中」，
          // 只能等 30 分钟的 timeoutStuckRecords 兜底清理。
          await this.wecomObservability.mergePrepTimingsFromSources(
            traceId,
            newMessages.map((message) => message.messageId),
          );

          // 等 replay 合入的新消息（可能含图片）的 vision 描述完成后再重跑 Agent
          await this.ensureVisionDescriptionsReady(imageMessageIds, contactName, logPrefix);

          agentResult = await this.callAgent({
            ...agentCallParams,
            userMessage: content,
            imageUrls: imageUrls.length > 0 ? imageUrls : undefined,
            imageMessageIds: imageMessageIds.length > 0 ? imageMessageIds : undefined,
            visualMessageTypes:
              Object.keys(visualMessageTypes).length > 0 ? visualMessageTypes : undefined,
            shortTermEndTimeInclusive,
            deferTurnEnd: true,
          });

          this.logger.log(
            `${logPrefix}[${contactName}][Replay] 重跑 Agent 完成，耗时 ${agentResult.processingTime}ms，` +
              `tokens=${agentResult.reply.usage?.totalTokens || 'N/A'}`,
          );
          startTurnEnd(agentResult);
        } else {
          // 首次结果被最终采纳，触发 turn-end lifecycle（与投递并行，方法返回前 await）。
          startTurnEnd(agentResult);
        }
      }

      if (agentResult.isFallback) {
        void this.processingFailureService.sendFallbackAlert({
          contactName,
          botUserName: parsed.managerName,
          userMessage: content,
          fallbackMessage: agentResult.reply.content,
          fallbackReason: 'Agent 返回降级响应',
          scenario,
          chatId,
          imBotId: params.primaryMessage.imBotId,
        });
      }

      const processedMessageIds = allMessages.map((message) => message.messageId);
      await this.dispatchBookingGateHandoffIfNeeded(agentResult, {
        traceId,
        chatId,
        userId: agentCallParams.userId,
        corpId: agentCallParams.corpId,
        contactName,
        botImId: agentCallParams.botImId,
        botUserId: agentCallParams.botUserId,
        userMessage: content,
      });

      // Agent 主动沉默 / 转人工短路 / 出站守卫拦截：跳过 WeCom 发送，但仍完成本轮流水与观测。
      // 守卫拦截（如歧视性筛选条件外露）宁可本轮沉默也不可泄漏，飞书已告警人工跟进。
      if (agentResult.isSkipped || agentResult.blockedByGuard) {
        if (agentResult.blockedByGuard) {
          this.logger.warn(
            `${logPrefix}[${contactName}] 出站守卫拦截回复，跳过消息发送 (rules=${agentResult.blockedByGuard.ruleIds.join(',')})`,
          );
        } else {
          const skipReason = this.extractSkipReason(agentResult) || '本轮无需回复';
          this.logger.log(`${logPrefix}[${contactName}] Agent 短路，跳过消息发送 (${skipReason})`);
        }
        await this.wecomObservability.markReplySkipped(traceId);
        const skippedMetadata = await this.buildSuccessMetadata(
          traceId,
          agentResult,
          { segmentCount: 0 },
          scenario,
          batchContext?.batchId,
        );
        this.monitoringService.recordSuccess(traceId, skippedMetadata);
        await this.markMessagesAsProcessed(processedMessageIds);
        await this.ackPendingIfMerged(chatId, consumedPending);
        return;
      }

      const deliveryContext = this.buildDeliveryContext(parsed, traceId);
      const deliveryResult = await this.deliveryService.deliverReply(
        agentResult.reply,
        deliveryContext,
        true,
      );

      // Agent 回复成功投递 → agent.replied（仅个人单聊；fire-and-forget）。
      // 已过 skip_reply/handoff 短路早返回，到这里一定是真实对外回复。
      this.recordAgentReplied(params.primaryMessage, parsed, traceId);

      const successMetadata = await this.buildSuccessMetadata(
        traceId,
        agentResult,
        deliveryResult,
        scenario,
        batchContext?.batchId,
      );

      this.monitoringService.recordSuccess(traceId, successMetadata);
      await this.markMessagesAsProcessed(processedMessageIds);
      await this.ackPendingIfMerged(chatId, consumedPending);

      if (!batchContext) {
        this.logger.debug(`[${contactName}] 请求流水 [${traceId}] 已标记为已处理`);
      }
    } finally {
      // 在方法返回（→ MessageProcessor 释放 chat 处理锁）前等待回合收尾落盘，
      // 保证同一 chat 的记忆写入相对处理锁串行，杜绝跨 job 并发覆盖。
      if (turnEndPromise) await turnEndPromise;
    }
  }

  /**
   * 聚合路径终态成功后裁掉已消费的 pending；单消息直发路径 consumedPending 永远是 0，
   * ackPendingMessages 内部会短路。
   *
   * 任何上游异常未走到这里 → 不 ack → pending 保留 → Bull stalled retry 时新 worker 仍能
   * 拿到完整数据继续处理（修复发版 SIGKILL 中断 agent 后候选人消息被吞的问题）。
   */
  private async ackPendingIfMerged(chatId: string, count: number): Promise<void> {
    if (count <= 0) return;
    try {
      await this.simpleMergeService.ackPendingMessages(chatId, count);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      // ack 失败不应让本轮整体失败——回复已发出，最坏情况是 Bull retry 时再处理一次相同
      // 数据并产生重复回复，监控里会观察到。这里只记日志，避免抛错触发 retry。
      this.logger.warn(`[${chatId}] ack pending 失败（${count} 条）: ${errorMessage}`);
    }
  }

  private async buildSuccessMetadata(
    traceId: string,
    agentResult: AgentInvokeResult,
    deliveryResult: { segmentCount: number },
    scenario: ScenarioType,
    batchId?: string,
  ): Promise<MonitoringMetadata & { fallbackSuccess?: boolean; batchId?: string }> {
    const replyPreview = agentResult.blockedByGuard
      ? `[守卫拦截 ${agentResult.blockedByGuard.ruleIds.join(',')}] ${agentResult.reply.content}`
      : agentResult.isSkipped
        ? `[主动沉默] ${this.extractSkipReason(agentResult) || '本轮无需回复'}`
        : agentResult.reply.content;
    return this.wecomObservability.buildSuccessMetadata(traceId, {
      scenario,
      batchId,
      replyPreview,
      replySegments: deliveryResult.segmentCount,
      extraResponse: {
        processingTimeMs: agentResult.processingTime,
      },
    });
  }

  private extractSkipReason(agentResult: AgentInvokeResult): string | undefined {
    const handoffCall = agentResult.toolCalls?.find((tc) => tc.toolName === 'request_handoff');
    if (handoffCall) {
      const args = handoffCall.args as { reasonCode?: unknown; reason?: unknown } | undefined;
      const reasonCode = typeof args?.reasonCode === 'string' ? args.reasonCode : '';
      const reason = typeof args?.reason === 'string' ? args.reason.trim() : '';
      const composed = [reasonCode && `handoff:${reasonCode}`, reason].filter(Boolean).join(' | ');
      return composed || undefined;
    }
    const skipCall = agentResult.toolCalls?.find((tc) => tc.toolName === 'skip_reply');
    const reason = (skipCall?.args as { reason?: unknown } | undefined)?.reason;
    if (typeof reason === 'string' && reason.trim().length > 0) return reason.trim();

    const shortCircuitCall = agentResult.toolCalls?.find(isShortCircuitedToolCall);
    if (shortCircuitCall) {
      const result = shortCircuitCall.result as
        | { reasonCode?: unknown; errorType?: unknown; _outcome?: unknown }
        | undefined;
      const reasonCode = typeof result?.reasonCode === 'string' ? result.reasonCode : '';
      const errorType = typeof result?.errorType === 'string' ? result.errorType : '';
      const outcome = typeof result?._outcome === 'string' ? result._outcome : '';
      const detail = reasonCode || errorType || outcome;
      return detail ? `${shortCircuitCall.toolName}:${detail}` : shortCircuitCall.toolName;
    }

    return undefined;
  }

  private async dispatchBookingGateHandoffIfNeeded(
    agentResult: AgentInvokeResult,
    context: {
      traceId: string;
      chatId: string;
      userId: string;
      corpId: string;
      contactName?: string;
      botImId?: string;
      botUserId?: string;
      userMessage: string;
    },
  ): Promise<void> {
    const gateCall = agentResult.toolCalls?.find(isBookingGateRejectedToolCall);
    if (!gateCall) return;

    const gateResult = gateCall.result as
      | { reasonCode?: unknown; errorType?: unknown; _outcome?: unknown; details?: unknown }
      | undefined;
    const gateReasonCode =
      typeof gateResult?.reasonCode === 'string' ? gateResult.reasonCode : 'booking_gate_rejected';
    const gateErrorType = typeof gateResult?.errorType === 'string' ? gateResult.errorType : '';
    const gateOutcome = typeof gateResult?._outcome === 'string' ? gateResult._outcome : '';
    const reason = [gateReasonCode, gateErrorType, gateOutcome].filter(Boolean).join(' | ');
    const occurredAt = new Date();
    const idempotencyKey = `${context.chatId}:handoff:${context.traceId}`;

    let writeOutcome: HandoffWriteOutcome = 'failed';
    try {
      writeOutcome = await this.handoffRecorder.record({
        corpId: context.corpId,
        chatId: context.chatId,
        userId: context.userId,
        reasonCode: 'system_blocked',
        reason: reason || 'booking runtime guard rejected this turn',
        actionAdvice: '人工确认 jobId 来源与候选人真实意向；必要时手动补录或重新推荐岗位。',
        stage: null,
        botImId: context.botImId,
        idempotencyKey,
        occurredAt,
      });
    } catch (error) {
      this.logger.error(
        `[BookingGateHandoff] handoff 底账写入异常，继续 fail-safe dispatch: chatId=${context.chatId}, key=${idempotencyKey}, error=${error instanceof Error ? error.message : String(error)}`,
      );
      writeOutcome = 'failed';
    }

    if (writeOutcome === 'duplicate') {
      this.logger.warn(
        `[BookingGateHandoff] duplicate handoff，跳过重复 dispatch: chatId=${context.chatId}, key=${idempotencyKey}`,
      );
      return;
    }
    if (writeOutcome === 'failed') {
      this.logger.error(
        `[BookingGateHandoff] handoff 底账写入失败，执行 fail-safe dispatch: chatId=${context.chatId}, key=${idempotencyKey}`,
      );
    }

    try {
      const result = await this.interventionService.dispatch({
        kind: 'general_handoff',
        source: 'agent_tool',
        alertLabel: 'Booking runtime guard 拦截',
        reason: reason || 'booking runtime guard rejected this turn',
        actionAdvice: '人工确认 jobId 来源与候选人真实意向；必要时手动补录或重新推荐岗位。',
        chatId: context.chatId,
        corpId: context.corpId,
        userId: context.userId,
        pauseTargetId: context.chatId,
        botImId: context.botImId,
        botUserName: context.botUserId,
        contactName: context.contactName,
        currentMessageContent: context.userMessage,
        recentMessages: [
          {
            role: 'user',
            content: context.userMessage,
            timestamp: occurredAt.getTime(),
          },
        ],
        sessionState: null,
      });
      this.logger.warn(
        `[BookingGateHandoff] dispatched: chatId=${context.chatId}, paused=${result.paused}, alerted=${result.alerted}, suppressed=${result.suppressed ?? '-'}`,
      );
    } catch (error) {
      this.logger.error(
        `[BookingGateHandoff] dispatch 失败: chatId=${context.chatId}, error=${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async markMessagesAsProcessed(messageIds: string[]): Promise<void> {
    await Promise.all(
      messageIds.map(async (messageId) => {
        await this.deduplicationService.markMessageAsProcessedAsync(messageId).catch((err) => {
          const errorMessage = err instanceof Error ? err.message : String(err);
          this.logger.warn(`[请求流水] 去重标记失败 [${messageId}]: ${errorMessage}`);
        });
      }),
    );
  }

  private async callAgent(params: {
    sessionId: string;
    userMessage: string;
    scenario?: string;
    messageId?: string;
    recordMonitoring?: boolean;
    userId: string;
    corpId: string;
    imageUrls?: string[];
    imageMessageIds?: string[];
    visualMessageTypes?: Record<string, MessageType.IMAGE | MessageType.EMOTION>;
    botUserId?: string;
    contactName?: string;
    botImId?: string;
    externalUserId?: string;
    token?: string;
    imContactId?: string;
    imRoomId?: string;
    apiType?: 'enterprise' | 'group';
    modelId?: string;
    thinking?: AgentThinkingConfig;
    shortTermEndTimeInclusive?: number;
    /** 延迟 turn-end 生命周期触发；replay 首次调用置 true 以便被丢弃时不污染记忆 */
    deferTurnEnd?: boolean;
  }): Promise<AgentInvokeResult> {
    const {
      userMessage,
      scenario = 'candidate-consultation',
      messageId,
      recordMonitoring = true,
      userId,
      corpId,
      deferTurnEnd,
    } = params;

    const startTime = Date.now();
    let shouldRecordAiEnd = false;

    try {
      if (recordMonitoring && messageId) {
        await this.wecomObservability.markAiStart(messageId);
        shouldRecordAiEnd = true;
      }

      const result = await this.runner.invoke({
        callerKind: CallerKind.WECOM,
        messages: [{ role: 'user', content: userMessage }],
        userId,
        corpId,
        sessionId: params.sessionId,
        messageId,
        scenario,
        contactName: params.contactName,
        imageUrls: params.imageUrls,
        imageMessageIds: params.imageMessageIds,
        visualMessageTypes: params.visualMessageTypes,
        botUserId: params.botUserId,
        botImId: params.botImId,
        externalUserId: params.externalUserId,
        token: params.token,
        imContactId: params.imContactId,
        imRoomId: params.imRoomId,
        apiType: params.apiType,
        modelId: params.modelId,
        thinking: params.thinking,
        shortTermEndTimeInclusive: params.shortTermEndTimeInclusive,
        deferTurnEnd,
        onPreparedRequest:
          recordMonitoring && messageId
            ? (agentRequest) => this.wecomObservability.recordAgentRequest(messageId, agentRequest)
            : undefined,
      });

      const processingTime = Date.now() - startTime;
      const content = this.normalizeContent(result.text);
      // 短路判定必须与 runner 的 stopWhen 一致（见 runner.service shortCircuitByToolResult）：
      // - skip_reply：无条件短路 → 跳过发送
      // - 任意工具 result.shortCircuited===true：运行时硬短路 → 跳过发送。
      //   request_handoff 的 HANDOFF_NO_BOOKING 返回 shortCircuited:false（不短路），
      //   此时 Agent 已按首次约面继续生成回复，必须正常投递。
      const isSkipped = result.toolCalls?.some(isShortCircuitedToolCall) ?? false;

      // Reply 后置事实对账：常规规则命中即日志告警，不改写文本（Phase 1）；
      // 阻断规则（如歧视性筛选条件外露）命中则出站短路——回复不发送，飞书告警人工跟进。
      // 历史 badcase i41pab8n：invite_to_group 成功后下一轮 Agent 无 tool 调用
      // 自由发挥说"群已满"。常规规则积累 1-2 周后再决定是否升级到 phase 2 改写。
      let blockedByGuard: AgentInvokeResult['blockedByGuard'];
      if (!isSkipped && content) {
        const guardResult = this.replyFactGuard.check({
          replyText: content,
          toolCalls: result.toolCalls,
          chatId: params.sessionId,
          userId,
          traceId: messageId,
          contactName: params.contactName,
          botImId: params.botImId,
          botUserName: params.botUserId,
          userMessage: params.userMessage,
        });
        if (guardResult.blocked) {
          blockedByGuard = {
            ruleIds: guardResult.contradictions.filter((c) => c.blocked).map((c) => c.ruleId),
          };
        }
      }

      const invokeResult: AgentInvokeResult = {
        reply: { content, reasoning: result.reasoning, usage: result.usage },
        isFallback: false,
        isSkipped,
        blockedByGuard,
        processingTime,
        toolCalls: result.toolCalls,
        agentSteps: result.agentSteps,
        memorySnapshot: result.memorySnapshot,
        responseMessages: result.responseMessages,
        runTurnEnd: result.runTurnEnd,
      };
      if (recordMonitoring && messageId) {
        await this.wecomObservability.recordAgentResult(messageId, invokeResult);
      }

      if (!content && !isSkipped) {
        const emptyResponseError = new Error('Agent 返回空响应') as AgentError;
        emptyResponseError.isAgentError = true;
        emptyResponseError.agentMeta = {
          sessionId: params.sessionId,
          userId,
          messageCount: 1,
          lastCategory: 'empty_response',
        };
        throw emptyResponseError;
      }

      this.logger.log(
        `Agent 调用成功，耗时 ${processingTime}ms，tokens=${result.usage?.totalTokens || 'N/A'}${
          isSkipped ? '，本轮主动沉默' : ''
        }`,
      );

      return invokeResult;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Agent 调用异常: ${errorMessage}`);
      throw error;
    } finally {
      if (shouldRecordAiEnd && messageId) {
        await this.wecomObservability.markAiEnd(messageId);
      }
    }
  }

  private resolveShortTermEndTimeInclusive(
    messages: EnterpriseMessageCallbackDto[],
  ): number | undefined {
    const timestamps = messages
      .map((message) => this.resolveStoredMessageTimestamp(message))
      .filter((timestamp): timestamp is number => Number.isFinite(timestamp));
    return timestamps.length > 0 ? Math.max(...timestamps) : undefined;
  }

  private resolveStoredMessageTimestamp(message: EnterpriseMessageCallbackDto): number | undefined {
    const callbackTimestamp = Number.parseInt(String(message.timestamp), 10);
    if (Number.isFinite(callbackTimestamp) && callbackTimestamp > 0) {
      return callbackTimestamp;
    }
    if (Number.isFinite(message._receivedAtMs) && (message._receivedAtMs ?? 0) > 0) {
      return message._receivedAtMs;
    }
    return undefined;
  }

  private normalizeContent(rawContent: string): string {
    if (ReplyNormalizer.needsNormalization(rawContent)) {
      const normalized = ReplyNormalizer.normalize(rawContent);
      this.logger.debug(
        `[ReplyNormalizer] 已清洗回复: "${rawContent.substring(0, 50)}..." → "${normalized.substring(0, 50)}..."`,
      );
      return normalized;
    }
    return rawContent;
  }

  private resolveAgentUserId(
    messageData: EnterpriseMessageCallbackDto,
    parsed: ReturnType<typeof MessageParser.parse>,
  ): string {
    return parsed.imContactId || messageData.externalUserId || parsed.chatId;
  }

  private resolveCorpId(messageData: EnterpriseMessageCallbackDto): string {
    return messageData.orgId || 'default';
  }

  /**
   * 记录 Agent 对外回复事件（仅个人单聊）。本会话**首条**对外回复 = 开场白：
   * - 开场白：agent.opening_sent（每会话一次，投影 agent_opening_sent_count）
   * - 普通回复：agent.replied（投影 agent_reply_count）
   *
   * 线上未配平台 SOP，开场白就是 Agent 回候选人首条消息（多为微信加好友握手语「我是xx」）。
   * 用「首条」判定开场白：以 `chatId:opening` 幂等插入的返回值为准——首次插入成功即开场白，
   * 之后插入冲突即普通回复。agent.replied 幂等键用 traceId（每轮一次，Bull retry 不重复计数）。
   * 全程 fire-and-forget。
   */
  private recordAgentReplied(
    primaryMessage: EnterpriseMessageCallbackDto,
    parsed: ReturnType<typeof MessageParser.parse>,
    traceId: string,
  ): void {
    if (primaryMessage.imRoomId) return; // 群聊不计入候选人漏斗
    const botImId = primaryMessage.imBotId;
    const corpId = this.resolveCorpId(primaryMessage);
    const userId = this.resolveAgentUserId(primaryMessage, parsed);
    const chatId = parsed.chatId;

    void (async () => {
      try {
        const openingResult = await this.opsEventsRecorder.recordEventDetailed({
          corpId,
          eventName: 'agent.opening_sent',
          idempotencyKey: `${chatId}:opening`,
          botImId,
          managerName: primaryMessage.botUserId,
          sourceChannel: 'unknown',
          userId,
          chatId,
        });

        // 写入失败（DB 不可用 / 熔断 OPEN / RPC 异常）时，无法判定本条是否开场白：
        // 不能据此误记为 agent.replied（否则开场白行永远缺失且不可恢复）。
        // 跳过本轮分类——开场白行未写入，后续回复会再次尝试插入并正确判定。
        if (openingResult === 'failed') {
          this.logger.warn(
            `[漏斗] 开场白事件写入失败，跳过本轮开场白/回复分类，等待后续重试 [${traceId}]`,
          );
          return;
        }

        const isOpening = openingResult === 'inserted';
        if (isOpening) {
          // 开场白已记录（agent.opening_sent）= reengagement opening_no_reply 场景锚点：
          // 排一个 15min 后的复聊 delayed job（shadow 模式只排程不发；processor 到点会读权威态
          // 做 shouldStop——候选人已回则丢弃）。fire-and-forget，失败不影响主漏斗。
          void this.followUpScheduler
            .scheduleFollowUp({
              sessionRef: { corpId, userId, sessionId: chatId },
              scenarioCode: 'opening_no_reply',
              anchorEventId: 'opening',
              anchorAt: Date.now(),
            })
            .catch((error: unknown) => {
              this.logger.warn(
                `[reengagement] opening 锚点排程失败 [${traceId}]: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            });
          // 开场白已记录（agent.opening_sent），本轮无需再记 agent.replied
          return;
        }

        await this.opsEventsRecorder.recordEvent({
          corpId,
          eventName: 'agent.replied',
          idempotencyKey: `${traceId}:replied`,
          botImId,
          managerName: primaryMessage.botUserId,
          sourceChannel: 'unknown',
          userId,
          chatId,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.warn(`[漏斗] agent 回复事件记录失败 [${traceId}]: ${errorMessage}`);
      }
    })();
  }

  /**
   * 等待本批所有图片/表情的 vision 描述完成（已完成的立即返回；超时则放行）。
   *
   * 必须在 callAgent 之前调用——Agent 读短期记忆时会从 chat_messages.content 取
   * vision 描述，若描述还没回写，模型只能拿到 "[图片消息]" 这种占位文本，
   * 相当于看不到图片内容。
   */
  private async ensureVisionDescriptionsReady(
    visualMessageIds: string[],
    contactName: string,
    logPrefix: string,
  ): Promise<void> {
    if (visualMessageIds.length === 0) return;
    const startedAt = Date.now();
    await this.imageDescription.awaitVision(visualMessageIds, VISION_AWAIT_TIMEOUT_MS);
    const waitedMs = Date.now() - startedAt;
    if (waitedMs > 50) {
      this.logger.log(
        `${logPrefix}[${contactName}] 等待 vision 描述完成: ${waitedMs}ms (${visualMessageIds.length} 张)`,
      );
    }
  }

  private collectImageUrls(messages: EnterpriseMessageCallbackDto[]): string[] {
    return messages
      .map((message) => {
        const imgUrl = MessageParser.extractImageUrl(message);
        if (!imgUrl) return null;
        const artworkUrl = (message.payload as Record<string, unknown>)?.artworkUrl;
        return typeof artworkUrl === 'string' ? artworkUrl : imgUrl;
      })
      .filter((url): url is string => url !== null);
  }

  private collectImageMessageIds(messages: EnterpriseMessageCallbackDto[]): string[] {
    return messages
      .filter((message) => MessageParser.extractImageUrl(message) !== null)
      .map((message) => message.messageId);
  }

  /**
   * 构建 messageId → 视觉类型 映射（IMAGE / EMOTION）。
   * 供 save_image_description 工具按类型选用前缀写回 DB。
   */
  private buildVisualMessageTypes(
    messages: EnterpriseMessageCallbackDto[],
  ): Record<string, MessageType.IMAGE | MessageType.EMOTION> {
    const map: Record<string, MessageType.IMAGE | MessageType.EMOTION> = {};
    for (const message of messages) {
      const kind = MessageParser.extractVisualMessageType(message);
      if (kind) {
        map[message.messageId] = kind;
      }
    }
    return map;
  }

  /**
   * Agent 执行期间的新消息：从 pending 列表 `fromIndex` 之后读取快照（不从队列移除）。
   *
   * 调用时机限定在 Bull Worker 持有 per-chat 处理锁期间，因此 LRANGE 不会读到跨 worker 的
   * 已消费部分。返回的 `snapshotSize` 由调用方累加进 `consumedPending`，整体 ack 在投递
   * 成功后由 `ackPendingIfMerged` 一次性裁掉。
   */
  private async fetchPendingSinceAgentStart(
    chatId: string,
    fromIndex: number,
  ): Promise<{ messages: EnterpriseMessageCallbackDto[]; snapshotSize: number }> {
    try {
      const { messages, snapshotSize } = await this.simpleMergeService.claimPendingSnapshot(
        chatId,
        fromIndex,
      );
      return { messages, snapshotSize };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `[Replay] 读取 Agent 执行期间的新消息失败，跳过重跑 chatId=${chatId}: ${errorMessage}`,
      );
      return { messages: [], snapshotSize: 0 };
    }
  }

  private buildDeliveryContext(
    parsed: ReturnType<typeof MessageParser.parse>,
    traceId?: string,
  ): DeliveryContext {
    return {
      token: parsed.token,
      imBotId: parsed.imBotId,
      imContactId: parsed.imContactId,
      imRoomId: parsed.imRoomId,
      contactName: parsed.contactName || '客户',
      messageId: traceId ?? parsed.messageId,
      chatId: parsed.chatId,
      _apiType: parsed._apiType,
    };
  }
}

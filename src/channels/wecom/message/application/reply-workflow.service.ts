import { Injectable, Logger } from '@nestjs/common';
import { CallerKind, ScenarioType } from '@enums/agent.enum';
import { MessageType } from '@enums/message-callback.enum';
import { MonitoringMetadata } from '@shared-types/tracking.types';
import { AgentRunnerService } from '@agent/runner/agent-runner.service';
import { resolveReplaySkipDecision } from '@agent/runner/turn-outcome';
import { isShortCircuitedToolCall } from '@agent/generator/tool-call-analysis';
import { TurnFinalizer } from '@agent/runner/turn-finalizer';
import { FollowUpSchedulerService } from '@agent/reengagement/follow-up-scheduler.service';
import { ReengagementAnchorService } from '@agent/reengagement/anchor.service';
import type { ReengagementChannelIdentity } from '@agent/reengagement/follow-up-scheduler.service';
import { MessageTrackingService } from '@biz/monitoring/services/tracking/message-tracking.service';
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
import { ImageDescriptionService } from './image-description.service';
import { OpsEventsRecorderService } from '@biz/ops-events/services/ops-events-recorder.service';
import { AlertNotifierService } from '@notification/services/alert-notifier.service';
import type { GeneratorThinkingConfig } from '@agent/generator/generator.types';
import { TurnOutcomeInterventionService } from '@agent/runner/turn-outcome-intervention.service';

/**
 * 兼容图片描述等待上限。Vision 调用通常 3-6s；15s 给 ~2.5x 余量。
 * 超时仍未完成时放行，避免单次图片描述卡死整个回合。
 */
const VISION_AWAIT_TIMEOUT_MS = 15_000;

type VisualMessageTypes = Record<string, MessageType.IMAGE | MessageType.EMOTION>;

interface AgentCallParams {
  sessionId: string;
  userMessage: string;
  scenario?: string;
  messageId?: string;
  recordMonitoring?: boolean;
  userId: string;
  corpId: string;
  imageUrls?: string[];
  imageMessageIds?: string[];
  visualMessageTypes?: VisualMessageTypes;
  botUserId?: string;
  contactName?: string;
  botImId?: string;
  groupId?: string;
  externalUserId?: string;
  token?: string;
  imContactId?: string;
  imRoomId?: string;
  apiType?: 'enterprise' | 'group';
  modelId?: string;
  thinking?: GeneratorThinkingConfig;
  shortTermEndTimeInclusive?: number;
  /** 延迟 turn-end 生命周期触发；replay 首次调用置 true 以便被丢弃时不污染记忆 */
  deferTurnEnd?: boolean;
}

@Injectable()
export class ReplyWorkflowService {
  private readonly logger = new Logger(ReplyWorkflowService.name);

  constructor(
    private readonly deduplicationService: MessageDeduplicationService,
    private readonly deliveryService: MessageDeliveryService,
    private readonly runner: AgentRunnerService,
    private readonly monitoringService: MessageTrackingService,
    private readonly wecomObservability: WecomMessageObservabilityService,
    private readonly runtimeConfig: MessageRuntimeConfigService,
    private readonly processingFailureService: MessageProcessingFailureService,
    private readonly simpleMergeService: SimpleMergeService,
    private readonly imageDescription: ImageDescriptionService,
    private readonly opsEventsRecorder: OpsEventsRecorderService,
    private readonly outcomeFinalizer: TurnOutcomeInterventionService,
    private readonly followUpScheduler: FollowUpSchedulerService,
    private readonly reengagementAnchors: ReengagementAnchorService,
    private readonly alertNotifier: AlertNotifierService,
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

      // handleProcessingError 会发送降级回复/告警并把本批 messageId 置为终态。
      // 此时若继续向 Bull 抛错，pending list 尚未 ack，会被 retry 重放，轻则重复告警，
      // 重则给候选人再发一条降级回复。单实例部署下这里按“失败已兜底”为终态处理。
      await this.ackPendingIfMerged(chatId, initialSnapshotSize);
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

    // 兼容描述等待：只有主聊天模型不支持 vision 时，accept-inbound 才会提前触发图片描述。
    // 多模态主路径没有 in-flight 任务，这里会立即返回；文本兼容路径则等描述写回后再进 Agent。
    await this.ensureCompatibilityDescriptionsReady(imageMessageIds, contactName, logPrefix);

    // 首次调用延迟 turn-end：若随后检测到新消息会走 replay 丢弃本次回复，
    // 记忆投影/事实提取也必须一同被丢弃，否则会把「未发出的回复」污染到 session 记忆里。
    let agentResult = await this.callAgentWithVisualCompatibilityFallback({
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

    // 回合收尾（记忆投影/事实提取/沉淀）由 agentResult.turnFinalizer（agent 层）封装：触发点
    // 统一收敛到「已知本轮投递结局」之后（守卫拦截/沉默分支 与 投递完成分支各一次 settle），
    // 而非生成结束就立即触发——否则被守卫拦截、托管暂停丢弃或投递失败的回复仍会被写进 session
    // 记忆，造成下一轮以为「已对候选人说过」的幽灵复聊。是否投影助手轮次由 `delivered` 决定。
    // finalizer 内部保证「锁释放前 await 落盘 / replay 丢弃首版 / delivered→includeAssistantText」
    // 这些记忆领域不变式，渠道只负责上报投递结局（见末尾 finally 的 whenSettled）。
    try {
      // 非 reply outcome（skipped/guardrail_blocked/handoff）与已固化副作用工具均是
      // agent/outcome 层给出的终态：不再拿通道 pending 变化重写这类结果。Agent 生成期间到达的
      // 新消息仍留在 Redis pending list 里，由 MessageProcessor 末尾补建 follow-up job 处理。
      const replaySkip = resolveReplaySkipDecision(agentResult.outcome, agentResult.toolCalls);

      if (replaySkip.skip) {
        this.logger.warn(
          `${logPrefix}[${contactName}][Replay-Skip] ${replaySkip.reasons.join(
            ',',
          )}，跳过 replay 检测，直接采用首次 outcome (chatId=${chatId})`,
        );
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
          // 丢弃首次的记忆收尾——它承载了将首次回复写入 session 记忆的副作用。
          // 第二次 callAgent 同样 deferTurnEnd，结果必然被采纳，返回后由 settle 触发。
          agentResult.turnFinalizer?.discard();

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

          // Replay 合入的新消息也可能走文本兼容描述；多模态主路径这里通常是 no-op。
          await this.ensureCompatibilityDescriptionsReady(imageMessageIds, contactName, logPrefix);

          agentResult = await this.callAgentWithVisualCompatibilityFallback({
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
        }
        // turn-end 触发推迟到投递结局已知之后（见下方守卫/投递分支），此处不再立即触发。
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
      const sideEffectContext = {
        traceId,
        chatId,
        userId: agentCallParams.userId,
        corpId: agentCallParams.corpId,
        contactName,
        botImId: agentCallParams.botImId,
        botUserId: agentCallParams.botUserId,
        userMessage: content,
      };
      if (agentResult.outcome?.kind !== 'reply') {
        await this.outcomeFinalizer.commit(agentResult.outcome, sideEffectContext);
      }
      this.reengagementAnchors.handleToolAnchors(agentResult, {
        traceId,
        chatId,
        userId: agentCallParams.userId,
        corpId: agentCallParams.corpId,
        isGroupChat: Boolean(params.primaryMessage.imRoomId),
        channelIdentity: this.buildReengagementChannelIdentity(parsed, params.primaryMessage),
      });

      // 非 reply 终态（skipped 沉默 / guardrail_blocked 守卫拦截 / handoff 转人工）：跳过 WeCom 发送，
      // 但仍完成本轮流水与观测。终态由 runner 共享分类器给出（agentResult.outcome），与主动复聊同源；
      // 守卫拦截（如歧视性筛选条件外露）宁可本轮沉默也不可泄漏。
      if (agentResult.outcome?.kind !== 'reply') {
        if (agentResult.guardrailBlocked) {
          const guardrail = agentResult.guardrailBlocked;
          const phaseLabel = guardrail.phase === 'inbound' ? '入站' : '出站';
          this.logger.warn(
            `${logPrefix}[${contactName}] ${phaseLabel}守卫拦截，跳过消息发送 (rules=${guardrail.ruleIds?.join(',') || '-'})`,
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
        // 回复未送达给候选人：记用户侧记忆但不投影助手轮次，避免下一轮幽灵复聊。
        agentResult.turnFinalizer?.settle({ delivered: false });
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
      await this.commitReplyOutcomeSideEffects(agentResult.outcome, sideEffectContext);

      // Agent 回复真实投递 → agent.replied（仅个人单聊；fire-and-forget）。
      // deliverReply 可能因托管暂停/内部泄漏保护返回 skipped=true，此时不能生成
      // delivered-reply 锚点，否则会排出候选人没收到上一条时的幽灵复聊。
      const replyDelivered = this.wasReplyActuallyDelivered(deliveryResult);
      if (replyDelivered) {
        this.recordAgentReplied(params.primaryMessage, parsed, traceId);
        this.reengagementAnchors.handleDeliveredReplyAnchors(agentResult, {
          traceId,
          chatId,
          userId: agentCallParams.userId,
          corpId: agentCallParams.corpId,
          isGroupChat: Boolean(params.primaryMessage.imRoomId),
          channelIdentity: this.buildReengagementChannelIdentity(parsed, params.primaryMessage),
        });
      }

      // 投递结局已知：仅当回复真实送达才把助手轮次投影进记忆；托管暂停/失败丢弃时
      // 只记用户侧记忆（delivered=false），与上方守卫拦截分支对称。
      agentResult.turnFinalizer?.settle({ delivered: replyDelivered });

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
    } catch (error) {
      // 投递/观测异常：回复未确认送达，但本轮用户消息的记忆收尾（事实提取等）不能一并丢——
      // 否则候选人已提供的姓名/手机号/意向在重试外的路径上永久丢失。只记用户侧，不投影助手轮次。
      // settle 幂等：若前面已按投递结局触发过，这里是 no-op。
      agentResult.turnFinalizer?.settle({ delivered: false });
      throw error;
    } finally {
      // 在方法返回（→ MessageProcessor 释放 chat 处理锁）前等待回合收尾落盘，
      // 保证同一 chat 的记忆写入相对处理锁串行，杜绝跨 job 并发覆盖。
      await agentResult.turnFinalizer?.whenSettled();
    }
  }

  private async commitReplyOutcomeSideEffects(
    outcome: AgentInvokeResult['outcome'],
    context: Parameters<TurnOutcomeInterventionService['commit']>[1],
  ): Promise<void> {
    if (outcome?.kind !== 'reply' || !outcome.sideEffects?.length) return;
    await this.outcomeFinalizer.commit(outcome, context).catch((error: unknown) => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`[ReplyOutcomeSideEffect] dispatch failed: ${errorMessage}`);
    });
  }

  /**
   * 聚合路径终态成功后裁掉已消费的 pending；单消息直发路径 consumedPending 永远是 0，
   * ackPendingMessages 内部会短路。
   *
   * 任何上游异常未走到这里 → 不 ack → pending 保留 → Bull stalled retry 时新 worker 仍能
   * 拿到完整数据继续处理（修复发版 SIGKILL 中断 agent 后候选人消息被吞的问题）。
   *
   * ack 本身失败（simple-merge 内已重试 3 次仍失败）不能让本轮整体失败——回复已发出，
   * 抛错触发 Bull retry 会给候选人再发一遍。但也不能只打日志：滞留的 pending 会被下一个
   * job 并进新批次造成重复回复，必须以飞书告警形式暴露给运维人工介入（清理该 chat 的
   * pending list 或等 5 分钟 TTL 自然过期，期间关注该会话是否产生重复回复）。
   */
  private async ackPendingIfMerged(chatId: string, count: number): Promise<void> {
    if (count <= 0) return;
    try {
      await this.simpleMergeService.ackPendingMessages(chatId, count);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `[${chatId}] ack pending 最终失败（${count} 条），已发告警: ${errorMessage}`,
      );
      void this.alertNotifier
        .sendSimpleAlert(
          '消息 pending ack 失败，存在重复回复风险',
          `chatId=${chatId} 的 ${count} 条已处理消息未能从 pending 队列裁掉（Redis LTRIM 重试 3 次仍失败）。` +
            `这些消息会在 5 分钟 TTL 内被下一个任务并进新批次、可能触发重复回复。` +
            `错误: ${errorMessage}`,
          'error',
        )
        .catch(() => {});
    }
  }

  private async buildSuccessMetadata(
    traceId: string,
    agentResult: AgentInvokeResult,
    deliveryResult: { segmentCount: number },
    scenario: ScenarioType,
    batchId?: string,
  ): Promise<MonitoringMetadata & { fallbackSuccess?: boolean; batchId?: string }> {
    const replyPreview = agentResult.guardrailBlocked
      ? this.buildGuardrailBlockedPreview(agentResult)
      : agentResult.isSkipped
        ? `[主动沉默] ${this.extractSkipReason(agentResult) || '本轮无需回复'}`
        : agentResult.reply.content;
    const guardrailInput: MonitoringMetadata['guardrailInput'] =
      agentResult.guardrailBlocked?.phase === 'inbound'
        ? {
            decision: 'block',
            riskType: agentResult.guardrailBlocked.riskType,
            riskLabel: agentResult.guardrailBlocked.riskLabel,
            reasonCode: agentResult.guardrailBlocked.reasonCode,
            reason: agentResult.guardrailBlocked.reason,
          }
        : undefined;
    const guardrailOutput = agentResult.outcome?.guardrailTrace;
    return this.wecomObservability.buildSuccessMetadata(traceId, {
      scenario,
      batchId,
      replyPreview,
      replySegments: deliveryResult.segmentCount,
      extraResponse: {
        processingTimeMs: agentResult.processingTime,
      },
      guardrailInput,
      guardrailOutput,
    });
  }

  private buildGuardrailBlockedPreview(agentResult: AgentInvokeResult): string {
    const guardrail = agentResult.guardrailBlocked;
    if (!guardrail) return agentResult.reply.content;
    if (guardrail.phase === 'inbound') {
      return `[入站守卫拦截] ${guardrail.riskLabel ?? guardrail.reason ?? '命中风险规则'}`;
    }
    const ruleText = guardrail.ruleIds?.join(',') || guardrail.reasonCode || 'output_guardrail';
    return `[出站守卫拦截 ${ruleText}] ${agentResult.reply.content}`;
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

  private async callAgentWithVisualCompatibilityFallback(
    params: AgentCallParams,
  ): Promise<AgentInvokeResult> {
    try {
      return await this.callAgent(params);
    } catch (error) {
      const imageUrls = params.imageUrls ?? [];
      const imageMessageIds = params.imageMessageIds ?? [];
      if (imageUrls.length === 0 || imageMessageIds.length === 0) {
        throw error;
      }

      this.logger.warn(
        `[${params.contactName ?? params.sessionId}] 多模态 Agent 调用失败，尝试图片描述文本兼容重跑: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      const prepared = await this.prepareRuntimeCompatibilityDescriptions({
        imageUrls,
        imageMessageIds,
        visualMessageTypes: params.visualMessageTypes,
        contactName: params.contactName ?? params.sessionId,
      });
      if (!prepared) {
        throw error;
      }

      return this.callAgent({
        ...params,
        imageUrls: undefined,
        imageMessageIds: undefined,
        visualMessageTypes: undefined,
      });
    }
  }

  private async prepareRuntimeCompatibilityDescriptions(params: {
    imageUrls: string[];
    imageMessageIds: string[];
    visualMessageTypes?: VisualMessageTypes;
    contactName: string;
  }): Promise<boolean> {
    const triggeredIds: string[] = [];
    params.imageMessageIds.forEach((messageId, index) => {
      const imageUrl = params.imageUrls[index];
      if (!messageId || !imageUrl) return;
      const kind = params.visualMessageTypes?.[messageId] ?? MessageType.IMAGE;
      this.imageDescription.describeAndUpdateAsync(messageId, imageUrl, kind);
      triggeredIds.push(messageId);
    });

    if (triggeredIds.length === 0) return false;
    await this.ensureCompatibilityDescriptionsReady(
      triggeredIds,
      params.contactName,
      '',
      '运行时 vision 降级',
    );
    return true;
  }

  private async callAgent(params: AgentCallParams): Promise<AgentInvokeResult> {
    const {
      scenario = 'candidate-consultation',
      messageId,
      recordMonitoring = true,
      userId,
      corpId,
    } = params;

    const startTime = Date.now();
    let shouldRecordAiEnd = false;

    try {
      if (recordMonitoring && messageId) {
        await this.wecomObservability.markAiStart(messageId);
        shouldRecordAiEnd = true;
      }

      const outcome = await this.runner.runTurn({
        trigger: { kind: 'inbound', userMessage: params.userMessage, images: params.imageUrls },
        sessionRef: { corpId, userId, sessionId: params.sessionId },
        context: {
          callerKind: CallerKind.WECOM,
          messageId,
          scenario,
          contactName: params.contactName,
          botUserId: params.botUserId,
          botImId: params.botImId,
          groupId: params.groupId,
          externalUserId: params.externalUserId,
          token: params.token,
          imContactId: params.imContactId,
          imRoomId: params.imRoomId,
          apiType: params.apiType,
          imageMessageIds: params.imageMessageIds,
          visualMessageTypes: params.visualMessageTypes,
          thinking: params.thinking,
          shortTermEndTimeInclusive: params.shortTermEndTimeInclusive,
          onPreparedRequest:
            recordMonitoring && messageId
              ? (agentRequest) =>
                  this.wecomObservability.recordAgentRequest(messageId, agentRequest)
              : undefined,
        },
        modelId: params.modelId,
      });

      const processingTime = Date.now() - startTime;
      const content = outcome.reply?.text ?? outcome.generatedText ?? '';
      const isSkipped = outcome.kind !== 'reply';
      const guardrailBlocked: AgentInvokeResult['guardrailBlocked'] =
        outcome.kind === 'guardrail_blocked' ? outcome.guardrail : undefined;
      const turnFinalizer = TurnFinalizer.from(outcome.runTurnEnd, (err) => {
        const errorMessage = err instanceof Error ? err.message : String(err);
        this.logger.warn(`[${params.contactName}] turn-end lifecycle 执行失败: ${errorMessage}`);
      });

      const invokeResult: AgentInvokeResult = {
        reply: { content, reasoning: outcome.reasoning, usage: outcome.usage },
        isFallback: false,
        isSkipped,
        guardrailBlocked,
        outcome: { ...outcome, runTurnEnd: undefined },
        processingTime,
        toolCalls: outcome.toolCalls,
        agentSteps: outcome.agentSteps,
        guardrailOutput: outcome.guardrailTrace,
        memorySnapshot: outcome.memorySnapshot,
        responseMessages: outcome.responseMessages,
        turnFinalizer,
      };
      if (recordMonitoring && messageId) {
        await this.wecomObservability.recordAgentResult(messageId, invokeResult);
      }

      const shortCircuitedByTool = (outcome.toolCalls ?? []).some(isShortCircuitedToolCall);
      if (!content && outcome.kind === 'skipped' && !shortCircuitedByTool) {
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
        `Agent 调用成功，耗时 ${processingTime}ms，tokens=${outcome.usage?.totalTokens || 'N/A'}${
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

  private resolveAgentUserId(
    messageData: EnterpriseMessageCallbackDto,
    parsed: ReturnType<typeof MessageParser.parse>,
  ): string {
    return parsed.imContactId || messageData.externalUserId || parsed.chatId;
  }

  private resolveCorpId(messageData: EnterpriseMessageCallbackDto): string {
    return messageData.orgId || 'default';
  }

  private wasReplyActuallyDelivered(deliveryResult: {
    segmentCount: number;
    deliveredSegments?: number;
    skipped?: boolean;
  }): boolean {
    if (deliveryResult.skipped) return false;
    return (deliveryResult.deliveredSegments ?? deliveryResult.segmentCount) > 0;
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
              channelIdentity: this.buildReengagementChannelIdentity(parsed, primaryMessage),
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
   * 等待文本兼容路径的图片/表情描述完成（已完成的立即返回；超时则放行）。
   *
   * 正常多模态路径由主模型直接读取 image part，这里不会有 in-flight 描述任务。
   * 只有主模型不支持 vision，或多模态调用失败后进入运行时降级，才依赖图片描述回写短期记忆。
   */
  private async ensureCompatibilityDescriptionsReady(
    visualMessageIds: string[],
    contactName: string,
    logPrefix: string,
    reason = '文本兼容',
  ): Promise<void> {
    if (visualMessageIds.length === 0) return;
    const startedAt = Date.now();
    await this.imageDescription.awaitVision(visualMessageIds, VISION_AWAIT_TIMEOUT_MS);
    const waitedMs = Date.now() - startedAt;
    if (waitedMs > 50) {
      this.logger.log(
        `${logPrefix}[${contactName}] 等待图片描述完成(${reason}): ${waitedMs}ms (${visualMessageIds.length} 张)`,
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

  private buildReengagementChannelIdentity(
    parsed: ReturnType<typeof MessageParser.parse>,
    primaryMessage: EnterpriseMessageCallbackDto,
  ): ReengagementChannelIdentity {
    return {
      candidateName: parsed.contactName,
      managerName: primaryMessage.botUserId,
      botImId: primaryMessage.imBotId,
      imContactId: parsed.imContactId,
      externalUserId: parsed.externalUserId,
    };
  }
}

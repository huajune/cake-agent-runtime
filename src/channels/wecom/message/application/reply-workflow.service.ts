import { ordinaryReplyEffects, readOrdinaryReplyEffects } from './ordinary-reply-effects';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { ReplyTurnsService } from '@biz/reply-execution/reply-turns.service';
import { ReplyDeferredError, type ReplyTurn } from '@biz/reply-execution/reply-execution.types';
import { RUNTIME_RETRY_LIMITS } from '@infra/config/constants/runtime-retry.constants';
import { hasReplayEvidence, attachReplayEvidence } from '@infra/utils/action-receipt.util';
import type { ToolReplayEvidence } from '@shared-types/tool-replay.types';
import { toErrorMessage } from '@infra/utils/error.util';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GroupRouteCredentialsService } from '../credentials/group-route-credentials.service';
import { CallerKind, ScenarioType } from '@enums/agent.enum';
import { MessageType } from '@enums/message-callback.enum';
import { LlmExecutorService } from '@/llm/llm-executor.service';
import { ModelRole } from '@/llm/llm.types';
import { AgentToolCall } from '@shared-types/agent-telemetry.types';
import { MonitoringMetadata } from '@shared-types/tracking.types';
import { AgentRunnerService } from '@agent/runner/agent-runner.service';
import { resolveReplaySkipDecision } from '@agent/runner/turn-outcome';
import {
  isShortCircuitedToolCall,
  collectToolReplayEvidence,
} from '@agent/generator/tool-call-analysis';
import { TurnFinalizer } from '@agent/runner/turn-finalizer';
import {
  ReengagementAnchorService,
  isBookingSucceededCall,
} from '@agent/reengagement/anchor.service';
import { OobReconcileService } from '@agent/reengagement/oob-reconcile.service';
import type { ReengagementChannelIdentity } from '@agent/reengagement/follow-up-scheduler.service';
import { FollowUpSchedulerService } from '@agent/reengagement/follow-up-scheduler.service';
import { MessageTrackingService } from '@biz/monitoring/services/tracking/message-tracking.service';
import { MessageParser } from '../utils/message-parser.util';
import { EnterpriseMessageCallbackDto } from '../ingress/message-callback.dto';
import { DeliveryContext, AgentInvokeResult, DeliveryFailureError, DeliveryResult } from '../types';
import type { AgentError } from '@shared-types/agent-error.types';
import { MessageDeduplicationService } from '../runtime/deduplication.service';
import { MessageRuntimeConfigService } from '../runtime/message-runtime-config.service';
import { MessageDeliveryService } from '../delivery/delivery.service';
import { SimpleMergeService } from '../runtime/simple-merge.service';
import { WecomMessageObservabilityService } from '../telemetry/wecom-message-observability.service';
import { MessageProcessingFailureService } from './message-processing-failure.service';
import { ImageDescriptionService } from './image-description.service';
import { ImageBrandBackfillService } from './image-brand-backfill.service';
import { OpsEventsRecorderService } from '@biz/ops-events/services/ops-events-recorder.service';
import { SessionStateService } from '@memory/short-term/session-state.service';
import { AlertNotifierService } from '@notification/services/alert-notifier.service';
import type { GeneratorThinkingConfig } from '@agent/generator/generator.types';
import { TurnOutcomeInterventionService } from '@agent/runner/turn-outcome-intervention.service';
import { BotService } from '../../bot/bot.service';
import { OPS_EVENT_WRITE_RESULT } from '@biz/ops-events/types/ops-events.types';
import {
  REPLY_TURN_STATUS,
  REPLY_DELIVERY_POLICY,
  REPLY_DELIVERY_OUTCOME,
  REPLY_PROJECTION_STATUS,
  REPLY_REVIEW_REASON,
} from '@biz/reply-execution/reply-execution.constants';
import type { WecomApiType } from '@shared-types/wecom-api.types';
import { WECOM_API_TYPE } from '@shared-types/wecom-api.types';

/**
 * 兼容图片描述等待上限。Vision 调用通常 3-6s；15s 给 ~2.5x 余量。
 * 超时仍未完成时放行，避免单次图片描述卡死整个回合。
 */
const VISION_AWAIT_TIMEOUT_MS = 15_000;

/**
 * 同一回合最多吸收三批 Agent 运行期间到达的新消息。
 *
 * 只允许 replay 一次不够：候选人在第一次 replay 期间继续补充时，新消息会被拆成
 * follow-up，旧回复和新回复紧挨着投递，语义上很像重复发送。三次足以覆盖常见的连续补充，
 * 同时保留硬上限，避免候选人持续输入时一个 worker 永不结束。
 */
const MAX_REPLAY_ATTEMPTS = RUNTIME_RETRY_LIMITS.pendingInputReplays;

type VisualMessageTypes = Record<string, MessageType.IMAGE | MessageType.EMOTION>;

interface AgentCallParams {
  logicalTurnId?: string;
  inputOccurredAt?: string;
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
  apiType?: WecomApiType;
  modelId?: string;
  thinking?: GeneratorThinkingConfig;
  shortTermEndTimeInclusive?: number;
  /** 报名等不可逆工具提交前检查 pending，避免用运行中已过期的候选人资料下单。 */
  hasNewerUserInput?: () => Promise<boolean>;
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
    private readonly imageBrandBackfill: ImageBrandBackfillService,
    private readonly session: SessionStateService,
    private readonly llm: LlmExecutorService,
    private readonly botService: BotService,
    private readonly oobReconcile: OobReconcileService,
    @Optional() private readonly replyTurns?: ReplyTurnsService,
    @Optional() private readonly groupCredentials?: GroupRouteCredentialsService,
    @Optional() private readonly config?: ConfigService,
  ) {}

  async processSingleMessage(messageData: EnterpriseMessageCallbackDto): Promise<void> {
    const parsed = MessageParser.parse(messageData);
    const { chatId, content, contactName, messageId } = parsed;
    const scenario = MessageParser.determineScenario();
    const traceId = messageId;
    const pendingMessageIds = new Set<string>();

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
        pendingMessageIds,
      });
    } catch (error) {
      if (error instanceof ReplyDeferredError) {
        this.logger.warn(error.message);
        // Direct mode has no pending input/job. Retain the exact new message for
        // retry instead of silently dropping it while an earlier turn is unresolved.
        await this.simpleMergeService.addMessage(messageData);
        return;
      }
      const errorType = this.processingFailureService.inferErrorType(error, 'message');
      await this.processingFailureService.handleProcessingError(error, parsed, {
        errorType,
        scenario,
        traceId,
        dispatchMode: 'direct',
        processedMessageIds: [...new Set([messageData.messageId, ...pendingMessageIds])],
      });
      await this.ackProcessedPending(chatId, pendingMessageIds);
    }
  }

  async processMergedMessages(
    messages: EnterpriseMessageCallbackDto[],
    batchId: string,
  ): Promise<void> {
    if (messages.length === 0) return;

    const scenario = MessageParser.determineScenario();
    const lastMessage = messages[messages.length - 1];
    const parsed = MessageParser.parse(lastMessage);
    const { chatId, contactName } = parsed;
    const content = this.wecomObservability.buildMergedRequestContent(messages);
    const traceId = batchId;
    const pendingMessageIds = new Set(messages.map((message) => message.messageId));

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
        pendingMessageIds,
      });
    } catch (error) {
      if (error instanceof ReplyDeferredError) {
        this.logger.warn(error.message);
        return;
      }
      const errorMessage = toErrorMessage(error);
      this.logger.error(`聚合消息处理失败:`, errorMessage);

      const errorType = this.processingFailureService.inferErrorType(error, 'merge');
      await this.processingFailureService.handleProcessingError(error, parsed, {
        errorType,
        scenario,
        traceId,
        batchId,
        dispatchMode: 'merged',
        processedMessageIds: [...pendingMessageIds],
      });

      // handleProcessingError 会发送降级回复/告警并把本批 messageId 置为终态。
      // 此时若继续向 Bull 抛错，pending list 尚未 ack，会被 retry 重放，轻则重复告警，
      // 重则给候选人再发一条降级回复。单实例部署下这里按“失败已兜底”为终态处理。
      await this.ackProcessedPending(chatId, pendingMessageIds);
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
    /** 本轮实际接纳的 pending 身份，包含 replay；由入口共享以覆盖失败收尾。 */
    pendingMessageIds?: Set<string>;
    resumeTurn?: ReplyTurn;
    assertOwned?: () => Promise<void>;
  }): Promise<void> {
    const { traceId, chatId, contactName, scenario, parsed, isSingleMessage, batchContext } =
      params;
    const pendingMessageIds = params.pendingMessageIds ?? new Set<string>();

    const logPrefix = isSingleMessage ? '' : '[聚合处理]';
    // 重跑会扩展本轮消息集合，这几个字段需要是 let。
    let allMessages: EnterpriseMessageCallbackDto[] = batchContext?.allMessages ?? [
      params.primaryMessage,
    ];
    let durableTurn =
      params.resumeTurn ??
      (await this.replyTurns?.open(
        { corpId: this.resolveCorpId(params.primaryMessage), accountId: parsed.imBotId, chatId },
        allMessages.map((message) => message.messageId),
        this.inputOccurredAt(allMessages),
        this.replyRecoveryContext(params.primaryMessage, params.content),
      ));
    if (
      durableTurn?.status === REPLY_TURN_STATUS.SETTLED ||
      durableTurn?.status === REPLY_TURN_STATUS.ACKED
    ) {
      await this.ackDurableTurn(durableTurn, params.assertOwned);
      return;
    }
    if (durableTurn) {
      // Retries can arrive through ordinary ingress after a mode rollback. Route and
      // credentials must still come from the original execute obligation.
      const route = await this.resolveDurableRoute(durableTurn, params.primaryMessage);
      parsed.token = route.token;
      parsed.groupId = route.groupId;
      const members = new Set(durableTurn.inputIds);
      allMessages = allMessages.filter((message) => members.has(message.messageId));
      if (!allMessages.length)
        allMessages = durableTurn.inputIds.map((messageId) => ({
          ...(durableTurn.recovery.primary as EnterpriseMessageCallbackDto),
          token: parsed.token,
          messageId,
        }));
    }
    let content = durableTurn
      ? String(durableTurn.recovery.userMessage ?? params.content)
      : params.content;
    let imageUrls = this.collectImageUrls(allMessages);
    let imageMessageIds = this.collectImageMessageIds(allMessages);
    let visualMessageTypes = this.buildVisualMessageTypes(allMessages);
    let shortTermEndTimeInclusive = this.resolveShortTermEndTimeInclusive(allMessages);

    const { overrideModelId, thinking } = await this.runtimeConfig.resolveWecomChatModelSelection();
    const stableBotUserId =
      (await this.botService.resolveBotUserIdByImBotId(params.primaryMessage.imBotId)) ??
      params.primaryMessage.botUserId?.trim();

    const agentCallParams = {
      sessionId: chatId,
      logicalTurnId: durableTurn?.logicalTurnId,
      inputOccurredAt: durableTurn?.inputOccurredAt,
      scenario,
      messageId: traceId,
      recordMonitoring: true,
      userId: this.resolveAgentUserId(params.primaryMessage, parsed),
      corpId: this.resolveCorpId(params.primaryMessage),
      botUserId: stableBotUserId,
      contactName: parsed.contactName,
      botImId: params.primaryMessage.imBotId,
      groupId: parsed.groupId,
      externalUserId: parsed.externalUserId,
      token: parsed.token,
      imContactId: parsed.imContactId,
      imRoomId: parsed.imRoomId,
      apiType: parsed._apiType,
      modelId: overrideModelId,
      thinking,
      hasNewerUserInput: async () => {
        if (durableTurn?.deliveryPolicy === REPLY_DELIVERY_POLICY.SINGLE_PASS)
          await this.replyTurns!.assertInputActive(durableTurn);
        const { messages: newerMessages } = await this.fetchPendingSinceAgentStart(
          chatId,
          allMessages,
        );
        return newerMessages.length > 0;
      },
    } as const;

    // 读时懒补写：接管/非托管时段沉积的裸图片描述在回合开始时补上
    //（fire-and-forget，本轮不阻塞；描述缺失绝大多数来自无回合时段）。
    this.imageDescription.backfillBareDescriptionsForChat?.(chatId);

    // 每次运行都返回独立的 turn-end 闭包；先由 TurnFinalizer 持有，不在生成结束时执行。
    // 若随后 replay，丢弃本版 finalizer，避免把「未发出的回复」污染到 session 记忆里。
    let agentResult: AgentInvokeResult;
    let deliveryResult: DeliveryResult | undefined;
    let businessEffects: Record<string, unknown> | undefined;
    if (durableTurn?.plan) {
      agentResult = this.restoreReplyResult(durableTurn);
    } else {
      try {
        agentResult = await this.callAgentWithVisualCompatibilityFallback({
          ...agentCallParams,
          userMessage: content,
          imageUrls: imageUrls.length > 0 ? imageUrls : undefined,
          imageMessageIds: imageMessageIds.length > 0 ? imageMessageIds : undefined,
          visualMessageTypes:
            Object.keys(visualMessageTypes).length > 0 ? visualMessageTypes : undefined,
          shortTermEndTimeInclusive,
        });
      } catch (error) {
        if (!durableTurn || !this.replyTurns || error instanceof ReplyDeferredError) throw error;
        // 模型中断前可能已经提交业务动作。未知工具终态不能当作“无需补账”确认输入。
        if (durableTurn.deliveryPolicy === REPLY_DELIVERY_POLICY.SINGLE_PASS)
          throw new ReplyDeferredError(REPLY_REVIEW_REASON.BUSINESS_EFFECTS_UNCONFIRMED);
        await this.processingFailureService.handleProcessingError(error, parsed, {
          scenario,
          traceId,
          processedMessageIds: durableTurn.inputIds,
          deliveryContext: {
            ...this.buildDeliveryContext(parsed, traceId),
            corpId: durableTurn.corpId,
            logicalTurnId: durableTurn.logicalTurnId,
            inputOccurredAt: durableTurn.inputOccurredAt,
            replyTurn: durableTurn,
          },
        });
        await this.ackDurableTurn(await this.replyTurns.settle(durableTurn));
        return;
      }
    }

    this.logger.log(
      `${logPrefix}[${contactName}] Agent 处理完成，耗时 ${agentResult.processingTime}ms，` +
        `tokens=${agentResult.reply.usage?.totalTokens || 'N/A'}`,
    );

    // 回合收尾（记忆投影/事实提取/沉淀）由 agentResult.turnFinalizer（agent 层）封装：触发点
    // 统一收敛到「已知本轮投递结局」之后（守卫拦截/沉默分支 与 投递完成分支各一次 settle），
    // 而非生成结束就立即触发——否则被守卫拦截、托管暂停丢弃或投递失败的回复仍会被写进 session
    // 记忆，造成下一轮以为「已对候选人说过」的幽灵复聊。是否投影助手轮次由 `delivered` 决定。
    // finalizer 内部保证「锁释放前 await 落盘 / replay 丢弃未投递版本 / delivered→includeAssistantText」
    // 这些记忆领域不变式，渠道只负责上报投递结局（见末尾 finally 的 whenSettled）。
    try {
      // 投递前重跑：每次 Agent 生成结束都检查运行期间到达的新消息，并在有界次数内继续
      // 合并重跑。只检查首次生成不够：候选人在第一次 replay 期间继续补充时会被拆成
      // follow-up，导致两批高度相似的回复紧挨着投递。
      let replayAttempt = 0;
      while (!durableTurn && replayAttempt < MAX_REPLAY_ATTEMPTS) {
        // 非 reply outcome（skipped/handoff）与已固化副作用工具均是
        // agent/outcome 层给出的终态：不再拿通道 pending 变化重写这类结果。未抓取的新消息
        // 仍留在 Redis pending list，由 MessageProcessor 末尾补建 follow-up job 处理。
        const replaySkip = resolveReplaySkipDecision(agentResult.outcome, agentResult.toolCalls);
        if (replaySkip.skip) {
          this.logger.warn(
            `${logPrefix}[${contactName}][Replay-Skip] ${replaySkip.reasons.join(
              ',',
            )}，跳过 replay 检测，直接采用当前 outcome (chatId=${chatId})`,
          );
          break;
        }

        // 每次读取当前列表，用原消息身份去重；过期重建后的列表不能沿用旧下标。
        const { messages: newMessages, pendingMessageIds: replayIds } =
          await this.fetchPendingSinceAgentStart(chatId, allMessages);
        for (const id of replayIds) pendingMessageIds.add(id);
        if (newMessages.length === 0) {
          break;
        }

        replayAttempt += 1;
        this.logger.warn(
          `${logPrefix}[${contactName}][Replay ${replayAttempt}/${MAX_REPLAY_ATTEMPTS}] ` +
            `检测到 ${newMessages.length} 条新消息，丢弃当前回复并重新调用 Agent (chatId=${chatId})`,
        );
        // 丢弃当前结果的记忆收尾——它承载了将未投递回复写入 session 记忆的副作用。
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

        agentResult = await this.callAgentWithVisualCompatibilityFallback({
          ...agentCallParams,
          userMessage: content,
          imageUrls: imageUrls.length > 0 ? imageUrls : undefined,
          imageMessageIds: imageMessageIds.length > 0 ? imageMessageIds : undefined,
          visualMessageTypes:
            Object.keys(visualMessageTypes).length > 0 ? visualMessageTypes : undefined,
          shortTermEndTimeInclusive,
        });

        this.logger.log(
          `${logPrefix}[${contactName}][Replay ${replayAttempt}/${MAX_REPLAY_ATTEMPTS}] ` +
            `重跑 Agent 完成，耗时 ${agentResult.processingTime}ms，` +
            `tokens=${agentResult.reply.usage?.totalTokens || 'N/A'}`,
        );
      }
      // turn-end 触发推迟到投递结局已知之后（见下方守卫/投递分支），此处不再立即触发。

      // 图片记忆确定性兜底：多模态主路径的跨轮图片记忆依赖模型自觉调用
      // save_image_description；本轮有图但漏调时用 vision 角色补描述回写 DB，
      // 保证「图片必然沉淀为文字记忆」的下限。全链纯文本时描述已由运行时兼容重跑
      // 确定性写回，方法内部识别并跳过。
      this.backfillMissingImageDescriptions({
        imageMessageIds,
        imageUrls,
        visualMessageTypes,
        overrideModelId,
        toolCalls: agentResult.toolCalls,
        contactName,
        logPrefix,
      });

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

      if (durableTurn && durableTurn.deliveryPolicy !== REPLY_DELIVERY_POLICY.SINGLE_PASS) {
        await params.assertOwned?.();
        const outbound =
          agentResult.outcome?.kind === 'handoff'
            ? (agentResult.outcome.preHandoffReceipt?.text ?? '')
            : agentResult.outcome?.kind === 'reply'
              ? agentResult.reply.content
              : '';
        durableTurn =
          (await this.deliveryService.prepareReplyPlan(
            { content: outbound },
            {
              ...this.buildDeliveryContext(parsed, traceId),
              corpId: durableTurn.corpId,
              logicalTurnId: durableTurn.logicalTurnId,
              inputOccurredAt: durableTurn.inputOccurredAt,
              replyTurn: durableTurn,
              assertOwned: params.assertOwned,
            },
            { agentResult: this.persistableReplyResult(agentResult) },
          )) ?? durableTurn;
      }
      const processedMessageIds =
        durableTurn?.inputIds ?? allMessages.map((message) => message.messageId);
      const sideEffectContext = {
        logicalTurnId: durableTurn?.logicalTurnId,
        traceId,
        chatId,
        userId: agentCallParams.userId,
        corpId: agentCallParams.corpId,
        contactName,
        botImId: agentCallParams.botImId,
        botUserId: agentCallParams.botUserId,
        userMessage: content,
      };
      const reengagementChannelIdentity = this.buildReengagementChannelIdentity(
        parsed,
        params.primaryMessage,
        stableBotUserId,
      );
      const toolAnchorContext = {
        assertOwned: params.assertOwned,
        traceId: durableTurn?.logicalTurnId ?? traceId,
        ...{
          logicalTurnId: durableTurn?.logicalTurnId,
          inputOccurredAt: durableTurn?.inputOccurredAt,
        },
        chatId,
        userId: agentCallParams.userId,
        corpId: agentCallParams.corpId,
        isGroupChat: Boolean(params.primaryMessage.imRoomId),
        channelIdentity: reengagementChannelIdentity,
      };
      if (durableTurn?.deliveryPolicy === REPLY_DELIVERY_POLICY.SINGLE_PASS) {
        businessEffects = ordinaryReplyEffects(agentResult.toolCalls, toolAnchorContext);
        durableTurn = await this.replyTurns!.saveEffects(durableTurn, businessEffects);
      }
      if (agentResult.outcome?.kind !== 'reply') {
        // 同轮已提交的报名/改约/取消结果：先把确定性回执发给候选人，再提交暂停/告警
        // （PRD R5.1 第 3 条）。顺序不能反：暂停后 deliverReply 会因托管暂停被跳过。
        let receiptPending: unknown;
        try {
          await this.deliverPreHandoffReceipt(
            agentResult.outcome,
            parsed,
            traceId,
            contactName,
            durableTurn,
            params.assertOwned,
          );
        } catch (error) {
          receiptPending = error;
        }
        // Safety pause/notification still happen even when the receipt is unresolved.
        await params.assertOwned?.();
        await this.outcomeFinalizer.commit(agentResult.outcome, sideEffectContext);
        if (receiptPending) throw receiptPending;
      }
      const terminalSettled = this.reengagementAnchors.handleToolAnchors(
        agentResult,
        toolAnchorContext,
      );
      // Business anchors are repaired independently from ordinary reply text.
      if (
        durableTurn?.deliveryPolicy === REPLY_DELIVERY_POLICY.SINGLE_PASS &&
        durableTurn.projectionStatus === REPLY_PROJECTION_STATUS.PENDING
      ) {
        await terminalSettled;
        await this.replyTurns!.completeProjection(durableTurn);
        durableTurn.projectionStatus = REPLY_PROJECTION_STATUS.COMPLETE;
      }
      // A durable plan must remain recoverable until its local facts and follow-up jobs persist.
      // Recovery reuses this plan and logical identity; it never regenerates or resubmits tools.
      if (durableTurn) await terminalSettled;
      // 带外工单对账副作用（PRD R2）：只在企微生产回合、渠道层、异步不阻塞回复；
      // 回归测试/调试也走 prepare 且连生产海绵，副作用不能放进 prepare。
      // 必须排在锚点链的终态写入 settle 之后：两条链路并发读-判-写同一会话终态时，
      // 对账按「快照为空」清 booked 可能落在锚点刚写的 booked 之后把它抹掉。
      if (!params.primaryMessage.imRoomId && !params.resumeTurn) {
        const bookingSucceededThisTurn = (agentResult.toolCalls ?? []).some((call) =>
          isBookingSucceededCall(call),
        );
        void terminalSettled
          .catch(() => undefined)
          .then(() =>
            this.oobReconcile.reconcileAfterTurn({
              corpId: agentCallParams.corpId,
              userId: agentCallParams.userId,
              chatId,
              botImId: agentCallParams.botImId ?? null,
              botUserId: agentCallParams.botUserId ?? null,
              traceId,
              channelIdentity: reengagementChannelIdentity,
              bookingSucceededThisTurn,
            }),
          );
      }

      // 非 reply 终态（skipped 静默 / handoff 人工介入意图）：跳过 WeCom 发送，
      // 但仍完成本轮流水与观测。终态由 runner 共享分类器给出（agentResult.outcome），与主动复聊同源；
      // 入站风险或出站无法安全放行时转人工，本轮不自动回复。
      if (agentResult.outcome?.kind !== 'reply') {
        if (agentResult.guardrail) {
          const guardrail = agentResult.guardrail;
          const phaseLabel = guardrail.phase === 'inbound' ? '入站' : '出站';
          const dispositionLabel =
            agentResult.outcome?.kind === 'handoff' ? '转人工意图' : '有意静默';
          this.logger.warn(
            `${logPrefix}[${contactName}] ${phaseLabel}守卫${dispositionLabel}，跳过消息发送 (rules=${guardrail.ruleIds?.join(',') || '-'})`,
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
        // 转人工或有意沉默也是成功处理：推进复聊「已处理」水位，与旧的回话即停行为保持一致。
        await params.assertOwned?.();
        await this.advanceProcessedCandidateWatermark(
          params.primaryMessage,
          agentCallParams,
          allMessages,
          Boolean(durableTurn),
        );
        if (durableTurn && this.replyTurns)
          await this.settleAndAckTurn(durableTurn, params.assertOwned);
        else {
          await this.markMessagesAsProcessed(processedMessageIds);
          await this.ackProcessedPending(chatId, pendingMessageIds);
        }
        return;
      }

      const deliveryContext = {
        ...this.buildDeliveryContext(parsed, traceId),
        corpId: durableTurn?.corpId,
        logicalTurnId: durableTurn?.logicalTurnId,
        inputOccurredAt: durableTurn?.inputOccurredAt,
        replyTurn: durableTurn,
        assertOwned: params.assertOwned,
      };
      deliveryResult = await this.deliveryService.deliverReply(
        agentResult.reply,
        deliveryContext,
        true,
      );
      // deliverReply 可能因托管暂停/内部泄漏保护返回 skipped=true，此时不能生成
      // delivered-reply 锚点，否则会排出候选人没收到上一条时的幽灵复聊。
      const replyDelivered = this.wasReplyActuallyDelivered(deliveryResult);
      await params.assertOwned?.();
      await this.commitReplyOutcomeSideEffects(agentResult.outcome, sideEffectContext, {
        replyDelivered,
      });

      // Agent 回复真实投递 → agent.replied（仅个人单聊；锚点读取必须先于回合 settle）。
      if (replyDelivered) {
        const reengagementAnchorContext = {
          assertOwned: params.assertOwned,
          traceId: durableTurn?.logicalTurnId ?? traceId,
          ...{
            logicalTurnId: durableTurn?.logicalTurnId,
            inputOccurredAt: durableTurn?.inputOccurredAt,
          },
          chatId,
          userId: agentCallParams.userId,
          corpId: agentCallParams.corpId,
          isGroupChat: Boolean(params.primaryMessage.imRoomId),
          channelIdentity: this.buildReengagementChannelIdentity(
            parsed,
            params.primaryMessage,
            stableBotUserId,
          ),
        };
        // 先确认这是不是本会话首条开场回复。开场本身即使询问了位置，也只排
        // opening_no_reply；不能同时排 address_missing，否则候选人持续沉默时会被连追两次。
        await params.assertOwned?.();
        const replyKind = await this.recordAgentReplied(
          params.primaryMessage,
          parsed,
          durableTurn?.logicalTurnId ?? traceId,
          stableBotUserId,
          durableTurn ? { turn: durableTurn, assertOwned: params.assertOwned } : undefined,
        );
        // 必须先于 settle 等待：推店锚点要读本轮计数 +1 前的
        // storePresentationRounds，否则第一轮可能被误判为升档。
        await this.reengagementAnchors
          .handleDeliveredReplyAnchors(agentResult, {
            ...reengagementAnchorContext,
            suppressAddressMissing: replyKind !== 'reply',
          })
          .catch((error: unknown) => {
            // Durable plans retain pending local work for recovery of the same reply.
            if (durableTurn) throw error;
            // Delivery is already confirmed. An auxiliary queue outage must not send
            // a second, contradictory fallback reply through the generic error path.
            this.logger.error(`已投递回复的复聊排程失败: ${toErrorMessage(error)}`);
          });
      }

      // 投递结局已知：仅当回复真实送达才把助手轮次投影进记忆；托管暂停/失败丢弃时
      // 只记用户侧记忆（delivered=false），与上方守卫拦截分支对称。
      agentResult.turnFinalizer?.settle({
        delivered:
          deliveryResult.acceptedText !== undefined
            ? Boolean(deliveryResult.acceptedText)
            : replyDelivered,
        acceptedText: deliveryResult.acceptedText,
      });

      const successMetadata = await this.buildSuccessMetadata(
        traceId,
        agentResult,
        deliveryResult,
        scenario,
        batchContext?.batchId,
      );

      this.monitoringService.recordSuccess(traceId, successMetadata);
      await params.assertOwned?.();
      await this.advanceProcessedCandidateWatermark(
        params.primaryMessage,
        agentCallParams,
        allMessages,
        Boolean(durableTurn),
      );
      if (durableTurn && this.replyTurns)
        await this.settleAndAckTurn(durableTurn, params.assertOwned);
      else {
        await this.markMessagesAsProcessed(processedMessageIds);
        await this.ackProcessedPending(chatId, pendingMessageIds);
      }

      if (!batchContext) {
        this.logger.debug(`[${contactName}] 请求流水 [${traceId}] 已标记为已处理`);
      }
    } catch (error) {
      // 投递/观测异常：回复未确认送达，但本轮用户消息的记忆收尾（事实提取等）不能一并丢——
      // 否则候选人已提供的姓名/手机号/意向在重试外的路径上永久丢失。只记用户侧，不投影助手轮次。
      // settle 幂等：若前面已按投递结局触发过，这里是 no-op。
      const deliveryFailure = error instanceof DeliveryFailureError ? error.result : deliveryResult;
      agentResult.turnFinalizer?.settle({
        delivered: Boolean(deliveryFailure?.acceptedText),
        acceptedText: deliveryFailure?.acceptedText,
      });
      if (durableTurn?.deliveryPolicy === REPLY_DELIVERY_POLICY.SINGLE_PASS) {
        // 只重试同一份最小业务结果，绝不重跑工具。仍写不进去则保留原输入待核实。
        if (durableTurn.projectionStatus === REPLY_PROJECTION_STATUS.NONE) {
          if (!businessEffects)
            throw new ReplyDeferredError(REPLY_REVIEW_REASON.BUSINESS_EFFECTS_UNCONFIRMED);
          durableTurn = await this.replyTurns!.saveEffects(durableTurn, businessEffects);
        }
        // Finish the original input even when text is incomplete. Never re-run its model/tools.
        // A failed terminal write is ack-only work after the lease expires, not a new send.
        await this.processingFailureService.handleProcessingError(
          error instanceof DeliveryFailureError
            ? error
            : new DeliveryFailureError(
                toErrorMessage(error),
                deliveryFailure ?? {
                  success: false,
                  segmentCount: 0,
                  deliveredSegments: 0,
                  failedSegments: 0,
                  totalTime: 0,
                },
              ),
          parsed,
          { scenario, traceId, processedMessageIds: durableTurn.inputIds },
        );
        const settled = await this.replyTurns!.settle(durableTurn, {
          outcome: deliveryFailure?.unknownSegments
            ? REPLY_DELIVERY_OUTCOME.UNKNOWN
            : REPLY_DELIVERY_OUTCOME.INCOMPLETE,
          accepted: deliveryFailure?.deliveredSegments ?? 0,
          total: deliveryFailure?.segmentCount ?? 0,
        });
        await this.ackDurableTurn(settled, params.assertOwned);
        return;
      }
      if (durableTurn && !(error instanceof ReplyDeferredError))
        throw new ReplyDeferredError('reply_local_repair_pending');
      throw error;
    } finally {
      // 在方法返回（→ MessageProcessor 释放 chat 处理锁）前等待回合收尾落盘，
      // 保证同一 chat 的记忆写入相对处理锁串行，杜绝跨 job 并发覆盖。
      await agentResult.turnFinalizer?.whenSettled();

      // 图片描述缺失兜底（§10.3）：回合终局确定后，用结构化 messageType + 本轮
      // save_image_description 工具调用记录检测缺描述的图片，触发异步 Vision 补写
      // （fire-and-forget，补写链路自行重新持锁 + 过期即弃）。只救下一轮状态。
      try {
        const missing = this.imageBrandBackfill.detectMissingImages({
          imageMessageIds,
          imageUrls,
          visualMessageTypes,
          toolCalls: agentResult.toolCalls,
        });
        this.imageBrandBackfill.scheduleBackfill({
          corpId: agentCallParams.corpId,
          userId: agentCallParams.userId,
          sessionId: chatId,
          chatId,
          missing,
          turnMs: Date.now(),
        });
      } catch (backfillError) {
        this.logger.warn(
          `${logPrefix}[${contactName}] 图片描述补写触发失败: ${toErrorMessage(backfillError)}`,
        );
      }
    }
  }

  /** Repair uses saved output and IDs even after Redis pending expires; never calls the model. */
  async resumePersistedReply(
    turn: ReplyTurn,
    token: string,
    assertOwned?: () => Promise<void>,
  ): Promise<void> {
    await assertOwned?.();
    if (turn.status === REPLY_TURN_STATUS.SETTLED || turn.status === REPLY_TURN_STATUS.ACKED) {
      await this.ackDurableTurn(turn, assertOwned);
      return;
    }
    if (turn.deliveryPolicy === REPLY_DELIVERY_POLICY.SINGLE_PASS) {
      await assertOwned?.();
      await this.ackDurableTurn(await this.replyTurns!.interrupt(turn), assertOwned);
      return;
    }
    if (!turn.plan) throw new ReplyDeferredError('no_recoverable_reply_plan');
    const primary = { ...(turn.recovery.primary as EnterpriseMessageCallbackDto), token };
    const parsed = MessageParser.parse(primary);
    const traceId = `reply-recovery_${randomUUID()}`;
    const scenario = MessageParser.determineScenario();
    const content = String(turn.recovery.userMessage ?? '');
    await this.wecomObservability.startRequestTrace({
      traceId,
      primaryMessage: primary,
      scenario,
      content,
    });
    await this.wecomObservability.updateDispatch(traceId, 'direct');
    await this.wecomObservability.markWorkerStart(traceId);
    await this.processMessageCore({
      primaryMessage: primary,
      traceId,
      chatId: turn.chatId,
      content,
      contactName: parsed.contactName,
      scenario,
      parsed,
      isSingleMessage: true,
      resumeTurn: turn,
      assertOwned,
    });
  }

  private async resolveDurableRoute(
    turn: ReplyTurn,
    message: EnterpriseMessageCallbackDto,
  ): Promise<{ token: string; groupId?: string }> {
    const primary = turn.recovery.primary as Partial<EnterpriseMessageCallbackDto> | undefined;
    const apiType = primary?._apiType ?? WECOM_API_TYPE.ENTERPRISE;
    if (
      !primary ||
      primary.orgId !== turn.corpId ||
      primary.imBotId !== turn.accountId ||
      primary.chatId !== turn.chatId ||
      message.orgId !== turn.corpId ||
      message.imBotId !== turn.accountId ||
      message.chatId !== turn.chatId ||
      (message._apiType ?? WECOM_API_TYPE.ENTERPRISE) !== apiType ||
      (message.groupId !== undefined && message.groupId !== primary.groupId) ||
      message.imContactId !== primary.imContactId ||
      message.imRoomId !== primary.imRoomId
    )
      throw new ReplyDeferredError('recovery_route_identity_mismatch');

    if (apiType === WECOM_API_TYPE.GROUP) {
      try {
        const route = await this.groupCredentials?.resolveForRecovery({
          corpId: turn.corpId,
          accountId: turn.accountId,
          groupId: primary.groupId,
        });
        if (route) return route;
      } catch {
        // A directory failure cannot fall through to a new model run or fallback send.
      }
      throw new ReplyDeferredError('group_credential_resolution');
    }
    const token = this.config?.get<string>('STRIDE_ENTERPRISE_TOKEN')?.trim();
    if (!token) throw new ReplyDeferredError('enterprise_credential_resolution');
    if (!turn.plan) {
      const expected = Buffer.from(token);
      const supplied = Buffer.from(typeof message.token === 'string' ? message.token : '');
      if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied))
        throw new ReplyDeferredError('enterprise_callback_unverified');
    }
    return { token, groupId: primary.groupId };
  }

  private async settleAndAckTurn(
    turn: ReplyTurn,
    assertOwned?: () => Promise<void>,
  ): Promise<void> {
    await assertOwned?.();
    const settled = await this.replyTurns!.settle(turn);
    await this.ackDurableTurn(settled, assertOwned);
  }

  private async ackDurableTurn(turn: ReplyTurn, assertOwned?: () => Promise<void>): Promise<void> {
    try {
      await assertOwned?.();
      if (
        turn.deliveryPolicy === REPLY_DELIVERY_POLICY.SINGLE_PASS &&
        turn.projectionStatus === REPLY_PROJECTION_STATUS.NONE
      )
        throw new ReplyDeferredError(REPLY_REVIEW_REASON.BUSINESS_EFFECTS_UNCONFIRMED);
      if (
        turn.deliveryPolicy === REPLY_DELIVERY_POLICY.SINGLE_PASS &&
        turn.projectionStatus === REPLY_PROJECTION_STATUS.PENDING
      ) {
        const effects = readOrdinaryReplyEffects(turn.recovery.effects);
        await this.reengagementAnchors.handleToolAnchors(
          { toolCalls: effects.toolCalls },
          { ...effects.context, assertOwned },
        );
        await this.replyTurns!.completeProjection(turn);
      }
      await this.simpleMergeService.ackPendingMessageIds(turn.chatId, turn.inputIds);
      for (const id of turn.inputIds) {
        await assertOwned?.();
        await this.deduplicationService.markMessageAsProcessedAsync(id);
      }
      await assertOwned?.();
      await this.replyTurns?.acked(turn);
    } catch {
      throw new ReplyDeferredError('ack_repair_pending');
    }
  }

  private inputOccurredAt(messages: EnterpriseMessageCallbackDto[]): string {
    const times = messages
      .map((message) => this.resolveStoredMessageTimestamp(message))
      .filter((value): value is number => Number.isFinite(value) && (value ?? 0) > 0);
    return times.length ? new Date(Math.min(...times)).toISOString() : '';
  }

  private replyRecoveryContext(
    message: EnterpriseMessageCallbackDto,
    userMessage: string,
  ): Record<string, unknown> {
    const {
      orgId,
      imBotId,
      imContactId,
      imRoomId,
      contactName,
      botUserId,
      externalUserId,
      groupId,
      timestamp,
      messageId,
      chatId,
      source,
      _apiType,
    } = message;
    return {
      userMessage,
      primary: {
        orgId,
        imBotId,
        imContactId,
        imRoomId,
        contactName,
        botUserId,
        externalUserId,
        groupId,
        timestamp,
        messageId,
        chatId,
        source,
        _apiType,
        messageType: MessageType.TEXT,
        isSelf: false,
        payload: { text: userMessage },
      },
    };
  }

  private persistableReplyResult(result: AgentInvokeResult): Record<string, unknown> {
    // Keep outcome/anchor repair input, omit full memory/model response/telemetry snapshots.
    const source = result.outcome;
    const outcome = source
      ? {
          kind: source.kind,
          reply: source.reply,
          preHandoffReceipt: source.preHandoffReceipt,
          toolCalls: source.toolCalls,
          disposition: source.disposition,
          guardrail: source.guardrail,
          sideEffects: source.sideEffects,
          handoff: source.handoff,
        }
      : { kind: 'reply', toolCalls: [] };
    return {
      reply: { content: result.reply.content },
      outcome,
      isFallback: result.isFallback,
      isSkipped: result.isSkipped,
      guardrail: result.guardrail,
      toolCalls: result.toolCalls,
      processingTime: 0,
    };
  }

  private restoreReplyResult(turn: ReplyTurn): AgentInvokeResult {
    const saved = turn.plan?.resume?.agentResult;
    return saved
      ? (saved as AgentInvokeResult)
      : {
          reply: { content: turn.plan?.text ?? '' },
          outcome: { kind: 'reply', reply: { text: turn.plan?.text ?? '' }, toolCalls: [] },
          isFallback: true,
          processingTime: 0,
        };
  }

  private async commitReplyOutcomeSideEffects(
    outcome: AgentInvokeResult['outcome'],
    context: Parameters<TurnOutcomeInterventionService['commit']>[1],
    options: { replyDelivered: boolean },
  ): Promise<void> {
    if (outcome?.kind !== 'reply' || !outcome.sideEffects?.length) return;
    // 承诺对账补的介入只在承诺真的送到候选人手上时才成立：回复被托管暂停/泄漏保护丢弃时，
    // 候选人根本没听到「会有人跟进」，补介入只会让运营去兑现一句没说出口的话。
    const sideEffects = options.replyDelivered
      ? outcome.sideEffects
      : outcome.sideEffects.filter((intent) => {
          const dropped =
            intent.kind === 'general_handoff' && intent.origin === 'promise_reconciliation';
          if (dropped) {
            this.logger.warn(
              `[ReplyOutcomeSideEffect] 回复未投递，跳过承诺对账补介入: chatId=${context.chatId}`,
            );
          }
          return !dropped;
        });
    if (sideEffects.length === 0) return;
    await this.outcomeFinalizer
      .commit({ ...outcome, sideEffects }, context)
      .catch((error: unknown) => {
        const errorMessage = toErrorMessage(error);
        this.logger.error(`[ReplyOutcomeSideEffect] dispatch failed: ${errorMessage}`);
      });
  }

  /**
   * handoff 终态前的已提交动作回执（报名成功/改约成功/取消成功）。文本由 runner 从工具结构化
   * 字段拼成；投递失败只记日志，不阻断随后的暂停/告警。
   */
  private async deliverPreHandoffReceipt(
    outcome: AgentInvokeResult['outcome'],
    parsed: ReturnType<typeof MessageParser.parse>,
    traceId: string,
    contactName: string,
    durableTurn?: ReplyTurn,
    assertOwned?: () => Promise<void>,
  ): Promise<void> {
    if (outcome?.kind !== 'handoff' || !outcome.preHandoffReceipt?.text.trim()) return;
    const receipt = outcome.preHandoffReceipt;
    try {
      const result = await this.deliveryService.deliverReply(
        { content: receipt.text },
        {
          ...this.buildDeliveryContext(parsed, traceId),
          corpId: durableTurn?.corpId,
          logicalTurnId: durableTurn?.logicalTurnId,
          inputOccurredAt: durableTurn?.inputOccurredAt,
          replyTurn: durableTurn,
          assertOwned,
        },
        false,
      );
      this.logger.warn(
        `[${contactName}] 转人工前先投递已提交动作回执: sources=${receipt.sources.join(',')}, delivered=${this.wasReplyActuallyDelivered(result)}`,
      );
    } catch (error) {
      if (error instanceof ReplyDeferredError) throw error;
      this.logger.error(
        `[${contactName}] 转人工前回执投递失败（继续提交介入）: ${toErrorMessage(error)}`,
      );
    }
  }

  /**
   * 非持久回合在投递、静默或失败兜底终态后，只确认实际接纳的 pending 身份。
   * 确认耗尽重试后告警，不重放已发回复；人工处理也只能核对这些原消息，不能清空列表。
   */
  private async ackProcessedPending(
    chatId: string,
    messageIds: ReadonlySet<string>,
  ): Promise<void> {
    if (!messageIds.size) return;
    try {
      await this.simpleMergeService.ackPendingMessageIds(chatId, [...messageIds]);
    } catch (error) {
      const errorMessage = toErrorMessage(error);
      this.logger.error(
        `[${chatId}] ack pending 最终失败（${messageIds.size} 个消息身份）: ${errorMessage}`,
      );
      void this.alertNotifier
        .sendSimpleAlert(
          '消息 pending ack 失败，存在重复回复风险',
          `chatId=${chatId} 的 ${messageIds.size} 条已处理消息按原 ID 确认失败（Redis 重试 3 次仍失败）。` +
            `原消息 ID=${[...messageIds].join(',')}。请按原消息核实，保留后来入队的输入。` +
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
    const replyPreview = agentResult.guardrail
      ? this.buildGuardrailPreview(agentResult)
      : agentResult.outcome?.kind === 'handoff'
        ? `[转人工意图] ${this.extractSkipReason(agentResult) || '本轮要求人工处理'}`
        : agentResult.isSkipped
          ? `[主动沉默] ${this.extractSkipReason(agentResult) || '本轮无需回复'}`
          : agentResult.reply.content;
    const guardrailInput: MonitoringMetadata['guardrailInput'] =
      agentResult.guardrail?.phase === 'inbound'
        ? {
            decision: 'handoff',
            riskType: agentResult.guardrail.riskType,
            riskLabel: agentResult.guardrail.riskLabel,
            reasonCode: agentResult.guardrail.reasonCode,
            reason: agentResult.guardrail.reason,
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

  private buildGuardrailPreview(agentResult: AgentInvokeResult): string {
    const guardrail = agentResult.guardrail;
    if (!guardrail) return agentResult.reply.content;
    if (guardrail.phase === 'inbound') {
      return `[入站转人工意图] ${guardrail.riskLabel ?? guardrail.reason ?? '命中风险规则'}`;
    }
    const ruleText = guardrail.ruleIds?.join(',') || guardrail.reasonCode || 'output_guardrail';
    const label = agentResult.outcome?.kind === 'handoff' ? '出站转人工意图' : '出站有意静默';
    return `[${label} ${ruleText}] ${agentResult.reply.content}`;
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
          const errorMessage = toErrorMessage(err);
          this.logger.warn(`[请求流水] 去重标记失败 [${messageId}]: ${errorMessage}`);
        });
      }),
    );
  }

  private async callAgentWithVisualCompatibilityFallback(
    params: AgentCallParams,
  ): Promise<AgentInvokeResult> {
    // One allowance per input snapshot; a visual retry processes the same messages.
    const toolCallCounts = new Map<string, number>();
    try {
      return await this.callAgent(params, toolCallCounts);
    } catch (error) {
      if (hasReplayEvidence(error) || RUNTIME_RETRY_LIMITS.imageCompatibilityRetries < 1) {
        this.logger.warn(
          `[${params.contactName ?? params.sessionId}] 图片兼容重跑已阻断：本轮存在禁止重做的动作证据`,
        );
        throw error;
      }
      const imageUrls = params.imageUrls ?? [];
      const imageMessageIds = params.imageMessageIds ?? [];
      if (imageUrls.length === 0 || imageMessageIds.length === 0) {
        throw error;
      }

      this.logger.warn(
        `[${params.contactName ?? params.sessionId}] 多模态 Agent 调用失败，尝试图片描述文本兼容重跑: ${toErrorMessage(
          error,
        )}`,
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

      return this.callAgent(
        {
          ...params,
          imageUrls: undefined,
          imageMessageIds: undefined,
          visualMessageTypes: undefined,
        },
        toolCallCounts,
      );
    }
  }

  /**
   * 图片记忆确定性兜底（仅多模态主路径生效）。
   *
   * 链上有认图候选时，图片以原图直达 Agent，跨轮记忆依赖模型自觉调用
   * save_image_description 固化为文字；模型漏调时这里用 vision 角色异步补描述回写，
   * 把「图片跨轮记忆必然存在」从模型自觉降级为确定性下限。
   * 全链纯文本时描述已由运行时兼容重跑（多模态调用失败→转写后重跑）确定性写回，直接返回避免重复描述。
   */
  private backfillMissingImageDescriptions(params: {
    imageMessageIds: string[];
    imageUrls: string[];
    visualMessageTypes: VisualMessageTypes;
    overrideModelId?: string;
    toolCalls?: AgentToolCall[];
    contactName: string;
    logPrefix: string;
  }): void {
    const { imageMessageIds, imageUrls, visualMessageTypes, toolCalls, contactName, logPrefix } =
      params;
    if (imageMessageIds.length === 0) return;

    void (async () => {
      try {
        const visionCapable = await this.llm.supportsVisionInput({
          role: ModelRole.Chat,
          modelId: params.overrideModelId,
        });
        if (!visionCapable) return;

        const savedIds = new Set(
          (toolCalls ?? [])
            .filter((call) => call.toolName === 'save_image_description')
            .map((call) => call.args?.messageId)
            .filter((messageId): messageId is string => typeof messageId === 'string'),
        );

        imageMessageIds.forEach((messageId, index) => {
          if (savedIds.has(messageId)) return;
          const imageUrl = imageUrls[index];
          if (!imageUrl) return;
          this.logger.warn(
            `${logPrefix}[${contactName}] 图片轮未调用 save_image_description，触发 vision 兜底补描述: ${messageId}`,
          );
          this.imageDescription.describeAndUpdateAsync(
            messageId,
            imageUrl,
            visualMessageTypes[messageId] ?? MessageType.IMAGE,
          );
        });
      } catch (error) {
        this.logger.warn(`${logPrefix}[${contactName}] 图片描述兜底触发失败`, error);
      }
    })();
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

  private async callAgent(
    params: AgentCallParams,
    toolCallCounts: Map<string, number>,
  ): Promise<AgentInvokeResult> {
    const {
      scenario = 'candidate-consultation',
      messageId,
      recordMonitoring = true,
      userId,
      corpId,
    } = params;

    const startTime = Date.now();
    let shouldRecordAiEnd = false;
    let replayBlockedBy: ToolReplayEvidence[] = [];

    try {
      if (recordMonitoring && messageId) {
        await this.wecomObservability.markAiStart(messageId);
        shouldRecordAiEnd = true;
      }

      const outcome = await this.runner.runInboundTurn({
        input: { text: params.userMessage, images: params.imageUrls },
        sessionRef: { corpId, userId, sessionId: params.sessionId },
        context: {
          callerKind: CallerKind.WECOM,
          logicalTurnId: params.logicalTurnId,
          toolCallCounts,
          inputOccurredAt: params.inputOccurredAt,
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
          hasNewerUserInput: params.hasNewerUserInput,
          onPreparedRequest:
            recordMonitoring && messageId
              ? (agentRequest) =>
                  this.wecomObservability.recordAgentRequest(messageId, agentRequest)
              : undefined,
        },
        modelId: params.modelId,
      });

      replayBlockedBy = collectToolReplayEvidence(outcome.toolCalls ?? []);
      const processingTime = Date.now() - startTime;
      const content = outcome.reply?.text ?? outcome.generatedText ?? '';
      const isSkipped = outcome.kind !== 'reply';
      const guardrail: AgentInvokeResult['guardrail'] = outcome.guardrail;
      const turnFinalizer = TurnFinalizer.from(outcome.runTurnEnd, (err) => {
        const errorMessage = toErrorMessage(err);
        this.logger.warn(`[${params.contactName}] turn-end lifecycle 执行失败: ${errorMessage}`);
      });

      const invokeResult: AgentInvokeResult = {
        reply: { content, reasoning: outcome.reasoning, usage: outcome.usage },
        isFallback: false,
        isSkipped,
        guardrail,
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
      const intentionalSilence =
        outcome.guardrail?.phase === 'outbound' && Boolean(outcome.guardrail.reasonCode);
      if (!content && outcome.kind === 'skipped' && !shortCircuitedByTool && !intentionalSilence) {
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
          outcome.kind === 'handoff' ? '，本轮转人工意图' : isSkipped ? '，本轮主动沉默' : ''
        }`,
      );

      return invokeResult;
    } catch (error) {
      const errorMessage = toErrorMessage(error);
      this.logger.error(`Agent 调用异常: ${errorMessage}`);
      if (hasReplayEvidence(error)) {
        replayBlockedBy = (error as AgentError).agentMeta.replayBlockedBy;
      }
      throw attachReplayEvidence(error, replayBlockedBy);
    } finally {
      if (shouldRecordAiEnd && messageId) {
        try {
          await this.wecomObservability.markAiEnd(messageId);
        } catch (error) {
          throw attachReplayEvidence(error, replayBlockedBy);
        }
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

  /**
   * 回合成功收尾（正常投递或有意沉默）后推进「候选人消息已处理」水位，取本轮消费的
   * 候选人消息最大回调时间戳——与入站层 lastCandidateMessageAt 同一时间源可直接比对。
   * timeout 静默丢弃的消息永远不会走到这里，复聊 shouldStop 据此识别无人搭理的回话。
   * 仅个人单聊（与 lastCandidateMessageAt 口径对齐）；fire-and-forget，失败不影响主流程。
   */
  private async advanceProcessedCandidateWatermark(
    primaryMessage: EnterpriseMessageCallbackDto,
    sessionRef: { corpId: string; userId: string; sessionId: string },
    allMessages: EnterpriseMessageCallbackDto[],
    strict = false,
  ): Promise<void> {
    if (primaryMessage.imRoomId) return;
    const maxTimestamp = allMessages.reduce((max, message) => {
      const timestamp = Number(message.timestamp);
      return Number.isFinite(timestamp) && timestamp > max ? timestamp : max;
    }, 0);
    if (maxTimestamp <= 0) return;
    await this.session
      .recordCandidateMessagesProcessed(
        sessionRef.corpId,
        sessionRef.userId,
        sessionRef.sessionId,
        new Date(maxTimestamp),
      )
      .catch((error: unknown) => {
        if (strict) throw error;
        this.logger.warn(
          `[reengagement] lastProcessedCandidateMessageAt 写入失败 [${sessionRef.sessionId}]: ${toErrorMessage(
            error,
          )}`,
        );
      });
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
   * 执行档用原逻辑回合绑定开场事件并等待排程；恢复重复插入仍识别同一开场回合。
   * 兼容路径保留旧 trace 幂等与非阻断行为。
   */
  private async recordAgentReplied(
    primaryMessage: EnterpriseMessageCallbackDto,
    parsed: ReturnType<typeof MessageParser.parse>,
    traceId: string,
    stableBotUserId?: string,
    durable?: { turn: ReplyTurn; assertOwned?: () => Promise<void> },
  ): Promise<'opening' | 'reply' | 'unknown'> {
    if (primaryMessage.imRoomId) return 'unknown'; // 群聊不计入候选人漏斗
    const botImId = primaryMessage.imBotId;
    const corpId = this.resolveCorpId(primaryMessage);
    const userId = this.resolveAgentUserId(primaryMessage, parsed);
    const chatId = parsed.chatId;

    try {
      const openingInput = {
        corpId,
        eventName: 'agent.opening_sent' as const,
        idempotencyKey: `${chatId}:opening`,
        botImId,
        managerName: primaryMessage.botUserId,
        sourceChannel: 'unknown',
        userId,
        chatId,
        ...(durable ? { occurredAt: durable.turn.inputOccurredAt } : {}),
      };
      const owned = durable?.assertOwned ? { assertOwned: durable.assertOwned } : undefined;
      await durable?.assertOwned?.();
      const openingResult = durable
        ? (await this.opsEventsRecorder.recordOpeningDurably(
            openingInput,
            durable.turn.logicalTurnId,
            owned,
          ))
          ? 'inserted'
          : 'duplicate'
        : await this.opsEventsRecorder.recordEventDetailed(openingInput);

      // 写入失败（DB 不可用 / 熔断 OPEN / RPC 异常）时，无法判定本条是否开场白：
      // 不能据此误记为 agent.replied（否则开场白行永远缺失且不可恢复）。
      // 跳过本轮分类——开场白行未写入，后续回复会再次尝试插入并正确判定。
      if (openingResult === OPS_EVENT_WRITE_RESULT.FAILED) {
        this.logger.warn(
          `[漏斗] 开场白事件写入失败，跳过本轮开场白/回复分类，等待后续重试 [${traceId}]`,
        );
        return 'unknown';
      }

      const isOpening = openingResult === OPS_EVENT_WRITE_RESULT.INSERTED;
      if (isOpening) {
        // 开场白已记录（agent.opening_sent）= reengagement opening_no_reply 场景锚点：
        // 排一个 15min 后的复聊 delayed job（shadow 模式只排程不发；processor 到点会读权威态
        // 做 shouldStop——候选人已回则丢弃）。fire-and-forget，失败不影响主漏斗。
        await durable?.assertOwned?.();
        const scheduled = this.followUpScheduler.scheduleFollowUp({
          sessionRef: { corpId, userId, sessionId: chatId },
          scenarioCode: 'opening_no_reply',
          anchorEventId: 'opening',
          anchorAt: durable ? Date.parse(durable.turn.inputOccurredAt) : Date.now(),
          channelIdentity: this.buildReengagementChannelIdentity(
            parsed,
            primaryMessage,
            stableBotUserId,
          ),
        });
        if (durable) {
          const result = await scheduled;
          if (result?.reason === 'enqueue_error') throw new Error('Opening schedule not persisted');
        } else
          void scheduled.catch((error: unknown) => {
            this.logger.warn(
              `[reengagement] opening 锚点排程失败 [${traceId}]: ${toErrorMessage(error)}`,
            );
          });
        // 开场白已记录（agent.opening_sent），本轮无需再记 agent.replied
        return 'opening';
      }

      const repliedInput = {
        corpId,
        eventName: 'agent.replied' as const,
        idempotencyKey: `${traceId}:replied`,
        botImId,
        managerName: primaryMessage.botUserId,
        sourceChannel: 'unknown',
        userId,
        chatId,
        ...(durable ? { occurredAt: durable.turn.inputOccurredAt } : {}),
      };
      await durable?.assertOwned?.();
      if (durable) await this.opsEventsRecorder.recordEventDurably(repliedInput, owned);
      else await this.opsEventsRecorder.recordEvent(repliedInput);
      return 'reply';
    } catch (error) {
      const errorMessage = toErrorMessage(error);
      this.logger.warn(`[漏斗] agent 回复事件记录失败 [${traceId}]: ${errorMessage}`);
      if (durable) throw error;
      return 'unknown';
    }
  }

  /**
   * 等待文本兼容路径的图片/表情描述完成（已完成的立即返回；超时则放行）。
   *
   * 正常多模态路径由主模型直接读取 image part，这里不会有 in-flight 描述任务。
   * 仅运行时降级路径调用（多模态调用失败 → 描述转文字重跑）；入站预描述分支已废弃
   *（主聊按输入换模型后该分支永久 no-op）。
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
   * 每次读取完整 pending 快照，按 messageId 找出本轮尚未接纳的输入。
   * 返回实际观察到的身份，只有 replay 接纳它们后才纳入终态确认；动作前探测不确认新输入。
   */
  private async fetchPendingSinceAgentStart(
    chatId: string,
    currentMessages: EnterpriseMessageCallbackDto[],
  ): Promise<{ messages: EnterpriseMessageCallbackDto[]; pendingMessageIds: string[] }> {
    try {
      const { messages } = await this.simpleMergeService.claimPendingSnapshot(chatId);
      const knownIds = new Set(currentMessages.map((message) => message.messageId));
      const newMessages = messages.filter(({ messageId }) => {
        if (knownIds.has(messageId)) return false;
        knownIds.add(messageId);
        return true;
      });
      return {
        messages: newMessages,
        pendingMessageIds: messages.map((message) => message.messageId),
      };
    } catch (error) {
      const errorMessage = toErrorMessage(error);
      this.logger.warn(
        `[Replay] 读取 Agent 执行期间的新消息失败，跳过重跑 chatId=${chatId}: ${errorMessage}`,
      );
      return { messages: [], pendingMessageIds: [] };
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
      groupId: parsed.groupId,
      _apiType: parsed._apiType,
    };
  }

  private buildReengagementChannelIdentity(
    parsed: ReturnType<typeof MessageParser.parse>,
    primaryMessage: EnterpriseMessageCallbackDto,
    stableBotUserId?: string,
  ): ReengagementChannelIdentity {
    return {
      candidateName: parsed.contactName,
      managerName: stableBotUserId ?? primaryMessage.botUserId,
      botImId: primaryMessage.imBotId,
      imContactId: parsed.imContactId,
      externalUserId: parsed.externalUserId,
    };
  }
}

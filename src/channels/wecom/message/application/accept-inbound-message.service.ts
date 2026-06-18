import { Injectable, Logger } from '@nestjs/common';
import { LlmExecutorService } from '@/llm/llm-executor.service';
import { ModelRole } from '@/llm/llm.types';
import { ScenarioType } from '@enums/agent.enum';
import { MessageTrackingService } from '@biz/monitoring/services/tracking/message-tracking.service';
import { ChatSessionService } from '@biz/message/services/chat-session.service';
import { ChatMessageInput } from '@biz/message/types/message.types';
import { MessageDeduplicationService } from '../runtime/deduplication.service';
import { MessageRuntimeConfigService } from '../runtime/message-runtime-config.service';
import { FilterResult, MessageFilterService } from './filter.service';
import { ImageDescriptionService } from './image-description.service';
import { WecomMessageObservabilityService } from '../telemetry/wecom-message-observability.service';
import { EnterpriseMessageCallbackDto } from '../ingress/message-callback.dto';
import { MessageParser } from '../utils/message-parser.util';
import { isPureFriendAddGreeting } from '../utils/friend-add-greeting.util';
import {
  MessageSource,
  MessageType,
  getMessageSourceDescription,
} from '@enums/message-callback.enum';
import { FilterReason } from '@enums/message-filter.enum';
import { LongTermService } from '@memory/services/long-term.service';
import type { MessageMetadata } from '@memory/types/long-term.types';
import { OpsEventsRecorderService } from '@biz/ops-events/ops-events-recorder.service';
import { UserHostingService } from '@biz/user/services/user-hosting.service';
import { GeneralHandoffNotifierService } from '@notification/services/general-handoff-notifier.service';
import { GroupBlacklistService } from '@biz/hosting-config/services/group-blacklist.service';

/** source_channel 暂不可用，统一写 'unknown'（上游接入后再带真实渠道）。 */
const UNKNOWN_SOURCE_CHANNEL = 'unknown';

const FILTERED_HISTORY_ARCHIVE_REASONS = new Set<string>([FilterReason.INVALID_SOURCE]);
// 人工介入来源白名单：自发消息（isSelf=true）中「真人亲手打字」的来源。
// 生产实证（近 2 个月 prod chat_messages）：真人招募经理介入的主力形态是经理在托管号
// 手机上手打 → source=MOBILE_PUSH（is_self=true，1.3 万+ 条）；而 AGGREGATED_CHAT_MANUAL
// （聚合聊天 web 控制台手发）实际 0 条。AI 自己的回复一律 API_SEND/AI_REPLY，不在此集合，
// 故用白名单可精确命中真人手打、排除 AI 回复与各类自动化 SOP 来源。
const HUMAN_INTERVENTION_SOURCES = new Set<MessageSource>([
  MessageSource.MOBILE_PUSH,
  MessageSource.AGGREGATED_CHAT_MANUAL,
]);

// 人工介入信号只认「真人手打文字」。仅 TEXT 类型才算真人介入，其余一律不暂停托管：
// 图片/语音/表情/卡片等结构化或非逐字输入都排除。典型误报：invite_to_group 成功后平台向候选人
// 发出的「入群邀请卡片」会以自发消息回灌（isSelf=true + source=MOBILE_PUSH + messageType=ROOM_INVITE），
// 旧逻辑只看 source 不看 messageType，把它误判成真人介入 → 误暂停托管 + 误告警（2026-06-17 李宇杭 case）。
const HUMAN_INTERVENTION_MESSAGE_TYPE = MessageType.TEXT;

// 暂停托管暗号：真人手打文字内容必须恰好等于「~」才触发暂停，避免经理日常正常回复被误判为介入。
const HUMAN_INTERVENTION_TRIGGER_TEXT = '~';

/**
 * 真人介入来源短语，用于原文案「检测到真人通过{X}手动发送消息…」。
 * 仅把旧版写死的「聚合聊天」按真实来源替换（手机手打 = MOBILE_PUSH），其余文案不变。
 */
function humanInterventionSourcePhrase(source: MessageSource): string {
  if (source === MessageSource.MOBILE_PUSH) return '手机';
  if (source === MessageSource.AGGREGATED_CHAT_MANUAL) return '聚合聊天';
  return getMessageSourceDescription(source);
}

export interface AcceptInboundMessageResult {
  shouldDispatch: boolean;
  response: { success: boolean; message: string };
  content?: string;
}

@Injectable()
export class AcceptInboundMessageService {
  private readonly logger = new Logger(AcceptInboundMessageService.name);

  constructor(
    private readonly deduplicationService: MessageDeduplicationService,
    private readonly chatSession: ChatSessionService,
    private readonly filterService: MessageFilterService,
    private readonly imageDescription: ImageDescriptionService,
    private readonly wecomObservability: WecomMessageObservabilityService,
    private readonly monitoringService: MessageTrackingService,
    private readonly runtimeConfig: MessageRuntimeConfigService,
    private readonly llm: LlmExecutorService,
    private readonly longTerm: LongTermService,
    private readonly opsEventsRecorder: OpsEventsRecorderService,
    private readonly userHostingService: UserHostingService,
    private readonly generalHandoffNotifier: GeneralHandoffNotifierService,
    private readonly groupBlacklistService: GroupBlacklistService,
  ) {}

  async execute(messageData: EnterpriseMessageCallbackDto): Promise<AcceptInboundMessageResult> {
    if (messageData.isSelf === true) {
      await this.handleSelfMessage(messageData);
      await this.deduplicationService.markMessageAsProcessedAsync(messageData.messageId);
      return { shouldDispatch: false, response: { success: true, message: 'Self message stored' } };
    }

    const filterResult = await this.filterService.validate(messageData);

    if (!filterResult.pass) {
      // pass=false is a terminal filtered path; historyOnly is only handled for pass=true below.
      await this.recordFilteredInboundMessageToHistory(messageData, filterResult);
      return {
        shouldDispatch: false,
        response: { success: true, message: `${filterResult.reason} ignored` },
      };
    }

    const isProcessed = await this.deduplicationService.isMessageProcessedAsync(
      messageData.messageId,
    );
    if (isProcessed) {
      this.logger.log(`[消息去重] 消息 [${messageData.messageId}] 已处理过，跳过重复处理`);
      return {
        shouldDispatch: false,
        response: { success: true, message: 'Duplicate message ignored' },
      };
    }

    // 候选人入站事件（非 self、过滤通过、非重复、非群聊）：friend.added（首次插入时开户长期记忆）
    // + candidate.message_received + 原子检测首条破冰（candidate.engaged）。
    // 微信「加好友纯默认招呼语」不计候选人消息/破冰。全部 fire-and-forget。
    this.recordInboundCandidateEvents(messageData, filterResult.content);

    return this.prepareForDispatch(messageData, filterResult);
  }

  private async recordFilteredInboundMessageToHistory(
    messageData: EnterpriseMessageCallbackDto,
    filterResult: FilterResult,
  ): Promise<void> {
    if (!filterResult.reason || !FILTERED_HISTORY_ARCHIVE_REASONS.has(filterResult.reason)) {
      return;
    }

    const parsed = MessageParser.parse(messageData);

    if (parsed.isRoom) {
      return;
    }

    const content = filterResult.content ?? parsed.content;
    if (!content || content.trim().length === 0) {
      return;
    }

    const saved = await this.recordUserMessageToHistory(messageData, content).then(
      (inserted) => inserted,
      (error) => {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `[过滤归档] 写入失败 [${messageData.messageId}], reason=${filterResult.reason}: ${errorMessage}`,
        );
        return false;
      },
    );

    if (saved) {
      this.logger.log(
        `[过滤归档] 已记录但不触发AI [${messageData.messageId}], chatId=${parsed.chatId}, reason=${filterResult.reason}`,
      );
    }
  }

  private async prepareForDispatch(
    messageData: EnterpriseMessageCallbackDto,
    filterResult: FilterResult,
  ): Promise<AcceptInboundMessageResult> {
    if (filterResult.historyOnly) {
      await this.recordUserMessageToHistory(messageData, filterResult.content);
      const parsed = MessageParser.parse(messageData);
      await this.deduplicationService.markMessageAsProcessedAsync(messageData.messageId);
      this.logger.log(
        `[historyOnly] 消息已记录到历史但不触发AI回复 [${messageData.messageId}], ` +
          `chatId=${parsed.chatId}, contact=${parsed.contactName}, reason=${filterResult.reason}`,
      );
      return {
        shouldDispatch: false,
        response: { success: true, message: 'Message recorded to history only' },
      };
    }

    const parsed = MessageParser.parse(messageData);
    const scenario: ScenarioType = MessageParser.determineScenario();
    const requestContent = filterResult.content ?? parsed.content;

    // 前置打点：trace 在回调入口就建立，后续 markHistoryStored/markImagePrepared/markQueueAdd
    // 都能真实落盘，不再被静默塞进 Queue 时间里。
    if (!(await this.wecomObservability.hasTrace(messageData.messageId))) {
      await this.wecomObservability.startRequestTrace({
        traceId: messageData.messageId,
        primaryMessage: messageData,
        scenario,
        content: requestContent,
      });
    }

    // 图片消息：先同步获取原图 URL 写入 payload，再存记录（一次 INSERT 到位）
    await this.enrichImagePayload(messageData);

    // 历史记录异步化：chat_messages INSERT（Supabase）+ short-term cache（Redis）总计
    // 约 500ms-2s，阻塞了 PreDispatch。Agent 在 ≥10s 静默窗口后才读历史，
    // 异步写入有充裕时间完成。失败降级：下一轮看不到本轮 user 消息。
    void this.recordUserMessageToHistory(messageData, filterResult.content)
      .then(() => this.wecomObservability.markHistoryStored(messageData.messageId))
      .catch((error) => {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.warn(`[异步历史记录] 写入失败 [${messageData.messageId}]: ${errorMessage}`);
      });

    try {
      await this.prepareImageIfNeeded(messageData);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const failureMetadata = await this.wecomObservability.buildFailureMetadata(
        messageData.messageId,
        {
          scenario,
          errorType: 'message',
          errorMessage,
          extraResponse: {
            phase: 'pre-dispatch',
            chatId: parsed.chatId,
          },
        },
      );
      this.monitoringService.recordFailure(messageData.messageId, errorMessage, failureMetadata);
      throw error;
    }

    return {
      shouldDispatch: true,
      response: { success: true, message: 'Message received' },
      content: filterResult.content,
    };
  }

  private resolveLongTermUserId(messageData: EnterpriseMessageCallbackDto): string | null {
    return messageData.imContactId || messageData.externalUserId || messageData.chatId || null;
  }

  /**
   * 候选人入站事件（仅个人单聊）。
   *
   * 生产实测：候选人加好友时微信会以普通 user 消息（MOBILE_PUSH）推送握手语
   * （「我是{昵称}」「请求添加你为朋友」「我通过了你的…验证请求」），Agent 直接回它即开场白；
   * 不存在独立的「新增客户回调 / NEW_CUSTOMER_ANSWER_SOP」入口（线上未配 SOP）。因此：
   * - **friend.added（加好友数）**：任何候选人首条消息都代表新好友，幂等键 `userId:friend_added`
   *   去重 → 每候选人一次；为省 RPC，仅在「握手语」或「首条真实消息(破冰)」时尝试。首次真正插入时
   *   顺带开户长期记忆元数据。
   * - **candidate.message_received + 破冰(candidate.engaged)**：排除「加好友纯默认招呼语」
   *   （见 isPureFriendAddGreeting）——这些不算候选人真实开口；带求职意图的「我是找工作的」仍计入。
   *
   * 仅在 execute() 里「非 self + 过滤通过 + 非重复」路径调用。全部 fire-and-forget，失败不影响主流程。
   */
  private recordInboundCandidateEvents(
    messageData: EnterpriseMessageCallbackDto,
    content: string | undefined,
  ): void {
    if (messageData.imRoomId) return; // 群聊不计入候选人漏斗
    const userId = this.resolveLongTermUserId(messageData);
    if (!userId) return;

    const corpId = messageData.orgId || 'default';
    const botImId = messageData.imBotId;
    const isGreeting = isPureFriendAddGreeting(content);

    void (async () => {
      try {
        if (isGreeting) {
          // 纯握手语：只代表「加好友」，不算候选人真实开口 → 兜底记 friend.added + 开户长期记忆，不记消息/破冰
          await this.recordFriendAddedOnFirstContact(messageData, corpId, botImId, userId);
          await this.ensureLongTermProfile(messageData, corpId, userId);
          this.logger.log(
            `[漏斗] 加好友握手语不计候选人消息/破冰 [${messageData.messageId}] chatId=${messageData.chatId}`,
          );
          return;
        }

        // 候选人真实消息：candidate.message_received + 原子破冰检测
        const result = await this.opsEventsRecorder.recordCandidateMessage({
          corpId,
          chatId: messageData.chatId,
          messageId: messageData.messageId,
          botImId,
          managerName: messageData.botUserId,
          sourceChannel: UNKNOWN_SOURCE_CHANNEL,
          userId,
        });

        // 首条真实消息（破冰）即新好友首次接触 → 兜底补记 friend.added（幂等）+ 开户长期记忆
        if (result.engaged) {
          await this.recordFriendAddedOnFirstContact(messageData, corpId, botImId, userId);
          await this.ensureLongTermProfile(messageData, corpId, userId);
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `[漏斗] 候选人入站事件记录失败 [${messageData.messageId}]: ${errorMessage}`,
        );
      }
    })();
  }

  /**
   * friend.added（幂等键 `userId:friend_added` → 每候选人一次）。
   *
   * 这是**兜底**信号：主信号来自「新增客户回调—RPA」(NewCustomerCallbackService)，它在真实加好友时
   * 即触发、含从不发消息的沉默僵尸。两者共用同一幂等键，谁先到算谁。长期记忆开户已解耦到
   * ensureLongTermProfile——否则回调抢先插入 friend.added 后，消息路径就再也不会开户。
   */
  private async recordFriendAddedOnFirstContact(
    messageData: EnterpriseMessageCallbackDto,
    corpId: string,
    botImId: string | undefined,
    userId: string,
  ): Promise<void> {
    await this.opsEventsRecorder.recordEvent({
      corpId,
      eventName: 'friend.added',
      idempotencyKey: `${userId}:friend_added`,
      botImId,
      managerName: messageData.botUserId,
      sourceChannel: UNKNOWN_SOURCE_CHANNEL,
      userId,
      chatId: messageData.chatId,
    });
  }

  /**
   * 开户长期记忆元数据。与 friend.added 是否新插入解耦：新增客户回调可能已抢先记了 friend.added，
   * 此时消息路径仍需在候选人首次接触时开户。updateMessageMetadata 底层为 upsert，重复调用幂等。
   */
  private async ensureLongTermProfile(
    messageData: EnterpriseMessageCallbackDto,
    corpId: string,
    userId: string,
  ): Promise<void> {
    const metadata = this.buildMessageMetadata(messageData);
    if (!metadata) return;
    try {
      await this.longTerm.updateMessageMetadata(corpId, userId, metadata);
      this.logger.log(
        `[新好友] 已开户长期记忆元数据: userId=${userId}, chatId=${messageData.chatId}`,
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `[新好友] 长期记忆元数据开户失败 [${messageData.messageId}]: ${errorMessage}`,
      );
    }
  }

  private buildMessageMetadata(messageData: EnterpriseMessageCallbackDto): MessageMetadata | null {
    const metadata: MessageMetadata = {};
    this.assignIfPresent(metadata, 'botId', messageData.botId);
    this.assignIfPresent(metadata, 'imBotId', messageData.imBotId);
    this.assignIfPresent(metadata, 'imContactId', messageData.imContactId);
    this.assignIfPresent(metadata, 'contactType', messageData.contactType);
    this.assignIfPresent(metadata, 'contactName', messageData.contactName);
    this.assignIfPresent(metadata, 'externalUserId', messageData.externalUserId);
    this.assignIfPresent(metadata, 'avatar', messageData.avatar);
    return Object.keys(metadata).length > 0 ? metadata : null;
  }

  private assignIfPresent<K extends keyof MessageMetadata>(
    target: MessageMetadata,
    key: K,
    value: MessageMetadata[K] | undefined,
  ): void {
    if (value === null || value === undefined) return;
    if (typeof value === 'string' && value.trim().length === 0) return;
    target[key] = value;
  }

  private async prepareImageIfNeeded(messageData: EnterpriseMessageCallbackDto): Promise<void> {
    const imgUrl = MessageParser.extractImageUrl(messageData);
    if (!imgUrl) {
      return;
    }

    const visualKind = MessageParser.extractVisualMessageType(messageData);
    if (!visualKind) {
      return;
    }

    const { overrideModelId } = await this.runtimeConfig.resolveWecomChatModelSelection();
    const shouldDescribeBeforeAgent = !this.llm.supportsVisionInput({
      role: ModelRole.Chat,
      modelId: overrideModelId,
    });

    if (!shouldDescribeBeforeAgent) {
      return;
    }

    // 关键：vision 描述同步等待会让消息晚 ~6s 才进 Redis 队列，期间前一条文本的
    // debounce 静默会"假性达标"提前 fire，把图文拆成两批（参见 wecom-batch race）。
    // 改 fire-and-forget 后，addMessage 立即更新 lastMessageAt 重置静默；worker
    // 真正取本批后由 ReplyWorkflowService 的 awaitVision 等待描述完成再调 Agent。
    const resolvedUrl = (messageData.payload as Record<string, unknown>)?.artworkUrl as
      | string
      | undefined;
    this.imageDescription.describeAndUpdateAsync(
      messageData.messageId,
      resolvedUrl || imgUrl,
      visualKind,
    );

    // 描述真正完成后再补打 imagePreparedAt（observability only），不影响业务正确性。
    void this.imageDescription
      .awaitVision([messageData.messageId], 30_000)
      .then(() => this.wecomObservability.markImagePrepared(messageData.messageId))
      .catch(() => {});
  }

  private async handleSelfMessage(messageData: EnterpriseMessageCallbackDto): Promise<void> {
    const parsed = MessageParser.parse(messageData);
    const { chatId } = parsed;
    await this.pauseHostingForHumanInterventionIfNeeded(messageData, chatId);

    // 入群邀请卡片（invite_to_group 拉群 / 经理手动发卡）没有可提取文本，
    // 补占位内容让卡片在聊天记录页可见；其余类型保持原行为（空内容跳过）。
    const content = parsed.content || this.buildSelfRoomInviteContent(messageData);

    if (!content || content.trim().length === 0) {
      this.logger.debug(`[自发消息] 消息内容为空，跳过存储 [${messageData.messageId}]`);
      return;
    }

    if (messageData.source === MessageSource.MOBILE_PUSH) {
      // isSelf=true + MOBILE_PUSH = 真人在托管号手机上手打（生产主力的人工介入形态）；
      // 私聊场景已由 pauseHostingForHumanInterventionIfNeeded 暂停托管，这里仅留痕，不再当异常告警。
      this.logger.debug(
        `[自发消息-真人手打] isSelf=true 且 source=${messageData.source}(${getMessageSourceDescription(messageData.source)}), ` +
          `messageId=${messageData.messageId}, chatId=${chatId}, botId=${messageData.botId}, botUserId=${messageData.botUserId}`,
      );
    }

    await this.enrichImagePayload(messageData);
    const candidateName = await this.getCandidateNameFromHistory(chatId);
    const isRoom = Boolean(messageData.imRoomId);
    const assistantMsg: ChatMessageInput = {
      chatId,
      messageId: messageData.messageId,
      role: 'assistant',
      content,
      timestamp: this.resolveStoredTimestamp(parsed.timestamp),
      candidateName,
      managerName: messageData.botUserId,
      orgId: messageData.orgId,
      botId: messageData.botId,
      messageType: messageData.messageType,
      source: messageData.source,
      isRoom,
      imBotId: messageData.imBotId,
      imContactId: messageData.imContactId,
      contactType: messageData.contactType,
      isSelf: messageData.isSelf,
      payload: messageData.payload as Record<string, unknown>,
      avatar: messageData.avatar,
      externalUserId: messageData.externalUserId,
    };
    await this.chatSession.saveMessage(assistantMsg);

    this.logger.log(
      `[自发消息] 已存储为 assistant 历史 [${messageData.messageId}]: "${content.substring(0, 50)}${content.length > 50 ? '...' : ''}"`,
    );

    // 招募经理（真人）发的图片/表情也需要 vision 描述：assistant 角色历史不会作为
    // image part 注入下一轮 Agent，模型只能从 text content 读图。这里 fire-and-forget
    // 触发描述，描述完成后会通过 chat_messages.UPDATE 回写 content（带 [图片消息] 前缀）
    // 并失效短期记忆缓存。
    this.triggerSelfMessageVisionIfNeeded(messageData);
  }

  private async pauseHostingForHumanInterventionIfNeeded(
    messageData: EnterpriseMessageCallbackDto,
    chatId: string,
  ): Promise<void> {
    if (!this.isHumanInterventionMessage(messageData) || !chatId) {
      return;
    }

    // 仅对"托管中"的小组才暂停+告警。与 Dashboard「小组托管状态」同源：
    // 小组在 group_blacklist（已屏蔽 = 关闭托管）里时，本就不触发 AI 回复，
    // 招募经理在该小组真人回复属正常操作，不应误暂停 + 误告警。
    if (
      messageData.groupId &&
      (await this.groupBlacklistService.isGroupBlacklisted(messageData.groupId))
    ) {
      this.logger.debug(
        `[真人介入] 小组未托管（已屏蔽），跳过暂停/告警 [${messageData.messageId}], groupId=${messageData.groupId}`,
      );
      return;
    }

    try {
      const hit = await this.userHostingService.isAnyPaused([
        chatId,
        messageData.imContactId,
        messageData.externalUserId,
      ]);
      if (hit.paused) {
        this.logger.log(
          `[真人介入] 会话已暂停托管，跳过重复暂停 [${messageData.messageId}], matchedId=${hit.matchedId}`,
        );
        return;
      }

      await this.userHostingService.pauseUser(chatId, {
        source: 'human_intervention',
        reason: '检测到真人介入聊天自动暂停',
      });
      await this.sendHumanInterventionHandoffAlert(messageData, chatId);
      this.logger.warn(
        `[真人介入] 已自动暂停候选人托管 [${messageData.messageId}], chatId=${chatId}, source=${messageData.source}(${getMessageSourceDescription(messageData.source)})`,
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `[真人介入] 自动暂停候选人托管失败 [${messageData.messageId}], chatId=${chatId}: ${errorMessage}`,
      );
    }
  }

  private isHumanInterventionMessage(messageData: EnterpriseMessageCallbackDto): boolean {
    if (messageData.isSelf !== true) {
      return false;
    }
    if (messageData.imRoomId) {
      return false;
    }
    // 仅真人手打文字（TEXT）才算人工介入；图片/语音/卡片/系统消息等一律不暂停托管。
    if (messageData.messageType !== HUMAN_INTERVENTION_MESSAGE_TYPE) {
      return false;
    }
    if (!HUMAN_INTERVENTION_SOURCES.has(messageData.source)) {
      return false;
    }
    // 仅当真人手打消息内容恰好等于约定暗号「~」时才暂停托管，避免经理正常回复被误判。
    return MessageParser.extractContent(messageData).trim() === HUMAN_INTERVENTION_TRIGGER_TEXT;
  }

  /**
   * 真人介入告警：复用「候选人需人工介入」通用人工介入卡片（命中原因 / 建议动作 /
   * 聊天上下文 / 候选人信息），由 GeneralHandoffNotifier 渲染并发到蛋糕私聊监控群、@ 负责人。
   *
   * 字段对齐（自发消息里 messageData.contactName/botUserId 都是「托管号」自己）：
   * - contactName（卡片「微信昵称」）= 真实候选人（从会话历史解析），无则留空
   * - botUserName（卡片「托管账号」）= 托管号账号 botUserId
   */
  private async sendHumanInterventionHandoffAlert(
    messageData: EnterpriseMessageCallbackDto,
    chatId: string,
  ): Promise<void> {
    try {
      const [recentMessages, candidateName] = await Promise.all([
        this.chatSession.getChatHistory(chatId, 10).catch(() => []),
        this.getCandidateNameFromHistory(chatId),
      ]);
      const sourcePhrase = humanInterventionSourcePhrase(messageData.source);
      const currentMessage = MessageParser.extractContent(messageData);

      await this.generalHandoffNotifier.notify({
        // 沿用原文案：仅把旧版写死的「聚合聊天」按真实来源动态填充。
        titleOverride: '🚨 真人介入聊天，已自动暂停托管',
        alertLabel: '真人介入自动暂停',
        reason: `检测到真人通过${sourcePhrase}手动发送消息，系统已自动暂停该候选人托管`,
        corpId: messageData.orgId,
        botImId: messageData.imBotId,
        botUserName: messageData.botUserId,
        contactName: candidateName,
        chatId,
        pausedUserId: chatId,
        currentMessageContent: currentMessage || '',
        recentMessages: recentMessages.map((m) => ({
          role: m.role,
          content: m.content,
          timestamp: m.timestamp,
        })),
        sessionState: null,
        diagnostics: {
          botId: messageData.botId,
          imBotId: messageData.imBotId,
          imContactId: messageData.imContactId,
          externalUserId: messageData.externalUserId,
          source: messageData.source,
          sourceDescription: getMessageSourceDescription(messageData.source),
          messageType: messageData.messageType,
        },
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `[真人介入] 飞书通知发送失败 [${messageData.messageId}], chatId=${chatId}: ${errorMessage}`,
      );
    }
  }

  /**
   * 自发入群邀请卡片的占位文本（仅 ROOM_INVITE，其余类型返回空串维持原跳过行为）。
   * payload 结构平台未文档化，按常见字段尽力取群名。
   */
  private buildSelfRoomInviteContent(messageData: EnterpriseMessageCallbackDto): string {
    if (messageData.messageType !== MessageType.ROOM_INVITE) return '';
    const payload = (messageData.payload ?? {}) as Record<string, unknown>;
    const groupName = [payload.roomName, payload.groupName, payload.title, payload.name].find(
      (v): v is string => typeof v === 'string' && v.trim().length > 0,
    );
    return groupName
      ? `[入群邀请] 邀请你加入"${groupName.trim()}"`
      : '[入群邀请] 已发送入群邀请卡片';
  }

  private triggerSelfMessageVisionIfNeeded(messageData: EnterpriseMessageCallbackDto): void {
    const imgUrl = MessageParser.extractImageUrl(messageData);
    if (!imgUrl) return;
    const visualKind = MessageParser.extractVisualMessageType(messageData);
    if (!visualKind) return;
    const resolvedUrl = (messageData.payload as Record<string, unknown>)?.artworkUrl as
      | string
      | undefined;
    this.imageDescription.describeAndUpdateAsync(
      messageData.messageId,
      resolvedUrl || imgUrl,
      visualKind,
    );
  }

  private async enrichImagePayload(messageData: EnterpriseMessageCallbackDto): Promise<void> {
    const imgUrl = MessageParser.extractImageUrl(messageData);
    if (!imgUrl) return;

    const artworkUrl = await this.imageDescription.resolveArtworkUrl(
      messageData.messageId,
      imgUrl,
      {
        chatId: messageData.chatId,
        imBotId: messageData.imBotId,
        imContactId: messageData.imContactId,
        imRoomId: messageData.imRoomId,
      },
    );

    if (artworkUrl !== imgUrl) {
      (messageData.payload as Record<string, unknown>).artworkUrl = artworkUrl;
    }
  }

  private async recordUserMessageToHistory(
    messageData: EnterpriseMessageCallbackDto,
    contentFromFilter?: string,
  ): Promise<boolean> {
    const parsed = MessageParser.parse(messageData);
    const { chatId, contactName } = parsed;
    const content = contentFromFilter ?? parsed.content;
    const isRoom = Boolean(messageData.imRoomId);

    if (!content || content.trim().length === 0) {
      this.logger.debug(`[历史记录] 消息内容为空，跳过记录历史 [${messageData.messageId}]`);
      return false;
    }

    const userMsg: ChatMessageInput = {
      chatId,
      messageId: messageData.messageId,
      role: 'user',
      content,
      timestamp: this.resolveStoredTimestamp(parsed.timestamp),
      candidateName: messageData.contactName || contactName,
      managerName: messageData.botUserId,
      orgId: messageData.orgId,
      botId: messageData.botId,
      messageType: messageData.messageType,
      source: messageData.source,
      isRoom,
      imBotId: messageData.imBotId,
      imContactId: messageData.imContactId,
      contactType: messageData.contactType,
      isSelf: messageData.isSelf,
      payload: messageData.payload as Record<string, unknown>,
      avatar: messageData.avatar,
      externalUserId: messageData.externalUserId,
    };
    return this.chatSession.saveMessage(userMsg);
  }

  private async getCandidateNameFromHistory(chatId: string): Promise<string | undefined> {
    try {
      const detail = await this.chatSession.getChatSessionMessages(chatId);
      if (!detail?.messages) {
        return undefined;
      }
      const userMessage = detail.messages.find(
        (message) => message.role === 'user' && message.candidateName,
      );
      return userMessage?.candidateName;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.debug(`获取候选人昵称失败 [${chatId}]: ${errorMessage}`);
      return undefined;
    }
  }

  private resolveStoredTimestamp(timestamp: number): number {
    return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : Date.now();
  }
}

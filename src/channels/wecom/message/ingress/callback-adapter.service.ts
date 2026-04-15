import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import {
  EnterpriseMessageCallbackDto,
  GroupMessageCallbackDto,
  MessageSource,
} from './message-callback.dto';
import {
  EnterpriseMessageCallbackInput,
  EnterpriseMessageCallbackInputSchema,
  GroupMessageCallbackInput,
  GroupMessageCallbackWrapperSchema,
} from './message-callback.schema';
import { z } from 'zod';

/**
 * 消息回调适配器服务
 * 负责将小组级回调格式转换为企业级统一格式
 *
 * 设计理念：
 * - 适配器模式：统一两种不同的回调格式
 * - 向后兼容：保持现有业务逻辑不变
 * - 字段映射：处理字段名称差异和数据类型转换
 */
@Injectable()
export class MessageCallbackAdapterService {
  private readonly logger = new Logger(MessageCallbackAdapterService.name);

  /**
   * 检测回调格式类型
   * @param body 原始回调数据
   * @returns 'enterprise' | 'group' | 'unknown'
   */
  detectCallbackType(body: unknown): 'enterprise' | 'group' | 'unknown' {
    if (!body || typeof body !== 'object') {
      return 'unknown';
    }

    const obj = body as Record<string, unknown>;

    // 企业级回调特征：有 orgId 字段且数据在顶层
    if (typeof obj.orgId === 'string' && obj.messageType !== undefined) {
      return 'enterprise';
    }

    // 小组级回调特征：有 data 字段且 data 内有 type 字段
    const data = obj.data;
    if (
      data &&
      typeof data === 'object' &&
      (data as Record<string, unknown>).type !== undefined &&
      typeof (data as Record<string, unknown>).messageId === 'string'
    ) {
      return 'group';
    }

    return 'unknown';
  }

  /**
   * 将小组级回调转换为企业级格式
   * @param groupCallback 小组级回调数据
   * @returns 企业级格式的回调数据
   */
  convertGroupToEnterprise(
    groupCallback: GroupMessageCallbackDto | GroupMessageCallbackInput,
  ): EnterpriseMessageCallbackDto {
    this.logger.debug(`转换小组级回调为企业级格式: messageId=${groupCallback.messageId}`);

    // 字段名称映射和转换
    const enterpriseCallback: EnterpriseMessageCallbackDto = {
      // 企业级特有字段（小组级没有，使用默认值）
      orgId: this.extractOrgIdFromToken(groupCallback.token), // 从 token 提取或使用默认值
      groupId: undefined, // 小组级没有此字段
      source: this.inferSourceFromGroupCallback(groupCallback), // 根据 isSelf 等字段推断 source

      // 字段名称映射
      messageType: groupCallback.type, // type → messageType
      imContactId: groupCallback.contactId, // contactId → imContactId
      imBotId: groupCallback.botWxid, // botWxid → imBotId
      botUserId: groupCallback.botWeixin, // botWeixin → botUserId

      // 时间戳转换（小组级是数字，企业级是字符串）
      timestamp: groupCallback.timestamp.toString(),

      // 直接映射的字段
      token: groupCallback.token,
      botId: groupCallback.botId,
      chatId: groupCallback.chatId,
      messageId: groupCallback.messageId,
      contactType: groupCallback.contactType,
      payload: groupCallback.payload,
      avatar: groupCallback.avatar,
      contactName: groupCallback.contactName,
      isSelf: groupCallback.isSelf,
      externalUserId: groupCallback.externalUserId ?? undefined,
      coworker: groupCallback.coworker,

      // 群聊相关字段（小组级独有）
      imRoomId: groupCallback.roomId,
      roomName: groupCallback.roomTopic,
      roomWecomChatId: groupCallback.roomWecomChatId ?? undefined,

      // 内部标记：标识为小组级回调转换而来（用于动态 API 选择）
      _apiType: 'group',
    };

    this.logger.debug(
      `转换完成: orgId=${enterpriseCallback.orgId}, messageType=${enterpriseCallback.messageType}`,
    );

    return enterpriseCallback;
  }

  /**
   * 统一处理回调数据（自动检测并转换）
   * @param body 原始回调数据（可能是企业级或小组级）
   * @returns 统一的企业级格式数据
   */
  normalizeCallback(body: unknown): EnterpriseMessageCallbackDto {
    const callbackType = this.detectCallbackType(body);

    this.logger.log(`检测到回调类型: ${callbackType}`);

    switch (callbackType) {
      case 'enterprise':
        // 已经是企业级格式，但需要补充可能缺失的字段
        // 注意：企业级格式没有 _apiType 字段，默认使用企业级 API
        return this.normalizeEnterpriseCallback(
          this.parseOrThrow(EnterpriseMessageCallbackInputSchema, body, callbackType),
        );

      case 'group':
        // 小组级格式，需要转换
        const wrapper = this.parseOrThrow(GroupMessageCallbackWrapperSchema, body, callbackType);
        const converted = this.convertGroupToEnterprise(wrapper.data);
        this.logger.debug(`小组级回调：设置 _apiType='group'（将使用小组级 API）`);
        return converted;

      case 'unknown':
        this.logger.warn('未知的回调格式，拒绝处理');
        throw new HttpException(
          {
            code: 'INVALID_MESSAGE_CALLBACK',
            message: 'Invalid message callback payload',
            details: {
              callbackType,
            },
          },
          HttpStatus.BAD_REQUEST,
        );
    }
  }

  /**
   * 规范化企业级回调数据
   * 补充可能缺失的字段，确保数据完整性
   * @param body 原始企业级回调数据
   * @returns 规范化后的企业级回调数据
   */
  private normalizeEnterpriseCallback(
    body: EnterpriseMessageCallbackInput,
  ): EnterpriseMessageCallbackDto {
    const normalized = {
      ...body,
      source: body.source,
    } as EnterpriseMessageCallbackDto;

    // 补充缺失的 source 字段
    // 企业级回调可能不包含 source 字段，需要根据 isSelf 推断
    if (normalized.source === undefined || normalized.source === null) {
      normalized.source = this.inferSourceFromEnterpriseCallback(normalized);
      this.logger.debug(
        `企业级回调：补充缺失的 source 字段为 ${normalized.source} (messageId=${normalized.messageId})`,
      );
    } else {
      this.logger.debug(
        `企业级回调：source=${normalized.source} (messageId=${normalized.messageId})`,
      );
    }

    return normalized;
  }

  /**
   * 从企业级回调推断消息来源
   * @param callback 企业级回调数据
   * @returns 推断的消息来源
   *
   * 推断规则：
   * - isSelf === true → AGGREGATED_CHAT_MANUAL（手动发送，避免循环回复）
   * - isSelf === false/undefined → MOBILE_PUSH（用户真实发送，触发 AI 回复）
   */
  private inferSourceFromEnterpriseCallback(callback: EnterpriseMessageCallbackDto): MessageSource {
    if (callback.isSelf === true) {
      this.logger.debug(
        `推断企业级消息来源: isSelf=true → AGGREGATED_CHAT_MANUAL (messageId=${callback.messageId})`,
      );
      return MessageSource.AGGREGATED_CHAT_MANUAL;
    }

    this.logger.debug(
      `推断企业级消息来源: isSelf=${callback.isSelf} → MOBILE_PUSH (messageId=${callback.messageId})`,
    );
    return MessageSource.MOBILE_PUSH;
  }

  /**
   * 从小组级回调推断消息来源
   * @param groupCallback 小组级回调数据
   * @returns 推断的消息来源
   *
   * 说明：
   * - 小组级没有 source 字段，需要根据其他字段推断
   * - 主要依据 isSelf 字段判断是否为自己发送的消息
   *
   * 推断规则：
   * - isSelf === true → AGGREGATED_CHAT_MANUAL（手动发送，避免循环回复）
   * - isSelf === false/undefined → MOBILE_PUSH（用户真实发送，触发 AI 回复）
   */
  private inferSourceFromGroupCallback(
    groupCallback: GroupMessageCallbackDto | GroupMessageCallbackInput,
  ): MessageSource {
    // 1. 自己发的消息 → 手动发送（不触发 AI 回复）
    if (groupCallback.isSelf === true) {
      this.logger.debug(
        `推断消息来源: isSelf=true → AGGREGATED_CHAT_MANUAL (messageId=${groupCallback.messageId})`,
      );
      return MessageSource.AGGREGATED_CHAT_MANUAL;
    }

    // 2. 默认：用户发的消息 → 手机推送（触发 AI 回复）
    this.logger.debug(
      `推断消息来源: isSelf=${groupCallback.isSelf} → MOBILE_PUSH (messageId=${groupCallback.messageId})`,
    );
    return MessageSource.MOBILE_PUSH;
  }

  /**
   * 从小组级回调生成 orgId
   * @param token 小组级 token（用于日志）
   * @returns orgId
   *
   * 说明：
   * - 小组级回调没有 orgId 字段
   * - 使用固定值标识来自小组级回调
   * - orgId 仅用于日志和统计，不影响业务逻辑
   */
  private extractOrgIdFromToken(token: string): string {
    this.logger.debug(`生成 orgId for 小组级回调: token=${this.maskToken(token)}`);
    return 'group_callback_org';
  }

  /**
   * 脱敏 token（日志记录用）
   */
  private maskToken(token: string): string {
    if (!token || token.length < 8) {
      return '****';
    }
    return `${token.substring(0, 4)}****${token.substring(token.length - 4)}`;
  }

  private parseOrThrow<T>(
    schema: z.ZodSchema<T>,
    body: unknown,
    callbackType: 'enterprise' | 'group',
  ): T {
    const parsed = schema.safeParse(body);
    if (parsed.success) {
      return parsed.data;
    }

    const issues = parsed.error.issues.map((issue) => ({
      path: issue.path.join('.') || '<root>',
      message: issue.message,
    }));

    this.logger.warn(
      `回调 schema 校验失败: type=${callbackType}, issues=${JSON.stringify(issues)}`,
    );

    throw new HttpException(
      {
        code: 'INVALID_MESSAGE_CALLBACK',
        message: 'Invalid message callback payload',
        details: {
          callbackType,
          issues,
        },
      },
      HttpStatus.BAD_REQUEST,
    );
  }
}

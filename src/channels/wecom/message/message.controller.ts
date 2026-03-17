import { Controller, Post, Body, Logger, Get, Query, Delete, Param } from '@nestjs/common';
import { MessageService } from './message.service';
import { MessageProcessor } from './message.processor';
import { RawResponse } from '@infra/server/response/decorators/api-response.decorator';
import {
  MessageType,
  ContactType,
  MessageSource,
  EnterpriseMessageCallbackDto,
} from './dto/message-callback.dto';
import { MessageCallbackAdapterService } from './services/callback-adapter.service';
import { MessageFilterService } from './services/filter.service';
import { GroupBlacklistService } from '@biz/hosting-config/services/group-blacklist.service';
import { LogSanitizer } from './utils/log-sanitizer.util';

/**
 * 消息处理控制器
 * 负责接收和处理企微机器人的消息回调
 *
 * 注意：企微回调接口必须返回特定格式，使用 @RawResponse 豁免统一包装
 *
 * 支持：
 * - 企业级回调格式（数据在顶层）
 * - 小组级回调格式（数据在 data 字段中）
 */
@Controller('message')
export class MessageController {
  private readonly logger = new Logger(MessageController.name);

  constructor(
    private readonly messageService: MessageService,
    private readonly messageProcessor: MessageProcessor,
    private readonly callbackAdapter: MessageCallbackAdapterService,
    private readonly filterService: MessageFilterService,
    private readonly groupBlacklistService: GroupBlacklistService,
  ) {}

  /**
   * 接收企微机器人推送的消息（统一入口）
   * @description 接收消息回调，支持 AI 自动回复
   * @description 自动识别并适配企业级/小组级回调格式
   * @example POST /message
   */
  @RawResponse() // 企微回调必须返回原始格式，不使用统一包装
  @Post()
  async receiveMessage(@Body() body: any) {
    // 自动检测并转换为统一格式
    const callbackType = this.callbackAdapter.detectCallbackType(body);

    // 打印原始回调数据（使用脱敏处理避免超大日志）
    this.logger.log('=== [消息回调] ===');
    this.logger.log(`类型=${callbackType}, messageId=${body.messageId || body.data?.messageId}`);
    // 使用 debug 级别和脱敏处理，避免生产环境产生超大日志
    const sanitizedBody = LogSanitizer.sanitizeMessageCallback(body.data || body);
    this.logger.debug(`原始数据(已脱敏): ${JSON.stringify(sanitizedBody)}`);

    // 统一转换为企业级格式
    const normalizedCallback = this.callbackAdapter.normalizeCallback(body);

    // 打印标准化后的关键字段
    this.logger.log(
      `[标准化] messageId=${normalizedCallback.messageId}, ` +
        `chatId=${normalizedCallback.chatId}, ` +
        `isSelf=${normalizedCallback.isSelf}, ` +
        `source=${normalizedCallback.source}, ` +
        `contactType=${normalizedCallback.contactType}, ` +
        `messageType=${normalizedCallback.messageType}`,
    );

    const result = await this.messageService.handleMessage(normalizedCallback);

    this.logger.log(
      `[处理完成] messageId=${normalizedCallback.messageId}, result=${JSON.stringify(result)}`,
    );

    return result;
  }

  /**
   * 接收消息发送结果回调（连字符命名）
   * @description 接收消息发送状态的回调通知
   * @example POST /message/sent-result
   */
  @RawResponse() // 企微回调必须返回原始格式，不使用统一包装
  @Post('sent-result')
  async receiveSentResult(@Body() body: any) {
    this.logger.debug('接收到发送结果回调 (sent-result)');
    return await this.messageService.handleSentResult(body);
  }

  /**
   * 接收消息发送结果回调（驼峰命名）
   * @description 兼容托管平台的驼峰命名回调
   * @example POST /message/sentResult
   */
  @RawResponse()
  @Post('sentResult')
  async receiveSentResultCamelCase(@Body() body: any) {
    this.logger.debug('接收到发送结果回调 (sentResult)');
    return await this.messageService.handleSentResult(body);
  }

  /**
   * 测试接口：模拟消息回调
   * @description 用于测试和调试，模拟企微推送消息，触发 AI 自动回复
   * @example POST /message/test
   * @body { "text": "你好，有什么岗位？", "chatId": "test_chat_123", "orgId": "test_org" }
   */
  @Post('test')
  async testMessage(
    @Body()
    body: {
      text: string;
      chatId?: string;
      orgId?: string;
      token?: string;
    },
  ) {
    this.logger.log('收到测试消息请求:', body);

    // 构造模拟的消息数据，符合 EnterpriseMessageCallbackDto 格式
    const mockMessageData: EnterpriseMessageCallbackDto = {
      orgId: body.orgId || 'test_org_123',
      token: body.token || 'test_token_for_development',
      botId: 'test_bot_123',
      imBotId: 'test_bot_wxid',
      chatId: body.chatId || `test_chat_${Date.now()}`,
      messageType: MessageType.TEXT,
      messageId: `test_msg_${Date.now()}`,
      timestamp: Date.now().toString(),
      isSelf: false,
      source: MessageSource.MOBILE_PUSH, // 手机推送消息，触发 AI 回复
      contactType: ContactType.PERSONAL_WECHAT,
      payload: {
        text: body.text,
        pureText: body.text,
      },
    };

    this.logger.debug('构造的模拟消息:', JSON.stringify(mockMessageData, null, 2));

    // 调用消息处理服务
    const result = await this.messageService.handleMessage(mockMessageData);

    return {
      success: true,
      message: '测试消息已发送',
      mockData: mockMessageData,
      result,
    };
  }

  /**
   * 获取服务状态
   * @description 获取消息服务的当前运行状态（并发、缓存使用率等）
   * @example GET /message/service/status
   */
  @Get('service/status')
  getServiceStatus() {
    return this.messageService.getServiceStatus();
  }

  /**
   * 获取缓存统计信息
   * @description 获取详细的缓存统计数据，包括去重缓存、历史记录、聚合队列等
   * @example GET /message/cache/stats
   */
  @Get('cache/stats')
  getCacheStats() {
    return this.messageService.getCacheStats();
  }

  /**
   * 获取内存中的聊天记录
   * @description 获取所有会话的聊天历史记录，或获取指定会话的历史
   * @example GET /message/history/all
   * @example GET /message/history/all?chatId=wxid_xxx
   */
  @Get('history/all')
  getAllHistory(@Query('chatId') chatId?: string) {
    return this.messageService.getAllHistory(chatId);
  }

  /**
   * 手动清理内存缓存
   * @description 清理消息服务的内存缓存，支持选择性清理
   * @example POST /message/cache/clear
   * @body { "deduplication": true, "history": true, "mergeQueues": true }
   * @example POST /message/cache/clear?chatId=wxid_xxx (清理指定会话)
   */
  @Post('cache/clear')
  clearCache(
    @Body()
    body?: {
      deduplication?: boolean;
      history?: boolean;
      mergeQueues?: boolean;
    },
    @Query('chatId') chatId?: string,
  ) {
    const options = {
      ...body,
      chatId,
    };

    return this.messageService.clearCache(options);
  }

  /**
   * 测试接口：模拟 Agent API 失败
   * @description 用于测试错误处理流程，包括飞书告警和降级回复
   * @example POST /message/test-error
   * @body { "text": "测试消息", "chatId": "test_chat_123", "errorType": "timeout" }
   */
  @Post('test-error')
  async testError(
    @Body()
    body: {
      text?: string;
      chatId?: string;
      orgId?: string;
      token?: string;
      errorType?: 'timeout' | 'network' | 'unauthorized' | 'server_error';
    },
  ) {
    this.logger.log('收到错误测试请求:', body);

    // 构造模拟的消息数据
    const mockMessageData: EnterpriseMessageCallbackDto = {
      orgId: body.orgId || 'test_org_123',
      token: body.token || 'test_token_for_development',
      botId: 'test_bot_123',
      imBotId: 'test_bot_wxid',
      chatId: body.chatId || `test_chat_${Date.now()}`,
      messageType: MessageType.TEXT,
      messageId: `test_msg_${Date.now()}`,
      timestamp: Date.now().toString(),
      isSelf: false,
      source: MessageSource.NEW_CUSTOMER_ANSWER_SOP, // 触发 AI 回复
      contactType: ContactType.PERSONAL_WECHAT,
      payload: {
        text: body.text || '测试 Agent API 失败',
        pureText: body.text || '测试 Agent API 失败',
      },
    };

    this.logger.debug('构造的模拟消息:', JSON.stringify(mockMessageData, null, 2));

    try {
      // 调用消息处理服务，由于我们会在测试环境中模拟失败，
      // 这里应该会触发错误处理流程
      const result = await this.messageService.handleMessage(mockMessageData);

      return {
        success: true,
        message: '测试消息已发送（预期会触发 Agent API 失败处理）',
        mockData: mockMessageData,
        result,
        note: '如果 Agent API 配置不正确或不可用，应该会收到飞书告警和降级回复',
      };
    } catch (error) {
      // 如果这里捕获到错误，说明错误处理可能有问题
      this.logger.error('测试过程中发生未预期的错误:', error);
      return {
        success: false,
        message: '测试失败（消息服务抛出了异常）',
        error: error.message,
        note: '消息服务应该内部处理错误，不应该向外抛出',
      };
    }
  }

  /**
   * 测试接口：模拟小组级消息回调
   * @description 用于测试小组级回调的完整流程（检测、转换、处理、发送）
   * @example POST /message/test-group
   * @body { "text": "测试小组级消息", "token": "68f88a31d53018ed04950739" }
   */
  @Post('test-group')
  async testGroupMessage(
    @Body()
    body: {
      text?: string;
      token?: string;
      chatId?: string;
    },
  ) {
    this.logger.log('收到小组级测试消息请求:', body);

    // 构造小组级格式的回调数据（参考 test-callback-adapter.json）
    const mockGroupCallback = {
      data: {
        messageId: `test_group_msg_${Date.now()}`,
        chatId: body.chatId || '68e7618f9d6d3a463b8dec3d',
        avatar:
          'https://wx.qlogo.cn/mmhead/oLU121BePGnQELLZwWEIfzyOZESyeA9ibPibsjOEqrPrHhLERgibRM6NG6yraSFxtemo3PNHa6trK8/0',
        roomTopic: '',
        roomId: '',
        contactName: '测试用户',
        contactId: '7881300085910772',
        payload: {
          text: body.text || '测试小组级消息发送',
          pureText: body.text || '测试小组级消息发送',
        },
        type: MessageType.TEXT,
        timestamp: Date.now(),
        token: body.token || '68f88a31d53018ed04950739', // 小组级 token
        contactType: ContactType.PERSONAL_WECHAT,
        coworker: false,
        botId: '68d3b986de170dd6eb01982a',
        botWxid: '1688854747775509',
        botWeixin: 'ZhuJie',
        isSelf: false,
        externalUserId: '',
        roomWecomChatId: null,
        mentionSelf: false,
      },
    };

    this.logger.debug('构造的小组级回调数据:', JSON.stringify(mockGroupCallback, null, 2));

    // 调用统一的消息接收接口（会经过完整的检测、转换、处理流程）
    const result = await this.receiveMessage(mockGroupCallback);

    return {
      success: true,
      message: '小组级测试消息已处理',
      mockData: mockGroupCallback,
      result,
      note: '该测试会经过完整的流程：格式检测 → 小组级转企业级 → 过滤 → AI回复 → 消息发送',
    };
  }

  /**
   * 诊断接口：检测回调格式并显示差异
   * @description 用于调试和理解企业级/小组级回调格式的差异
   * @example POST /message/callback/diagnose
   * @body 任意回调数据（企业级或小组级）
   */
  @Post('callback/diagnose')
  diagnoseCallback(@Body() body: any) {
    const callbackType = this.callbackAdapter.detectCallbackType(body);

    const result: any = {
      detectedType: callbackType,
      summary: {
        enterprise: '企业级格式（数据在顶层，有 orgId/groupId/source 字段）',
        group: '小组级格式（数据在 data 字段中，有 coworker/mentionSelf 等字段）',
        unknown: '未知格式（建议检查数据结构）',
      }[callbackType],
      originalData: body,
    };

    // 如果是小组级格式，显示转换后的数据
    if (callbackType === 'group') {
      const normalizedData = this.callbackAdapter.normalizeCallback(body);
      result.normalizedData = normalizedData;
      result.conversion = {
        message: '小组级格式已转换为企业级格式',
        fieldMappings: [
          { from: 'data.type', to: 'messageType' },
          { from: 'data.contactId', to: 'imContactId' },
          { from: 'data.botWxid', to: 'imBotId' },
          { from: 'data.botWeixin', to: 'botUserId' },
          { from: 'data.timestamp (number)', to: 'timestamp (string)' },
          { from: 'data.roomId', to: 'imRoomId' },
          { from: 'data.roomTopic', to: 'roomName' },
        ],
        addedFields: [
          { field: 'orgId', value: normalizedData.orgId, note: '从 token 提取或使用默认值' },
          { field: 'groupId', value: normalizedData.groupId, note: '小组级没有此字段' },
          { field: 'source', value: normalizedData.source, note: '默认为 MOBILE_PUSH' },
        ],
      };
    }

    // 如果是企业级格式，直接显示
    if (callbackType === 'enterprise') {
      result.message = '已是企业级格式，无需转换';
    }

    return result;
  }

  /**
   * 工具接口：获取格式差异说明
   * @description 获取企业级和小组级格式的详细差异说明
   * @example GET /message/callback/diff
   */
  @Get('callback/diff')
  getCallbackDiff() {
    return {
      title: '企业级 vs 小组级回调格式差异',
      structureDifference: {
        enterprise: '数据在顶层（直接访问字段）',
        group: '数据在 data 字段中（需要通过 body.data 访问）',
      },
      fieldMappings: [
        {
          dataType: '消息类型',
          groupField: 'type',
          enterpriseField: 'messageType',
          note: '取值相同',
        },
        {
          dataType: '联系人ID',
          groupField: 'contactId',
          enterpriseField: 'imContactId',
          note: '系统微信号',
        },
        {
          dataType: 'Bot微信ID',
          groupField: 'botWxid',
          enterpriseField: 'imBotId',
          note: '托管账号的系统wxid',
        },
        {
          dataType: 'Bot用户ID',
          groupField: 'botWeixin',
          enterpriseField: 'botUserId',
          note: '用户ID/员工ID',
        },
        {
          dataType: '时间戳',
          groupField: 'timestamp (number)',
          enterpriseField: 'timestamp (string)',
          note: '类型不同，需要转换',
        },
        {
          dataType: '群聊ID',
          groupField: 'roomId',
          enterpriseField: 'imRoomId',
          note: '群聊时有值',
        },
        {
          dataType: '群聊名称',
          groupField: 'roomTopic',
          enterpriseField: 'roomName',
          note: '群聊时有值',
        },
      ],
      enterpriseOnly: [
        { field: 'orgId', description: '组织ID - 企业级特有' },
        { field: 'groupId', description: '分组ID - 企业级特有（可选）' },
        { field: 'source', description: '消息来源标识 - 企业级特有' },
      ],
      groupOnly: [
        { field: 'coworker', description: '是否同事 - 小组级特有' },
        { field: 'mentionSelf', description: '是否@自己 - 小组级特有' },
        { field: 'externalUserId', description: '外部用户ID - 小组级特有' },
      ],
      commonFields: [
        'messageId',
        'chatId',
        'avatar',
        'contactName',
        'contactType',
        'token',
        'botId',
        'payload',
      ],
      adapterBehavior: {
        autoDetection: '根据数据结构特征自动检测格式类型',
        conversion: '小组级格式会自动转换为企业级统一格式',
        defaultValues: {
          orgId: '从 token 提取或使用默认值 "default_org_from_group_callback"',
          groupId: 'undefined（小组级没有此字段）',
          source: 'MessageSource.MOBILE_PUSH（默认值）',
        },
      },
    };
  }

  // ==================== 小组黑名单管理 ====================

  /**
   * 获取小组黑名单列表
   * @description 获取所有在黑名单中的小组（不触发AI回复但记录历史）
   * @example GET /message/blacklist/groups
   */
  @Get('blacklist/groups')
  async getGroupBlacklist() {
    const blacklist = await this.groupBlacklistService.getGroupBlacklist();
    return {
      success: true,
      data: blacklist,
      count: blacklist.length,
      description: '黑名单中的小组不会触发AI回复，但消息仍会记录到聊天历史',
    };
  }

  /**
   * 添加小组到黑名单
   * @description 添加小组到黑名单，该小组的消息不会触发AI回复但会记录历史
   * @example POST /message/blacklist/groups
   * @body { "groupId": "691d3b171535fed6bcc94f66", "reason": "测试小组" }
   */
  @Post('blacklist/groups')
  async addGroupToBlacklist(
    @Body()
    body: {
      groupId: string;
      reason?: string;
    },
  ) {
    if (!body.groupId) {
      return {
        success: false,
        message: 'groupId 是必填字段',
      };
    }

    await this.groupBlacklistService.addGroupToBlacklist(body.groupId, body.reason);

    return {
      success: true,
      message: `小组 ${body.groupId} 已添加到黑名单`,
      data: {
        groupId: body.groupId,
        reason: body.reason,
        addedAt: Date.now(),
      },
    };
  }

  /**
   * 从黑名单移除小组
   * @description 从黑名单中移除小组，恢复该小组的AI回复功能
   * @example DELETE /message/blacklist/groups/:groupId
   */
  @Delete('blacklist/groups/:groupId')
  async removeGroupFromBlacklist(@Param('groupId') groupId: string) {
    const removed = await this.groupBlacklistService.removeGroupFromBlacklist(groupId);

    if (removed) {
      return {
        success: true,
        message: `小组 ${groupId} 已从黑名单移除`,
      };
    } else {
      return {
        success: false,
        message: `小组 ${groupId} 不在黑名单中`,
      };
    }
  }

  /**
   * 检查小组是否在黑名单中
   * @description 检查指定小组是否在黑名单中
   * @example GET /message/blacklist/groups/:groupId/check
   */
  @Get('blacklist/groups/:groupId/check')
  async checkGroupBlacklist(@Param('groupId') groupId: string) {
    const isBlacklisted = await this.groupBlacklistService.isGroupBlacklisted(groupId);

    return {
      success: true,
      data: {
        groupId,
        isBlacklisted,
        description: isBlacklisted
          ? '该小组在黑名单中，消息不会触发AI回复但会记录历史'
          : '该小组不在黑名单中，消息会正常触发AI回复',
      },
    };
  }

  // ==================== 队列管理 ====================

  /**
   * 获取消息队列状态
   * @description 获取 Bull 队列中各状态的任务数量
   * @example GET /message/queue/status
   */
  @Get('queue/status')
  async getQueueStatus() {
    const queueStatus = await this.messageProcessor.getQueueStatus();
    const workerStatus = this.messageProcessor.getWorkerStatus();

    return {
      success: true,
      data: {
        queue: queueStatus,
        worker: workerStatus,
      },
      description: {
        waiting: '等待处理的任务',
        active: '正在处理的任务',
        completed: '已完成的任务',
        failed: '失败的任务',
        delayed: '延迟执行的任务',
        paused: '暂停的任务',
      },
    };
  }

  /**
   * 清理队列中卡住的任务
   * @description 清理 active（卡住）和 failed 状态的任务
   * @example POST /message/queue/clean
   * @body { "cleanActive": true, "cleanFailed": true, "cleanCompleted": false, "cleanDelayed": false }
   */
  @Post('queue/clean')
  async cleanQueue(
    @Body()
    body?: {
      cleanActive?: boolean;
      cleanFailed?: boolean;
      cleanCompleted?: boolean;
      cleanDelayed?: boolean;
      gracePeriodMs?: number;
    },
  ) {
    const result = await this.messageProcessor.cleanStuckJobs(body);

    return {
      success: result.success,
      data: result.cleaned,
      message: result.message,
    };
  }
}

import {
  Controller,
  Post,
  Body,
  Param,
  HttpException,
  HttpStatus,
  UseGuards,
  ParseEnumPipe,
  Logger,
} from '@nestjs/common';
import { ApiTokenGuard } from '@infra/server/guards/api-token.guard';
import { GroupTaskSchedulerService } from './services/group-task-scheduler.service';
import { GroupResolverService } from './services/group-resolver.service';
import { NotificationSenderService } from './services/notification-sender.service';
import { RoomService } from '@channels/wecom/room/room.service';
import { MessageSenderService } from '@channels/wecom/message-sender/message-sender.service';
import { FeishuAlertService } from '@infra/feishu/services/alert.service';
import { AlertLevel } from '@infra/feishu/interfaces/interface';
import { CompletionService } from '@agent/completion.service';
import { ConfigService } from '@nestjs/config';
import { GroupTaskType, GroupContext } from './group-task.types';

/**
 * 群任务 Controller
 *
 * 手动触发通知任务（调试用）。
 * 配置管理已合并到 /config/agent-config 和 /config/group-task-config。
 * 显式声明 ApiTokenGuard，防止全局 Guard 配置变更时意外暴露。
 */
@UseGuards(ApiTokenGuard)
@Controller('group-task')
export class GroupTaskController {
  private readonly logger = new Logger(GroupTaskController.name);

  constructor(
    private readonly scheduler: GroupTaskSchedulerService,
    private readonly groupResolver: GroupResolverService,
    private readonly notificationSender: NotificationSenderService,
    private readonly completionService: CompletionService,
    private readonly roomService: RoomService,
    private readonly messageSender: MessageSenderService,
    private readonly alertService: FeishuAlertService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * 手动触发指定类型的通知任务
   *
   * POST /group-task/trigger/:type
   * type: order_grab | part_time | store_manager | work_tips
   *
   * forceEnabled=true 绕过 enabled 开关（即使定时任务关闭也能执行），
   * 但仍遵守 DB 中的 dryRun 设置（试运行时只发飞书不发企微）。
   */
  @Post('trigger/:type')
  async trigger(@Param('type', new ParseEnumPipe(GroupTaskType)) type: GroupTaskType) {
    const strategy = this.scheduler.getStrategy(type);

    if (!strategy) {
      throw new HttpException(
        `未知的任务类型: ${type}，可选值: ${Object.values(GroupTaskType).join(', ')}`,
        HttpStatus.BAD_REQUEST,
      );
    }

    const result = await this.scheduler.executeTask(strategy, { forceEnabled: true });
    return {
      type: result.type,
      totalGroups: result.totalGroups,
      successCount: result.successCount,
      failedCount: result.failedCount,
      skippedCount: result.skippedCount,
      details: result.details,
      errors: result.errors,
      durationMs: result.endTime.getTime() - result.startTime.getTime(),
    };
  }

  /**
   * 测试端点：向指定群发送模拟群任务通知
   *
   * POST /group-task/test-send
   * Body: { type, groupName, city?, industry?, forceSend? }
   *
   * 从已配置的小组 token 中查找目标群（按群名匹配），
   * 运行策略的完整流程（fetchData → 生成消息 → 发送）。
   */
  @Post('test-send')
  async testSend(
    @Body()
    body: {
      /** 任务类型 */
      type: GroupTaskType;
      /** 目标群名称（精确匹配） */
      groupName: string;
      /** 模拟城市（默认 '上海'） */
      city?: string;
      /** 模拟行业（默认 '餐饮'） */
      industry?: string;
      /** 强制发送到企微（默认 false，只发飞书预览） */
      forceSend?: boolean;
    },
  ) {
    const { type, groupName, city = '上海', industry = '餐饮', forceSend = false } = body;

    if (!type || !groupName) {
      throw new HttpException('type 和 groupName 必填', HttpStatus.BAD_REQUEST);
    }

    // 1. 获取策略
    const strategy = this.scheduler.getStrategy(type);
    if (!strategy) {
      throw new HttpException(
        `未知的任务类型: ${type}，可选值: ${Object.values(GroupTaskType).join(', ')}`,
        HttpStatus.BAD_REQUEST,
      );
    }

    // 2. 按群名搜索任意群（不要求有标签）
    const targetGroup = await this.groupResolver.findGroupByName(groupName);
    if (!targetGroup) {
      return {
        success: false,
        error: `未找到群: ${groupName}`,
        hint: '确保目标群在已配置的小组 token 中（GROUP_TASK_TOKENS）',
      };
    }

    // 3. 覆盖城市/行业（测试用）
    const testContext: GroupContext = {
      ...targetGroup,
      city,
      industry,
    };

    // 4. 执行策略：fetchData → 生成消息
    const data = await strategy.fetchData(testContext);
    if (!data.hasData) {
      return {
        success: false,
        error: '策略无数据可推送',
        summary: data.summary,
        context: { city, industry, groupName: targetGroup.groupName },
      };
    }

    let message: string;
    if (strategy.needsAI && strategy.buildPrompt) {
      const prompt = strategy.buildPrompt(data, testContext);
      message = await this.completionService.generateSimple({
        systemPrompt: prompt.systemPrompt,
        userMessage: prompt.userMessage,
      });
      if (strategy.appendFooter) {
        message = strategy.appendFooter(message, data);
      }
    } else if (strategy.buildMessage) {
      message = strategy.buildMessage(data, testContext);
    } else {
      throw new HttpException(
        '策略未实现 buildMessage 或 buildPrompt',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    // 5. 发送（forceSend=false 时相当于 dryRun，只发飞书预览）
    const dryRun = !forceSend;
    await this.notificationSender.sendToGroup(targetGroup, message, type, dryRun);

    // 6. 跟随消息（如店长群问候语）单独发送
    const followUpMessage = data.payload?.followUpMessage as string | undefined;
    if (followUpMessage) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await this.notificationSender.sendTextToGroup(targetGroup, followUpMessage, dryRun);
    }

    return {
      success: true,
      dryRun,
      groupName: targetGroup.groupName,
      city,
      industry,
      type,
      dataSummary: data.summary,
      message,
      followUpMessage,
    };
  }

  /**
   * 临时测试端点：模拟 invite_to_group 工具的完整链路
   *
   * POST /group-task/test-invite
   * Body: { city, contactWxid, imBotId?, imContactId?, enterpriseToken?, industry? }
   *
   * 链路：GroupResolver 解析兼职群 → 按城市/行业匹配 → RoomService.addMember 拉人 → 发话术消息
   *
   * 发话术需要传 imBotId + imContactId + enterpriseToken（企业级 API）
   */
  @Post('test-invite')
  async testInvite(
    @Body()
    body: {
      city: string;
      contactWxid: string;
      imBotId?: string;
      imContactId?: string;
      enterpriseToken?: string;
      industry?: string;
      /** 模拟群满场景，触发飞书告警 */
      simulateGroupFull?: boolean;
    },
  ) {
    const { city, contactWxid, industry } = body;
    if (!city || !contactWxid) {
      throw new HttpException('city 和 contactWxid 必填', HttpStatus.BAD_REQUEST);
    }

    // Step 1: 获取兼职群列表
    const allGroups = await this.groupResolver.resolveGroups('兼职群');
    this.logger.log(`兼职群总数: ${allGroups.length}`);

    if (allGroups.length === 0) {
      return { success: false, error: '无兼职群数据', step: 'resolve_groups' };
    }

    // Step 2: 按城市筛选
    const cityGroups = allGroups.filter((g) => g.city === city);
    if (cityGroups.length === 0) {
      const availableCities = [...new Set(allGroups.map((g) => g.city))];
      return {
        success: false,
        error: `城市 ${city} 无匹配群`,
        availableCities,
        step: 'city_filter',
      };
    }

    // Step 3: 按行业精筛
    let candidates = cityGroups;
    if (industry) {
      const industryGroups = cityGroups.filter((g) => g.industry === industry);
      candidates = industryGroups.length > 0 ? industryGroups : cityGroups;
    }

    // Step 3.5: 模拟群满 → 飞书告警
    if (body.simulateGroupFull) {
      this.logger.warn(`[模拟] 群满告警: ${city}/${industry ?? '全行业'}`);
      const alertResult = await this.alertService.sendAlert({
        errorType: 'group_full',
        level: AlertLevel.WARNING,
        title: '兼职群容量已满',
        message: `${city}${industry ? `/${industry}` : ''} 所有兼职群已满，需要创建新群`,
        details: {
          city,
          industry: industry ?? '全行业',
          groups: candidates.map((g) => ({
            name: g.groupName,
            memberCount: g.memberCount,
          })),
          simulated: true,
        },
      });
      return {
        success: false,
        reason: 'group_full',
        simulated: true,
        alertSent: alertResult,
        groups: candidates.map((g) => ({
          name: g.groupName,
          memberCount: g.memberCount,
        })),
      };
    }

    // Step 4: 选群（人数最少的）
    const sorted = candidates
      .filter((g) => g.memberCount !== undefined)
      .sort((a, b) => (a.memberCount ?? 0) - (b.memberCount ?? 0));
    const targetGroup = (sorted.length > 0 ? sorted : candidates)[0];

    this.logger.log(
      `目标群: ${targetGroup.groupName} (room=${targetGroup.imRoomId}, bot=${targetGroup.imBotId}, members=${targetGroup.memberCount})`,
    );

    // Step 5: 企业级拉人进群
    try {
      const enterpriseToken = this.configService.get<string>('STRIDE_ENTERPRISE_TOKEN', '');
      // imBotId 优先用请求参数传入的（模拟聊天 bot），回退到群所属 bot 的系统 wxid
      const inviteBotId = body.imBotId || targetGroup.imBotId;
      const addResult = await this.roomService.addMemberEnterprise({
        token: enterpriseToken,
        imBotId: inviteBotId,
        botUserId: targetGroup.imBotId,
        contactWxid,
        roomWxid: targetGroup.imRoomId,
      });

      const isInviteLink = (targetGroup.memberCount ?? 0) >= 100;
      const inviteMode = isInviteLink ? 'link' : 'direct';

      // Step 6: 发送话术消息（企业级 API：需要 imBotId + imContactId + enterpriseToken）
      let sendResult: unknown = null;
      const {
        imBotId: requestImBotId,
        imContactId: requestImContactId,
        enterpriseToken: requestEnterpriseToken,
      } = body;
      if (requestImBotId && requestImContactId && requestEnterpriseToken) {
        const text =
          inviteMode === 'direct'
            ? `已帮你加入了${targetGroup.groupName}，里面经常有同城的好岗位，可以多留意~`
            : `已发了入群邀请，点一下就能进群，里面经常有同城的好岗位，有新的机会可以第一时间看到~`;

        sendResult = await this.messageSender.sendMessage({
          token: requestEnterpriseToken,
          imBotId: requestImBotId,
          imContactId: requestImContactId,
          messageType: 7,
          payload: { text },
        });
        this.logger.log(`话术消息已发送: inviteMode=${inviteMode}`);
      }

      return {
        success: true,
        groupName: targetGroup.groupName,
        city,
        industry: industry ?? undefined,
        inviteMode,
        memberCount: targetGroup.memberCount,
        addMemberResult: addResult,
        sendResult,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: message,
        step: 'add_member',
        targetGroup: targetGroup.groupName,
      };
    }
  }
}

import {
  BadRequestException,
  Controller,
  Get,
  Post,
  HttpCode,
  Logger,
  Body,
  Param,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { DashboardAccessService } from '@infra/server/dashboard-access/dashboard-access.service';
import { isDashboardAdministrator } from '@/types/dashboard-account';
import { UserHostingService } from './services/user-hosting.service';

/**
 * 用户管理控制器
 * 处理用户托管、状态切换等业务逻辑
 */
@Controller('user')
export class UserController {
  private readonly logger = new Logger(UserController.name);

  constructor(
    private readonly userHostingService: UserHostingService,
    private readonly access: DashboardAccessService,
  ) {}

  @Post('users/:userId/pause')
  @HttpCode(200)
  async pauseUserHosting(
    @Param('userId') userId: string,
    @Body('permanent') permanent?: boolean,
    @Body('reason') reason?: string,
    @Body('operator') operator?: string,
  ) {
    this.logger.log(`暂停用户托管: ${userId}${permanent ? '（永久）' : ''}`);
    await this.userHostingService.pauseUser(userId, {
      permanent,
      reason,
      operator,
      source: 'manual',
    });
    return {
      userId,
      isPaused: true,
      isPermanent: permanent === true,
      message: permanent ? `用户 ${userId} 已永久禁止托管` : `用户 ${userId} 的托管已暂停`,
    };
  }

  @Post('users/:userId/resume')
  @HttpCode(200)
  async resumeUserHosting(@Param('userId') userId: string) {
    this.logger.log(`恢复用户托管: ${userId}`);
    await this.userHostingService.resumeUser(userId);
    return {
      userId,
      isPaused: false,
      message: `用户 ${userId} 的托管已恢复`,
    };
  }

  @Get('users/paused')
  async getPausedUsers() {
    this.logger.debug('获取暂停托管用户列表');
    return { users: await this.userHostingService.getPausedUsersWithProfiles() };
  }

  @Get('users/:userId/status')
  async getUserHostingStatus(@Param('userId') userId: string) {
    return {
      userId,
      isPaused: await this.userHostingService.isUserPaused(userId),
    };
  }

  @Post('users/:chatId/hosting')
  @HttpCode(200)
  async toggleUserHosting(
    @Param('chatId') chatId: string,
    @Body('enabled') enabled: unknown,
    @Req() request: Request,
  ) {
    const actor = this.access.requireAccount(request);
    if (typeof enabled !== 'boolean' || !chatId.trim() || chatId.length > 100)
      throw new BadRequestException('请选择有效的会话和托管状态');
    if (!isDashboardAdministrator(actor)) {
      await this.userHostingService.setTenantHosting(actor.organization, chatId, enabled);
    } else if (enabled) {
      await this.userHostingService.resumeUser(chatId);
    } else {
      await this.userHostingService.pauseUser(chatId, { source: 'manual' });
    }
    this.logger.log(
      `用户托管开关 actor=${actor.userId} organization=${actor.organization} chat=${JSON.stringify(chatId)} enabled=${enabled}`,
    );
    return {
      chatId,
      hostingEnabled: enabled,
      message: `用户 ${chatId} 的托管已${enabled ? '启用' : '暂停'}`,
    };
  }
}

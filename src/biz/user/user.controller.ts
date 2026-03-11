import { Controller, Get, Post, HttpCode, Logger, Body, Param } from '@nestjs/common';
import { UserHostingService } from './user-hosting.service';

/**
 * 用户管理控制器
 * 处理用户托管、状态切换等业务逻辑
 */
@Controller('user')
export class UserController {
  private readonly logger = new Logger(UserController.name);

  constructor(private readonly userHostingService: UserHostingService) {}

  @Post('users/:userId/pause')
  @HttpCode(200)
  async pauseUserHosting(@Param('userId') userId: string) {
    this.logger.log(`暂停用户托管: ${userId}`);
    await this.userHostingService.pauseUser(userId);
    return {
      userId,
      isPaused: true,
      message: `用户 ${userId} 的托管已暂停`,
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
  async toggleUserHosting(@Param('chatId') chatId: string, @Body('enabled') enabled: boolean) {
    this.logger.log(`切换用户托管状态: ${chatId}, enabled=${enabled}`);
    if (enabled) {
      await this.userHostingService.resumeUser(chatId);
      return { chatId, hostingEnabled: true, message: `用户 ${chatId} 的托管已启用` };
    } else {
      await this.userHostingService.pauseUser(chatId);
      return { chatId, hostingEnabled: false, message: `用户 ${chatId} 的托管已暂停` };
    }
  }
}

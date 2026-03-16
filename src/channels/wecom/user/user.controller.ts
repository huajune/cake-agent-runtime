import { Controller, Get, Query } from '@nestjs/common';
import { UserService } from './user.service';

/**
 * 企业成员管理控制器
 * 提供企业内部成员查询接口
 */
@Controller('user')
export class UserController {
  constructor(private readonly userService: UserService) {}

  /**
   * 获取企业成员列表
   * @description 查询企业内部所有成员信息
   * @example GET /user/list?token=xxx&current=0&pageSize=20
   */
  @Get('list')
  async getUserList(
    @Query('token') token: string,
    @Query('current') current?: number,
    @Query('pageSize') pageSize?: number,
  ) {
    return await this.userService.getUserList(token, current, pageSize);
  }
}

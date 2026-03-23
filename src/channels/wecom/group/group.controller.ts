import { Controller, Get, Query } from '@nestjs/common';
import { GroupService } from './group.service';

@Controller('group')
export class GroupController {
  constructor(private readonly groupService: GroupService) {}

  /**
   * 获取小组列表
   * 访问: GET http://localhost:8080/group/list?token=xxx
   */
  @Get('list')
  async getGroupList(
    @Query('token') token: string,
    @Query('current') current?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return await this.groupService.getGroupList({
      token,
      current: current ? parseInt(current, 10) : undefined,
      pageSize: pageSize ? parseInt(pageSize, 10) : undefined,
    });
  }
}

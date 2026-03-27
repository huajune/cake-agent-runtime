import { Controller, Get, Query } from '@nestjs/common';
import { GroupService } from './group.service';

@Controller('group')
export class GroupController {
  constructor(private readonly groupService: GroupService) {}

  /**
   * 获取小组列表
   * 访问: GET http://localhost:8080/group/list
   */
  @Get('list')
  async getGroupList(
    @Query('current') current?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return await this.groupService.getGroupList({
      current: current ? parseInt(current, 10) : undefined,
      pageSize: pageSize ? parseInt(pageSize, 10) : undefined,
    });
  }
}

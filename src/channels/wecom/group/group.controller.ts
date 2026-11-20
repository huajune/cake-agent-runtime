import { Controller, Get, Query } from '@nestjs/common';
import { GroupService } from './group.service';

import { HostingBindingsRepository } from '@biz/center-dashboard/hosting-bindings.repository';

@Controller('group')
export class GroupController {
  constructor(
    private readonly groupService: GroupService,
    private readonly bindings: HostingBindingsRepository,
  ) {}

  /**
   * 获取小组列表
   * 访问: GET http://localhost:8080/group/list
   */
  @Get('list')
  async getGroupList(
    @Query('current') current?: string,
    @Query('pageSize') pageSize?: string,
    @Query('all') all?: string,
  ) {
    if (all === 'true') {
      const groups = await this.groupService.getAllGroups();
      const ownership = await this.bindings.scope(
        groups.map((g) => g.id),
        [],
      );
      return groups.map((group) => ({ ...group, tenantId: ownership.groups[group.id] ?? null }));
    }
    return this.groupService.getGroupList({
      current: current ? parseInt(current, 10) : undefined,
      pageSize: pageSize ? parseInt(pageSize, 10) : undefined,
    });
  }
}

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { DashboardAdminOnly } from '@infra/server/guards/api-token.guard';
import { DashboardAccessService } from '@infra/server/dashboard-access/dashboard-access.service';
import {
  hostingGroupId,
  hostingSelection,
  readHostingSelection,
} from '@infra/server/dashboard-access/hosting-binding.schema';
import { type DashboardOrganization, isDashboardOrganization } from '@/types/dashboard-account';
import { HostingBindingsService } from './hosting-bindings.service';
import { HostingBindingsRepository } from './hosting-bindings.repository';

const bindingRequest = hostingSelection.extend({
  organization: z.custom<DashboardOrganization>(isDashboardOrganization),
});
const handoverRequest = z
  .object({
    targetGroupId: hostingGroupId.nullable(),
    effectiveAt: z.iso.datetime({ offset: true }),
  })
  .strict();

@Controller('dashboard/hosting-bindings')
@DashboardAdminOnly()
export class HostingBindingsController {
  constructor(
    private readonly service: HostingBindingsService,
    private readonly repository: HostingBindingsRepository,
    private readonly access: DashboardAccessService,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  directory() {
    return this.repository.directory();
  }

  @Post('sync')
  async sync() {
    await this.service.sync();
    return this.repository.directory();
  }

  @Post('members/:id')
  async bind(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const parsed = bindingRequest.safeParse(body);
    if (!parsed.success) throw new BadRequestException('请选择成员所属组织和托管小组');
    await this.service.bind(
      id,
      parsed.data.organization,
      readHostingSelection(parsed.data),
      this.access.requireAccount(req).userId,
    );
    return { message: '小组绑定已保存' };
  }

  @Post('handovers/:id')
  async confirm(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const parsed = handoverRequest.safeParse(body);
    if (!parsed.success) throw new BadRequestException('请选择要核对的小组及实际交接时间');
    await this.service.confirm(
      id,
      parsed.data.targetGroupId,
      parsed.data.effectiveAt,
      this.access.requireAccount(req).userId,
    );
    return { message: '交接已确认' };
  }
}

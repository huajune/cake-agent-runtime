import {
  BadRequestException,
  Body,
  Controller,
  DefaultValuePipe,
  Delete,
  Get,
  Header,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { dashboardPasswordSchema } from './dashboard-password.schema';
import { hostingSelection, readHostingSelection } from './hosting-binding.schema';
import { normalizeDashboardPhone, TenantRole } from '@/types/dashboard-account';
import { DashboardAccessService } from './dashboard-access.service';
import { DashboardAccountsService } from './dashboard-accounts.service';
import { DashboardAdminOnly } from '../guards/api-token.guard';

const organizationSchema = z.string().trim().min(1);
const createSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    phone: z.string().transform(normalizeDashboardPhone).refine(Boolean),
    organization: organizationSchema,
    tenantRole: z.enum(TenantRole).optional(),
    memberId: z.uuid().optional(),
    password: dashboardPasswordSchema,
    hostingBinding: hostingSelection.transform(readHostingSelection).optional(),
  })
  .strict();
const resetSchema = z.object({ password: dashboardPasswordSchema }).strict();

@Controller('dashboard/accounts')
@DashboardAdminOnly()
export class DashboardAccountsController {
  constructor(
    private readonly accounts: DashboardAccountsService,
    private readonly access: DashboardAccessService,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  list(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('organization') organization?: string,
  ) {
    if (page < 1 || page > 100000) throw new BadRequestException('页码无效');
    const tenant = organizationSchema.optional().safeParse(organization);
    if (!tenant.success) throw new BadRequestException('请选择有效组织');
    return this.accounts.list(page, tenant.data);
  }

  @Get('organizations')
  @Header('Cache-Control', 'no-store')
  listTenants(@Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number) {
    if (page < 1 || page > 100000) throw new BadRequestException('页码无效');
    return this.accounts.listTenants(page);
  }

  @Post('organizations')
  async registerOrganization(@Req() req: Request, @Body() body: unknown) {
    const parsed = z
      .object({ name: z.string().trim().min(1).max(100) })
      .strict()
      .safeParse(body);
    if (!parsed.success) throw new BadRequestException('请输入 1 至 100 个字符的组织名称');
    return this.accounts.registerTenant(parsed.data.name, this.access.requireAccount(req).userId);
  }

  @Post()
  async create(@Req() req: Request, @Body() body: unknown) {
    const actor = this.access.requireAccount(req).userId;
    const parsed = createSchema.safeParse(body);
    if (!parsed.success || !parsed.data.phone)
      throw new BadRequestException(
        '请检查姓名、手机号、所属组织、角色及密码（至少 8 个字符，最多 72 字节）',
      );
    const { name, phone, password, organization, tenantRole, memberId, hostingBinding } =
      parsed.data;
    await this.accounts.create(
      {
        name,
        phone,
        password,
        organization,
        ...(tenantRole && { tenantRole }),
        ...(memberId && { memberId }),
        ...(hostingBinding && { hostingBinding }),
      },
      actor,
    );
    return { message: '账号已开通' };
  }

  @Delete('organizations/:id')
  async deleteOrganization(@Req() req: Request, @Param('id') id: string) {
    await this.accounts.deleteEmptyTenant(id, this.access.requireAccount(req).userId);
    return { message: '组织已删除' };
  }

  @Post(':id/password')
  async reset(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const actor = this.access.requireAccount(req).userId;
    const parsed = resetSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('新密码至少 8 个字符，最多 72 字节');
    await this.accounts.resetPassword(id, parsed.data.password, actor);
    return { message: '密码已重置' };
  }

  @Post(':id/disable')
  async disable(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
    await this.accounts.disable(id, this.access.requireAccount(req).userId);
    return { message: '账号已停用' };
  }

  @Post(':id/restore')
  async restore(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
    await this.accounts.restore(id, this.access.requireAccount(req).userId);
    return { message: '账号已恢复' };
  }

  @Delete(':id')
  async deleteLogin(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
    await this.accounts.deleteLogin(id, this.access.requireAccount(req).userId);
    return { message: '登录资格已删除' };
  }
}

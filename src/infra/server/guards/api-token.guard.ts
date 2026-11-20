import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { DashboardAccessService } from '../dashboard-access/dashboard-access.service';
import { authorizeCenterRequest } from '../dashboard-access/dashboard-access.guard';
import { isDashboardAdministrator } from '@/types/dashboard-account';

export const IS_PUBLIC_KEY = 'isPublic';
const MACHINE_ACCESS = 'allowMachineAccess';
const ADMIN_ONLY = 'dashboardAdministratorOnly';
export const DashboardAdminOnly = () => SetMetadata(ADMIN_ONLY, true);
export const AllowMachineAccess = () => SetMetadata(MACHINE_ACCESS, true);

@Injectable()
export class ApiTokenGuard implements CanActivate {
  private readonly machineToken?: string;
  constructor(
    config: ConfigService,
    private readonly reflector: Reflector,
    private readonly access: DashboardAccessService,
  ) {
    this.machineToken = config.get<string>('CAKE_MACHINE_API_TOKEN');
    if (this.machineToken && this.machineToken === config.get<string>('API_GUARD_TOKEN'))
      throw new Error('机器凭据必须与历史前端凭据不同');
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    const adminOnly = this.reflector.getAllAndOverride<boolean>(ADMIN_ONLY, targets);
    if (!adminOnly && this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets))
      return true;
    const request = context.switchToHttp().getRequest<Request>();
    const token = /^Bearer ([^\s]+)$/i.exec(request.headers.authorization ?? '')?.[1];
    if (!token) throw new UnauthorizedException('请登录运营后台');
    if (this.machineToken && token === this.machineToken) {
      if (!adminOnly && this.reflector.getAllAndOverride<boolean>(MACHINE_ACCESS, targets))
        return true;
      throw new ForbiddenException('此接口需要后台员工账号');
    }
    const account = await this.access.authenticate(request, token);
    if (adminOnly && !isDashboardAdministrator(account))
      throw new ForbiddenException('仅管理员 cakeadmin 可使用此功能');
    if (account.organization !== 'headquarters') authorizeCenterRequest(request);
    return true;
  }
}

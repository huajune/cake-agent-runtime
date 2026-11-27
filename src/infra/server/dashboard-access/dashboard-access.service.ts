import { Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import type { DashboardAccount } from '@/types/dashboard-account';
import { DashboardAccountsService } from './dashboard-accounts.service';

@Injectable()
export class DashboardAccessService {
  // Nest can apply the guard both globally and on a handler. Bind the result only to this HTTP request.
  private readonly actors = new WeakMap<Request, DashboardAccount>();
  constructor(private readonly accounts: DashboardAccountsService) {}

  async authenticate(request: Request, token: string): Promise<DashboardAccount> {
    const known = this.actors.get(request);
    if (known) return known;
    const account = await this.accounts.identify(token);
    this.actors.set(request, account);
    return account;
  }

  current(request: Request): DashboardAccount | undefined {
    return this.actors.get(request);
  }

  requireAccount(request: Request): DashboardAccount {
    const account = this.current(request);
    if (!account) throw new UnauthorizedException('请登录运营后台');
    return account;
  }
}

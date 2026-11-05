import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';
import { ApiConfigService } from '@infra/config/api-config.service';
import { fetchWithTimeout } from '@infra/utils/fetch-timeout.util';

export const LEGACY_GROUP_CORP_ID = 'group_callback_org';
const DIRECTORY_TIMEOUT_MS = 5000;
const MAX_DIRECTORY_GROUPS = 2000;
const MAX_DIRECTORY_BOTS = 10000;

interface GroupRouteScope {
  corpId: string;
  accountId: string;
  groupId?: string;
}

interface GroupRouteCredential {
  groupId: string;
  accountId: string;
  corpId: string;
  botId: string;
  token: string;
}

/** Current server-side directory credentials; never derive authority from callback body identity. */
@Injectable()
export class GroupRouteCredentialsService {
  // Share only an in-flight read. A completed read must never authorize a later request.
  private pending?: {
    enterpriseToken: string;
    promise: Promise<GroupRouteCredential[]>;
  };

  constructor(
    private readonly config: ConfigService,
    private readonly apiConfig: ApiConfigService,
  ) {}

  async verifyCallback(
    input: GroupRouteScope & { token: string; botId?: string },
  ): Promise<{ groupId: string; corpIds: string[] } | null> {
    if (!this.hasScope(input) || !input.token) return null;
    const route = this.findRoute(await this.readDirectory(), input);
    if (!route || (input.botId !== undefined && input.botId !== route.botId)) return null;
    const expected = Buffer.from(route.token);
    const supplied = Buffer.from(input.token);
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;
    return { groupId: route.groupId, corpIds: [LEGACY_GROUP_CORP_ID, route.corpId] };
  }

  async resolveForRecovery(
    input: GroupRouteScope,
  ): Promise<{ token: string; groupId: string } | null> {
    // A missing frozen group cannot be reconstructed from today's membership after a move.
    if (!this.hasScope(input) || !input.groupId?.trim()) return null;
    const route = this.findRoute(await this.readDirectory(), input);
    return route ? { token: route.token, groupId: route.groupId } : null;
  }

  private hasScope(input: GroupRouteScope): boolean {
    return Boolean(input.corpId?.trim() && input.accountId?.trim());
  }

  private findRoute(
    directory: GroupRouteCredential[],
    input: GroupRouteScope,
  ): GroupRouteCredential | null {
    const route = directory.find((entry) => entry.accountId === input.accountId.trim());
    if (
      !route ||
      !route.token ||
      !route.corpId ||
      route.corpId === LEGACY_GROUP_CORP_ID ||
      (input.groupId !== undefined && input.groupId.trim() !== route.groupId) ||
      (input.corpId.trim() !== LEGACY_GROUP_CORP_ID && input.corpId.trim() !== route.corpId)
    )
      return null;
    return route;
  }

  private async readDirectory(): Promise<GroupRouteCredential[]> {
    const enterpriseToken = this.config.get<string>('STRIDE_ENTERPRISE_TOKEN')?.trim();
    if (!enterpriseToken) throw new Error('group_route_credentials_unavailable');
    if (this.pending?.enterpriseToken === enterpriseToken) return this.pending.promise;
    const promise = this.fetchDirectory(enterpriseToken);
    this.pending = { enterpriseToken, promise };
    try {
      return await promise;
    } finally {
      if (this.pending?.promise === promise) this.pending = undefined;
    }
  }

  private async fetchDirectory(enterpriseToken: string): Promise<GroupRouteCredential[]> {
    try {
      const url = new URL(this.apiConfig.endpoints.bot.groupBots());
      url.searchParams.set('token', enterpriseToken);
      const response = await fetchWithTimeout(url.toString(), {
        method: 'GET',
        redirect: 'error',
        timeoutMs: DIRECTORY_TIMEOUT_MS,
        // Keep the deadline active during response body decoding as well as headers.
        signal: AbortSignal.timeout(DIRECTORY_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error('directory_http_failure');
      return this.parseDirectory(await response.json());
    } catch {
      // Do not expose URL, upstream response, token, or cause through the public endpoint/logs.
      throw new Error('group_route_credentials_unavailable');
    }
  }

  private parseDirectory(response: unknown): GroupRouteCredential[] {
    let value = response;
    for (let depth = 0; depth < 5; depth++) {
      if (!this.isObject(value)) throw new Error('directory_invalid');
      if ('errcode' in value && value.errcode !== 0) throw new Error('directory_failed');
      if (!('data' in value)) break;
      value = value.data;
    }
    if (
      !this.isObject(value) ||
      ('errcode' in value && value.errcode !== 0) ||
      !Array.isArray(value.groups) ||
      value.groups.length > MAX_DIRECTORY_GROUPS
    )
      throw new Error('directory_invalid');
    const groupIds = new Set<string>();
    const accountIds = new Set<string>();
    const routes: GroupRouteCredential[] = [];
    for (const group of value.groups) {
      if (!this.isObject(group)) throw new Error('directory_invalid_group');
      const groupId = this.text(group.id);
      if (!groupId || groupIds.has(groupId) || !Array.isArray(group.bots))
        throw new Error('directory_ambiguous_group');
      groupIds.add(groupId);
      for (const bot of group.bots) {
        if (!this.isObject(bot)) throw new Error('directory_invalid_account');
        const accountId = this.text(bot.wxid);
        if (!accountId || accountIds.has(accountId) || routes.length >= MAX_DIRECTORY_BOTS)
          throw new Error('directory_ambiguous_account');
        accountIds.add(accountId);
        routes.push({
          groupId,
          accountId,
          corpId: this.text(bot.corpId),
          botId: this.text(bot.id),
          token: this.text(group.token),
        });
      }
    }
    return routes;
  }

  private isObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  private text(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
  }
}

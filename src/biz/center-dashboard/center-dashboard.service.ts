import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { CenterRoute } from '@infra/server/dashboard-access/center-routes';
import { GroupBlacklistService } from '@biz/hosting-config/services/group-blacklist.service';
import { FOLLOW_UP_SCENARIOS } from '@agent/reengagement/scenario-registry';
import { CenterScopeService } from './center-scope.service';
import { CenterDashboardRepository } from './center-dashboard.repository';

@Injectable()
export class CenterDashboardService {
  constructor(
    private readonly scopes: CenterScopeService,
    private readonly blacklist: GroupBlacklistService,
    private readonly repository: CenterDashboardRepository,
  ) {}

  async handle(kind: CenterRoute, request: Request) {
    const scope = await this.scopes.getScope(kind === 'group-switch');
    if (kind === 'groups') return scope.groups;
    if (kind === 'bots') return scope.bots;
    if (kind === 'blacklist') {
      const groups = await this.blacklist.getGroupBlacklistStrict();
      const allowed = new Set(scope.groups.map((group) => group.id));
      return {
        chatIds: [],
        groupIds: groups
          .filter((group) => allowed.has(group.group_id))
          .map((group) => group.group_id),
      };
    }
    if (kind === 'group-switch') {
      const body = request.body;
      if (
        !body ||
        body.type !== 'groupId' ||
        typeof body.id !== 'string' ||
        Object.keys(body).some((key) => !['id', 'type'].includes(key))
      )
        throw new BadRequestException('只允许操作本中心的小组开关');
      if (!scope.groups.some((group) => group.id === body.id))
        throw new ForbiddenException('无权操作此小组');
      await this.blacklist.setGroupBlacklisted(
        body.id,
        request.method === 'POST',
        '河南自招团队小组开关',
      );
      return { message: '小组开关已保存' };
    }
    if (kind === 'scenarios')
      return FOLLOW_UP_SCENARIOS.map((scenario) => ({
        code: scenario.code,
        phase: scenario.phase,
        displayName: scenario.displayName,
        anchorEvent: scenario.anchorEvent,
        anchorLabel: scenario.anchorLabel,
        delayLabel: scenario.delayLabel,
        delayMode: scenario.delayMode,
        defaultDelayMinutes: scenario.defaultDelayMinutes,
        objective: scenario.objective,
        generationPolicy: scenario.generationPolicy,
        defaultRolloutEnabled: scenario.defaultRolloutEnabled,
      }));
    const input: Record<string, unknown> = { ...request.query };
    if (kind === 'messages') input.chatId = request.params.chatId;
    if (kind === 'processing-detail') input.id = request.params.messageId;
    return this.repository.read(kind, scope.botIds, input);
  }
}

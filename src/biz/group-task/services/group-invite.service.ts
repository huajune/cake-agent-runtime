import { ActionPermitService } from '@biz/action-permit/services/action-permit.service';
import { ActionExecutorService } from '@biz/action-execution/action-executor.service';
import { ActionRecoveryRegistry } from '@biz/action-execution/action-recovery.registry';
import type {
  ActionExecution,
  ActionIntent,
  ActionSyncContext,
} from '@biz/action-execution/action-execution.types';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RoomService } from '@channels/wecom/room/room.service';
import { MemoryService } from '@memory/memory.service';
import { OpsEventsRecorderService } from '@biz/ops-events/services/ops-events-recorder.service';
import { OpsNotifierService } from '@notification/services/ops-notifier.service';
import { normalizeCityName as normalizeCity } from '@resolution/geo';
import { sleep } from '@infra/utils/async.util';
import { toErrorMessage } from '@infra/utils/error.util';
import { refreshMemberCountsFromEnterpriseList } from '@tools/invite/enterprise-room-count.util';
import { GroupContext } from '../group-task.types';
import { GroupMembershipService } from './group-membership.service';
import { GroupResolverService } from './group-resolver.service';

const COMPAT_RETRY_DELAYS_MS = [3000, 5000, 8000];

export interface GroupInviteInput {
  corpId: string;
  userId: string;
  sessionId: string;
  botImId: string;
  botUserId: string;
  contactWxid: string;
  city: string;
  industry?: string;
  turnKey: string;
  logicalTurnId?: string;
  inputOccurredAt?: string;
  /** Live dispatch guard only; never stored in the action record. */
  authorize?: () => Promise<boolean>;
  messageId?: string;
  contactName?: string;
  chatId?: string;
}

export interface GroupInviteCitySnapshot {
  totalGroups: number;
  memberLimit: number;
  byIndustry: Array<{
    industry: string;
    groupCount: number;
    availableCount: number;
  }>;
}

export type GroupInviteFailureReason =
  | 'enterprise_token_missing'
  | 'missing_bot_identity'
  | 'no_group_available'
  | 'no_group_in_city'
  | 'group_full'
  | 'candidate_not_friend'
  | 'api_rejected'
  | 'api_failed'
  | 'result_unknown';

export interface GroupInviteResult {
  success: boolean;
  actionStatus?: string;
  actionId?: string;
  requestId?: string;
  actionDispatched?: boolean;
  actionReason?: string;
  localSync?: 'pending' | 'complete';
  groupName?: string;
  alreadyInGroup?: boolean;
  reason?: GroupInviteFailureReason;
  inviteDelivery?: 'direct_add' | 'invite_card';
  inviteCardPendingConsent?: boolean;
  matchedIndustry?: string;
  fallbackUsed?: boolean;
  selectionReason?: 'lowest_member_count' | 'only_option';
  citySnapshot?: GroupInviteCitySnapshot;
  rejectionReason?: string;
  totalRejected?: number;
}

interface InviteApiResult {
  accepted: boolean;
  code: number | null;
  error?: string;
  action?: ActionExecution<InviteApiResult>;
  unresolved?: boolean;
}

interface CompatibilityRetryOutcome {
  inviteResult: InviteApiResult;
  addBotResult: InviteApiResult;
  retryAttempts?: number;
}

@Injectable()
export class GroupInviteService implements OnModuleInit {
  private readonly logger = new Logger(GroupInviteService.name);

  private readonly memberLimit: number;
  private readonly enterpriseToken: string | null;

  constructor(
    private readonly groupResolver: GroupResolverService,
    private readonly groupMembership: GroupMembershipService,
    private readonly roomService: RoomService,
    private readonly memoryService: MemoryService,
    private readonly opsEventsRecorder: OpsEventsRecorderService,
    private readonly opsNotifier: OpsNotifierService,
    configService: ConfigService,
    private readonly actions: ActionExecutorService,
    private readonly recoveryRegistry: ActionRecoveryRegistry,
    private readonly permits: ActionPermitService,
  ) {
    this.memberLimit = Number.parseInt(configService.get('GROUP_MEMBER_LIMIT', '200'), 10);
    this.enterpriseToken = configService.get<string>('STRIDE_ENTERPRISE_TOKEN')?.trim() || null;
  }

  onModuleInit(): void {
    this.recoveryRegistry.register('wecom.group_add_member', {
      reconcile: async () => ({
        status: 'unknown',
        evidence: {
          kind: 'indeterminate',
          requestTerminated: false,
          detail: 'membership_is_not_request_completion_evidence',
        },
      }),
      sync: (record, context) =>
        this.syncInviteAction(record.intent, record.result as InviteApiResult, context),
    });
  }

  async preflightExistingMembership(input: GroupInviteInput): Promise<GroupInviteResult | null> {
    try {
      const cachedGroups = await this.groupResolver.resolveGroups('兼职群');
      const normalizedRequestedCity = normalizeCity(input.city);
      const requestedCityRooms = cachedGroups.filter(
        (group) => normalizeCity(group.city) === normalizedRequestedCity && Boolean(group.imRoomId),
      );
      if (requestedCityRooms.length === 0) return null;

      const roomsUserIn = await this.groupMembership.listUserRooms(
        input.contactWxid,
        requestedCityRooms.map((group) => group.imRoomId),
      );
      const existingGroup =
        roomsUserIn.length > 0
          ? requestedCityRooms.find((group) => group.imRoomId === roomsUserIn[0])
          : undefined;
      return existingGroup
        ? await this.respondAlreadyInGroup(input, existingGroup.groupName, '前置已在群闸门')
        : null;
    } catch (error: unknown) {
      this.logger.warn(`前置已在群闸门核验失败（降级回原流程）: ${toErrorMessage(error)}`);
      return null;
    }
  }

  async invite(input: GroupInviteInput): Promise<GroupInviteResult> {
    try {
      if (!this.enterpriseToken) {
        this.logger.error(`STRIDE_ENTERPRISE_TOKEN 未配置，无法拉人进群 (user=${input.userId})`);
        return { success: false, reason: 'enterprise_token_missing' };
      }
      if (!input.botImId || !input.botUserId) {
        this.logger.warn(`缺少 bot 身份信息，无法拉群 (user=${input.userId})`);
        return { success: false, reason: 'missing_bot_identity' };
      }

      const allGroups = await this.groupResolver.resolveGroups('兼职群', { forceRefresh: true });
      if (allGroups.length === 0) {
        this.logger.warn(`无兼职群数据 (user=${input.userId})`);
        return { success: false, reason: 'no_group_available' };
      }

      const normalizedTargetCity = normalizeCity(input.city);
      const cityGroups = allGroups.filter(
        (group) => normalizeCity(group.city) === normalizedTargetCity,
      );
      if (cityGroups.length === 0) {
        this.logger.log(`城市无匹配，静默跳过: ${input.city} (user=${input.userId})`);
        return { success: false, reason: 'no_group_in_city' };
      }

      const existingGroup = await this.findExistingGroup(input.contactWxid, cityGroups);
      if (existingGroup) {
        return this.respondAlreadyInGroup(input, existingGroup.groupName, '实时预检命中');
      }

      const groupsWithFreshCounts = await refreshMemberCountsFromEnterpriseList({
        groups: cityGroups,
        roomService: this.roomService,
        enterpriseToken: this.enterpriseToken,
      });
      const citySnapshot = this.buildCitySnapshot(groupsWithFreshCounts);
      const { candidates, fallbackUsed } = this.resolveCandidates(
        groupsWithFreshCounts,
        input.industry,
      );
      const availableCandidates = this.pickAvailableGroups(candidates);

      if (availableCandidates.length === 0) {
        this.logger.warn(
          `群已满: ${input.city}/${input.industry ?? '全行业'} (user=${input.userId})`,
        );
        this.sendGroupFullAlert(input, candidates);
        return { success: false, reason: 'group_full', citySnapshot };
      }

      const selectionReason =
        candidates.length === 1 ? ('only_option' as const) : ('lowest_member_count' as const);
      const fullGroupsDuringInvite: GroupContext[] = [];
      const rejectedGroupsDuringInvite: Array<{
        group: GroupContext;
        error?: string;
        code: number | null;
      }> = [];

      for (const targetGroup of availableCandidates) {
        let inviteApiResult = await this.invokeAddMember({
          input,
          targetGroup,
          token: this.enterpriseToken,
          imBotId: input.botImId,
          botUserId: input.botUserId,
          contactWxid: input.contactWxid,
          roomWxid: targetGroup.imRoomId,
        });
        if (inviteApiResult.unresolved)
          return {
            success: false,
            reason: 'result_unknown',
            groupName: targetGroup.groupName,
            ...this.actionReceipt(inviteApiResult.action),
          };
        const initialInviteApiResult = inviteApiResult;
        const compatibilityRetryOutcome = await this.maybeAddChatBotToGroupAndRetryInvite({
          input,
          token: this.enterpriseToken,
          initialResult: inviteApiResult,
          targetGroup,
          chatBotImId: input.botImId,
          chatBotUserId: input.botUserId,
          contactWxid: input.contactWxid,
        });
        if (compatibilityRetryOutcome) {
          inviteApiResult = compatibilityRetryOutcome.inviteResult;
        }

        if (inviteApiResult.unresolved)
          return {
            success: false,
            reason: 'result_unknown',
            groupName: targetGroup.groupName,
            ...this.actionReceipt(inviteApiResult.action),
          };
        const inviteCardSentPendingConsent =
          !inviteApiResult.accepted && this.isInviteCardSentPendingConsent(inviteApiResult);
        if (!inviteApiResult.accepted && !inviteCardSentPendingConsent) {
          if (inviteApiResult.code === -9) {
            return this.respondAlreadyInGroup(
              input,
              targetGroup.groupName,
              '接口返回已在群',
              inviteApiResult.action,
            );
          }
          if (inviteApiResult.code === -10) {
            this.logger.warn(
              `接口返回群已满，尝试下一个候选群: ${targetGroup.groupName} (user=${input.userId})`,
            );
            fullGroupsDuringInvite.push({
              ...targetGroup,
              memberCount: Math.max(targetGroup.memberCount ?? 0, this.memberLimit),
            });
            continue;
          }

          this.logger.warn(
            `企业级拉群接口拒绝，尝试下一个候选群: ${targetGroup.groupName} (user=${input.userId}, error=${inviteApiResult.error})`,
          );
          rejectedGroupsDuringInvite.push({
            group: targetGroup,
            error: this.formatInviteRejectionError(
              inviteApiResult,
              compatibilityRetryOutcome,
              initialInviteApiResult,
            ),
            code: inviteApiResult.code,
          });
          continue;
        }

        const isDirectAdd = !inviteCardSentPendingConsent && (targetGroup.memberCount ?? 0) < 40;
        this.logger.log(
          `拉群成功: ${targetGroup.groupName} (user=${input.userId}, city=${input.city}, industry=${input.industry ?? '-'}, matched=${targetGroup.industry ?? '-'}, fallback=${fallbackUsed}, pendingConsent=${inviteCardSentPendingConsent})`,
        );
        this.recordGroupInvited(input, targetGroup.groupName);
        return {
          success: true,
          ...this.actionReceipt(inviteApiResult.action),
          groupName: targetGroup.groupName,
          inviteDelivery: isDirectAdd ? 'direct_add' : 'invite_card',
          inviteCardPendingConsent: inviteCardSentPendingConsent,
          matchedIndustry: targetGroup.industry,
          fallbackUsed,
          selectionReason,
          citySnapshot,
        };
      }

      const fullGroupNames = new Set(fullGroupsDuringInvite.map((group) => group.imRoomId));
      const alertGroups = candidates.map((group) =>
        fullGroupNames.has(group.imRoomId)
          ? { ...group, memberCount: Math.max(group.memberCount ?? 0, this.memberLimit) }
          : group,
      );
      const allRejectionsNotFriend =
        rejectedGroupsDuringInvite.length > 0 &&
        fullGroupsDuringInvite.length === 0 &&
        rejectedGroupsDuringInvite.every((entry) => entry.code === -8);
      if (allRejectionsNotFriend) {
        this.logger.log(
          `候选人非接客 bot 外部联系人(拉黑/删好友)，静默收口不告警: ${input.city}/${input.industry ?? '全行业'} (user=${input.userId}, groups=${rejectedGroupsDuringInvite.length})`,
        );
        return { success: false, reason: 'candidate_not_friend' };
      }

      if (rejectedGroupsDuringInvite.length > 0) {
        this.logger.warn(
          `所有候选群均被拒绝: ${input.city}/${input.industry ?? '全行业'} (user=${input.userId}, rejected=${rejectedGroupsDuringInvite.length}, full=${fullGroupsDuringInvite.length})`,
        );
        this.sendInviteRejectedAlert(input, rejectedGroupsDuringInvite);
        return {
          success: false,
          reason: 'api_rejected',
          groupName: rejectedGroupsDuringInvite[0].group.groupName,
          citySnapshot,
          rejectionReason: rejectedGroupsDuringInvite[0].error,
          totalRejected: rejectedGroupsDuringInvite.length,
        };
      }

      this.logger.warn(
        `所有候选群均已满: ${input.city}/${input.industry ?? '全行业'} (user=${input.userId})`,
      );
      this.sendGroupFullAlert(input, alertGroups);
      return {
        success: false,
        reason: 'group_full',
        groupName: alertGroups.length === 1 ? alertGroups[0]?.groupName : undefined,
        citySnapshot: this.buildCitySnapshot(alertGroups),
      };
    } catch (error: unknown) {
      const message = toErrorMessage(error);
      this.logger.error(`拉群失败: ${message} (user=${input.userId})`);
      return { success: false, reason: 'api_failed', rejectionReason: message };
    }
  }

  private async findExistingGroup(
    contactWxid: string,
    cityGroups: GroupContext[],
  ): Promise<GroupContext | undefined> {
    const cityRoomIds = cityGroups.map((group) => group.imRoomId).filter(Boolean);
    const roomsUserIn = await this.groupMembership.listUserRooms(contactWxid, cityRoomIds);
    return roomsUserIn.length > 0
      ? cityGroups.find((group) => group.imRoomId === roomsUserIn[0])
      : undefined;
  }

  private async respondAlreadyInGroup(
    input: GroupInviteInput,
    groupName: string,
    via: string,
    action?: ActionExecution<InviteApiResult>,
  ): Promise<GroupInviteResult> {
    if (!action)
      await this.memoryService
        .saveInvitedGroup(input.corpId, input.userId, input.sessionId, {
          groupName,
          city: input.city,
          industry: input.industry,
          invitedAt: new Date().toISOString(),
        })
        .catch((error: unknown) => {
          this.logger.warn(`写入 invitedGroups 失败（忽略）: ${toErrorMessage(error)}`);
        });
    this.logger.log(`${via}：候选人已在群 ${groupName}，跳过拉群 (user=${input.userId})`);
    // Existing membership is an observed goal, not a newly completed invitation.
    return {
      success: true,
      alreadyInGroup: true,
      groupName,
      ...this.actionReceipt(action),
    };
  }

  private actionReceipt(action?: ActionExecution<InviteApiResult>) {
    return action
      ? {
          actionStatus: action.status,
          actionId: action.actionId,
          requestId: action.requestId,
          localSync: action.localSync,
          actionDispatched: action.dispatched,
          actionReason: action.reason,
        }
      : {};
  }

  private recordGroupInvited(input: GroupInviteInput, groupName: string): void {
    void this.opsEventsRecorder.recordEvent({
      corpId: input.corpId,
      eventName: 'group.invited',
      idempotencyKey: `${input.sessionId}:group:${groupName}:${input.turnKey}`,
      botImId: input.botImId,
      managerName: input.botUserId,
      sourceChannel: 'unknown',
      userId: input.userId,
      chatId: input.sessionId,
      payload: { group_name: groupName, city: input.city },
    });
  }

  private resolveCandidates(
    cityGroups: GroupContext[],
    industry?: string,
  ): { candidates: GroupContext[]; fallbackUsed: boolean } {
    if (!industry) return { candidates: cityGroups, fallbackUsed: false };
    const industryGroups = cityGroups.filter((group) => group.industry === industry);
    return industryGroups.length > 0
      ? { candidates: industryGroups, fallbackUsed: false }
      : { candidates: cityGroups, fallbackUsed: true };
  }

  private pickAvailableGroups(candidates: GroupContext[]): GroupContext[] {
    return [...candidates]
      .sort((left, right) => {
        const leftCount = left.memberCount ?? Number.POSITIVE_INFINITY;
        const rightCount = right.memberCount ?? Number.POSITIVE_INFINITY;
        return leftCount - rightCount;
      })
      .filter((group) => group.memberCount === undefined || group.memberCount < this.memberLimit);
  }

  private buildCitySnapshot(cityGroups: GroupContext[]): GroupInviteCitySnapshot {
    const byIndustry = new Map<string, { groupCount: number; availableCount: number }>();
    for (const group of cityGroups) {
      const industry = group.industry ?? '未分类';
      const entry = byIndustry.get(industry) ?? { groupCount: 0, availableCount: 0 };
      entry.groupCount += 1;
      if (group.memberCount === undefined || group.memberCount < this.memberLimit) {
        entry.availableCount += 1;
      }
      byIndustry.set(industry, entry);
    }
    return {
      totalGroups: cityGroups.length,
      memberLimit: this.memberLimit,
      byIndustry: Array.from(byIndustry.entries())
        .map(([industry, stats]) => ({ industry, ...stats }))
        .sort((left, right) => right.groupCount - left.groupCount),
    };
  }

  private sendGroupFullAlert(input: GroupInviteInput, groups: GroupContext[]): void {
    void this.opsNotifier
      .sendGroupFullAlert({
        city: input.city,
        industry: input.industry,
        memberLimit: this.memberLimit,
        groups: groups.map((group) => ({
          name: group.groupName,
          memberCount: group.memberCount,
        })),
      })
      .catch((error: unknown) => {
        this.logger.error(`飞书告警发送失败: ${toErrorMessage(error)}`);
      });
  }

  private sendInviteRejectedAlert(
    input: GroupInviteInput,
    rejectedGroups: Array<{ group: GroupContext; error?: string }>,
  ): void {
    void this.opsNotifier
      .sendInviteRejectedAlert({
        city: input.city,
        industry: input.industry,
        chatBotImId: input.botImId,
        chatBotUserId: input.botUserId,
        scope: {
          corpId: input.corpId,
          userId: input.userId,
          contactName: input.contactName,
          chatId: input.chatId ?? input.sessionId,
          sessionId: input.sessionId,
          messageId: input.messageId,
        },
        rejectedGroups: rejectedGroups.map((entry) => ({
          name: entry.group.groupName,
          imRoomId: entry.group.imRoomId,
          ownerBotImId: entry.group.imBotId,
          ownerBotUserId: entry.group.botUserId,
          error: entry.error,
        })),
      })
      .catch((error: unknown) => {
        this.logger.error(`飞书告警发送失败: ${toErrorMessage(error)}`);
      });
  }

  private async invokeAddMember(params: {
    token: string;
    imBotId: string;
    botUserId: string;
    contactWxid: string;
    roomWxid: string;
    input: GroupInviteInput;
    targetGroup: GroupContext;
    intentStep?: string;
  }): Promise<InviteApiResult> {
    const { input, targetGroup, intentStep, ...external } = params;
    const logicalTurnId = input.logicalTurnId ?? input.turnKey;
    const intent: ActionIntent = {
      corpId: input.corpId,
      accountId: external.imBotId,
      chatId: input.chatId ?? input.sessionId,
      logicalTurnId,
      intentId: `${logicalTurnId}:${intentStep ?? 'initial'}`,
      kind: 'wecom.group_add_member',
      target: `group:${external.roomWxid}:member:${external.contactWxid}`,
      parameters: {
        imBotId: external.imBotId,
        botUserId: external.botUserId,
        contactWxid: external.contactWxid,
        roomWxid: external.roomWxid,
      },
      occurredAt: input.inputOccurredAt ?? new Date().toISOString(),
      identityReliable: Boolean(input.logicalTurnId && input.inputOccurredAt),
      recovery: {
        userId: input.userId,
        sessionId: input.sessionId,
        groupName: targetGroup.groupName,
        city: input.city,
        industry: input.industry ?? null,
        candidate: external.contactWxid === input.contactWxid,
      },
    };
    const action = await this.actions.execute<InviteApiResult>(intent, {
      authorize: async () => {
        if (input.authorize && !(await input.authorize())) return false;
        return (
          await this.permits.evaluate({
            chatId: input.chatId ?? input.sessionId,
            action: 'tool',
            botImId: external.imBotId,
            candidateIds: [input.userId, input.contactWxid],
          })
        ).allowed;
      },
      dispatch: async () => {
        const result = this.parseInviteApiResult(
          await this.roomService.addMemberEnterprise(external),
        );
        if (result.code === 0 || this.isInviteCardSentPendingConsent(result) || result.code === -9)
          return {
            status: 'succeeded',
            result,
            evidence: {
              kind: result.code === -9 ? 'already_satisfied' : 'accepted',
              requestTerminated: true,
              goalSatisfied: result.code === -9,
              detail:
                result.code === -9
                  ? 'already_in_group'
                  : 'invitation_accepted_membership_not_verified',
            },
          };
        if (result.code != null && [-8, -10, 400400].includes(result.code))
          return {
            status: 'failed',
            result,
            retryable: false,
            evidence: { kind: 'definitive_no_effect', requestTerminated: true },
          };
        return {
          status: 'unknown',
          result,
          evidence: { kind: 'indeterminate', requestTerminated: false },
        };
      },
      sync: (result) => this.syncInviteAction(intent, result),
    });
    if (!['succeeded', 'failed'].includes(action.status) || !action.result)
      return { accepted: false, code: null, unresolved: true, action };
    return { ...action.result, action };
  }

  private async syncInviteAction(
    intent: ActionIntent,
    result: InviteApiResult,
    context?: ActionSyncContext,
  ): Promise<void> {
    const data = intent.recovery;
    if (
      !data?.candidate ||
      !(result.code === 0 || result.code === -9 || this.isInviteCardSentPendingConsent(result))
    )
      return;
    if (
      typeof data.userId !== 'string' ||
      typeof data.sessionId !== 'string' ||
      typeof data.groupName !== 'string' ||
      typeof data.city !== 'string'
    )
      throw new Error('Invite repair data unavailable');
    await context?.assertOwned();
    await this.memoryService.saveInvitedGroup(
      intent.corpId,
      data.userId,
      data.sessionId,
      {
        groupName: data.groupName,
        city: data.city,
        ...(typeof data.industry === 'string' ? { industry: data.industry } : {}),
        invitedAt: intent.occurredAt,
      },
      ...(context ? ([{ requireExisting: true }] as const) : ([] as const)),
    );
  }

  private async maybeAddChatBotToGroupAndRetryInvite(params: {
    input: GroupInviteInput;
    token: string;
    initialResult: InviteApiResult;
    targetGroup: GroupContext;
    chatBotImId: string;
    chatBotUserId: string;
    contactWxid: string;
  }): Promise<CompatibilityRetryOutcome | null> {
    if (
      !this.shouldAddChatBotToGroup(params.initialResult, params.targetGroup, params.chatBotImId)
    ) {
      return null;
    }
    const ownerBotUserId = params.targetGroup.botUserId?.trim();
    if (!ownerBotUserId) return null;

    try {
      const addBotResult = await this.invokeAddMember({
        input: params.input,
        targetGroup: params.targetGroup,
        intentStep: 'add_chat_bot',
        token: params.token,
        imBotId: params.targetGroup.imBotId,
        botUserId: ownerBotUserId,
        contactWxid: params.chatBotImId,
        roomWxid: params.targetGroup.imRoomId,
      });
      if (addBotResult.unresolved) return { inviteResult: addBotResult, addBotResult };
      if (!addBotResult.accepted && addBotResult.code !== -9) {
        this.logger.warn(
          `接客 bot 入群补偿失败: ${params.targetGroup.groupName} ` +
            `(chatBot=${params.chatBotImId}, ownerBot=${params.targetGroup.imBotId}, error=${addBotResult.error})`,
        );
        return { inviteResult: addBotResult, addBotResult };
      }

      this.logger.log(
        `接客 bot ${addBotResult.code === -9 ? '已在目标群' : '入群补偿成功'}，继续重试拉候选人: ${params.targetGroup.groupName} ` +
          `(chatBot=${params.chatBotImId}, ownerBot=${params.targetGroup.imBotId})`,
      );

      const syncChatBotRooms = async (): Promise<void> => {
        try {
          await this.roomService.syncRoom(params.token, params.chatBotImId);
        } catch (error: unknown) {
          this.logger.warn(`syncRoom 失败（忽略，继续重试拉人）: ${toErrorMessage(error)}`);
        }
      };
      let compatibilityAttempt = 0;
      const retryInviteCandidate = (): Promise<InviteApiResult> =>
        this.invokeAddMember({
          input: params.input,
          targetGroup: params.targetGroup,
          intentStep: `after_bot_join:${compatibilityAttempt++}`,
          token: params.token,
          imBotId: params.chatBotImId,
          botUserId: params.chatBotUserId,
          contactWxid: params.contactWxid,
          roomWxid: params.targetGroup.imRoomId,
        });

      await syncChatBotRooms();
      let retryInviteResult = await retryInviteCandidate();
      let retryAttempts = 1;
      for (const delayMs of COMPAT_RETRY_DELAYS_MS) {
        if (
          retryInviteResult.unresolved ||
          retryInviteResult.accepted ||
          !this.isRoomNotFoundError(retryInviteResult)
        )
          break;
        this.logger.log(
          `接客 bot 入群可能尚未生效，${delayMs}ms 后重试拉候选人: ${params.targetGroup.groupName} ` +
            `(chatBot=${params.chatBotImId}, attempt=${retryAttempts})`,
        );
        await sleep(delayMs);
        await syncChatBotRooms();
        retryInviteResult = await retryInviteCandidate();
        retryAttempts++;
      }
      if (!retryInviteResult.accepted) {
        this.logger.warn(
          `接客 bot 入群后重试拉候选人仍被拒绝: ${params.targetGroup.groupName} ` +
            `(chatBot=${params.chatBotImId}, attempts=${retryAttempts}, error=${retryInviteResult.error})`,
        );
      }
      return { inviteResult: retryInviteResult, addBotResult, retryAttempts };
    } catch (error: unknown) {
      const message = toErrorMessage(error);
      this.logger.warn(
        `接客 bot 入群补偿异常: ${params.targetGroup.groupName} ` +
          `(chatBot=${params.chatBotImId}, ownerBot=${params.targetGroup.imBotId}, error=${message})`,
      );
      const rejected = {
        accepted: false,
        code: null,
        error: `add chat bot to group exception: ${message}`,
      };
      return { inviteResult: rejected, addBotResult: rejected };
    }
  }

  private parseInviteApiResult(result: unknown): InviteApiResult {
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      return { accepted: true, code: null };
    }
    const record = result as Record<string, unknown>;
    const errcode = typeof record.errcode === 'number' ? record.errcode : null;
    if (errcode != null) {
      if (errcode === 0) return { accepted: true, code: 0 };
      const message =
        typeof record.errmsg === 'string' && record.errmsg.trim()
          ? record.errmsg.trim()
          : 'unknown error';
      return { accepted: false, code: errcode, error: `errcode=${errcode}, errmsg=${message}` };
    }
    const code = typeof record.code === 'number' ? record.code : null;
    if (code != null) {
      if (code === 0) return { accepted: true, code: 0 };
      const message =
        typeof record.message === 'string' && record.message.trim()
          ? record.message.trim()
          : 'unknown error';
      return { accepted: false, code, error: `code=${code}, message=${message}` };
    }
    if (record.success === false) {
      const message =
        typeof record.message === 'string' && record.message.trim()
          ? record.message.trim()
          : 'unknown error';
      return { accepted: false, code: null, error: `success=false, message=${message}` };
    }
    return { accepted: true, code: null };
  }

  private isRoomNotFoundError(result: InviteApiResult): boolean {
    return result.code === 400400 || /room not found/i.test(result.error ?? '');
  }

  private isInviteCardSentPendingConsent(result: InviteApiResult): boolean {
    return result.code === -12 || /已发送入群邀请/.test(result.error ?? '');
  }

  private shouldAddChatBotToGroup(
    result: InviteApiResult,
    targetGroup: GroupContext,
    chatBotImId: string,
  ): boolean {
    if (result.accepted) return false;
    const ownerBotImId = targetGroup.imBotId?.trim();
    return Boolean(
      ownerBotImId && ownerBotImId !== chatBotImId && this.isRoomNotFoundError(result),
    );
  }

  private formatInviteRejectionError(
    result: InviteApiResult,
    compatibilityRetryOutcome: CompatibilityRetryOutcome | null,
    initialResult: InviteApiResult,
  ): string | undefined {
    if (!compatibilityRetryOutcome) return result.error;
    const addBotError = compatibilityRetryOutcome.addBotResult.error;
    const retryInviteError = compatibilityRetryOutcome.inviteResult.error;
    if (
      compatibilityRetryOutcome.addBotResult.accepted ||
      compatibilityRetryOutcome.addBotResult.code === -9
    ) {
      const attempts = compatibilityRetryOutcome.retryAttempts ?? 1;
      return `candidate retry after adding chat bot rejected (${attempts} attempts with backoff): ${
        retryInviteError ?? 'unknown error'
      }; initial chat bot error: ${initialResult.error ?? 'unknown error'}`;
    }
    return `add chat bot to group rejected: ${
      addBotError ?? 'unknown error'
    }; initial chat bot error: ${initialResult.error ?? 'unknown error'}`;
  }
}

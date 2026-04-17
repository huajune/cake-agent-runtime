import { Logger } from '@nestjs/common';
import { tool } from 'ai';
import { z } from 'zod';
import { ToolBuilder } from '@shared-types/tool.types';
import { GroupResolverService } from '@biz/group-task/services/group-resolver.service';
import { GroupContext } from '@biz/group-task/group-task.types';
import { RoomService } from '@channels/wecom/room/room.service';
import { MemoryService } from '@memory/memory.service';
import { OpsNotifierService } from '@notification/services/ops-notifier.service';

const logger = new Logger('invite_to_group');

interface CitySnapshotIndustry {
  industry: string;
  groupCount: number;
  availableCount: number;
}

interface CitySnapshot {
  totalGroups: number;
  memberLimit: number;
  byIndustry: CitySnapshotIndustry[];
}

export function buildInviteToGroupTool(
  groupResolver: GroupResolverService,
  roomService: RoomService,
  opsNotifier: OpsNotifierService,
  memoryService: MemoryService,
  memberLimit: number,
  enterpriseToken?: string | null,
): ToolBuilder {
  return (context) =>
    tool({
      description: `邀请候选人加入企微兼职群。

使用场景（满足任一即可）：
1. 判断当前意向下已无匹配可能 — 必须先做过实际检索（至少一次 duliday_job_list）、已告知候选人当前没有合适岗位，再调用本工具。严禁为了凑推荐继续硬推不符合候选人意向的替代岗位。
2. 面试预约成功后 — 面试预约/信息收集完成，邀请入群获取更多机会。

返回字段：
- inviteMode："direct"（群<40人，直接拉入，告知"已帮你加入了XX群"）/"link"（群>=40人，发邀请卡片，告知"已发了入群邀请，点一下就能进群"）
- matchedIndustry：实际命中群的行业；与入参 industry 不一致即触发了回退
- fallbackUsed / selectionReason / citySnapshot：供你向候选人解释群选择依据`,
      inputSchema: z.object({
        city: z.string().describe('候选人所在城市'),
        industry: z
          .string()
          .optional()
          .describe('候选人求职意向行业（餐饮/零售等）；意向明确时必须传，详见兼职群资源段指引'),
      }),
      execute: async ({ city, industry }) => {
        try {
          if (context.bookingSucceeded === false) {
            logger.log(`本轮预约失败，跳过拉群: city=${city}, user=${context.userId}`);
            return {
              success: false,
              reason: 'booking_not_succeeded',
              error: '本轮面试预约未成功，不执行拉群',
            };
          }

          const normalizedEnterpriseToken = enterpriseToken?.trim();
          if (!normalizedEnterpriseToken) {
            logger.error(`STRIDE_ENTERPRISE_TOKEN 未配置，无法拉人进群 (user=${context.userId})`);
            return {
              success: false,
              errorType: 'enterprise_token_missing',
              error: 'STRIDE_ENTERPRISE_TOKEN 未配置，无法执行企业级拉群',
            };
          }
          if (!context.botImId || !context.botUserId) {
            logger.warn(`缺少 bot 身份信息，无法拉群 (user=${context.userId})`);
            return {
              success: false,
              reason: 'missing_bot_identity',
              errorType: 'missing_bot_identity',
              error: '缺少 botImId / botUserId，无法执行企业级拉群',
            };
          }

          const allGroups = await groupResolver.resolveGroups('兼职群');
          if (allGroups.length === 0) {
            logger.warn(`无兼职群数据 (user=${context.userId})`);
            return { success: false, error: '暂无可用群' };
          }

          const cityGroups = allGroups.filter((group) => group.city === city);
          if (cityGroups.length === 0) {
            logger.log(`城市无匹配，静默跳过: ${city} (user=${context.userId})`);
            return { success: false, reason: 'no_group_in_city' };
          }

          const citySnapshot = buildCitySnapshot(cityGroups, memberLimit);

          const { candidates, fallbackUsed } = resolveCandidates(cityGroups, industry);
          const targetGroup = pickAvailableGroup(candidates, memberLimit);

          if (!targetGroup) {
            logger.warn(`群已满: ${city}/${industry ?? '全行业'} (user=${context.userId})`);
            void sendGroupFullAlert({
              city,
              industry,
              memberLimit,
              groups: candidates.map((group) => ({
                name: group.groupName,
                memberCount: group.memberCount,
              })),
              opsNotifier,
            }).catch((error: unknown) => {
              const message = error instanceof Error ? error.message : String(error);
              logger.error(`飞书告警发送失败: ${message}`);
            });
            return {
              success: false,
              reason: 'group_full',
              citySnapshot,
            };
          }

          const isDirectAdd = (targetGroup.memberCount ?? 0) < 40;
          const selectionReason: 'lowest_member_count' | 'only_option' =
            candidates.length === 1 ? 'only_option' : 'lowest_member_count';

          const addResult = await roomService.addMemberEnterprise({
            token: normalizedEnterpriseToken,
            imBotId: context.botImId,
            botUserId: context.botUserId,
            contactWxid: context.userId,
            roomWxid: targetGroup.imRoomId,
          });
          const inviteApiResult = parseInviteApiResult(addResult);
          if (!inviteApiResult.accepted) {
            if (inviteApiResult.code === -9) {
              logger.log(
                `用户已在群中，静默跳过: ${targetGroup.groupName} (user=${context.userId})`,
              );
              return {
                success: false,
                reason: 'already_in_group',
                groupName: targetGroup.groupName,
              };
            }

            if (inviteApiResult.code === -10) {
              logger.warn(`接口返回群已满: ${targetGroup.groupName} (user=${context.userId})`);
              void sendGroupFullAlert({
                city,
                industry,
                memberLimit,
                groups: [
                  {
                    name: targetGroup.groupName,
                    memberCount: targetGroup.memberCount,
                  },
                ],
                opsNotifier,
              }).catch((error: unknown) => {
                const message = error instanceof Error ? error.message : String(error);
                logger.error(`飞书告警发送失败: ${message}`);
              });
              return {
                success: false,
                reason: 'group_full',
                groupName: targetGroup.groupName,
                citySnapshot,
              };
            }

            logger.warn(
              `企业级拉群接口拒绝: ${targetGroup.groupName} (user=${context.userId}, error=${inviteApiResult.error})`,
            );
            return {
              success: false,
              reason: 'invite_api_rejected',
              error: inviteApiResult.error,
              groupName: targetGroup.groupName,
              city,
              industry: industry ?? undefined,
            };
          }

          await memoryService.saveInvitedGroup(context.corpId, context.userId, context.sessionId, {
            groupName: targetGroup.groupName,
            city,
            industry: industry ?? undefined,
            invitedAt: new Date().toISOString(),
          });

          logger.log(
            `拉群成功: ${targetGroup.groupName} (user=${context.userId}, city=${city}, industry=${industry ?? '-'}, matched=${targetGroup.industry ?? '-'}, fallback=${fallbackUsed})`,
          );

          return {
            success: true,
            groupName: targetGroup.groupName,
            city,
            industry: industry ?? undefined,
            inviteMode: isDirectAdd ? 'direct' : 'link',
            matchedIndustry: targetGroup.industry,
            fallbackUsed,
            selectionReason,
            citySnapshot,
          };
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          logger.error(`拉群失败: ${message} (user=${context.userId})`);
          return { success: false, error: `拉人失败: ${message}` };
        }
      },
    });
}

function parseInviteApiResult(result: unknown): {
  accepted: boolean;
  code: number | null;
  error?: string;
} {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return { accepted: true, code: null };
  }

  const record = result as Record<string, unknown>;

  const errcode = typeof record.errcode === 'number' ? record.errcode : null;
  if (errcode != null) {
    if (errcode === 0) {
      return { accepted: true, code: 0 };
    }
    const message =
      typeof record.errmsg === 'string' && record.errmsg.trim()
        ? record.errmsg.trim()
        : 'unknown error';
    return {
      accepted: false,
      code: errcode,
      error: `errcode=${errcode}, errmsg=${message}`,
    };
  }

  const code = typeof record.code === 'number' ? record.code : null;
  if (code != null) {
    if (code === 0) {
      return { accepted: true, code: 0 };
    }
    const message =
      typeof record.message === 'string' && record.message.trim()
        ? record.message.trim()
        : 'unknown error';
    return {
      accepted: false,
      code,
      error: `code=${code}, message=${message}`,
    };
  }

  if (record.success === false) {
    const message =
      typeof record.message === 'string' && record.message.trim()
        ? record.message.trim()
        : 'unknown error';
    return {
      accepted: false,
      code: null,
      error: `success=false, message=${message}`,
    };
  }

  return { accepted: true, code: null };
}

function resolveCandidates(
  cityGroups: GroupContext[],
  industry?: string,
): { candidates: GroupContext[]; fallbackUsed: boolean } {
  if (!industry) {
    return { candidates: cityGroups, fallbackUsed: false };
  }
  const industryGroups = cityGroups.filter((group) => group.industry === industry);
  if (industryGroups.length > 0) {
    return { candidates: industryGroups, fallbackUsed: false };
  }
  return { candidates: cityGroups, fallbackUsed: true };
}

function pickAvailableGroup(
  candidates: GroupContext[],
  memberLimit: number,
): GroupContext | undefined {
  const sortedByCapacity = candidates
    .filter((group) => group.memberCount !== undefined)
    .sort((left, right) => (left.memberCount ?? 0) - (right.memberCount ?? 0));
  const withCapacity = sortedByCapacity.length > 0 ? sortedByCapacity : candidates;

  return withCapacity.find(
    (group) => group.memberCount === undefined || group.memberCount < memberLimit,
  );
}

function buildCitySnapshot(cityGroups: GroupContext[], memberLimit: number): CitySnapshot {
  const byIndustry = new Map<string, { groupCount: number; availableCount: number }>();

  for (const group of cityGroups) {
    const industry = group.industry ?? '未分类';
    const entry = byIndustry.get(industry) ?? { groupCount: 0, availableCount: 0 };
    entry.groupCount += 1;
    const hasCapacity = group.memberCount === undefined || group.memberCount < memberLimit;
    if (hasCapacity) entry.availableCount += 1;
    byIndustry.set(industry, entry);
  }

  return {
    totalGroups: cityGroups.length,
    memberLimit,
    byIndustry: Array.from(byIndustry.entries())
      .map(([industry, stats]) => ({ industry, ...stats }))
      .sort((left, right) => right.groupCount - left.groupCount),
  };
}

async function sendGroupFullAlert(params: {
  city: string;
  industry?: string;
  memberLimit: number;
  groups: Array<{ name: string; memberCount?: number }>;
  opsNotifier: OpsNotifierService;
}): Promise<boolean> {
  return params.opsNotifier.sendGroupFullAlert(params);
}

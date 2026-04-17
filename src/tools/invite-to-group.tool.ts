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
      description: `邀请候选人加入企微兼职群。根据城市和行业匹配合适的群。

使用场景（满足任一即可）：
1. 判断当前意向下已无匹配可能 — 候选人明确的意向（品牌/岗位类型/城市/区域/班次/薪资等）已超出当前可推范围，或继续检索已无新进展。由你自行判断时机，不设固定轮数门槛；但必须先做过实际检索（至少一次 duliday_job_list）、已告知候选人当前没有合适岗位，再调用本工具。严禁为了凑推荐继续硬推不符合候选人意向的替代岗位。
2. 面试预约成功后 — 面试预约/信息收集完成，邀请入群获取更多机会。

调用前必须已知候选人所在城市。

返回结果中 inviteMode 表示拉群方式：
- "direct"：已直接拉入群（群<40人），告知候选人"已帮你加入了XX群"
- "link"：已发送入群邀请卡片（群>=40人），告知候选人"已发了入群邀请，点一下就能进群"`,
      inputSchema: z.object({
        city: z.string().describe('候选人所在城市（必填）'),
        industry: z.string().optional().describe('行业偏好（可选，如：餐饮、零售）'),
      }),
      execute: async ({ city, industry }) => {
        try {
          // 硬规则：本轮 booking 失败则禁止拉群（穷尽推荐场景 bookingSucceeded 为 undefined，不拦截）
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
            // 该城市没有群：静默跳过，不告警、不通知候选人
            logger.log(`城市无匹配，静默跳过: ${city} (user=${context.userId})`);
            return { success: false, reason: 'no_group_in_city' };
          }

          const candidates = resolveCandidates(cityGroups, industry);
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
            return { success: false, reason: 'group_full' };
          }

          const isDirectAdd = (targetGroup.memberCount ?? 0) < 40;
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
            `拉群成功: ${targetGroup.groupName} (user=${context.userId}, city=${city}, industry=${industry ?? '-'})`,
          );

          return {
            success: true,
            groupName: targetGroup.groupName,
            city,
            industry: industry ?? undefined,
            inviteMode: isDirectAdd ? 'direct' : 'link',
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

function resolveCandidates(cityGroups: GroupContext[], industry?: string): GroupContext[] {
  if (!industry) return cityGroups;
  const industryGroups = cityGroups.filter((group) => group.industry === industry);
  return industryGroups.length > 0 ? industryGroups : cityGroups;
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

async function sendGroupFullAlert(params: {
  city: string;
  industry?: string;
  memberLimit: number;
  groups: Array<{ name: string; memberCount?: number }>;
  opsNotifier: OpsNotifierService;
}): Promise<boolean> {
  return params.opsNotifier.sendGroupFullAlert(params);
}

import { Logger } from '@nestjs/common';
import { tool } from 'ai';
import { z } from 'zod';
import { ToolBuilder } from '@shared-types/tool.types';
import { GroupResolverService } from '@biz/group-task/services/group-resolver.service';
import { GroupContext } from '@biz/group-task/group-task.types';
import { RoomService } from '@channels/wecom/room/room.service';
import { MemoryService } from '@memory/memory.service';
import { OpsNotifierService } from '@notification/services/ops-notifier.service';
import { refreshMemberCountsFromEnterpriseList } from '@tools/duliday/enterprise-room-count.util';

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

## 触发场景（满足任一即可）
1. **首次面试预约成功后** — duliday_interview_booking 返回 success: true（必须检查 _outcome 字段确认预约成功），且已知候选人城市时，在同轮调用。仅限本会话首次预约成功时触发，后续再预约不再重复拉群
2. **判断当前意向下已无匹配可能** — 候选人明确的意向（品牌、岗位类型、城市、区域、班次、薪资等）已超出当前可推范围，或继续检索已无新进展。必须先做过实际检索（至少一次 duliday_job_list）、已告知候选人当前没有合适岗位，再调用本工具。不设固定轮数门槛，由你根据对话把握时机；严禁为了凑推荐继续硬推不符合候选人意向的替代岗位
3. **候选人同意入群/后续通知** — 如果上一轮你曾提出"拉群/进群/有岗位通知"，候选人本轮回复"好/可以/嗯/谢谢"等同意词，必须调用本工具确认是否真的能拉群；只有 success: true 才能说已拉群或已发邀请

## 禁止触发
- duliday_interview_booking 本轮已调用且返回 success: false / 抛异常时（首次预约成功场景）
- 城市未知时
- 候选人明确拒绝或表示不需要时
- 本会话已经成功拉过群时（查看 [会话记忆] 中的 invitedGroups）
- 尚未做过任何岗位检索、还完全没判断过是否有匹配时

## 参数
- city（必填）：从 [会话记忆] 或对话上下文获取
- industry（强烈建议传）：候选人的求职意向行业
  - 候选人意向餐饮（如肯德基、必胜客、奶茶店、饭店服务员）→ 必须传 industry="餐饮"
  - 候选人意向零售（如奥乐齐、超市补货、便利店）→ 必须传 industry="零售"
  - 意向明确但漏传 → 工具按"人数最少"兜底，可能选到不匹配行业的群，引起候选人疑问
  - 仅当候选人跨行业或完全没表达过行业偏好时才可以不传

## 返回字段
- inviteMode：拉群方式
  - "direct"（群<40人，已直接拉入）→ 告知候选人"已帮你加入了XX群"
  - "link"（群>=40人，已发送入群邀请卡片）→ 告知候选人"已发了入群邀请，点一下就能进群"
- matchedIndustry：实际命中群的行业；与入参 industry 不一致说明触发了回退
- fallbackUsed：是否触发行业回退（入参 industry 在该城市无匹配群时为 true）
- selectionReason：选群原因（lowest_member_count / only_option）
- citySnapshot：该城市兼职群分布概览，可在候选人质疑群选择时作为解释依据

## 失败处理
- success: false 时静默跳过，不向候选人提及群相关内容
- 只有 success: true 时才能说"已拉群/已发入群邀请"；无群、群满、接口拒绝、未调用工具时，都不要承诺群相关动作
- 严禁在未调用本工具、或本工具返回 success: false 时说"我先拉你进群/后面群里通知/已发群邀请"`,
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

          const groupsWithFreshCounts = await refreshMemberCountsFromEnterpriseList({
            groups: cityGroups,
            roomService,
            enterpriseToken: normalizedEnterpriseToken,
          });
          const citySnapshot = buildCitySnapshot(groupsWithFreshCounts, memberLimit);

          const { candidates, fallbackUsed } = resolveCandidates(groupsWithFreshCounts, industry);
          const availableCandidates = pickAvailableGroups(candidates, memberLimit);

          if (availableCandidates.length === 0) {
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

          const selectionReason: 'lowest_member_count' | 'only_option' =
            candidates.length === 1 ? 'only_option' : 'lowest_member_count';

          const fullGroupsDuringInvite: GroupContext[] = [];
          for (const targetGroup of availableCandidates) {
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
                // 外部接口返回 user 已在群：写入 invitedGroups 记忆，避免同会话后续
                // 再触发 invite_to_group 重复调用这个慢接口（实测每次 20-30s）。
                await memoryService
                  .saveInvitedGroup(context.corpId, context.userId, context.sessionId, {
                    groupName: targetGroup.groupName,
                    city,
                    industry: industry ?? undefined,
                    invitedAt: new Date().toISOString(),
                  })
                  .catch((err: unknown) => {
                    const msg = err instanceof Error ? err.message : String(err);
                    logger.warn(`写入 invitedGroups 失败（忽略）: ${msg}`);
                  });
                logger.log(
                  `用户已在群中，记入记忆并静默跳过: ${targetGroup.groupName} (user=${context.userId})`,
                );
                return {
                  success: false,
                  reason: 'already_in_group',
                  groupName: targetGroup.groupName,
                };
              }

              if (inviteApiResult.code === -10) {
                logger.warn(
                  `接口返回群已满，尝试下一个候选群: ${targetGroup.groupName} (user=${context.userId})`,
                );
                fullGroupsDuringInvite.push({
                  ...targetGroup,
                  memberCount: Math.max(targetGroup.memberCount ?? 0, memberLimit),
                });
                continue;
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

            await memoryService.saveInvitedGroup(
              context.corpId,
              context.userId,
              context.sessionId,
              {
                groupName: targetGroup.groupName,
                city,
                industry: industry ?? undefined,
                invitedAt: new Date().toISOString(),
              },
            );

            const isDirectAdd = (targetGroup.memberCount ?? 0) < 40;

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
          }

          const fullGroupNames = new Set(fullGroupsDuringInvite.map((group) => group.imRoomId));
          const alertGroups = candidates.map((group) =>
            fullGroupNames.has(group.imRoomId)
              ? { ...group, memberCount: Math.max(group.memberCount ?? 0, memberLimit) }
              : group,
          );

          logger.warn(`所有候选群均已满: ${city}/${industry ?? '全行业'} (user=${context.userId})`);
          void sendGroupFullAlert({
            city,
            industry,
            memberLimit,
            groups: alertGroups.map((group) => ({
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
            groupName: alertGroups.length === 1 ? alertGroups[0]?.groupName : undefined,
            citySnapshot: buildCitySnapshot(alertGroups, memberLimit),
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

function pickAvailableGroups(candidates: GroupContext[], memberLimit: number): GroupContext[] {
  return [...candidates]
    .sort((left, right) => {
      const leftCount = left.memberCount ?? Number.POSITIVE_INFINITY;
      const rightCount = right.memberCount ?? Number.POSITIVE_INFINITY;
      return leftCount - rightCount;
    })
    .filter((group) => group.memberCount === undefined || group.memberCount < memberLimit);
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

import { Logger } from '@nestjs/common';
import { tool } from 'ai';
import { z } from 'zod';
import { ToolBuilder } from '@shared-types/tool.types';
import { GroupResolverService } from '@biz/group-task/services/group-resolver.service';
import { GroupContext } from '@biz/group-task/group-task.types';
import { RoomService } from '@channels/wecom/room/room.service';
import { RedisService } from '@infra/redis/redis.service';
import { FeishuAlertService } from '@infra/feishu/services/alert.service';
import { AlertLevel } from '@infra/feishu/interfaces/interface';
import { MemoryService } from '@memory/memory.service';

const logger = new Logger('invite_to_group');

/** Redis 去重 key 前缀 */
const INVITE_KEY_PREFIX = 'invite';
/** 去重记录 TTL：30 天 */
const INVITE_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * invite_to_group 构建函数
 *
 * 邀请候选人加入企微兼职群。
 * 根据城市和行业匹配合适的群，执行拉人操作。
 *
 * 触发场景：
 * 1. 穷尽推荐后无匹配岗位（严格边界：多次调整推荐策略仍无匹配）
 * 2. 候选人完成登记后（面试预约/信息收集完成）
 */
export function buildInviteToGroupTool(
  groupResolver: GroupResolverService,
  roomService: RoomService,
  redisService: RedisService,
  alertService: FeishuAlertService,
  memoryService: MemoryService,
  memberLimit: number,
  enterpriseToken: string,
): ToolBuilder {
  return (context) => {
    return tool({
      description: `邀请候选人加入企微兼职群。根据城市和行业匹配合适的群。

使用场景：
1. 穷尽推荐后无匹配岗位 — 必须同时满足：已明确候选人意向（城市/区域）、已尝试多维度推荐（换区域/品牌/岗位类型）、确认无可推荐岗位、已告知候选人当前没有合适岗位。禁止在信息不全或仅搜索一次无结果时调用。
2. 候选人完成登记后 — 面试预约/信息收集完成，邀请入群获取更多机会。

调用前必须已知候选人所在城市。

返回结果中 inviteMode 表示拉群方式：
- "direct"：已直接拉入群，告知候选人"已帮你加入了XX群"
- "link"：已发送入群邀请链接，告知候选人"已发了入群邀请，点一下就能进群"`,
      inputSchema: z.object({
        city: z.string().describe('候选人所在城市（必填）'),
        industry: z.string().optional().describe('行业偏好（可选，如：餐饮、零售）'),
      }),
      execute: async ({ city, industry }) => {
        try {
          // 1. 获取兼职群列表（带 10 分钟缓存）
          const allGroups = await groupResolver.resolveGroups('兼职群');
          if (allGroups.length === 0) {
            logger.warn(`无兼职群数据 (user=${context.userId})`);
            return { success: false, error: '暂无可用群' };
          }

          // 2. 按城市筛选
          const cityGroups = allGroups.filter((g) => g.city === city);
          if (cityGroups.length === 0) {
            const availableCities = [...new Set(allGroups.map((g) => g.city))];
            logger.warn(`城市无匹配: ${city} (user=${context.userId})`);
            return { success: false, availableCities };
          }

          // 3. 按行业精筛（可选）
          let candidates: GroupContext[];
          if (industry) {
            const industryGroups = cityGroups.filter((g) => g.industry === industry);
            // 有行业匹配用行业匹配，否则回退到城市级
            candidates = industryGroups.length > 0 ? industryGroups : cityGroups;
          } else {
            candidates = cityGroups;
          }

          // 4. 容量排序 & 选群
          const sortedByCapacity = candidates
            .filter((g) => g.memberCount !== undefined)
            .sort((a, b) => (a.memberCount ?? 0) - (b.memberCount ?? 0));

          // 如果没有 memberCount 数据，直接用第一个
          const withCapacity = sortedByCapacity.length > 0 ? sortedByCapacity : candidates;

          const targetGroup = withCapacity.find(
            (g) => g.memberCount === undefined || g.memberCount < memberLimit,
          );

          if (!targetGroup) {
            // 全部已满 → 飞书告警，对候选人静默跳过
            logger.warn(`群已满: ${city}/${industry ?? '全行业'} (user=${context.userId})`);
            alertService
              .sendAlert({
                errorType: 'group_full',
                level: AlertLevel.WARNING,
                title: '兼职群容量已满',
                message: `${city}${industry ? `/${industry}` : ''} 所有兼职群已满，需要创建新群`,
                details: {
                  city,
                  industry: industry ?? '全行业',
                  groups: candidates.map((g) => ({
                    name: g.groupName,
                    memberCount: g.memberCount,
                  })),
                },
              })
              .catch((e: unknown) => {
                const msg = e instanceof Error ? e.message : String(e);
                logger.error(`飞书告警发送失败: ${msg}`);
              });
            return { success: false, reason: 'group_full' };
          }

          // 5. 检查重复（Redis 去重）
          const redisKey = `${INVITE_KEY_PREFIX}:${context.corpId}:${context.userId}:${targetGroup.imRoomId}`;
          const alreadyInvited = await redisService.exists(redisKey);
          if (alreadyInvited) {
            logger.log(`已拉过此群: ${targetGroup.groupName} (user=${context.userId})`);
            return {
              success: false,
              reason: 'already_invited',
              groupName: targetGroup.groupName,
            };
          }

          // 6. 执行拉人（企业级接口，不受小组限制）
          const imBotId = context.botImId || '';
          const botUserId = context.botUserId || '';
          await roomService.addMemberEnterprise({
            token: enterpriseToken,
            imBotId,
            botUserId,
            contactWxid: context.userId,
            roomWxid: targetGroup.imRoomId,
          });

          // 7. 记录 Redis（TTL 30 天）+ 写入会话记忆
          await redisService.setex(redisKey, INVITE_TTL_SECONDS, '1');
          await memoryService.saveInvitedGroup(context.corpId, context.userId, context.sessionId, {
            groupName: targetGroup.groupName,
            city,
            industry: industry ?? undefined,
            invitedAt: new Date().toISOString(),
          });

          logger.log(
            `拉群成功: ${targetGroup.groupName} (user=${context.userId}, city=${city}, industry=${industry ?? '-'})`,
          );

          // memberCount >= 100 时企微自动发邀请链接而非直接拉入
          const isInviteLink = (targetGroup.memberCount ?? 0) >= 100;

          return {
            success: true,
            groupName: targetGroup.groupName,
            city,
            industry: industry ?? undefined,
            inviteMode: isInviteLink ? 'link' : 'direct',
          };
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          logger.error(`拉群失败: ${message} (user=${context.userId})`);
          return { success: false, error: `拉人失败: ${message}` };
        }
      },
    });
  };
}

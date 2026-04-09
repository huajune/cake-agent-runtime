import { Logger } from '@nestjs/common';
import { tool } from 'ai';
import { z } from 'zod';
import { ToolBuilder } from '@shared-types/tool.types';
import { GroupResolverService } from '@biz/group-task/services/group-resolver.service';
import { GroupMembershipService } from '@biz/group-task/services/group-membership.service';
import { GroupContext } from '@biz/group-task/group-task.types';
import { RoomService } from '@channels/wecom/room/room.service';
import { MemoryService } from '@memory/memory.service';
import { FeishuWebhookService } from '@infra/feishu/services/webhook.service';
import { FeishuCardBuilderService } from '@infra/feishu/services/card-builder.service';
import { FEISHU_RECEIVER_USERS } from '@infra/feishu/constants/receivers';

const logger = new Logger('invite_to_group');
const INVITE_CONFIRM_ATTEMPTS = 3;
const INVITE_CONFIRM_RETRY_DELAY_MS = 1200;

export function buildInviteToGroupTool(
  groupResolver: GroupResolverService,
  groupMembership: GroupMembershipService,
  roomService: RoomService,
  webhookService: FeishuWebhookService,
  cardBuilder: FeishuCardBuilderService,
  memoryService: MemoryService,
  memberLimit: number,
  enterpriseToken?: string | null,
): ToolBuilder {
  return (context) =>
    tool({
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
              webhookService,
              cardBuilder,
            }).catch((error: unknown) => {
              const message = error instanceof Error ? error.message : String(error);
              logger.error(`飞书告警发送失败: ${message}`);
            });
            return { success: false, reason: 'group_full' };
          }

          await groupMembership.refreshRoomCacheByToken(targetGroup.imRoomId, targetGroup.token);
          const alreadyMember = await groupMembership.isUserInRoom(
            targetGroup.imRoomId,
            context.userId,
            [targetGroup.imRoomId],
          );
          if (alreadyMember) {
            logger.log(`用户已在群中，静默跳过: ${targetGroup.groupName} (user=${context.userId})`);
            return {
              success: false,
              reason: 'already_in_group',
              groupName: targetGroup.groupName,
            };
          }

          const addResult = await roomService.addMemberEnterprise({
            token: normalizedEnterpriseToken,
            imBotId: context.botImId,
            botUserId: context.botUserId,
            contactWxid: context.userId,
            roomWxid: targetGroup.imRoomId,
          });
          const addError = extractInviteApiError(addResult);
          if (addError) {
            logger.warn(
              `企业级拉群接口拒绝: ${targetGroup.groupName} (user=${context.userId}, error=${addError})`,
            );
            return {
              success: false,
              reason: 'invite_api_rejected',
              error: addError,
              groupName: targetGroup.groupName,
              city,
              industry: industry ?? undefined,
            };
          }

          const isInviteLink = (targetGroup.memberCount ?? 0) >= 100;
          const joinConfirmed = await confirmInviteJoined({
            groupMembership,
            roomId: targetGroup.imRoomId,
            userId: context.userId,
            roomToken: targetGroup.token,
          });
          if (!joinConfirmed) {
            logger.warn(
              `拉群请求已提交但未确认入群: ${targetGroup.groupName} (user=${context.userId}, mode=${
                isInviteLink ? 'link' : 'direct'
              })`,
            );
            return {
              success: false,
              reason: 'invite_not_confirmed',
              groupName: targetGroup.groupName,
              city,
              industry: industry ?? undefined,
              inviteMode: isInviteLink ? 'link' : 'direct',
            };
          }

          await groupMembership.markUserInRoom(targetGroup.imRoomId, context.userId);
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
            inviteMode: isInviteLink ? 'link' : 'direct',
          };
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          logger.error(`拉群失败: ${message} (user=${context.userId})`);
          return { success: false, error: `拉人失败: ${message}` };
        }
      },
    });
}

async function confirmInviteJoined(params: {
  groupMembership: GroupMembershipService;
  roomId: string;
  userId: string;
  roomToken?: string;
}): Promise<boolean> {
  const { groupMembership, roomId, userId, roomToken } = params;

  for (let attempt = 1; attempt <= INVITE_CONFIRM_ATTEMPTS; attempt += 1) {
    await groupMembership.refreshRoomCacheByToken(roomId, roomToken);
    const joined = await groupMembership.isUserInRoom(roomId, userId, [roomId]);
    if (joined) return true;

    if (attempt < INVITE_CONFIRM_ATTEMPTS) {
      await sleep(INVITE_CONFIRM_RETRY_DELAY_MS);
    }
  }

  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractInviteApiError(result: unknown): string | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const record = result as Record<string, unknown>;

  const errcode = typeof record.errcode === 'number' ? record.errcode : null;
  if (errcode != null && errcode !== 0) {
    const message =
      typeof record.errmsg === 'string' && record.errmsg.trim()
        ? record.errmsg.trim()
        : 'unknown error';
    return `errcode=${errcode}, errmsg=${message}`;
  }

  const code = typeof record.code === 'number' ? record.code : null;
  if (code != null && code !== 0) {
    const message =
      typeof record.message === 'string' && record.message.trim()
        ? record.message.trim()
        : 'unknown error';
    return `code=${code}, message=${message}`;
  }

  if (record.success === false) {
    const message =
      typeof record.message === 'string' && record.message.trim()
        ? record.message.trim()
        : 'unknown error';
    return `success=false, message=${message}`;
  }

  return null;
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
  webhookService: FeishuWebhookService;
  cardBuilder: FeishuCardBuilderService;
}): Promise<boolean> {
  const { city, industry, memberLimit, groups, webhookService, cardBuilder } = params;
  const scope = `${city}${industry ? ` / ${industry}` : ''}`;
  const conclusion = `${city}${industry ? `/${industry}` : ''} 所有兼职群已满，需要创建新群`;
  const numberedGroups = groups.map((group, index) => {
    const count = group.memberCount ?? '未知';
    return `${index + 1}. ${group.name} (${count} / ${memberLimit})`;
  });

  const content = [
    `**时间**: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
    '**级别**: WARNING',
    `**范围**: ${scope}`,
    `**结论**: ${conclusion}`,
    `**容量阈值**: ${memberLimit} 人`,
    `**已满群数**: ${groups.length}`,
    '',
    '**已满群列表**',
    ...numberedGroups,
  ].join('\n');

  const card = cardBuilder.buildMarkdownCard({
    title: conclusion,
    content,
    color: 'yellow',
    atUsers: [FEISHU_RECEIVER_USERS.GAO_YAQI],
  });

  return webhookService.sendMessage('ALERT', card);
}

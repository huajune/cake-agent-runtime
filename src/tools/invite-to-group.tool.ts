import { Logger } from '@nestjs/common';
import { tool } from 'ai';
import { z } from 'zod';
import { ToolBuilder } from '@shared-types/tool.types';
import { buildToolError, TOOL_ERROR_TYPES } from '@tools/types/tool-error-types';
import { GroupResolverService } from '@biz/group-task/services/group-resolver.service';
import { GroupContext } from '@biz/group-task/group-task.types';
import { normalizeCity } from '@biz/group-task/utils/city-normalize.util';
import { RoomService } from '@channels/wecom/room/room.service';
import { MemoryService } from '@memory/memory.service';
import { OpsNotifierService } from '@notification/services/ops-notifier.service';
import { refreshMemberCountsFromEnterpriseList } from '@tools/utils/enterprise-room-count.util';

const logger = new Logger('invite_to_group');

const UNDELIVERED_INVITE_HANDOFF_INSTRUCTION =
  '如果候选人本轮是在同意入群/后续通知，或当前意向已无匹配而需要群维护，请立即调用 request_handoff(reasonCode="other") 转人工跟进；调用后不得再输出文本。';

const DESCRIPTION = `邀请候选人加入企微兼职群。

## 触发场景（满足任一即可）
1. **首次面试预约成功后** — duliday_interview_booking 返回 success: true（必须检查 _outcome 字段确认预约成功），且已知候选人城市时，在同轮调用。仅限本会话首次预约成功时触发，后续再预约不再重复拉群
2. **判断当前意向下已无匹配可能** — 候选人明确的意向（品牌、岗位类型、城市、区域、班次、薪资等）已超出当前可推范围，或继续检索已无新进展。必须先做过实际检索（至少一次 duliday_job_list）、已告知候选人当前没有合适岗位，再调用本工具。不设固定轮数门槛，由你根据对话把握时机；严禁为了凑推荐继续硬推不符合候选人意向的替代岗位
3. **候选人同意入群/后续通知** — 如果上一轮你曾提出"拉群/进群/有岗位通知"，候选人本轮回复"好/可以/嗯/谢谢"等同意词，必须调用本工具确认是否真的能拉群；只有 success: true 才能说已拉群或已发邀请

## 调用前置条件（必须满足）
- **本轮必须已经给出查岗结论**：要么本轮已推荐了具体岗位（让候选人明确知道有什么岗），要么本轮已明确告知候选人"暂时没有合适岗位"。**未先告知候选人查岗结果就直接发群邀请属于"突兀拉群"**，候选人会困惑你是因为有岗还是没岗才拉他进群
- **本城市必须有可用群**：参考 [兼职群资源] 段。该段显示"该城市暂无可用兼职群"时，禁止调用本工具

## 禁止触发
- duliday_interview_booking 本轮已调用且返回 success: false / 抛异常时（首次预约成功场景）
- 城市未知时
- 候选人明确拒绝或表示不需要时
- 本会话已经成功拉过群时（查看 [会话记忆] 中的 invitedGroups）
- 尚未做过任何岗位检索、还完全没判断过是否有匹配时
- [兼职群资源] 段已注明该城市无可用群时

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
- 若候选人本轮是在同意入群/后续通知，或当前意向已无匹配而需要群维护，但工具返回 success: false，必须立刻调用 request_handoff(reasonCode="other") 转人工跟进；不要自然语言收尾把候选人晾住
- 只有 success: true 时才能说"已拉群/已发入群邀请"；无群、群满、接口拒绝、未调用工具时，都不要承诺群相关动作
- 严禁在未调用本工具、或本工具返回 success: false 时说"我先拉你进群/后面群里通知/已发群邀请"

## 空头承诺禁忌
- 本轮回复中只要出现"拉你进群 / 把你加进群 / 进我们群 / 发个群邀请 / 后面群里通知"等表述，**必须**本轮实调本工具且返回 success: true
- 已说要拉群但没调本工具 = 空头承诺；候选人下轮看到没动静会立刻流失
- 拉群成功后，本轮必须停止继续推荐其他岗位；后续轮也不要再向候选人推岗位，转为群内运营`;

const inputSchema = z.object({
  city: z.string().describe('候选人所在城市'),
  industry: z
    .string()
    .optional()
    .describe('候选人求职意向行业（餐饮/零售等）；意向明确时必须传，详见兼职群资源段指引'),
});

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
      description: DESCRIPTION,
      inputSchema,
      execute: async ({ city, industry }) => {
        try {
          if (context.bookingSucceeded === false) {
            logger.log(`本轮预约失败，跳过拉群: city=${city}, user=${context.userId}`);
            return buildToolError({
              errorType: TOOL_ERROR_TYPES.INVITE_BOOKING_NOT_SUCCESS,
              outcome: '本轮面试预约未成功，跳过拉群',
              replyInstruction:
                '本轮预约未成功，不要向候选人提及群相关内容；按 booking 工具的失败处理继续，不要说"已发邀请"或"等通知"。',
            });
          }

          const normalizedEnterpriseToken = enterpriseToken?.trim();
          if (!normalizedEnterpriseToken) {
            logger.error(`STRIDE_ENTERPRISE_TOKEN 未配置，无法拉人进群 (user=${context.userId})`);
            return buildToolError({
              errorType: TOOL_ERROR_TYPES.INVITE_ENTERPRISE_TOKEN_MISSING,
              outcome: '企业 Token 未配置',
              replyInstruction: `拉群配置缺失，本次不向候选人提及群相关内容；这是部署侧配置问题，不应反复重试。${UNDELIVERED_INVITE_HANDOFF_INSTRUCTION}`,
              details: { detailedReason: 'STRIDE_ENTERPRISE_TOKEN 未配置，无法执行企业级拉群' },
            });
          }
          if (!context.botImId || !context.botUserId) {
            logger.warn(`缺少 bot 身份信息，无法拉群 (user=${context.userId})`);
            return buildToolError({
              errorType: TOOL_ERROR_TYPES.INVITE_MISSING_BOT_IDENTITY,
              outcome: '缺少 bot 身份信息',
              replyInstruction: `拉群所需的 bot 身份不完整，本次不向候选人提及群相关内容；这是上下文缺失问题，不要反复重试。${UNDELIVERED_INVITE_HANDOFF_INSTRUCTION}`,
              details: { detailedReason: '缺少 botImId / botUserId，无法执行企业级拉群' },
            });
          }

          const allGroups = await groupResolver.resolveGroups('兼职群', { forceRefresh: true });
          if (allGroups.length === 0) {
            logger.warn(`无兼职群数据 (user=${context.userId})`);
            return buildToolError({
              errorType: TOOL_ERROR_TYPES.INVITE_NO_GROUP_AVAILABLE,
              outcome: '暂无可用群',
              replyInstruction: `当前平台无可用兼职群数据，本次不向候选人提及群相关内容。${UNDELIVERED_INVITE_HANDOFF_INSTRUCTION}`,
            });
          }

          // 用 normalizeCity 兜底字符串不一致——Agent 传入可能是 "北京市"，
          // 而群 labels 里通常是 "北京"。严格相等会让整轮回 no_group_in_city。
          const normalizedTargetCity = normalizeCity(city);
          const cityGroups = allGroups.filter(
            (group) => normalizeCity(group.city) === normalizedTargetCity,
          );
          if (cityGroups.length === 0) {
            logger.log(`城市无匹配，静默跳过: ${city} (user=${context.userId})`);
            return buildToolError({
              errorType: TOOL_ERROR_TYPES.INVITE_NO_GROUP_IN_CITY,
              outcome: '该城市无匹配群',
              replyInstruction: `该候选人所在城市暂无兼职群，本次不向候选人提及群相关内容。${UNDELIVERED_INVITE_HANDOFF_INSTRUCTION}`,
              details: { city },
            });
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
            return buildToolError({
              errorType: TOOL_ERROR_TYPES.INVITE_GROUP_FULL,
              outcome: '候选群均已满',
              replyInstruction: `该候选人区域/行业下的兼职群均已满，本次不向候选人提及群相关内容；运维侧告警已自动触发。${UNDELIVERED_INVITE_HANDOFF_INSTRUCTION}`,
              details: { citySnapshot },
            });
          }

          const selectionReason: 'lowest_member_count' | 'only_option' =
            candidates.length === 1 ? 'only_option' : 'lowest_member_count';

          const fullGroupsDuringInvite: GroupContext[] = [];
          const rejectedGroupsDuringInvite: Array<{
            group: GroupContext;
            error?: string;
          }> = [];
          for (const targetGroup of availableCandidates) {
            const inviteApiResult = await invokeAddMember({
              roomService,
              token: normalizedEnterpriseToken,
              imBotId: context.botImId,
              botUserId: context.botUserId,
              contactWxid: context.userId,
              roomWxid: targetGroup.imRoomId,
            });

            if (!inviteApiResult.accepted) {
              if (inviteApiResult.code === -9) {
                // 外部接口返回 user 已在群：业务目标已经达成（候选人在群内），
                // 按 success 返回。不走 buildToolError，避免 prompt 里"invite 失败分支
                // 统一调 request_handoff 兜底"规则误把这种正常路径当失败处理（badcase
                // i41pab8n / gay6j94c 引入兜底时未区分"群拉不上"和"已在群"）。
                // 同时写入 invitedGroups 记忆，避免同会话后续再触发本工具重调慢接口
                // （实测每次 20-30s）。
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
                  success: true,
                  alreadyInGroup: true,
                  groupName: targetGroup.groupName,
                  city,
                  industry: industry ?? undefined,
                  _outcome: '候选人已在该群中',
                  _replyInstruction:
                    '候选人已在目标群里，本次不向候选人提及群相关内容；记忆已写入，同会话后续不再重复触发本工具。',
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

              // 其他失败（含 400400 room not found，多见于接客 bot 不是群成员的结构性失败）：
              // 记录后继续尝试下一个候选群，跑完全部候选再决定是回 invite_api_rejected
              // 还是 group_full 综合状态。
              logger.warn(
                `企业级拉群接口拒绝，尝试下一个候选群: ${targetGroup.groupName} (user=${context.userId}, error=${inviteApiResult.error})`,
              );
              rejectedGroupsDuringInvite.push({
                group: targetGroup,
                error: inviteApiResult.error,
              });
              continue;
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

          // 候选群里出现接口拒绝（含切群主 bot 重试也失败）时，独立告警；
          // 不要被合并进"群已满"通道，运维需要区分"扩群"与"修 bot 群关系"两种动作。
          if (rejectedGroupsDuringInvite.length > 0) {
            logger.warn(
              `所有候选群均被拒绝: ${city}/${industry ?? '全行业'} (user=${context.userId}, rejected=${rejectedGroupsDuringInvite.length}, full=${fullGroupsDuringInvite.length})`,
            );
            void sendInviteRejectedAlert({
              city,
              industry,
              chatBotImId: context.botImId,
              chatBotUserId: context.botUserId,
              rejectedGroups: rejectedGroupsDuringInvite.map((entry) => ({
                name: entry.group.groupName,
                imRoomId: entry.group.imRoomId,
                ownerBotImId: entry.group.imBotId,
                ownerBotUserId: entry.group.botUserId,
                error: entry.error,
              })),
              opsNotifier,
            }).catch((error: unknown) => {
              const message = error instanceof Error ? error.message : String(error);
              logger.error(`飞书告警发送失败: ${message}`);
            });

            return buildToolError({
              errorType: TOOL_ERROR_TYPES.INVITE_API_REJECTED,
              outcome: '候选群均被接口拒绝',
              replyInstruction: `所有候选群被企业接口拒绝（通常是 bot 不在群中等结构性问题），本次不向候选人提及群相关内容；运维告警已自动触发。${UNDELIVERED_INVITE_HANDOFF_INSTRUCTION}`,
              details: {
                groupName: rejectedGroupsDuringInvite[0].group.groupName,
                city,
                industry: industry ?? undefined,
                citySnapshot,
                reason: rejectedGroupsDuringInvite[0].error,
                totalRejected: rejectedGroupsDuringInvite.length,
              },
            });
          }

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

          return buildToolError({
            errorType: TOOL_ERROR_TYPES.INVITE_GROUP_FULL,
            outcome: '候选群均已满',
            replyInstruction: `该候选人区域/行业下的兼职群均已满，本次不向候选人提及群相关内容；运维告警已自动触发。${UNDELIVERED_INVITE_HANDOFF_INSTRUCTION}`,
            details: {
              groupName: alertGroups.length === 1 ? alertGroups[0]?.groupName : undefined,
              citySnapshot: buildCitySnapshot(alertGroups, memberLimit),
            },
          });
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          logger.error(`拉群失败: ${message} (user=${context.userId})`);
          return buildToolError({
            errorType: TOOL_ERROR_TYPES.INVITE_API_FAILED,
            outcome: '拉群接口异常',
            replyInstruction: `拉群接口暂时不可用，本次不向候选人提及群相关内容；不要把异常信息原文转述给候选人。${UNDELIVERED_INVITE_HANDOFF_INSTRUCTION}`,
            details: { reason: message },
          });
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

async function invokeAddMember(params: {
  roomService: RoomService;
  token: string;
  imBotId: string;
  botUserId: string;
  contactWxid: string;
  roomWxid: string;
}): Promise<ReturnType<typeof parseInviteApiResult>> {
  const result = await params.roomService.addMemberEnterprise({
    token: params.token,
    imBotId: params.imBotId,
    botUserId: params.botUserId,
    contactWxid: params.contactWxid,
    roomWxid: params.roomWxid,
  });
  return parseInviteApiResult(result);
}

async function sendInviteRejectedAlert(params: {
  city: string;
  industry?: string;
  chatBotImId?: string;
  chatBotUserId?: string;
  rejectedGroups: Array<{
    name: string;
    imRoomId: string;
    ownerBotImId?: string;
    ownerBotUserId?: string;
    error?: string;
  }>;
  opsNotifier: OpsNotifierService;
}): Promise<boolean> {
  return params.opsNotifier.sendInviteRejectedAlert(params);
}

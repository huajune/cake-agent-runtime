import { toErrorMessage } from '@infra/utils/error.util';
import type { Logger } from '@nestjs/common';
import type {
  GroupInviteInput,
  GroupInviteResult,
  GroupInviteService,
} from '@biz/group-task/services/group-invite.service';
import type { SessionStateService } from '@memory/short-term/session-state.service';
import { extractUserTexts } from '@resolution/signal/dialogue';
import type { ToolBuildContext } from '@shared-types/tool.types';
import { canUseFactForAction } from '@tools/shared/action-confidence';
import { evaluateInviteCityGate, type InviteCityGateVerdict } from './invite-city-gate';
import { evaluateInviteTimingGate, type InviteTimingGateVerdict } from './invite-timing-gate';

/**
 * 拉群确定性流水线：`invite_to_group` 工具与报名成功后的运行时拉群共用同一段闸门与执行。
 *
 * 顺序固定：重复邀请 gate → 前置已在群闸门 → 城市 provenance gate → testing 模拟 → 真实邀请。
 * 只做结构化裁决与副作用执行，不生成模型话术；话术由各调用方按自己的返回契约拼装。
 */
export type GroupInvitePipelineOutcome =
  | { kind: 'already_invited'; verdict: Extract<InviteTimingGateVerdict, { decision: 'reject' }> }
  | { kind: 'already_in_group'; result: GroupInviteResult }
  | { kind: 'city_rejected'; verdict: Extract<InviteCityGateVerdict, { decision: 'reject' }> }
  | { kind: 'simulated'; groupName: string }
  | { kind: 'invited'; result: GroupInviteResult };

export interface GroupInvitePipelineParams {
  context: ToolBuildContext;
  city: string;
  industry?: string;
  groupInviteService: GroupInviteService;
  sessionService?: SessionStateService;
  logger: Logger;
}

export function buildGroupInviteInput(
  context: ToolBuildContext,
  city: string,
  industry?: string,
): GroupInviteInput {
  return {
    corpId: context.session.corpId,
    userId: context.session.userId,
    sessionId: context.session.sessionId,
    botImId: context.session.botImId ?? '',
    botUserId: context.session.botUserId ?? '',
    contactWxid: context.session.userId,
    city,
    industry,
    turnKey: context.session.turnId ?? Date.now().toString(),
    messageId: context.session.turnId,
    contactName: context.session.contactName,
    chatId: context.session.chatId ?? context.session.sessionId,
  };
}

/**
 * 读取会话记忆里可用于拉群动作的高置信城市事实；读取失败或置信不足返回 null。
 */
export async function readSessionCityForInvite(
  context: ToolBuildContext,
  sessionService: SessionStateService | undefined,
  logger: Logger,
): Promise<string | null> {
  if (!sessionService) return null;
  try {
    const facts = await sessionService.getFacts(
      context.session.corpId,
      context.session.userId,
      context.session.sessionId,
    );
    const cityFact = facts?.preferences?.city ?? null;
    if (!cityFact || typeof cityFact.value !== 'string' || !cityFact.value.trim()) return null;
    return canUseFactForAction('invite_city', cityFact.confidence) ? cityFact.value.trim() : null;
  } catch (error: unknown) {
    logger.warn(`读取会话城市事实失败（gate 按无事实降级）: ${toErrorMessage(error)}`);
    return null;
  }
}

export async function runGroupInvitePipeline(
  params: GroupInvitePipelineParams,
): Promise<GroupInvitePipelineOutcome> {
  const { context, city, industry, groupInviteService, sessionService, logger } = params;
  const inviteInput = buildGroupInviteInput(context, city, industry);

  // 重复邀请状态在会话归档中已有快照；如果可用，先用轻量会话状态刷新一次，
  // 但读取失败时继续用快照，不让 Redis 抖动挡住合法拉群。只有整个时机 gate
  // 通过后才值得触达企微实时成员接口。
  let invitedGroups: { groupName?: string | null; city?: string | null }[] =
    context.archive.invitedGroups ?? [];
  if (sessionService) {
    try {
      const state = await sessionService.getSessionState(
        context.session.corpId,
        context.session.userId,
        context.session.sessionId,
      );
      invitedGroups = state?.invitedGroups ?? invitedGroups;
    } catch (error: unknown) {
      logger.warn(`读取 invitedGroups 失败（时机 gate 使用归档快照）: ${toErrorMessage(error)}`);
    }
  }
  const timingVerdict = evaluateInviteTimingGate({ requestedCity: city, invitedGroups });
  if (timingVerdict.decision === 'reject') {
    return { kind: 'already_invited', verdict: timingVerdict };
  }

  // 前置已在群闸门：候选人已在目标城市兼职群时，业务目标已达成，直接短路成功——不再要求
  // 城市出处。实时群成员关系本身就是该城市的最强依据；群列表走缓存，任何失败静默降级。
  if (context.runtime.strategySource !== 'testing') {
    const existingMembership = await groupInviteService.preflightExistingMembership(inviteInput);
    if (existingMembership) {
      return { kind: 'already_in_group', result: existingMembership };
    }
  }

  // 城市 provenance gate（防拉错城市群）：city 必须能追溯到会话城市事实、候选人原文城市名、
  // geo 地名白名单推断、本轮 geocode 确权或本轮地图截图，模型自报不构成依据。
  const sessionCity = await readSessionCityForInvite(context, sessionService, logger);
  const cityGateVerdict = evaluateInviteCityGate({
    requestedCity: city,
    sessionCity,
    userTexts: extractUserTexts(context.turnInput.messages),
    geoSignalCities: context.ledger.geo.signalCities,
    // 同轮 geocode unique / 定位分享确权城市：补"轮末写档、下轮生效"的时序空档。
    // cityAttestation 与 anchors 同源（amap 解析 / 定位消息），定位分享 seed 可能只有
    // attestation 没有坐标锚点，两者都作第四档出处。
    turnResolvedCities: [
      ...(context.ledger.geo.anchors ?? []).map((anchor) => anchor.city),
      context.ledger.geo.cityAttestation?.city ?? null,
    ],
    turnVisualSheets: context.ledger.visual.factSheets,
  });
  if (cityGateVerdict.decision === 'reject') {
    return { kind: 'city_rejected', verdict: cityGateVerdict };
  }

  // testing 链路（test-suite 重放/调试）：确定性校验已真实跑完，这里返回模拟成功、不触达
  // 企业接口——否则测试环境缺 bot 身份必失败，拉群链路永远测不到。
  if (context.runtime.strategySource === 'testing') {
    logger.log(`testing 链路模拟拉群成功: city=${city} (user=${context.session.userId})`);
    return { kind: 'simulated', groupName: `${city}兼职群（测试模拟）` };
  }

  const result = await groupInviteService.invite(inviteInput);
  return { kind: 'invited', result };
}

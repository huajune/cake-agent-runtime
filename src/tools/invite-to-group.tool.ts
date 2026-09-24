import { toErrorMessage } from '@infra/utils/error.util';
import { Logger } from '@nestjs/common';
import { tool } from 'ai';
import { z } from 'zod';
import type { ToolBuildContext, ToolBuilder } from '@shared-types/tool.types';
import { buildToolError, TOOL_ERROR_TYPES } from '@tools/shared/tool-error-types';
import {
  GroupInviteService,
  type GroupInviteResult,
} from '@biz/group-task/services/group-invite.service';
import { SessionStateService } from '@memory/short-term/session-state.service';
import type { InviteCityGateVerdict } from '@tools/invite/invite-city-gate';
import type { InviteTimingGateVerdict } from '@tools/invite/invite-timing-gate';
import { runGroupInvitePipeline } from '@tools/invite/group-invite-pipeline';
import {
  buildPostBookingGroupInviteGuide,
  type PostBookingGroupInviteOutcome,
} from '@tools/invite/post-booking-group-invite';
import { resolveCityFromDistrict } from '@resolution/geo';

const logger = new Logger('invite_to_group');

const UNDELIVERED_INVITE_HANDOFF_INSTRUCTION =
  '如果候选人本轮是在同意入群/后续通知，或当前意向已无匹配而需要群维护，请立即调用 request_handoff(reasonCode="group_invite_failed") 转人工跟进；调用后不得再输出文本。';

// 无群（区别于群满）：业务要求"推荐无岗且没有兼职群（群满场景除外）不再转人工"。
// 该城市/平台本就没有可对接的兼职群时，不触发人工介入，Agent 自然收口并继续托管。
const NO_GROUP_CONTINUE_INSTRUCTION =
  '该城市/平台本就没有可对接的兼职群（注意：这不是群满，而是没有群）。这种情况不要调用 request_handoff 转人工，也不要向候选人提及群相关内容。请自然收口：礼貌告知候选人当前暂时没有合适岗位、后续有匹配会主动联系，然后正常结束本轮、保持托管。';

// 多步回合送达提醒：模型在工具调用之间"计划说"的无岗承接句不会真正发出，候选人只收到
// 拉群确认句（"不说原因直接拉群"）。工具成功结果里显式提醒：中间步骤文字不送达，最终
// 回复必须补上。
const UNDELIVERED_PRELUDE_REMINDER =
  '注意：本轮此前步骤里你写过/计划过的话（包括"附近暂无岗位"的无岗承接句）**并没有发给候选人**，候选人只会看到你本次的最终回复。若本次拉群源于查岗无结果（noMatchScript 场景）且对话历史里尚未出现无岗说明，最终回复必须先按 noMatchScript.candidateMessage 的口径说明无岗原因，再接入群确认句；不得只发一句入群确认。';

// 候选人非接客 bot 的外部联系人（已拉黑/删好友），全部候选群都报 -8 "is not a friend"。
// 这是候选人侧真实状态、人工无可作为，故不发运维告警、也不转人工，自然收口即可。
const NOT_FRIEND_CONTINUE_INSTRUCTION =
  '候选人当前无法被拉进群（候选人侧关系问题，多为已删除/拉黑接客账号）。这种情况不要调用 request_handoff 转人工，也不要向候选人提及群相关内容、不要承诺拉群。请自然收口：礼貌告知候选人当前暂时没有合适岗位、后续有匹配会主动联系，然后正常结束本轮、保持托管。';

// 程序记忆层（procedural memory）工具绑定规则；总目录：docs/prompt-rule-ledger.md
const DESCRIPTION = `邀请候选人加入企微兼职岗位信息群。

## 群用途边界（硬规则）
- 本工具只能发送**兼职岗位信息群**，返回的 groupPurpose 固定为 "job_pool"。
- 本工具不能发送面试群。即使本轮预约成功、岗位备注提到“面试群/腾讯会议链接”，也不得把本工具选中的兼职群说成面试群。
- 预约成功且 booking 返回 interviewGroupHandling.required=true 时，最终回复必须明确区分：
  1. booking 回执 groupInvite（或本工具）返回的实际 groupName 是兼职岗位信息群，邀请已发送/已加入；
  2. 本次面试使用单独的面试群，按 booking 的 _manualInterviewGroupGuide 告知“我这边接着发你邀请”。
- 腾讯会议链接、面试通知、姓名+手机号备注要求只能关联“面试群”，不得接在兼职群说明后让候选人误以为两者是同一个群。

## 报名成功后的拉群不归本工具
报名成功后的拉群由系统随 duliday_interview_booking 自动完成：结果在 booking 回执的 groupInvite / _groupInviteGuide 里，你只按结果说话，**不需要也不应再调用本工具**。同轮再调本工具只会得到系统已处理的结果，不会重复邀请。

## 触发场景（满足任一即可）
1. **连续两轮推荐均不满意后的群承接** — 你必须根据完整对话确认候选人已明确否定两轮具体岗位推荐；工具不会用关键词替你计数。上一轮已停止第三轮推荐并征询入群，候选人本轮明确回复同意后调用本工具。真实搜索 0 条/暑假工无库存不属于本场景，不得因此直接拉群。**拉群不能替代取消工单**：若候选人在**面试开始之前**放弃的岗位在 [当前预约信息] 里有进行中的工单，必须同时走 duliday_cancel_work_order 取消该工单再拉群收尾。面试时间已到/已过之后才说没去属爽约，不要取消工单
2. **候选人同意入群/后续通知** — 如果上一轮你曾提出"拉群/进群/有岗位通知"，候选人本轮回复"好/可以/嗯/谢谢"等同意词，必须调用本工具确认是否真的能拉群；只有 success: true 才能说已拉群或已发邀请

## 调用前置条件（必须满足）
- **本轮必须已经给出查岗结论**：要么本轮已推荐了具体岗位（让候选人明确知道有什么岗），要么本轮已明确告知候选人"暂时没有合适岗位"。**未先告知候选人查岗结果就直接发群邀请属于"突兀拉群"**，候选人会困惑你是因为有岗还是没岗才拉他进群
- **本城市必须有可用群**：参考 [兼职群资源] 段。该段显示"该城市暂无可用兼职群"时，禁止调用本工具
  - 本城市群库为空：禁止承诺"我先把你拉进群/进我们群/发群邀请/后面群里通知"等拉群相关动作；
  - 本城市本就没有兼职群（区别于群满），属于"推荐无岗且没有兼职群"场景，不要转人工，继续托管即可：礼貌告知暂时没有合适岗位、后续有匹配会主动联系，引导候选人留意后续主动联系，不要调用 request_handoff。

## 禁止触发
- 本轮已调用 duliday_interview_booking（无论成败）：报名后的拉群随报名结果由系统处理，不要再调本工具
- 城市未知时
- 候选人明确拒绝或表示不需要时
- 本会话已经成功拉过群时（查看 [会话记忆] 中的 invitedGroups）
- 尚未做过任何岗位检索、还完全没判断过是否有匹配时
- [兼职群资源] 段已注明该城市无可用群时
- **候选人正在推进某个已匹配岗位的收资/约面/确认面试时** — 候选人已接受某岗位、正在回填资料、追问"明天能面试吗/几点面试/怎么报名"等推进信号时，说明当前有匹配在走报名流程，**禁止**此时拉群打断。本工具只承接"无岗维护"（场景 1/2）；"有岗推进"的拉群时点是报名成功那一刻，由系统自动完成，不需要你操作。应继续把这单约面收尾；只有确认该岗位无法继续（如失败/不符）且满足场景 1/2 时才考虑拉群

## 参数
- city（必填）：候选人所在**城市级**名称，从 [会话记忆] / [本轮查询硬约束] 的"城市"字段获取。
  - 严禁把区域/区县/镇/街道/商圈/门店地址传给 city；上下文同时有城市与区域时，取城市字段，不取区域字段
- industry（强烈建议传）：候选人的求职意向行业
  - 调用 invite_to_group 时，若候选人求职意向明确（如餐饮/零售），必须传对应 industry 参数。
  - 候选人意向餐饮品牌或餐饮岗位 → 必须传 industry="餐饮"
  - 候选人意向零售品牌或零售岗位 → 必须传 industry="零售"
  - 否则工具会按"人数最少"兜底，可能选到不匹配行业的群引起候选人疑问。
  - 仅当候选人跨行业或完全没表达过行业偏好时才可以不传

## 返回字段
- inviteDelivery：拉群投递方式
  - "direct_add"（群<40人，已直接拉入）→ 告知候选人"已帮你加入了XX群"
  - "invite_card"（群>=40人，企微已自动发送入群邀请卡片）→ 告知候选人"入群邀请已经发你了，点一下卡片就能进群"
- groupPurpose：固定为 "job_pool"，表示兼职岗位信息群，不是面试群
- _replyInstruction：成功后必须严格遵守的话术指令；尤其 inviteDelivery="invite_card" 时，禁止输出、编造或粘贴任何群链接 / URL
- matchedIndustry：实际命中群的行业；与入参 industry 不一致说明触发了回退
- fallbackUsed：是否触发行业回退（入参 industry 在该城市无匹配群时为 true）
- selectionReason：选群原因（lowest_member_count / only_option）
- citySnapshot：该城市兼职群分布概览，可在候选人质疑群选择时作为解释依据

## 失败处理
- success: false 时静默跳过，不向候选人提及群相关内容
- 若 errorType=invite.invalid_city_scope，说明你把区域/区县误传给了 city。必须立即用工具返回的 expectedCity 重新调用 invite_to_group；不要调用 request_handoff，也不要说"该区域暂无兼职群"
- 若 errorType=invite.city_conflict，说明你传的城市与会话记忆中的城市不一致。候选人没明确说换城市时，改用返回的 expectedCity 重新调用；否则先向候选人确认城市，不要转人工
- 若 errorType=invite.city_unverified，说明该城市没有出处依据（会话记忆和候选人原文都没有）。先向候选人确认所在城市再调用；本轮不要提群相关内容，不要转人工
- 若 errorType=invite.already_invited，说明本会话已给该城市拉过群。按返回的群名据实回应（"邀请已经发过了"），不要再次发起邀请，不要转人工
- 若候选人本轮是在同意入群/后续通知，或当前意向已无匹配而需要群维护，但工具返回 success: false，多数情况要立刻调用 request_handoff(reasonCode="group_invite_failed") 转人工跟进（群满用 no_match_or_group_full，不要归 other）；不要自然语言收尾把候选人晾住
  - **例外（不转人工）**：失败原因是"该城市/平台本就没有兼职群"（invite.no_group_in_city / invite.no_group_available），或"候选人非外部联系人/已拉黑删好友"（invite.candidate_not_friend）时，**不要**转人工——按工具返回的 replyInstruction 自然收口并继续托管即可；只有"群满"（invite.group_full）或接口/结构性失败才转人工
- 只有 success: true 时才能说"已拉群/已发入群邀请"；无群、群满、接口拒绝、未调用工具时，都不要用**完成口径**声称群相关动作已发生

## 拉群口径（两轮动作链，与场景 1/2 一致）
- **征询式**（"要不我邀请你进群？"）只在连续两轮推荐均不满意后使用：先承接候选人意向，**本轮不调本工具**；真实搜索 0 条不得提群
- 候选人对拉群提议回复"好/可以/嗯"等同意词后，**下一轮必须实调本工具**（场景 2）；提了拉群却一直不调 = 空头承诺，候选人看到没动静会立刻流失
- **完成口径**（"已拉你进群 / 群邀请已经发你了 / 发了群邀请"）**必须**本轮实调本工具且返回 success: true，或 booking 回执 groupInvite.success=true，否则严禁使用
- 拉群成功后，本轮必须停止继续推荐其他岗位；后续轮也不要再向候选人推岗位，转为群内运营`;

const inputSchema = z.object({
  city: z.string().describe('候选人所在城市级名称。严禁传区域/区县/镇/街道/商圈。'),
  industry: z
    .string()
    .optional()
    .describe('候选人求职意向行业（餐饮/零售等）；意向明确时必须传，详见兼职群资源段指引'),
});

export function buildInviteToGroupTool(
  groupInviteService: GroupInviteService,
  sessionService?: SessionStateService,
): ToolBuilder {
  return (context) =>
    tool({
      description: DESCRIPTION,
      inputSchema,
      execute: async ({ city, industry }) => {
        try {
          // 报名成功后的拉群已由运行时随 booking 执行（PRD R3）；模型仍调本工具时按运行时
          // 结果回应，不重复发起邀请、不重复触达企业接口。
          const runtimeInvite = context.ledger.jobs.postBookingGroupInvite;
          if (runtimeInvite) {
            return buildRuntimeHandledResult(runtimeInvite, city, industry);
          }

          if (context.ledger.jobs.bookingSucceeded === false) {
            logger.log(`本轮预约失败，跳过拉群: city=${city}, user=${context.session.userId}`);
            return buildToolError({
              errorType: TOOL_ERROR_TYPES.INVITE_BOOKING_NOT_SUCCESS,
              outcome: '本轮面试预约未成功，跳过拉群',
              replyInstruction:
                '本轮预约未成功，不要向候选人提及群相关内容；按 booking 工具的失败处理继续，不要说"已发邀请"或"等通知"。',
            });
          }

          const districtResolvedCity = resolveCityFromDistrict(city.trim());
          if (districtResolvedCity) {
            logger.warn(
              `invite_to_group city 入参误传为区域: city=${city}, expectedCity=${districtResolvedCity} (user=${context.session.userId})`,
            );
            return buildToolError({
              errorType: TOOL_ERROR_TYPES.INVITE_INVALID_CITY_SCOPE,
              outcome: 'city 入参误传为区域/区县',
              replyInstruction:
                'invite_to_group 的 city 必须是城市级名称，不能传区域/区县/镇。请立即使用 expectedCity 字段重新调用 invite_to_group，并保留原 industry；不要调用 request_handoff，也不要说"该区域暂无兼职群"。',
              details: {
                city,
                expectedCity: districtResolvedCity,
                industry: industry ?? undefined,
              },
            });
          }

          // 候选人是否同意入群由主 Agent 根据完整对话判断；工具层不解析自然语言做二次授权
          // 裁决，只跑与报名后运行时拉群共用的确定性流水线：重复邀请 gate → 前置已在群闸门
          // （必须排在城市 gate 之前，否则模型无视"已在群"注入、city 又缺出处时会被引导
          // 反复追问城市）→ 城市 provenance gate → testing 模拟 → 真实邀请。
          const outcome = await runGroupInvitePipeline({
            context,
            city,
            industry,
            groupInviteService,
            sessionService,
            logger,
          });
          switch (outcome.kind) {
            case 'already_invited':
              logger.warn(
                `invite_to_group 前置时机 gate 拒绝: reason=${outcome.verdict.reason}, city=${city} (user=${context.session.userId})`,
              );
              return buildInviteTimingGateError({ verdict: outcome.verdict, city, industry });
            case 'already_in_group':
              return buildAlreadyInGroupResult(outcome.result, city, industry);
            case 'city_rejected':
              return buildCityGateError({ context, verdict: outcome.verdict, city, industry });
            case 'simulated':
              return {
                success: true,
                simulated: true,
                groupName: outcome.groupName,
                groupPurpose: 'job_pool',
                city,
                industry: industry ?? undefined,
                inviteDelivery: 'invite_card',
                _outcome: '【测试链路模拟】已向候选人发送入群邀请卡片（未触达真实企业接口）',
                _replyInstruction:
                  `企微已向候选人发送兼职岗位信息群"${outcome.groupName}"的邀请卡片。` +
                  `回复时必须带实际群名并说明这是兼职岗位信息群、不是面试群；不得把腾讯会议链接或面试通知关联到这个群；` +
                  `禁止输出、编造或粘贴任何群链接 / URL。${UNDELIVERED_PRELUDE_REMINDER}`,
              };
            case 'invited':
              return buildGroupInviteResult({ result: outcome.result, city, industry });
          }
        } catch (error: unknown) {
          const message = toErrorMessage(error);
          logger.error(`拉群失败: ${message} (user=${context.session.userId})`);
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

/** 报名后运行时拉群已执行：成功按成功口径复述，未成功按 handled_by_runtime 收口，不再重试。 */
function buildRuntimeHandledResult(
  runtimeInvite: PostBookingGroupInviteOutcome,
  city: string,
  industry?: string,
) {
  if (runtimeInvite.success) {
    if (runtimeInvite.alreadyInGroup) {
      return buildAlreadyInGroupResult(
        { success: true, alreadyInGroup: true, groupName: runtimeInvite.groupName },
        runtimeInvite.city ?? city,
        industry,
      );
    }
    return buildGroupInviteResult({
      result: {
        success: true,
        groupName: runtimeInvite.groupName,
        inviteDelivery: runtimeInvite.delivery ?? 'invite_card',
      },
      city: runtimeInvite.city ?? city,
      industry,
    });
  }
  return buildToolError({
    errorType: TOOL_ERROR_TYPES.INVITE_HANDLED_BY_RUNTIME,
    outcome: '本轮报名成功后拉群已由系统处理且未成功，不重复发起',
    replyInstruction: buildPostBookingGroupInviteGuide(runtimeInvite),
    details: {
      city: runtimeInvite.city ?? city,
      industry: industry ?? undefined,
      skippedReason: runtimeInvite.skippedReason,
      failureReason: runtimeInvite.failureReason,
    },
  });
}

function buildCityGateError(params: {
  context: ToolBuildContext;
  verdict: Extract<InviteCityGateVerdict, { decision: 'reject' }>;
  city: string;
  industry?: string;
}) {
  const { context, verdict, city, industry } = params;
  // 顺序恢复提示（visual-fact §二A ⑩）：本轮有图片但尚未 save_image_description
  // 时，地图截图的城市线索还没进 ledger——拒绝理由里给模型一条确定性恢复路径。
  const hasUnsavedImages =
    (context.turnInput.imageMessageIds?.length ?? 0) > 0 &&
    (context.ledger.visual.factSheets?.length ?? 0) === 0;
  const unsavedImageHint = hasUnsavedImages
    ? '本轮候选人发了图片但你还没调用 save_image_description；若图片是位置/地图截图，先保存描述再重试本工具，城市核验会采信图中位置。'
    : '';
  if (verdict.reason === 'city_conflict') {
    logger.warn(
      `invite_to_group city 与会话城市事实冲突: city=${city}, expectedCity=${verdict.expectedCity} (user=${context.session.userId})`,
    );
    return buildToolError({
      errorType: TOOL_ERROR_TYPES.INVITE_CITY_CONFLICT,
      outcome: 'city 入参与会话记忆中的城市不一致',
      replyInstruction:
        '你传入的 city 与候选人会话记忆中的城市不一致。若候选人本轮没有明确说换城市，请改用 expectedCity 重新调用 invite_to_group；若你认为候选人换了城市，先向候选人确认所在城市，本轮不要提群相关内容，也不要调用 request_handoff。' +
        unsavedImageHint,
      details: {
        city,
        expectedCity: verdict.expectedCity,
        industry: industry ?? undefined,
      },
    });
  }
  logger.warn(
    `invite_to_group city 缺少出处依据（模型凭空指定）: city=${city} (user=${context.session.userId})`,
  );
  return buildToolError({
    errorType: TOOL_ERROR_TYPES.INVITE_CITY_UNVERIFIED,
    outcome: 'city 入参在会话记忆与候选人原文中均无依据',
    replyInstruction:
      '该城市在会话记忆和候选人原文里都找不到依据，不能据此拉群。请先向候选人确认所在城市（例如"方便说下你现在在哪个城市吗"），得到明确回复后再调用本工具；本轮不要提群相关内容，也不要调用 request_handoff。' +
      unsavedImageHint,
    details: { city, industry: industry ?? undefined },
  });
}

function buildInviteTimingGateError(params: {
  verdict: Exclude<InviteTimingGateVerdict, { decision: 'allow' }>;
  city: string;
  industry?: string;
}) {
  const { verdict, city, industry } = params;
  const groupName = verdict.invitedGroupName;
  return buildToolError({
    errorType: TOOL_ERROR_TYPES.INVITE_ALREADY_INVITED,
    outcome: '本会话已给该城市拉过群，不重复邀请',
    replyInstruction:
      `本会话此前已经给候选人发过${groupName ? `「${groupName}」` : '兼职岗位信息群'}的邀请，` +
      '不要再次发起邀请、不要说"已拉你进群"。候选人主动问群相关问题时按"邀请已经发过了，点卡片就能进"口径回应；' +
      '其余情况不主动提群，正常回应候选人本轮的问题。不要调用 request_handoff。',
    details: { city, groupName, industry: industry ?? undefined },
  });
}

function buildAlreadyInGroupResult(result: GroupInviteResult, city: string, industry?: string) {
  const groupName = result.groupName ?? '';
  return {
    success: true,
    alreadyInGroup: true,
    groupName,
    groupPurpose: 'job_pool',
    city,
    industry: industry ?? undefined,
    _outcome: '候选人已在该群中（实时核验）',
    _replyInstruction:
      `候选人已经在兼职岗位信息群「${groupName}」里，不要承诺拉群、不要再次发起邀请；` +
      '这个群不是面试群，不得把腾讯会议链接或面试通知关联到这个群；' +
      `候选人主动问群相关问题时按"你已经在${groupName}里了"口径回应，其余情况不主动提及群。` +
      '记忆已写入，同会话后续不再重复触发本工具。',
  };
}

function buildGroupInviteResult(params: {
  result: GroupInviteResult;
  city: string;
  industry?: string;
}) {
  const { result, city, industry } = params;
  if (result.success) {
    if (result.alreadyInGroup) {
      return buildAlreadyInGroupResult(result, city, industry);
    }

    const groupName = result.groupName ?? '';
    const isDirectAdd = result.inviteDelivery === 'direct_add';
    return {
      success: true,
      groupName,
      groupPurpose: 'job_pool',
      city,
      industry: industry ?? undefined,
      inviteDelivery: result.inviteDelivery,
      matchedIndustry: result.matchedIndustry,
      fallbackUsed: result.fallbackUsed,
      selectionReason: result.selectionReason,
      citySnapshot: result.citySnapshot,
      _outcome: result.inviteCardPendingConsent
        ? '已向候选人发送入群邀请卡片（企微要求候选人同意后才会入群）'
        : isDirectAdd
          ? '候选人已被直接加入目标兼职群'
          : '已向候选人发送入群邀请卡片',
      _replyInstruction: isDirectAdd
        ? `候选人已被直接加入兼职岗位信息群"${groupName}"。回复时必须带实际群名并说明用途，例如"已帮你加入了「${groupName}」，这个群平时用来看兼职岗位信息"；这是兼职群，不是面试群，不得把腾讯会议链接或面试通知关联到这个群；不要输出任何群链接或二维码。${UNDELIVERED_PRELUDE_REMINDER}`
        : `企微已向候选人发送兼职岗位信息群"${groupName}"的邀请卡片。回复时必须带实际群名并说明用途，例如"「${groupName}」的邀请已经发你了，点一下卡片就能进，这个群平时用来看兼职岗位信息"；这是兼职群，不是面试群，不得把腾讯会议链接或面试通知关联到这个群；禁止输出、编造或粘贴任何 work.weixin.qq.com 群链接 / URL。${UNDELIVERED_PRELUDE_REMINDER}`,
    };
  }

  switch (result.reason) {
    case 'enterprise_token_missing':
      return buildToolError({
        errorType: TOOL_ERROR_TYPES.INVITE_ENTERPRISE_TOKEN_MISSING,
        outcome: '企业 Token 未配置',
        replyInstruction: `拉群配置缺失，本次不向候选人提及群相关内容；这是部署侧配置问题，不应反复重试。${UNDELIVERED_INVITE_HANDOFF_INSTRUCTION}`,
        details: { detailedReason: 'STRIDE_ENTERPRISE_TOKEN 未配置，无法执行企业级拉群' },
      });
    case 'missing_bot_identity':
      return buildToolError({
        errorType: TOOL_ERROR_TYPES.INVITE_MISSING_BOT_IDENTITY,
        outcome: '缺少 bot 身份信息',
        replyInstruction: `拉群所需的 bot 身份不完整，本次不向候选人提及群相关内容；这是上下文缺失问题，不要反复重试。${UNDELIVERED_INVITE_HANDOFF_INSTRUCTION}`,
        details: { detailedReason: '缺少 botImId / botUserId，无法执行企业级拉群' },
      });
    case 'no_group_available':
      return buildToolError({
        errorType: TOOL_ERROR_TYPES.INVITE_NO_GROUP_AVAILABLE,
        outcome: '暂无可用群',
        replyInstruction: `当前平台无可用兼职群数据，本次不向候选人提及群相关内容。${NO_GROUP_CONTINUE_INSTRUCTION}`,
      });
    case 'no_group_in_city':
      return buildToolError({
        errorType: TOOL_ERROR_TYPES.INVITE_NO_GROUP_IN_CITY,
        outcome: '该城市无匹配群',
        replyInstruction: `该候选人所在城市暂无兼职群，本次不向候选人提及群相关内容。${NO_GROUP_CONTINUE_INSTRUCTION}`,
        details: { city },
      });
    case 'group_full':
      return buildToolError({
        errorType: TOOL_ERROR_TYPES.INVITE_GROUP_FULL,
        outcome: '候选群均已满',
        replyInstruction: `该候选人区域/行业下的兼职群均已满，本次不向候选人提及群相关内容；运维侧告警已自动触发。${UNDELIVERED_INVITE_HANDOFF_INSTRUCTION}`,
        details: {
          ...(result.groupName ? { groupName: result.groupName } : {}),
          citySnapshot: result.citySnapshot,
        },
      });
    case 'candidate_not_friend':
      return buildToolError({
        errorType: TOOL_ERROR_TYPES.INVITE_CANDIDATE_NOT_FRIEND,
        outcome: '候选人非外部联系人(拉黑/删好友)，无法拉群',
        replyInstruction: NOT_FRIEND_CONTINUE_INSTRUCTION,
        details: { city, industry: industry ?? undefined },
      });
    case 'api_rejected':
      return buildToolError({
        errorType: TOOL_ERROR_TYPES.INVITE_API_REJECTED,
        outcome: '候选群均被接口拒绝',
        replyInstruction: `所有候选群被企业接口拒绝（通常是 bot 不在群中等结构性问题），本次不向候选人提及群相关内容；运维告警已自动触发。${UNDELIVERED_INVITE_HANDOFF_INSTRUCTION}`,
        details: {
          groupName: result.groupName,
          city,
          industry: industry ?? undefined,
          citySnapshot: result.citySnapshot,
          reason: result.rejectionReason,
          totalRejected: result.totalRejected,
        },
      });
    case 'api_failed':
    default:
      return buildToolError({
        errorType: TOOL_ERROR_TYPES.INVITE_API_FAILED,
        outcome: '拉群接口异常',
        replyInstruction: `拉群接口暂时不可用，本次不向候选人提及群相关内容；不要把异常信息原文转述给候选人。${UNDELIVERED_INVITE_HANDOFF_INSTRUCTION}`,
        details: { reason: result.rejectionReason },
      });
  }
}

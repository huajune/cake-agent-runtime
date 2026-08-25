import { toErrorMessage } from '@infra/utils/error.util';
import { Logger } from '@nestjs/common';
import { tool } from 'ai';
import { z } from 'zod';
import { ToolBuilder } from '@shared-types/tool.types';
import { buildToolError, TOOL_ERROR_TYPES } from '@tools/shared/tool-error-types';
import {
  GroupInviteService,
  type GroupInviteInput,
  type GroupInviteResult,
} from '@biz/group-task/services/group-invite.service';
import { SessionStateService } from '@memory/short-term/session-state.service';
import { evaluateInviteCityGate } from '@tools/invite/invite-city-gate';
import { evaluateInviteTimingGate, hasAcceptedGroupOffer } from '@tools/invite/invite-timing-gate';
import { extractUserTexts } from '@resolution/signal/dialogue';
import { resolveCityFromDistrict } from '@resolution/geo';
import {
  buildRecommendationLimitScript,
  countDissatisfiedRecommendationRounds,
  hasPriorNoMatchReply,
} from '@tools/job-list/no-match-script.util';
import { canUseFactForAction } from '@tools/shared/action-confidence';

const logger = new Logger('invite_to_group');

const UNDELIVERED_INVITE_HANDOFF_INSTRUCTION =
  '如果候选人本轮是在同意入群/后续通知，或当前意向已无匹配而需要群维护，请立即调用 request_handoff(reasonCode="other") 转人工跟进；调用后不得再输出文本。';

// 无群（区别于群满）：业务要求"推荐无岗且没有兼职群（群满场景除外）不再转人工"。
// 该城市/平台本就没有可对接的兼职群时，不触发人工介入，Agent 自然收口并继续托管。
const NO_GROUP_CONTINUE_INSTRUCTION =
  '该城市/平台本就没有可对接的兼职群（注意：这不是群满，而是没有群）。这种情况不要调用 request_handoff 转人工，也不要向候选人提及群相关内容。请自然收口：礼貌告知候选人当前暂时没有合适岗位、后续有匹配会主动联系，然后正常结束本轮、保持托管。';

// 二次无岗升级（badcase 6a5df7e7 Aron 案）：无群城市里 Agent 连续两轮照本指令输出
// 一字不差的"暂时没有合适的岗位"，且没回应候选人"除了必胜客还有其他吗"的具体提问，
// 候选人评价"说话跟人机一样"后辱骂流失。已告知过一次无岗时只回应本轮问题并引导入群，
// 不再让模型通过“换一种说法”重复同一结论。
const NO_GROUP_REPEAT_ESCALATION =
  '注意：本会话已经告知过候选人"暂时没有岗位"，本次**严禁与已发送的消息逐字重复**。' +
  '只用一句话正面回应候选人本轮的具体问题并引导其查看/进入岗位信息群；' +
  '不要再次复述无岗原因，也不要重复“后续有岗位通知你”的承诺。';

// 多步回合送达提醒（badcase recvqgsttbhyYq / chat 6a62f368，2026-07-24）：无岗→拉群链路里，
// 模型在工具调用之间"计划说"的无岗承接句从未真正发出，最终只投递了拉群确认句，候选人
// 收到"不说原因直接拉群"。工具成功结果里显式提醒：中间步骤文字不会送达，最终回复必须补上。
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
  1. 本工具返回的实际 groupName 是兼职岗位信息群，邀请已发送/已加入；
  2. 本次面试使用单独的面试群，按 booking 的 _manualInterviewGroupGuide 告知“我这边接着发你邀请”。
- 腾讯会议链接、面试通知、姓名+手机号备注要求只能关联“面试群”，不得接在兼职群说明后让候选人误以为两者是同一个群。

## 触发场景（满足任一即可）
1. **首次面试预约成功后** — duliday_interview_booking 返回 success: true（必须检查 _outcome 字段确认预约成功），且已知候选人城市时，在同轮调用。仅限本会话首次预约成功时触发，后续再预约不再重复拉群
2. **连续两轮推荐均不满意后的群承接** — 候选人已明确否定两轮具体岗位推荐，上一轮已停止第三轮推荐并征询入群，候选人本轮明确回复同意后调用本工具。真实搜索 0 条/暑假工无库存不属于本场景，不得因此直接拉群。**拉群不能替代取消工单**：若候选人在**面试开始之前**放弃的岗位在 [当前预约信息] 里有进行中的工单，必须同时走 duliday_cancel_work_order 取消该工单再拉群收尾。面试时间已到/已过之后才说没去属爽约，不要取消工单
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
- **候选人正在推进某个已匹配岗位的收资/约面/确认面试时** — 候选人已接受某岗位、正在回填资料、追问"明天能面试吗/几点面试/怎么报名"等推进信号时，说明当前有匹配在走报名流程，**禁止**此时拉群打断（拉群是"无岗维护"场景，不是"有岗推进"场景）。应继续把这单约面收尾；只有等本次预约成功（走场景 1）或确认该岗位无法继续（如失败/不符）才考虑拉群

## 参数
- city（必填）：候选人所在**城市级**名称，从 [会话记忆] / [本轮查询硬约束] 的"城市"字段获取，例如"上海"、"北京"、"武汉"。
  - 严禁把区域/区县/镇/街道/商圈/门店地址传给 city，例如"静安区"、"浦东新区"只能用于查岗的 regionNameList / location，不能作为兼职群城市
  - 当上下文同时出现"城市: 上海"和"区域: 静安区"时，调用本工具必须传 city="上海"
- industry（强烈建议传）：候选人的求职意向行业
  - 候选人意向餐饮（如肯德基、必胜客、奶茶店、饭店服务员）→ 必须传 industry="餐饮"
  - 候选人意向零售（如奥乐齐、超市补货、便利店）→ 必须传 industry="零售"
  - 意向明确但漏传 → 工具按"人数最少"兜底，可能选到不匹配行业的群，引起候选人疑问
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
- 若 errorType=invite.no_job_result，说明本轮还没跑过 duliday_job_list（突兀拉群被拦）。先查岗给出结论再决定是否拉群；本轮不要提群相关内容，不要转人工
- 若 errorType=invite.booking_in_progress，说明候选人本轮正在推进报名/约面（问怎么报名、几点面试等）。直接回答他的问题并把这单约面推下去，本轮不要提群相关内容，不要转人工
- 若 errorType=invite.already_invited，说明本会话已给该城市拉过群。按返回的群名据实回应（"邀请已经发过了"），不要再次发起邀请，不要转人工
- 若候选人本轮是在同意入群/后续通知，或当前意向已无匹配而需要群维护，但工具返回 success: false，多数情况要立刻调用 request_handoff(reasonCode="other") 转人工跟进；不要自然语言收尾把候选人晾住
  - **例外（不转人工）**：失败原因是"该城市/平台本就没有兼职群"（errorType=invite.no_group_in_city / invite.no_group_available）、或"候选人非外部联系人/已拉黑删好友"（errorType=invite.candidate_not_friend）时，**不要**转人工——按工具返回的 replyInstruction 自然收口并继续托管即可；只有"群满"（invite.group_full）或接口/结构性失败才转人工
- 只有 success: true 时才能说"已拉群/已发入群邀请"；无群、群满、接口拒绝、未调用工具时，都不要用**完成口径**声称群相关动作已发生

## 拉群口径（两轮动作链，与场景 2/3 一致）
- **征询式**（"要不我邀请你进群？"）只在连续两轮推荐均不满意后使用：先承接候选人意向，**本轮不调本工具**；真实搜索 0 条不得提群
- 候选人对拉群提议回复"好/可以/嗯"等同意词后，**下一轮必须实调本工具**（场景 3）；提了拉群却一直不调 = 空头承诺，候选人看到没动静会立刻流失
- **完成口径**（"已拉你进群 / 群邀请已经发你了 / 发了群邀请"）**必须**本轮实调本工具且返回 success: true，否则严禁使用
- 拉群成功后，本轮必须停止继续推荐其他岗位；后续轮也不要再向候选人推岗位，转为群内运营`;

const inputSchema = z.object({
  city: z
    .string()
    .describe(
      '候选人所在城市级名称，如"上海"。严禁传区域/区县/镇/街道/商圈，如"静安区"、"浦东新区"。',
    ),
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
        const inviteInput: GroupInviteInput = {
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

        try {
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

          // 前置已在群闸门（badcase batch_6a4790c7ce406a6aeee9c102）：候选人已在
          // 目标城市兼职群时，业务目标已达成，直接短路成功——不再要求城市出处。
          // 本核验必须排在城市 provenance gate 之前，否则模型无视"已在群"注入调用本
          // 工具、city 又缺出处时，工具回 city_unverified 并引导模型追问城市继续
          // 推进拉群，候选人被反复纠缠。实时群成员关系本身就是该城市的最强依据。
          // 群列表走缓存（不 forceRefresh），任何失败静默降级回原流程。
          if (context.runtime.strategySource !== 'testing') {
            const existingMembership =
              await groupInviteService.preflightExistingMembership(inviteInput);
            if (existingMembership) {
              return buildAlreadyInGroupResult(existingMembership, city, industry);
            }
          }

          // 城市 provenance gate（badcase recvk28F1xrsKj 拉错城市群）：
          // city 入参必须能追溯到会话城市事实、候选人原文城市名、geo 地名白名单
          // 推断（顺义→北京 等，见 @resolution/geo）或本轮 geocode 确权城市
          //（ledger.geo.anchors 穿线，#765），模型自报不构成依据。
          // 会话城市事实的合法来源含 rule/llm/derived 之外的 'tool'（geocode unique
          // 确权、定位分享逆解析，2026-07-27 证据化穿线）——按置信度采信，不挑 source。
          // 会话事实读取失败按 null 降级（gate 仍可凭候选人原文放行），不让 Redis 抖动挡住拉群。
          let sessionCity: string | null = null;
          if (sessionService) {
            try {
              const facts = await sessionService.getFacts(
                context.session.corpId,
                context.session.userId,
                context.session.sessionId,
              );
              const cityFact = facts?.preferences?.city ?? null;
              sessionCity =
                cityFact && canUseFactForAction('invite_city', cityFact.confidence)
                  ? cityFact.value
                  : null;
            } catch (error: unknown) {
              const message = toErrorMessage(error);
              logger.warn(`读取会话城市事实失败（gate 按无事实降级）: ${message}`);
            }
          }
          // 顺序恢复提示（visual-fact §二A ⑩）：本轮有图片但尚未 save_image_description
          // 时，地图截图的城市线索还没进 ledger——拒绝理由里给模型一条确定性恢复路径。
          const hasUnsavedImages =
            (context.turnInput.imageMessageIds?.length ?? 0) > 0 &&
            (context.ledger.visual.factSheets?.length ?? 0) === 0;
          const unsavedImageHint = hasUnsavedImages
            ? '本轮候选人发了图片但你还没调用 save_image_description；若图片是位置/地图截图，先保存描述再重试本工具，城市核验会采信图中位置。'
            : '';
          const cityGateVerdict = evaluateInviteCityGate({
            requestedCity: city,
            sessionCity,
            userTexts: extractUserTexts(context.turnInput.messages),
            geoSignalCities: context.ledger.geo.signalCities,
            // 同轮 geocode unique 确权城市：补"轮末写档、下轮生效"的时序空档
            //（geocode → 无岗 → invite 常在同一轮发生）。
            turnResolvedCities: (context.ledger.geo.anchors ?? []).map((anchor) => anchor.city),
            turnVisualSheets: context.ledger.visual.factSheets,
          });
          if (cityGateVerdict.decision === 'reject') {
            if (cityGateVerdict.reason === 'city_conflict') {
              logger.warn(
                `invite_to_group city 与会话城市事实冲突: city=${city}, expectedCity=${cityGateVerdict.expectedCity} (user=${context.session.userId})`,
              );
              return buildToolError({
                errorType: TOOL_ERROR_TYPES.INVITE_CITY_CONFLICT,
                outcome: 'city 入参与会话记忆中的城市不一致',
                replyInstruction:
                  '你传入的 city 与候选人会话记忆中的城市不一致。若候选人本轮没有明确说换城市，请改用 expectedCity 重新调用 invite_to_group；若你认为候选人换了城市，先向候选人确认所在城市，本轮不要提群相关内容，也不要调用 request_handoff。' +
                  unsavedImageHint,
                details: {
                  city,
                  expectedCity: cityGateVerdict.expectedCity,
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

          // 时机 gate（badcase 63eefu6c / chat 6a68392b，2026-07-29）：同会话两次把要全职的
          // 候选人拉进兼职群 —— 一次在查岗结论出来之前，一次在候选人问"直接去门店面试吗"
          // （报名推进信号）时。三条禁止项都已写在工具描述里，模型照样不遵循，落成确定性闸门。
          // invitedGroups 读取失败按空降级（不让 Redis 抖动挡住合法拉群）。
          let invitedGroups: { groupName?: string | null; city?: string | null }[] = [];
          if (sessionService) {
            try {
              const state = await sessionService.getSessionState(
                context.session.corpId,
                context.session.userId,
                context.session.sessionId,
              );
              invitedGroups = state?.invitedGroups ?? [];
            } catch (error: unknown) {
              const message = toErrorMessage(error);
              logger.warn(`读取 invitedGroups 失败（时机 gate 按空降级）: ${message}`);
            }
          }
          const timingVerdict = evaluateInviteTimingGate({
            requestedCity: city,
            jobListExecuted: context.ledger.jobs.jobListExecuted === true,
            bookingSucceeded: context.ledger.jobs.bookingSucceeded,
            groupOfferAccepted: hasAcceptedGroupOffer(context.turnInput.messages ?? []),
            invitedGroups,
            currentUserMessage: context.turnInput.currentUserMessage,
          });
          if (timingVerdict.decision === 'reject') {
            logger.warn(
              `invite_to_group 时机 gate 拒绝: reason=${timingVerdict.reason}, city=${city} (user=${context.session.userId})`,
            );
            if (timingVerdict.reason === 'already_invited_city') {
              const groupName = timingVerdict.invitedGroupName;
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
            if (timingVerdict.reason === 'no_job_result_this_turn') {
              return buildToolError({
                errorType: TOOL_ERROR_TYPES.INVITE_NO_JOB_RESULT,
                outcome: '本轮尚未给出查岗结论，不能直接拉群',
                replyInstruction:
                  '本轮还没有查岗结论，候选人不知道是有岗还是没岗就收到群邀请会困惑。' +
                  '请先调用 duliday_job_list 查岗：有合适岗位就推荐；真实无岗则如实收口且不拉群。' +
                  '只有连续两轮推荐均不满意、上一轮已征询入群且本轮候选人明确同意时，才可在无本轮查岗的情况下调用本工具。' +
                  '本轮不要提群相关内容，也不要调用 request_handoff。',
                details: { city, industry: industry ?? undefined },
              });
            }
            if (timingVerdict.reason === 'group_consent_required') {
              const dissatisfiedRecommendationRounds = countDissatisfiedRecommendationRounds(
                context.turnInput.messages ?? [],
              );
              const noMatchScript =
                dissatisfiedRecommendationRounds >= 2
                  ? buildRecommendationLimitScript({ cityLabels: [city] })
                  : null;
              return buildToolError({
                errorType: TOOL_ERROR_TYPES.INVITE_GROUP_CONSENT_REQUIRED,
                outcome: '本轮没有合法的入群授权，禁止用查岗完成替代候选人同意',
                replyInstruction: noMatchScript
                  ? '**候选人已连续否定两轮具体岗位，但本轮尚未同意入群。严格按 noMatchScript.candidateMessage 征询入群意愿，' +
                    '不得重查或继续推荐，不得再次调用 invite_to_group；候选人下一轮明确同意后才实调。'
                  : '本轮虽然已经查过岗位，但拉群只允许两种入口：预约成功后的首次承接，或连续两轮推荐均不满意、' +
                    '上一轮已征询入群且候选人本轮明确同意。真实无岗请按 noMatchScript 如实收口并等待库存，' +
                    '查到岗位则继续正常推荐/推进；本轮不要提群相关内容，也不要调用 request_handoff。',
                details: {
                  city,
                  industry: industry ?? undefined,
                  dissatisfiedRecommendationRounds,
                  noMatchScript,
                },
              });
            }
            return buildToolError({
              errorType: TOOL_ERROR_TYPES.INVITE_BOOKING_IN_PROGRESS,
              outcome: '候选人正在推进报名/约面，拉群会打断成单',
              replyInstruction:
                '候选人本轮在问报名或面试怎么走，说明他正推进某个具体岗位 —— 拉群是"无岗维护"场景，' +
                '此时拉群等于打断成单。请直接回答候选人的问题并把这单约面推下去（该跑 precheck 就跑 precheck、' +
                '该收资就收资）。本轮不要提群相关内容，也不要调用 request_handoff。',
              details: { city, industry: industry ?? undefined },
            });
          }

          // testing 链路（test-suite 重放/调试）：确定性校验（区县、城市 gate）已在上方
          // 真实跑完，这里返回模拟成功、不触达企业接口——否则测试环境缺 bot 身份必失败，
          // prompt 的"invite 失败转人工"指引会把重放全部推进 handoff，拉群链路永远测不到。
          if (context.runtime.strategySource === 'testing') {
            logger.log(`testing 链路模拟拉群成功: city=${city} (user=${context.session.userId})`);
            return {
              success: true,
              simulated: true,
              groupName: `${city}兼职群（测试模拟）`,
              groupPurpose: 'job_pool',
              city,
              industry: industry ?? undefined,
              inviteDelivery: 'invite_card',
              _outcome: '【测试链路模拟】已向候选人发送入群邀请卡片（未触达真实企业接口）',
              _replyInstruction:
                `企微已向候选人发送兼职岗位信息群"${city}兼职群（测试模拟）"的邀请卡片。` +
                `回复时必须带实际群名并说明这是兼职岗位信息群、不是面试群；不得把腾讯会议链接或面试通知关联到这个群；` +
                `禁止输出、编造或粘贴任何群链接 / URL。${UNDELIVERED_PRELUDE_REMINDER}`,
            };
          }

          const inviteResult = await groupInviteService.invite(inviteInput);
          return buildGroupInviteResult({
            result: inviteResult,
            city,
            industry,
            priorNoMatch: hasPriorNoMatchReply(context.turnInput.messages ?? []),
          });
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
  priorNoMatch: boolean;
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
        replyInstruction: `当前平台无可用兼职群数据，本次不向候选人提及群相关内容。${NO_GROUP_CONTINUE_INSTRUCTION}${params.priorNoMatch ? NO_GROUP_REPEAT_ESCALATION : ''}`,
      });
    case 'no_group_in_city':
      return buildToolError({
        errorType: TOOL_ERROR_TYPES.INVITE_NO_GROUP_IN_CITY,
        outcome: '该城市无匹配群',
        replyInstruction: `该候选人所在城市暂无兼职群，本次不向候选人提及群相关内容。${NO_GROUP_CONTINUE_INSTRUCTION}${params.priorNoMatch ? NO_GROUP_REPEAT_ESCALATION : ''}`,
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

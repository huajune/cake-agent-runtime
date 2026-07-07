import type { AgentToolCall } from '@agent/generator/generator.types';
import { GUARDRAIL_ACTION } from '@shared-types/guardrail.contract';
import { textAssertsClaim } from './claim-assertion.util';
import { asRecord, type FactRule, type RuleContradiction } from '../output-rule.types';

/**
 * 虚假承诺 / 工具动作反向声称成功规则。
 *
 * 职责：
 * - 管“Agent 对候选人承诺了一个动态状态或副作用动作，但本轮没有可靠外部信号支撑”的场景；
 * - 典型包括：名额不会满、声称已拉群/邀请已发、工具失败却说预约/取消/改期/发定位成功；
 * - 拉群的征询/承诺式话术（"要不我拉你进群？"）是 invite_to_group 场景 2/3 设计内的
 *   前置轮（先问意向、候选人同意后下一轮实调），不属于虚假承诺；
 * - 这类问题的风险不是敏感信息外泄，而是给候选人制造了可以追责的承诺。
 *
 * 不负责：
 * - 不管岗位内容、薪资、距离等事实编造，它们属于 job-fact-hallucinations；
 * - 不管 booking precheck 后的约面口径，那类依赖 precheck 结构化结果，放在 booking-claim-errors；
 * - 不管“候选人问保险/社保时如何回答”，保险政策有独立规则。
 *
 * 动作策略：
 * - quota_promise 用 block：名额承诺没有任何工具能正当化，发出去风险不可逆；
 * - 工具失败却声称成功用 revise：通常可以改写成“未成功/需补充/人工处理”；
 * - 群满/群解散若没有本轮拉群成功信号，已升级为 revise，避免编造群状态。
 */

// 注意：`还` 后面的承诺后缀必须命中其一——不能整组可选，否则裸子串"名额还"就会命中，
// 把"名额还在不在我这边没法保证"这类合规免责话术一起硬拦（P0 block 不可修复，误杀即静默）。
const QUOTA_PROMISE_PATTERN =
  /名额(?:放心|不会满|还(?:有很多|有不少|够了?)|充足|给你留|帮你留|专门给你|留够了)|帮你(?:留(?!意)|保留)(?:好了|着)?(?:名额|位置)?|你(?:的|那个)?名额(?:还在(?!不在)|有的|没满)|名额不会满的/;

// 副作用工具“成功口径”集合。只有对应工具真的成功，reply 才能说这些话。
const BOOKING_SUCCESS_CLAIM_PATTERN =
  /(?:预约|报名|面试|到店)[^。！？\n]{0,16}(?:成功|好了|约好了|安排好了|提交成功)|(?:已|已经|帮你|给你)[^。！？\n]{0,18}(?:约好|预约成功|报名成功|安排(?:好)?面试|提交(?:报名)?)|(?:今天|明天|后天|大后天|周[一二三四五六日天]|星期[一二三四五六日天])[^。！？\n]{0,16}(?:面试|到店)/;
const CANCEL_SUCCESS_CLAIM_PATTERN =
  /(?:已|已经|帮你|给你)[^。！？\n]{0,12}取消|取消[^。！？\n]{0,8}(?:成功|好了|完成)/;
const MODIFY_SUCCESS_CLAIM_PATTERN =
  /(?:已|已经|帮你|给你)[^。！？\n]{0,16}(?:改约|改到|调整|修改)|(?:改约|改时间|修改面试时间)[^。！？\n]{0,8}(?:成功|好了|完成)/;
const INVITE_SUCCESS_CLAIM_PATTERN =
  /(?:已|已经)[^。！？\n]{0,12}(?:拉|加)[^。！？\n]{0,12}群|(?:入群)?邀请[^。！？\n]{0,8}(?:已|已经)?发|我[^。！？\n]{0,12}(?:拉|加)你[^。！？\n]{0,12}群了/;
const STORE_LOCATION_SUCCESS_CLAIM_PATTERN =
  /(?:定位|位置|导航)[^。！？\n]{0,12}(?:发你|发过去|已发|发了)|(?:已|已经|帮你|给你)[^。！？\n]{0,12}(?:发|发送)[^。！？\n]{0,8}(?:定位|位置|导航)/;
const SYSTEM_STATUS_FABRICATION_PATTERN =
  /(?:系统|平台|后台|网络|接口|服务器|数据|信息|名单|岗位|预约|报名)[^。！？\n]{0,12}(?:同步|更新|刷新|提交|录入|审核)?[^。！？\n]{0,8}(?:失败|异常|出错|错误|卡住|卡了|延迟|没同步|没更新|有(?:点)?问题)|(?:同步|网络|系统)[^。！？\n]{0,8}(?:有(?:点)?问题|不好|不太稳定)/;

/**
 * 拉群规则的误杀主要来自“询问/建议/条件句”：
 * - “需要的话我可以拉你进群吗”不是承诺已拉群；
 * - “要不我给你发个群邀请”是候选人确认前的提议；
 * - 这些不能要求 invite_to_group 已经成功。
 */
function isConditionalGroupInviteQuestion(text: string): boolean {
  const normalized = text.replace(/\s+/g, '');

  if (
    /(?:要不要|需不需要|是否需要|你看是|还是(?:先)?|要不(?:我)?)[^。！？?；]{0,80}?(?:拉(?:你|您)[^。！？?；]{0,15}?群|进(?:咱们|我们|这个|这|这边)[^。！？?；]{0,15}?群|加(?:你|您)[^。！？?；]{0,15}?群|发(?:个|一个|条)?(?:入)?群邀请)[^。！？?；]{0,80}?(?:吗|呢|？|\?)/.test(
      normalized,
    )
  ) {
    return true;
  }

  if (
    /(?:我?(?:也|还)?可以|(?:要|需要|有需要|感兴趣)的话(?:我)?(?:也)?)[^。！？?；]{0,30}?(?:拉(?:你|您)[^。！？?；]{0,15}?群|进(?:咱们|我们|这个|这|这边)[^。！？?；]{0,15}?群|加(?:你|您)[^。！？?；]{0,15}?群|发(?:个|一个|条)?(?:入)?群邀请)/.test(
      normalized,
    )
  ) {
    return true;
  }

  if (
    /(?:拉(?:你|您)[^。，,；！？\s]{0,15}?群|进(?:咱们|我们|这个|这|这边)[^。，,；！？\s]{0,15}?群|加(?:你|您)[^。，,；！？\s]{0,15}?群|发(?:个|一个|条)?(?:入)?群邀请)[^。！？]{0,30}?(?:你看(?:行|好|可以|怎么样|行不行|行行)?|好吗|行吗|可以吗|方便吗|好不好)[^。！？]{0,10}?(?:？|\?)/.test(
      normalized,
    )
  ) {
    return true;
  }

  if (
    /或者(?:我)?(?:也|先|还)?(?:给(?:你|您))?[^。！？?；]{0,20}?(?:拉(?:你|您)[^。！？?；]{0,15}?群|进(?:咱们|我们|这个|这|这边)[^。！？?；]{0,15}?群|加(?:你|您)[^。！？?；]{0,15}?群|发(?:个|一个|条)?(?:入)?群邀请)/.test(
      normalized,
    )
  ) {
    return true;
  }

  return /(?:不[^。！？?；]{0,8}?|(?:可以|愿意|感兴趣|有需要|有兴趣|方便))的话[^。！？?；]{0,80}?(?:拉(?:你|您)[^。！？?；]{0,15}?群|进(?:咱们|我们|这个|这|这边)[^。！？?；]{0,15}?群|加(?:你|您)[^。！？?；]{0,15}?群|发(?:个|一个|条)?(?:入)?群邀请)/.test(
    normalized,
  );
}

/**
 * 候选人追问历史群邀请时，Agent 可能复述“之前已经拉过/发过邀请”。
 * 这不一定要求本轮再次调用 invite_to_group，因此单独豁免过去式表达。
 */
function isPastTenseGroupReference(text: string): boolean {
  const normalized = text.replace(/\s+/g, '');
  return /(?:之前|上次|前面|前两天|前几天|此前|早先)[^。！？?；]{0,40}?(?:拉(?:你|您)[^。！？?；]{0,15}?群|加(?:你|您)[^。！？?；]{0,15}?群|发(?:过)?(?:入)?群邀请)/.test(
    normalized,
  );
}

/**
 * 判断“本轮确实完成拉群副作用”。
 * 有些工具返回用 status=ok，有些返回 result.success=true，因此两个口径都接住。
 *
 * 结果缺失按“无法证伪”放行：生产流水里 invite_to_group 存在 status=unknown 且 result
 * 未落的记录缺口（2026-07-06 守卫档案 id=3：同轮真调了 invite 仍被判“未成功”）。
 * 工具确实被调用但结果拿不到时，宁可放过“邀请已发”话术，也不能把正确路径误拦。
 */
function inviteCalledSuccessfully(toolCalls: AgentToolCall[]): boolean {
  return toolCalls.some((call) => {
    if (call.toolName !== 'invite_to_group') return false;
    if (call.status === 'ok') return true;
    if (typeof call.result === 'object' && call.result !== null) {
      return (call.result as Record<string, unknown>).success === true;
    }
    // 已调用但 status/result 双缺失：无法证伪，不据此判假承诺。
    return call.status !== 'error';
  });
}

export const FALSE_PROMISE_RULES: FactRule[] = [
  {
    ruleId: 'group_full_without_invite',
    label: '声称群满/群解散但本轮未成功调 invite_to_group（badcase i41pab8n）',
    keywords: /群已满|群里人数满|群人数已满|邀请暂时发不过去|拉不进群|拉群没成功|群已解散|群里满了/,
    requiredToolPredicate: inviteCalledSuccessfully,
    action: GUARDRAIL_ACTION.REVISE,
  },
  {
    ruleId: 'group_promise_without_invite',
    label:
      '声称"已拉群/群邀请已发"（完成口径）但本轮没有成功的 invite_to_group 调用（badcase gay6j94c）',
    // 口径（2026-07-06 校准，对齐 invite_to_group 场景 2/3 的两轮动作链）：
    // - 征询/承诺式（"要不我拉你进群？""我先帮你进群，后续有岗通知你"）是设计内的
    //   前置轮——先承接候选人意向，候选人同意后下一轮实调工具（场景 3），不拦；
    //   job_list noMatchScript.candidateMessage 的脚本原文也是这种形态。
    // - 只有"完成时态"的宣称（已拉你进群 / 群邀请发你了 / 发了群邀请）必须由本轮
    //   invite_to_group 成功结果接地，否则就是编造已发生的副作用。
    keywords:
      /已经?(?:帮你|给你)?[^。，,；！？\s]{0,8}?(?:拉|加)(?:你|您)?[^。，,；！？\s]{0,12}?群|(?:拉|加)(?:你|您)[^。，,；！？\s]{0,12}?群了|发(?:了|过)(?:入)?群邀请|(?:入)?群邀请(?:已经?|刚刚?)?发(?:给)?(?:你|您)|邀请已经?(?:发(?:出|过去)?|发送)/,
    ignorePredicate: (text) =>
      isConditionalGroupInviteQuestion(text) || isPastTenseGroupReference(text),
    requiredToolPredicate: inviteCalledSuccessfully,
    action: GUARDRAIL_ACTION.REVISE,
  },
  {
    ruleId: 'quota_promise',
    label:
      '回复向候选人承诺名额不会满或已保留（承诺一旦发出即成证据，岗位状态可能随时变化，候选人有前置成本时需提示不确定性）',
    keywords: QUOTA_PROMISE_PATTERN,
    requiredToolPredicate: () => false,
    action: GUARDRAIL_ACTION.BLOCK,
  },
  {
    ruleId: 'system_status_fabrication',
    label:
      '回复用系统/网络/后台异常解释拖延或失败（系统状态禁止编造和外露），需改写为补充信息、稍后人工处理或继续推进业务动作的口径',
    keywords: SYSTEM_STATUS_FABRICATION_PATTERN,
    requiredToolPredicate: () => false,
    action: GUARDRAIL_ACTION.REVISE,
  },
];

/**
 * 对副作用工具做“失败结果 vs 回复成功口径”的二次对账。
 *
 * 这里不用简单 FactRule，是因为它必须同时看两件事：
 * 1. reply 是否出现某类成功话术；
 * 2. 本轮对应 toolName 是否有 error / success=false / errorType。
 *
 * 一旦发现矛盾，返回 revise 而不是 block：这类回复通常可以安全改成
 * “这边还没操作成功 / 需要补充信息 / 已为你转人工处理”的口径。
 */
export function detectToolFailureSuccessClaim(
  text: string,
  toolCalls: AgentToolCall[],
): RuleContradiction | null {
  const toolClaimPatterns: Array<{
    toolName: string;
    pattern: RegExp;
    label: string;
  }> = [
    {
      toolName: 'duliday_interview_booking',
      pattern: BOOKING_SUCCESS_CLAIM_PATTERN,
      label: 'booking 工具失败/拒绝后，回复却声称已预约/已安排面试',
    },
    {
      toolName: 'duliday_cancel_work_order',
      pattern: CANCEL_SUCCESS_CLAIM_PATTERN,
      label: 'cancel 工具失败/拒绝后，回复却声称已取消预约',
    },
    {
      toolName: 'duliday_modify_interview_time',
      pattern: MODIFY_SUCCESS_CLAIM_PATTERN,
      label: 'modify 工具失败/拒绝后，回复却声称已改约/已修改面试时间',
    },
    {
      toolName: 'invite_to_group',
      pattern: INVITE_SUCCESS_CLAIM_PATTERN,
      label: 'invite_to_group 工具失败/拒绝后，回复却声称已拉群/已发送入群邀请',
    },
    {
      toolName: 'send_store_location',
      pattern: STORE_LOCATION_SUCCESS_CLAIM_PATTERN,
      label: 'send_store_location 工具失败/拒绝后，回复却声称已发送定位/位置',
    },
  ];

  for (const { toolName, pattern, label } of toolClaimPatterns) {
    // 句粒度声称判定（否定/疑问句豁免）："暂时没能提交成功，你看周三方便吗"是工具失败后
    // 的诚实纠错口径，不是成功宣称——全文裸匹配曾把这种修复版再次拦死（2026-07-06
    // 守卫档案 id=104：首版谎称已登记被正确拦下，诚实修复版因"提交成功"字样连坐）。
    if (!textAssertsClaim(text, pattern)) continue;
    const latestCall = [...toolCalls].reverse().find((call) => call.toolName === toolName);
    if (!latestCall || !isFailedToolCall(latestCall)) continue;
    const result = asRecord(latestCall.result);
    const errorType = typeof result?.errorType === 'string' ? result.errorType : 'unknown';
    return {
      ruleId: 'tool_failure_success_claim',
      label: `${label}（errorType=${errorType}），需改写为未成功/需补充/人工处理口径`,
      action: GUARDRAIL_ACTION.REVISE,
    };
  }

  return null;
}

/**
 * 统一兼容工具失败信号。
 * 工具层历史返回格式并不完全一致：有的用 call.status=error，有的用 result.success=false，
 * 也有的只给 errorType/error 字段，所以这里做保守聚合。
 */
function isFailedToolCall(call: AgentToolCall): boolean {
  const result = asRecord(call.result);
  if (call.status === 'error') return true;
  if (!result) return false;
  return (
    result.success === false ||
    typeof result.errorType === 'string' ||
    typeof result.error === 'string'
  );
}

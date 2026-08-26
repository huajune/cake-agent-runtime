/**
 * 无岗动作链的候选人可见文案模板。
 *
 * 历史 badcase 簇 ④ 中"无岗时的处理"3 条待修：
 *  - ohvvn4yw：候选人指定汉堡王无岗 → Agent 直接拉群，漏掉"X 品牌暂时没有"的承接
 *  - vic2p8ok：岗位不合适没有拉群（软收尾失败）
 *  - l2ftjgka：指定门店无岗时跨品牌推（违反"无岗 → 拉群"动作链）
 *
 * 当前路径：buildToolError 的 replyInstruction 是 prose 指令，LLM 解析时
 * 漏几个动作或自己造一句"看看其他城市/品牌吗"。
 *
 * 本层路径：直接给 LLM 一个 ready-to-send 的 candidateMessage 字符串模板，
 * 用候选人本轮查询的品牌/区域参数化（"X 在 Y 这附近暂时没找到岗位"），让
 * LLM 照念，不需要自己组装"承接 + 婉拒 + 拉群"三件套。
 */

export interface NoMatchQueryContext {
  brandLabels?: string[];
  storeLabels?: string[];
  cityLabels?: string[];
  regionLabels?: string[];
  maxKm?: number | null;
  scheduleConstraintLabel?: string | null;
  /** 身份硬门槛过滤标签（如"学生可做"），进 querySummary 观测口径 */
  identityConstraintLabel?: string | null;
  /**
   * 本会话是否已发送过一次"暂时没有岗位"类话术（由调用方从消息历史判定）。
   * true 时输出二档话术：不再逐字重复一档句式，改为"确认当前确实没有 + 已记录意向 +
   * 有岗第一时间联系"，并要求先回应候选人本轮的具体问题。
   * badcase 6a5df7e7（Aron 辱骂流失案）：两轮一字不差的无岗复读 + 不回应"除了必胜客
   * 还有其他吗"的具体提问，是候选人"说话跟人机一样"评价的直接来源。
   */
  priorNoMatchReplySent?: boolean;
}

export const NO_MATCH_NEXT_ACTIONS = [
  'wait_for_inventory',
  'offer_group_invite',
  'group_handoff_complete',
] as const;
export type NoMatchNextAction = (typeof NO_MATCH_NEXT_ACTIONS)[number];

/** 本会话已发送过的无岗类话术签名（一档 candidateMessage 与 invite 无群收口话术的共同特征）。 */
const NO_MATCH_REPLY_SIGNATURE = /暂时没(有|找到).{0,12}岗位/;

/**
 * 扫描消息历史里 assistant 是否已发过"暂时没有岗位"类话术。
 * 消息形态为 ModelMessage（role + string/parts content），与 booking 侧同构；
 * 本域不依赖 tools/shared，就地实现最小抽取。
 */
export function hasPriorNoMatchReply(messages: readonly unknown[]): boolean {
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const msg = m as { role?: unknown; content?: unknown };
    if (msg.role !== 'assistant') continue;
    const text =
      typeof msg.content === 'string'
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content
              .map((part) =>
                part &&
                typeof part === 'object' &&
                typeof (part as { text?: unknown }).text === 'string'
                  ? (part as { text: string }).text
                  : '',
              )
              .join(' ')
          : '';
    if (NO_MATCH_REPLY_SIGNATURE.test(text)) return true;
  }
  return false;
}

export interface NoMatchScript {
  /** 一句话总结候选人本轮查询的范围，用于飞书告警/log 观测，不直接给候选人 */
  querySummary: string;
  /** 直接照念给候选人的话术（承接 + 婉拒 + 下一步） */
  candidateMessage: string;
  /** 机器可读的封闭动作：真无岗等待库存；两轮不满意征询入群；已拉群后收口。 */
  nextAction: NoMatchNextAction;
  /** 显式列出被禁动作，避免 prose 指令漏几条 */
  forbiddenActions: string[];
}

const RECOMMENDATION_SIGNAL =
  /(?:推荐|岗位|门店)[^\n]{0,80}(?:薪资|时薪|班次|上班|工作时间|元\/(?:时|小时)|公里)|(?:薪资|时薪|班次|工作时间)[^\n]{0,80}(?:岗位|门店)|(?:（[^）\n]{1,40}）|\([^\)\n]{1,40}\))[^\n]{0,80}(?:\d+(?:\.\d+)?\s*(?:km|公里)|班次|薪资|\d+(?:\.\d+)?\s*元\/(?:时|小时))/i;
const DISSATISFACTION_SIGNAL =
  /不合适|不考虑|不想(?:做|去|要)|不要(?:这个|这些|这家)|(?:这个|这家|这些|都)(?:不行|不合适|不要)|做不了|干不了|接受不了|太远|有点远|离得?远|没有近的|上不了.{0,12}(?:时间|班)|只能做.{0,8}小时|时间.{0,8}(?:不行|不合适)|换(?:一个|别的|其他)|还有(?:其他|别的)|没兴趣|不满意/;

function extractMessageText(message: unknown): { role: string; text: string } | null {
  if (!message || typeof message !== 'object') return null;
  const value = message as { role?: unknown; content?: unknown };
  if (typeof value.role !== 'string') return null;
  const text =
    typeof value.content === 'string'
      ? value.content
      : Array.isArray(value.content)
        ? value.content
            .map((part) =>
              part &&
              typeof part === 'object' &&
              typeof (part as { text?: unknown }).text === 'string'
                ? (part as { text: string }).text
                : '',
            )
            .join(' ')
        : '';
  return { role: value.role, text };
}

/** 每次“已推荐具体岗位 → 候选人明确不满意”计一轮；同一推荐后的连发只计一次。 */
export function countDissatisfiedRecommendationRounds(messages: readonly unknown[]): number {
  let recommendationPending = false;
  let count = 0;
  for (const message of messages) {
    const parsed = extractMessageText(message);
    if (!parsed) continue;
    if (parsed.role === 'assistant') {
      // 岗位卡片经常拆成多条，末尾再发“你看哪家方便”。末尾 CTA 本身没有薪资/班次，
      // 不能把前面已经建立的“本轮推荐待反馈”状态清掉。
      if (RECOMMENDATION_SIGNAL.test(parsed.text)) recommendationPending = true;
      continue;
    }
    if (
      parsed.role === 'user' &&
      recommendationPending &&
      DISSATISFACTION_SIGNAL.test(parsed.text)
    ) {
      count += 1;
      recommendationPending = false;
    }
  }
  return count;
}

function joinWithCommaAndOr(labels: string[] | undefined): string {
  if (!labels || labels.length === 0) return '';
  if (labels.length === 1) return labels[0];
  return labels.join(' / ');
}

function buildQuerySummary(ctx: NoMatchQueryContext): string {
  const brand = joinWithCommaAndOr(ctx.brandLabels);
  const store = joinWithCommaAndOr(ctx.storeLabels);
  const region = joinWithCommaAndOr(ctx.regionLabels);
  const city = joinWithCommaAndOr(ctx.cityLabels);

  // 锚定优先级：门店 > 品牌 > 区域 > 城市
  const subject = store || brand || '岗位';
  const place = region ? (city ? `${city}${region}` : region) : city;
  const placeText = place ? `（${place}）` : '';
  const distanceText = ctx.maxKm != null ? `，附近 ${ctx.maxKm}km 内` : '';
  const scheduleText = ctx.scheduleConstraintLabel ? `，限 ${ctx.scheduleConstraintLabel}` : '';
  const identityText = ctx.identityConstraintLabel ? `，限 ${ctx.identityConstraintLabel}` : '';
  return `${subject}${placeText}${distanceText}${scheduleText}${identityText}`;
}

/**
 * 工具明确未查到岗位时返回的文案模板。
 *
 * 设计：把"承接候选人意向 + 婉拒 + 拉群兜底"压成一句口语化文案，
 * 用候选人本轮查询的品牌/门店/区域参数化。
 *
 * 例：brand=汉堡王, region=徐汇 → "汉堡王在徐汇这边暂时没找到合适的岗位，
 * 后续有合适的新岗位上来，我会第一时间联系你。"
 */
export function buildNoMatchScript(ctx: NoMatchQueryContext): NoMatchScript {
  const querySummary = buildQuerySummary(ctx);

  const brand = joinWithCommaAndOr(ctx.brandLabels);
  const store = joinWithCommaAndOr(ctx.storeLabels);
  const region = joinWithCommaAndOr(ctx.regionLabels);
  const city = joinWithCommaAndOr(ctx.cityLabels);

  // 承接句：候选人提了什么就接什么
  const subjectPhrase = store ? `${store}这家` : brand ? `${brand}` : '咱们这边';
  // 距离锚定的查询只覆盖以候选人坐标为圆心的 maxKm 圆，不能口播成"整个城市没有"。
  // badcase 4c94j4f7：10km 圆内 0 结果被说成"必胜客在北京这边没岗"，15 分钟后换个
  // 锚点就查出 8.7km 的门店，候选人当场质疑。半径必须进候选人可见文案。
  const placePhrase =
    ctx.maxKm != null
      ? `${region ? `${region}一带` : '你'}附近 ${ctx.maxKm} 公里内`
      : region
        ? `${region}这片`
        : city
          ? `${city}这边`
          : '附近';
  const intro = `${subjectPhrase}${store ? '' : `在${placePhrase}`}暂时没找到合适的岗位`;

  // 真无岗只做库存等待，不用拉群替代岗位供给。
  const action = '后续有合适的新岗位上来，我会第一时间联系你';

  // 二档话术（本会话已告知过一次无岗）：不再逐字重复一档句式——候选人已经听过一遍，
  // 复读即"人机感"（badcase 6a5df7e7）。改为确认式收口 + 已记录意向 + 主动联系承诺。
  const candidateMessage = ctx.priorNoMatchReplySent
    ? `刚又帮你查了一遍，${subjectPhrase}${store ? '' : `在${placePhrase}`}现在确实还没有新的合适岗位，你的需求我记下来了，一有新岗位上来就第一时间联系你`
    : `${intro}，${action}`;

  return {
    querySummary,
    candidateMessage,
    nextAction: 'wait_for_inventory',
    forbiddenActions: [
      ...(ctx.maxKm != null
        ? [
            `本轮只查了候选人坐标附近 ${ctx.maxKm} 公里内，不得把它说成"整个城市/这个区都没有岗位"——范围外可能仍有该品牌门店`,
          ]
        : []),
      '不得反问"换品牌 / 换城市 / 别的区域看看吗"',
      '不得跨品牌推荐（候选人提了 X 品牌，无岗就走拉群，不能默默推 Y 品牌）',
      '不得说"这家可能关了 / 应该是搬了 / 估计招满了"等门店运营状态推测',
      '本轮是真实无岗结论，不得调用 invite_to_group；拉群只用于连续两轮推荐均不满意后的承接',
      ...(ctx.priorNoMatchReplySent
        ? [
            '本会话已发送过一次无岗话术：本次严禁与已发送的消息逐字重复；若候选人本轮提了具体问题（点名的品牌、追问的范围等），先用一句话正面回应它，再用 candidateMessage 收口',
          ]
        : []),
    ],
  };
}

/** 连续两轮推荐均不满意：停止第三轮查询，只征询是否愿意入群；同轮不实调邀请。 */
export function buildRecommendationLimitScript(ctx: NoMatchQueryContext): NoMatchScript {
  const querySummary = buildQuerySummary(ctx);
  const city = joinWithCommaAndOr(ctx.cityLabels);
  const groupLabel = city ? `${city}兼职岗位信息群` : '兼职岗位信息群';
  return {
    querySummary,
    candidateMessage:
      `前面两轮推荐的岗位都不太合适，我先不继续重复推荐了。` +
      `可以邀请你进${groupLabel}，群里有新岗位会更新；你愿意的话回复我“可以”就行。`,
    nextAction: 'offer_group_invite',
    forbiddenActions: [
      '连续两轮推荐均不满意，本轮禁止第三次查询或继续推荐岗位',
      '不得再问“要不要看其他区域/品牌/岗位”',
      '本轮只征询入群意愿；候选人尚未同意，不得调用 invite_to_group',
      '未收到 invite_to_group success=true 前不得声称已拉群或已发邀请',
    ],
  };
}

/** 已完成群承接：岗位查询链路永久收口，只提示查看既有群。 */
export function buildPostInviteClosureScript(params: {
  groupName?: string | null;
  city?: string | null;
}): NoMatchScript {
  const groupLabel = params.groupName?.trim() || '之前邀请你的兼职岗位信息群';
  return {
    querySummary: params.city?.trim() ? `已完成${params.city.trim()}群承接` : '已完成群承接',
    candidateMessage: `之前已经邀请你进「${groupLabel}」了，后续新岗位会在群里更新，可以留意群消息。`,
    nextAction: 'group_handoff_complete',
    forbiddenActions: [
      '本会话已完成群承接，禁止继续调用 duliday_job_list 查询或推荐岗位',
      '不得再问“要不要看其他区域/品牌/岗位”',
      '不得再次调用 invite_to_group 或重复发送邀请',
    ],
  };
}

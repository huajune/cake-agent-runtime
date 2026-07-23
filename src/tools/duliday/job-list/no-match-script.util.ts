/**
 * 无岗动作链文案模板（Phase 1.C 文案模板化）。
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
  /**
   * 本会话是否已发送过一次"暂时没有岗位"类话术（由调用方从消息历史判定）。
   * true 时输出二档话术：不再逐字重复一档句式，改为"确认当前确实没有 + 已记录意向 +
   * 有岗第一时间联系"，并要求先回应候选人本轮的具体问题。
   * badcase 6a5df7e7（Aron 辱骂流失案）：两轮一字不差的无岗复读 + 不回应"除了必胜客
   * 还有其他吗"的具体提问，是候选人"说话跟人机一样"评价的直接来源。
   */
  priorNoMatchReplySent?: boolean;
}

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
  /** 工具明确建议的下一步动作（机器可读，便于 Agent 不丢动作） */
  nextToolCall: 'invite_to_group';
  /** 显式列出被禁动作，避免 prose 指令漏几条 */
  forbiddenActions: string[];
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
  return `${subject}${placeText}${distanceText}${scheduleText}`;
}

/**
 * 工具明确未查到岗位时返回的文案模板。
 *
 * 设计：把"承接候选人意向 + 婉拒 + 拉群兜底"压成一句口语化文案，
 * 用候选人本轮查询的品牌/门店/区域参数化。
 *
 * 例：
 *   brand=汉堡王, region=徐汇 → "汉堡王在徐汇这边暂时没找到合适的岗位，
 *   我先帮你进餐饮兼职群，有合适的会第一时间@你。"
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

  // 拉群兜底动作（统一一句，不让模型自由发挥）
  const action = '我先帮你进餐饮兼职群，后续有合适的我会第一时间@你';

  // 二档话术（本会话已告知过一次无岗）：不再逐字重复一档句式——候选人已经听过一遍，
  // 复读即"人机感"（badcase 6a5df7e7）。改为确认式收口 + 已记录意向 + 主动联系承诺。
  const candidateMessage = ctx.priorNoMatchReplySent
    ? `刚又帮你查了一遍，${subjectPhrase}${store ? '' : `在${placePhrase}`}现在确实还没有新的合适岗位，你的需求我记下来了，一有新岗位上来就第一时间联系你`
    : `${intro}，${action}`;

  return {
    querySummary,
    candidateMessage,
    nextToolCall: 'invite_to_group',
    forbiddenActions: [
      ...(ctx.maxKm != null
        ? [
            `本轮只查了候选人坐标附近 ${ctx.maxKm} 公里内，不得把它说成"整个城市/这个区都没有岗位"——范围外可能仍有该品牌门店`,
          ]
        : []),
      '不得反问"换品牌 / 换城市 / 别的区域看看吗"',
      '不得跨品牌推荐（候选人提了 X 品牌，无岗就走拉群，不能默默推 Y 品牌）',
      '不得说"这家可能关了 / 应该是搬了 / 估计招满了"等门店运营状态推测',
      '不得直接静默调 invite_to_group——必须先用 candidateMessage 承接候选人意向再拉群',
      ...(ctx.priorNoMatchReplySent
        ? [
            '本会话已发送过一次无岗话术：本次严禁与已发送的消息逐字重复；若候选人本轮提了具体问题（点名的品牌、追问的范围等），先用一句话正面回应它，再用 candidateMessage 收口',
          ]
        : []),
    ],
  };
}

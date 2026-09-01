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
  /**
   * 被班次硬约束剔除的在招岗位数。>0 时附近**有岗**只是排班对不上——话术必须如实说
   * "有 N 家但排班对不上"，不得说成"没找到岗位"（8 家在招被剔除后仍口播"附近没岗"，
   * 候选人换个渠道一查就穿帮）。
   */
  scheduleExcludedCount?: number | null;
  /** 身份硬门槛过滤标签（如"学生可做"），进 querySummary 观测口径 */
  identityConstraintLabel?: string | null;
}

export const NO_MATCH_NEXT_ACTIONS = ['wait_for_inventory', 'group_handoff_complete'] as const;
export type NoMatchNextAction = (typeof NO_MATCH_NEXT_ACTIONS)[number];

export interface NoMatchScript {
  /** 一句话总结候选人本轮查询的范围，用于飞书告警/log 观测，不直接给候选人 */
  querySummary: string;
  /** 直接照念给候选人的话术（承接 + 婉拒 + 下一步） */
  candidateMessage: string;
  /** 机器可读的封闭动作：真无岗等待库存；已拉群后收口。 */
  nextAction: NoMatchNextAction;
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
  const scheduleExcluded = ctx.scheduleExcludedCount ?? 0;
  const intro =
    scheduleExcluded > 0 && ctx.scheduleConstraintLabel
      ? `${subjectPhrase}${store ? '' : `在${placePhrase}`}有 ${scheduleExcluded} 家在招，` +
        `但排班要求和你「${ctx.scheduleConstraintLabel}」的时段对不上，暂时没有能直接匹配的`
      : `${subjectPhrase}${store ? '' : `在${placePhrase}`}暂时没找到合适的岗位`;

  // 真无岗只做库存等待，不用拉群替代岗位供给。
  const action = '后续有合适的新岗位上来，我会第一时间联系你';

  return {
    querySummary,
    candidateMessage: `${intro}，${action}`,
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
      ...(ctx.scheduleExcludedCount
        ? [
            '附近有在招岗位、只是排班与候选人时段不匹配：不得说成"附近没有岗位/没查到岗位"，必须按照 candidateMessage 的"有 N 家但排班对不上"口径说',
          ]
        : []),
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

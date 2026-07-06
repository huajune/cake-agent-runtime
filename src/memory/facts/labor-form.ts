/**
 * 用工形式（labor_form）工具函数与常量。
 *
 * 业务前提：平台**同时有全职和兼职岗位**，岗位 `laborForm` 字段是单值，合法取值含
 * 全职 / 兼职 / 兼职+ / 小时工 / 寒假工 / 暑假工。用工形式一律按岗位 laborForm 字段
 * 如实介绍，禁止互相改写或编造。
 *
 * 注意："正式工"/"临时工" 与 全职/兼职 不是同一概念轴（它们都属于"正式工"用工性质），
 * 不在本平台招聘范围内，作为噪音词剥离/隐藏。
 *
 * 这里是所有层（事实提取、Prompt 渲染、工具入参兜底）共享的单一事实来源，
 * 避免多处硬编码导致规则漂移。
 */

/** 平台支持的 labor_form 合法值（全职 + 兼职及其细分）。 */
export const VALID_LABOR_FORMS = ['全职', '兼职', '兼职+', '小时工', '寒假工', '暑假工'] as const;

/** 全职用工形式的标准值。 */
export const FULL_TIME_LABOR_FORM = '全职';

/** 判断一个 labor_form（规整后）是否为全职。 */
export function isFullTimeLaborForm(value: string | null | undefined): boolean {
  return sanitizeLaborFormForDisplay(value) === FULL_TIME_LABOR_FORM;
}

/** 季节性用工形式，也是岗位 `laborForm` 轴上的明确合法取值。 */
export const SEASONAL_LABOR_FORMS = ['寒假工', '暑假工'] as const;

/** 判断一个 labor_form 是否为季节性用工形式（寒假工 / 暑假工）。 */
export function isSeasonalLaborForm(value: string | null | undefined): boolean {
  if (!value) return false;
  return (SEASONAL_LABOR_FORMS as readonly string[]).includes(value);
}

/**
 * 触发 laborForm **硬过滤**的用工形式集（见 `applyLaborFormConstraint`）。
 *
 * 业务口径：岗位 `laborForm` 有明确取值，候选人指定任一合法用工形式时，都必须按岗位字段
 * 严格匹配，不能把别的用工形式包装成候选人想要的类型。
 */
export const HARD_FILTERED_LABOR_FORMS = VALID_LABOR_FORMS;

/** 判断候选人想要的用工形式是否会触发 laborForm 硬过滤。 */
export function isHardFilteredLaborForm(value: string | null | undefined): boolean {
  if (!value) return false;
  return (HARD_FILTERED_LABOR_FORMS as readonly string[]).includes(value);
}

/**
 * 判断岗位 laborForm 是否严格匹配候选人想要的细分用工形式。
 *
 * 用岗位 API 返回的 laborForm 字段做"展示规整后严格相等"比对——
 * 不做"小时工≈暑假工""兼职+≈兼职"之类的语义放宽：平台口径要求
 * **严格按岗位写的值介绍**，宁可不匹配也不把常规岗包装成季节工。
 */
export function matchesLaborForm(
  jobLaborForm: string | null | undefined,
  wanted: string | null | undefined,
): boolean {
  if (!wanted) return false;
  const normalized = sanitizeLaborFormForDisplay(jobLaborForm);
  if (!normalized) return false;
  return normalized === wanted;
}

/**
 * 噪音词：与本平台 全职/兼职 用工形式不属同一概念轴，应从展示文本/laborForm 中剥离或隐藏。
 * "正式工"/"临时工" 都属"正式工"用工性质，不在平台招聘范围；不能把它们当成 全职/兼职 复述。
 */
export const INVALID_LABOR_FORM_WORDS = ['临时工', '正式工'] as const;

/**
 * 判断一个 labor_form 值是否合法。
 * 兼容历史会话事实 —— 老数据里可能存了 "正式工"/"临时工"，读取时应被视为无效。
 */
export function isValidLaborForm(value: string | null | undefined): boolean {
  if (!value) return false;
  return (VALID_LABOR_FORMS as readonly string[]).includes(value);
}

/**
 * 把岗位 API 返回的 jobName / jobNickName / jobCategoryName 等"可展示文本"中
 * 残留的噪音用工性质词（正式工/临时工）剔除掉。
 *
 * 业务说明：平台招的是 全职/兼职 岗，"正式工/临时工" 属另一概念轴（正式工用工性质），
 * 不在招聘范围，出现在岗位名里是后台噪音，应在渲染层剥离，不让 LLM 触达。
 * 注意：全职/兼职 现在都是合法用工形式，**不再剥离**，照岗位 laborForm 如实展示。
 *
 * 实现策略：纯字符串 token 替换，配合分隔符清理。
 */
export function sanitizeJobDisplayText(value: string | null | undefined): string | null {
  if (!value) return null;
  let out = value;
  for (const token of INVALID_LABOR_FORM_WORDS) {
    out = out.split(token).join('');
  }
  // 移除因剔除产生的空括号、空连字符片段
  out = out
    .replace(/[（(]\s*[)）]/g, '')
    .replace(/[-——_/]{2,}/g, '-')
    .replace(/^[\s\-_/]+|[\s\-_/]+$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return out || null;
}

/**
 * 把岗位 API 返回的 labor_form 值规整为"可对外展示"的口径。
 *
 * 业务前提：平台同时有全职和兼职岗位，laborForm 按岗位字段如实展示。
 *
 * - 噪音用工性质词（"正式工/临时工"）→ 返回 null（不展示，与 全职/兼职 不同轴，
 *   不在招聘范围，避免 LLM 误把它们当 全职/兼职 透传给候选人）。
 * - 合法值（全职 / 兼职 / 兼职+ / 小时工 / 寒假工 / 暑假工）→ 原样返回。
 * - 其它非空值 → 原样返回（兜底，避免误删未见过的合法值）。
 */
export function sanitizeLaborFormForDisplay(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if ((INVALID_LABOR_FORM_WORDS as readonly string[]).includes(trimmed)) return null;
  return trimmed;
}

/**
 * 从 jobCategoryList 等查询参数中剔除"用工形式"词。
 *
 * 这些词不是岗位工种，不应作为 category 查询条件；
 * 即使模型违反约束填入，这里也要兜底剥离。
 */
export function stripLaborFormFromCategories(categories: readonly string[]): {
  cleaned: string[];
  removed: string[];
} {
  const banned = new Set<string>([...INVALID_LABOR_FORM_WORDS, ...VALID_LABOR_FORMS]);
  const cleaned: string[] = [];
  const removed: string[] = [];

  for (const raw of categories) {
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    if (!trimmed) continue;
    if (banned.has(trimmed)) {
      removed.push(trimmed);
    } else {
      cleaned.push(trimmed);
    }
  }

  return { cleaned, removed };
}

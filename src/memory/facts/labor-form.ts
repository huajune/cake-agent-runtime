/**
 * 用工形式（labor_form）工具函数与常量。
 *
 * 业务前提：平台所有岗位都是兼职岗位。"兼职"/"全职" 不是筛选维度，
 * 真正有区分度的是 4 个细分类型：兼职+ / 小时工 / 寒假工 / 暑假工。
 *
 * 这里是所有层（事实提取、Prompt 渲染、工具入参兜底）共享的单一事实来源，
 * 避免多处硬编码导致规则漂移。
 */

/** 平台支持的 labor_form 合法值。 */
export const VALID_LABOR_FORMS = ['兼职+', '小时工', '寒假工', '暑假工'] as const;

/** 不应作为 labor_form 或 jobCategoryList 出现的用工形式词（平台属性词 + 反向词）。 */
export const INVALID_LABOR_FORM_WORDS = ['兼职', '全职', '临时工', '正式工'] as const;

/**
 * 判断一个 labor_form 值是否合法。
 * 兼容历史会话事实 —— 老数据里可能存了 "兼职"/"全职"，读取时应被视为无效。
 */
export function isValidLaborForm(value: string | null | undefined): boolean {
  if (!value) return false;
  return (VALID_LABOR_FORMS as readonly string[]).includes(value);
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

/**
 * Test Suite 共享工具函数
 */

/**
 * LLM 评估分数样式类名
 */
export type ScoreStyleClass =
  | 'scoreExcellent'
  | 'scoreGood'
  | 'scoreFair'
  | 'scorePoor'
  | 'scoreDefault';

/**
 * LLM 评估评级文本
 */
export type ScoreRating = '优秀' | '良好' | '一般' | '较差' | '--';

/**
 * 获取评分样式类名
 * @param score 评估分数 (0-100)
 * @returns 样式类名
 */
export function getScoreStyleClass(score: number | null): ScoreStyleClass {
  if (score === null) return 'scoreDefault';
  if (score >= 80) return 'scoreExcellent';
  if (score >= 60) return 'scoreGood';
  if (score >= 40) return 'scoreFair';
  return 'scorePoor';
}

/**
 * 获取评分评级文本
 * @param score 评估分数 (0-100)
 * @returns 评级文本
 */
export function getScoreRating(score: number | null): ScoreRating {
  if (score === null) return '--';
  if (score >= 80) return '优秀';
  if (score >= 60) return '良好';
  if (score >= 40) return '一般';
  return '较差';
}

/**
 * 获取评分评级带范围文本
 * @param score 评估分数 (0-100)
 * @returns 评级文本（含范围）
 */
export function getScoreRatingWithRange(score: number | null): string {
  if (score === null) return '--';
  if (score >= 80) return '优秀 (80-100)';
  if (score >= 60) return '良好 (60-79)';
  if (score >= 40) return '一般 (40-59)';
  return '较差 (0-39)';
}

/**
 * 格式化耗时显示
 * @param durationMs 耗时（毫秒）
 * @returns 格式化字符串
 */
export function formatDuration(durationMs: number | null): string {
  if (durationMs === null) return '--';
  return `${(durationMs / 1000).toFixed(1)}s`;
}

/**
 * 格式化评分显示
 * @param value 评分值 (0-100)
 * @param defaultValue 默认显示
 * @returns 格式化字符串
 */
export function formatScore(value: number | null, defaultValue = '--'): string {
  if (value === null) return defaultValue;
  return `${value}分`;
}

const CATEGORY_COLOR_CLASSES = [
  'category1',
  'category2',
  'category3',
  'category4',
  'category5',
  'category6',
  'category7',
  'category8',
  'category9',
  'category10',
  'category11',
] as const;

export type CategoryStyleClass =
  | (typeof CATEGORY_COLOR_CLASSES)[number]
  | 'categoryRegion'
  | 'categoryAddressJob'
  | 'categoryAppointment'
  | 'categoryJobHard'
  | 'categoryJobIssue'
  | 'categoryOther'
  | 'categoryTrust'
  | 'categoryMessageFlow'
  | 'categoryDefault';

function hashCategory(category: string): number {
  return Array.from(category).reduce((sum, char) => sum + char.charCodeAt(0), 0);
}

/**
 * 获取分类标签颜色样式类名
 */
export function getCategoryStyleClass(category: string | null | undefined): CategoryStyleClass {
  if (!category) return 'categoryDefault';

  const normalized = category.trim();
  const match = normalized.match(/^(\d+)-/);
  if (match) {
    const num = parseInt(match[1], 10);
    return CATEGORY_COLOR_CLASSES[(num - 1) % CATEGORY_COLOR_CLASSES.length] || 'categoryDefault';
  }

  if (normalized.includes('地区识别') || normalized.includes('地域识别')) return 'categoryRegion';
  if (normalized.includes('地址识别')) return 'categoryAddressJob';
  if (normalized.includes('预约') || normalized.includes('报名')) return 'categoryAppointment';
  if (normalized.includes('岗位推荐硬约束') || normalized.includes('硬约束'))
    return 'categoryJobHard';
  if (normalized.includes('岗位推荐')) return 'categoryJobIssue';
  if (normalized.includes('信任') || normalized.includes('话术')) return 'categoryTrust';
  if (normalized.includes('消息处理') || normalized.includes('群')) return 'categoryMessageFlow';
  if (normalized.includes('其他')) return 'categoryOther';

  return CATEGORY_COLOR_CLASSES[hashCategory(normalized) % CATEGORY_COLOR_CLASSES.length];
}

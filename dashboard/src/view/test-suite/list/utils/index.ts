/**
 * Test Suite 共享工具函数
 */

/**
 * 相似度分数样式类名
 */
export type ScoreStyleClass = 'scoreExcellent' | 'scoreGood' | 'scoreFair' | 'scorePoor' | 'scoreDefault';

/**
 * 相似度评级文本
 */
export type ScoreRating = '优秀' | '良好' | '一般' | '较差' | '--';

/**
 * 获取相似度分数样式类名
 * @param score 相似度分数 (0-100)
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
 * 获取相似度评级文本
 * @param score 相似度分数 (0-100)
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
 * 获取相似度评级带范围文本
 * @param score 相似度分数 (0-100)
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
 * 格式化百分比显示
 * @param value 百分比值
 * @param defaultValue 默认显示
 * @returns 格式化字符串
 */
export function formatPercent(value: number | null, defaultValue = '--'): string {
  if (value === null) return defaultValue;
  return `${value}%`;
}

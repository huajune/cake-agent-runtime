/**
 * 评审相关的标签格式化工具
 *
 * 抽取自 ConversationDetailModal 与 ExecutionDetailViewer 的重复 helper，
 * 两处原本是 copy-paste 关系，任何措辞调整都得改两遍。抽到 util 保证单点维护。
 */

/**
 * 评审者来源（与后端 test_executions.reviewer_source 枚举对齐）。
 *
 * 两个调用点分别用的是 snake_case (`reviewer_source`) 与 camelCase (`reviewerSource`)
 * 字段，值域一致，这里用统一的宽类型接收。
 */
export type ReviewerSource = 'manual' | 'codex' | 'claude' | 'system' | 'api';

/**
 * 评审状态（与后端 test_executions.review_status 枚举对齐）。
 */
export type ReviewStatus = 'pending' | 'passed' | 'failed' | 'skipped';

/**
 * 从 reviewer 字符串里识别出展示用的短标签。
 *
 * `dashboard-user` → 人工；带 `codex`/`claude` 关键字 → 对应 AI 标签；其余原样返回。
 */
export function formatReviewerLabel(reviewer?: string | null): string | null {
  if (!reviewer) return null;
  if (reviewer === 'dashboard-user') return '人工';
  const lower = reviewer.toLowerCase();
  if (lower.includes('codex')) return 'Codex';
  if (lower.includes('claude')) return 'Claude';
  return reviewer;
}

/**
 * 按 reviewerSource 枚举值解析中文标签；未识别时回退到 formatReviewerLabel。
 */
export function resolveReviewerSourceLabel(
  reviewerSource?: ReviewerSource | null,
  reviewer?: string | null,
): string | null {
  switch (reviewerSource) {
    case 'manual':
      return '人工';
    case 'codex':
      return 'Codex';
    case 'claude':
      return 'Claude';
    case 'system':
      return '系统';
    case 'api':
      return 'API';
    default:
      return formatReviewerLabel(reviewer);
  }
}

/**
 * 把评审状态 + 评审者标签拼成展示文案（如"Claude评审通过"、"人工评审失败"）。
 *
 * `reviewStatus` 类型用 `string` 兼容 —— 两个调用点一个用严格枚举，另一个来自
 * 更宽松的 snapshot 字段；实际判定仍按已知枚举走，未知值兜底为"待评审"。
 */
export function formatReviewStatusLabel(
  reviewStatus?: string | null,
  reviewerLabel?: string | null,
): string {
  if (!reviewStatus || reviewStatus === 'pending') {
    return '待评审';
  }

  const prefix = reviewerLabel ? `${reviewerLabel}评审` : '评审';
  if (reviewStatus === 'passed') return `${prefix}通过`;
  if (reviewStatus === 'failed') return `${prefix}失败`;
  if (reviewStatus === 'skipped') return `${prefix}跳过`;

  return '待评审';
}

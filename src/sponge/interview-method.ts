/**
 * 海绵岗位「面试方式」（`interviewProcess.firstInterview.firstInterviewWay`）。
 *
 * 后台表单是必填单选，只有四个值；生产近 7 天 precheck 返回值也只出现这四个，
 * 空值全部来自岗位失效/接口失败。全仓只在这里认值，是否需要到店只有一个判据。
 */

export const INTERVIEW_METHODS = ['AI面试', '电话面试', '视频面试', '线下面试'] as const;

export type InterviewMethod = (typeof INTERVIEW_METHODS)[number];

const INTERVIEW_METHOD_SET: ReadonlySet<string> = new Set(INTERVIEW_METHODS);

/**
 * 把接口原值归一成枚举；非法/缺失返回 null。
 *
 * 只容忍空白与 `ai` 大小写差异（工具结果里曾出现 "AI 面试" 写法），不做任何同义词映射。
 */
export function parseInterviewMethod(value: unknown): InterviewMethod | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\s+/gu, '').replace(/^ai面试$/iu, 'AI面试');
  return INTERVIEW_METHOD_SET.has(normalized) ? (normalized as InterviewMethod) : null;
}

/** 只有线下面试需要候选人到店；未知方式不得按到店处理。 */
export function requiresStoreVisit(method: InterviewMethod | null | undefined): boolean {
  return method === '线下面试';
}

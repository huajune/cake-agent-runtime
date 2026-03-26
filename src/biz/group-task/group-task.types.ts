/**
 * 群任务定时通知 — 类型定义
 */

/** 群任务类型 */
export enum GroupTaskType {
  /** 抢单群通知 */
  ORDER_GRAB = 'order_grab',
  /** 兼职群通知 */
  PART_TIME_JOB = 'part_time',
  /** 店长群通知 */
  STORE_MANAGER = 'store_manager',
  /** 工作小贴士 */
  WORK_TIPS = 'work_tips',
}

/** 群任务类型中文名映射 */
export const GROUP_TASK_TYPE_NAMES: Record<GroupTaskType, string> = {
  [GroupTaskType.ORDER_GRAB]: '抢单群',
  [GroupTaskType.PART_TIME_JOB]: '兼职群',
  [GroupTaskType.STORE_MANAGER]: '店长群',
  [GroupTaskType.WORK_TIPS]: '工作小贴士',
};

/** 解析后的群标签 */
export interface ParsedGroupTag {
  /** 群类型：抢单群 | 兼职群 | 店长群 */
  type: string;
  /** 城市 */
  city: string;
  /** 行业（仅兼职群有）：餐饮 | 零售 */
  industry?: string;
}

/** 群上下文（编排流程中传递） */
export interface GroupContext {
  /** 群 wxid（小组级 API 的群 ID） */
  imRoomId: string;
  /** 群名称 */
  groupName: string;
  /** 解析后的城市 */
  city: string;
  /** 解析后的行业（仅兼职群） */
  industry?: string;
  /** 群类型标签（如 '抢单群'） */
  tag: string;
  /** 托管账号 wxid（发消息用） */
  imBotId: string;
  /** 小组级 token（发消息用） */
  token: string;
  /** 对话 ID（小组级发消息用） */
  chatId?: string;
}

/** 策略 fetchData 返回的数据 */
export interface NotificationData {
  /** 是否有数据可推送 */
  hasData: boolean;
  /** 数据载荷（策略特有） */
  payload: Record<string, unknown>;
  /** 日志摘要 */
  summary: string;
}

/** AI 提示词输入 */
export interface PromptInput {
  systemPrompt: string;
  userMessage: string;
}

/** 分组执行详情 */
export interface GroupExecutionDetail {
  /** 分组 key（如 "上海_餐饮"） */
  groupKey: string;
  /** 该分组的群数量 */
  groupCount: number;
  /** 数据摘要（如 "塔可贝尔: 2个岗位"） */
  dataSummary: string;
  /** 执行状态 */
  status: 'success' | 'skipped' | 'failed';
  /** 群名列表 */
  groupNames: string[];
}

/** 单次任务执行结果 */
export interface TaskExecutionResult {
  type: GroupTaskType;
  totalGroups: number;
  successCount: number;
  failedCount: number;
  skippedCount: number;
  errors: Array<{ groupName: string; error: string }>;
  /** 分组执行详情 */
  details: GroupExecutionDetail[];
  startTime: Date;
  endTime: Date;
}

/** 观远BI 订单查询参数 */
export interface BIOrderQueryParams {
  startDate?: string;
  endDate?: string;
  regionName?: string;
  companyName?: string;
  orderStatus?: string;
  /** 排序字段 */
  sortBy?: string;
  /** 排序方向 */
  sortOrder?: 'ASC' | 'DESC';
  /** 是否在请求前刷新数据源（默认 false） */
  refreshBeforeQuery?: boolean;
}

/** 观远BI 订单（行式对象） */
export type BIOrder = Record<string, unknown>;

/** 观远BI 字段名常量 */
export const BI_FIELD_NAMES = {
  COMPANY_NAME: '所属企业',
  CITY: '城市',
  ORDER_DATE: '订单归属日期',
  ORDER_STATUS: '订单状态',
  STORE_NAME: '订单所属门店',
  STORE_ADDRESS: '门店地址',
  BIG_REGION: '大区归属',
  ORDER_REGION: '订单所属地区',
  SERVICE_DATE: '订单计划时间',
  SERVICE_CONTENT: '服务内容',
  EXPECTED_REVENUE: '预计收入',
  SHARE_LINK: '分享链接',
  SHARE_TEXT: '分享文案',
} as const;

/** 观远BI 过滤类型 */
export const BI_FILTER_TYPES = {
  GREATER_EQUAL: 'GE',
  LESS_EQUAL: 'LE',
  EQUAL: 'EQ',
  CONTAINS: 'CONTAINS',
} as const;

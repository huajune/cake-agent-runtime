import { GroupContext, GroupTaskType, TimeSlot } from '../group-task.types';

/**
 * 群任务 Bull 队列
 *
 * 三类 Job 解耦发送流程，让单群失败可独立重试、进程重启不丢消息：
 *   Plan     → 从 cron/手动触发入口产生，负责分组 + 排程
 *   Prepare  → 每 (city+industry) 一个，拉数据 + 生成消息 + 缓存 + 派发 Send
 *   Send     → 每群一个，幂等发送 + 品牌轮转 + 写结果
 *   Summarize→ 整体完成后汇总上报飞书
 */
export const GROUP_TASK_QUEUE_NAME = 'group-task';

export enum GroupTaskJobName {
  PLAN = 'plan',
  PREPARE = 'prepare',
  SEND = 'send',
  SUMMARIZE = 'summarize',
}

/** 消息缓存 / 结果缓存 TTL：48 小时，覆盖日内补发窗口 */
export const GROUP_TASK_CACHE_TTL_SECONDS = 48 * 60 * 60;

/** 同群当日幂等守护 TTL：48 小时，跨次重试仍生效 */
export const GROUP_TASK_IDEMPOTENCY_TTL_SECONDS = 48 * 60 * 60;

/** Redis key helpers（实际落盘会被 RedisService 再套一层环境前缀） */
export const groupTaskMsgKey = (execId: string, groupKey: string): string =>
  `group-task:msg:${execId}:${groupKey}`;

export const groupTaskResultKey = (execId: string, groupId: string): string =>
  `group-task:result:${execId}:${groupId}`;

export const groupTaskMetaKey = (execId: string): string => `group-task:meta:${execId}`;

/**
 * 同群当日幂等键，避免同一群在同一天同场次被重复发送。
 * - 跨 exec 有效：手动补发不会对已成功群二次发送。
 * - 仅在发送成功后设置，失败的群下次仍可重试。
 */
export const groupTaskDailySentKey = (
  type: GroupTaskType,
  date: string,
  timeSlot: TimeSlot | undefined,
  groupId: string,
): string => `group-task:sent:${type}:${date}${timeSlot ? `-${timeSlot}` : ''}:${groupId}`;

// ==================== Job Payloads ====================

export interface PlanJobData {
  execId: string;
  type: GroupTaskType;
  timeSlot?: TimeSlot;
  /** 由 Scheduler 在入队时决定并冻结，避免中途改配置影响当前 exec */
  dryRun: boolean;
  /** 由 Scheduler 在入队时决定并冻结，供 Prepare 计算每个 Send 的 delay */
  sendDelayMs: number;
  /** plan 产生时间（毫秒） */
  startedAt: number;
  /** 仅 cron 触发时为 'cron'；否则 'manual' */
  trigger: 'cron' | 'manual';
}

/** 发送任务所需的群上下文（含全局顺序 index，供 Bull delay 错峰） */
export interface SendTarget {
  group: GroupContext;
  /** 该 exec 内所有群的全局顺序，用于 Bull delay 错峰 */
  globalIndex: number;
}

export interface PrepareJobData {
  execId: string;
  type: GroupTaskType;
  timeSlot?: TimeSlot;
  dryRun: boolean;
  /** 分组 key，例：'上海_餐饮' | '武汉' */
  groupKey: string;
  /** 同 groupKey 下的目标群列表（共享消息，分别发送） */
  targets: SendTarget[];
  /** 整次 exec 的群总数 */
  totalGroups: number;
  /** 单群间的基准间隔（毫秒），用于计算 Bull delay；来自 GROUP_TASK_SEND_DELAY_MS */
  sendDelayMs: number;
  /** 日内幂等键的日期段（YYYYMMDD，Asia/Shanghai，源自 plan.startedAt） */
  execDate: string;
  /** 触发源：'manual' 时 send 阶段将绕过日内幂等，允许人工补发覆盖 */
  trigger: 'cron' | 'manual';
}

export interface SendJobData {
  execId: string;
  type: GroupTaskType;
  timeSlot?: TimeSlot;
  dryRun: boolean;
  group: GroupContext;
  /** 该群所属的分组 key，用于定位消息缓存 */
  groupKey: string;
  /** 消息缓存的 Redis key */
  msgRedisKey: string;
  /** 日内幂等 key 里的日期段（YYYYMMDD，Asia/Shanghai） */
  execDate: string;
  /** 整次 exec 的群总数 */
  totalGroups: number;
  /** 触发源：'manual' 时跳过幂等检查（人工补发），'cron' 时遵守日内幂等 */
  trigger: 'cron' | 'manual';
}

export interface SummarizeJobData {
  execId: string;
  type: GroupTaskType;
  timeSlot?: TimeSlot;
  dryRun: boolean;
  totalGroups: number;
  startedAt: number;
  /** 所有参与本次 exec 的群 ID（summarize 按此回收各群结果） */
  groupIds: string[];
}

/** Prepare / Send 写入 Redis 的单群结果 */
export interface GroupTaskResultSnapshot {
  groupKey: string;
  groupName: string;
  status: 'sent' | 'failed' | 'skipped';
  summary: string;
  error?: string;
  updatedAt: number;
}

/** Plan 写入 Redis 的整次 exec 元信息（summarize 读取） */
export interface GroupTaskMetaSnapshot {
  execId: string;
  type: GroupTaskType;
  timeSlot?: TimeSlot;
  dryRun: boolean;
  totalGroups: number;
  groupIds: string[];
  startedAt: number;
  trigger: 'cron' | 'manual';
}

/** 缓存在 Redis 的消息体（Prepare 写 → Send 读） */
export interface GroupTaskMessageCache {
  message: string;
  followUpMessage?: string;
  brand?: string;
  summary: string;
}

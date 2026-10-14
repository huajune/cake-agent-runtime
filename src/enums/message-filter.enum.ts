/**
 * 消息过滤原因枚举
 * 用于标识消息被过滤的具体原因
 */
export enum FilterReason {
  /** 机器人自己发送的消息 */
  SELF_MESSAGE = 'self-message',
  /** 非手机推送来源（非真实用户发送） */
  INVALID_SOURCE = 'invalid-source',
  /** 非个微用户（企微、公众号等） */
  NON_PERSONAL_WECHAT = 'non-personal-wechat',
  /** 用户已暂停托管 */
  USER_PAUSED = 'user-paused',
  /** 小组在黑名单中（仅记录历史） */
  GROUP_BLACKLISTED = 'group-blacklisted',
  /** 候选人在黑名单中（告警并永久取消该会话托管，仅记录历史） */
  CANDIDATE_BLACKLISTED = 'candidate-blacklisted',
  /** 群聊消息（暂不处理） */
  ROOM_MESSAGE = 'room-message',
  /** 不支持的消息类型 */
  UNSUPPORTED_MESSAGE_TYPE = 'unsupported-message-type',
  /** 消息内容为空 */
  EMPTY_CONTENT = 'empty-content',
}

/**
 * 候选人消息「只存历史、交给真人处理」的过滤原因（落 chat_messages.history_only_reason）。
 * 这些消息按设计不进 Agent、没有 message_processing_records，不能当作主链静默丢消息。
 */
export const HISTORY_ONLY_REASONS = [
  FilterReason.USER_PAUSED,
  FilterReason.CANDIDATE_BLACKLISTED,
  FilterReason.GROUP_BLACKLISTED,
] as const;

export type HistoryOnlyReason = (typeof HISTORY_ONLY_REASONS)[number];

export function isHistoryOnlyReason(value: unknown): value is HistoryOnlyReason {
  return (HISTORY_ONLY_REASONS as readonly unknown[]).includes(value);
}

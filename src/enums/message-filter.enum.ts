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
  /** 企业级特定分组被屏蔽 */
  BLOCKED_ENTERPRISE_GROUP = 'blocked-enterprise-group',
  /** 群聊消息（暂不处理） */
  ROOM_MESSAGE = 'room-message',
  /** 不支持的消息类型 */
  UNSUPPORTED_MESSAGE_TYPE = 'unsupported-message-type',
  /** 消息内容为空 */
  EMPTY_CONTENT = 'empty-content',
}

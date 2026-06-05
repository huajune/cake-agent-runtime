/**
 * 「新增客户回调—RPA」报文。
 *
 * 平台在**真实加好友**时回调（不依赖 SOP / 不经消息过滤），是 friend.added 的独立信号源——
 * 含从不发消息的「沉默僵尸好友」。接入后破冰率 = candidate.engaged / friend.added 才有区分度。
 *
 * 注意：
 * - 文档示例「没有外层 data」，但实际可能带 `{ data: {...} }`，handler 两者都兼容。
 * - `imContactId`（客户系统id）与消息回调同名同源 → 与 candidate.engaged 的 user_id 可 cohort join。
 * - `createTimestamp` 为毫秒时间戳，作为 friend.added 的真实业务时间。
 * - 报文不含 orgId/corpId（以 API 文档为准），故 friend.added 统一记到 corp_id='default'。
 * 文档：接口文档/企业级接口/客户接口/客户信息管理 · 新增客户回调—RPA
 */
export interface NewCustomerCallbackPayload {
  /** 客户系统 id（= 消息回调的 imContactId，cohort join 主键）。 */
  imContactId?: string;
  /** 客户昵称。 */
  name?: string;
  /** 客户头像。 */
  avatar?: string;
  /** 性别：0 未知 / 1 男 / 2 女。 */
  gender?: number;
  /** 添加时间（毫秒时间戳）。 */
  createTimestamp?: number;
  /** 用户手机号（仅特定情形返回）。 */
  remarkMobiles?: string[];
  imInfo?: {
    /** im 联系人 id。 */
    externalUserId?: string;
    followUser?: {
      /** im 员工 id。 */
      wecomUserId?: string;
    };
  };
  botInfo?: {
    /** 账号 id。 */
    botId?: string;
    /** 托管账号对应成员的系统 wxid（= 我们的 bot_im_id）。 */
    imBotId?: string;
    /** 托管账号名称。 */
    name?: string;
    /** 托管账号头像。 */
    avatar?: string;
  };
}

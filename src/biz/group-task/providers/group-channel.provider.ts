/**
 * 群任务域对企微渠道能力的域内抽象（依赖倒置，模式同 ops-events 的 BOT_ACCOUNT_PROVIDER）。
 *
 * `biz/` 禁止依赖 `channels/wecom/`，故群任务域在此定义接口与注入令牌；
 * 由 `wecom/` 侧的 RoomService / MessageSenderService 实现并在各自 @Global 模块里
 * 绑定令牌（`{ provide: TOKEN, useExisting: Service }`）。群解析 / 群成员 / 群发
 * 通知只依赖本接口，不再 import 任何 wecom 具体实现。
 */

/* eslint-disable @typescript-eslint/no-explicit-any --
 * 托管平台群列表/发送接口的响应无上游类型（RoomService/MessageSenderService 即返回 any），
 * 消费方均做防御式解析；此处如实声明边界，不伪造精确类型。 */

export const GROUP_ROOM_QUERY = Symbol('GROUP_ROOM_QUERY');

/** 群任务域用到的群查询能力子集（wecom RoomService 的兼容超集）。 */
export interface GroupRoomQuery {
  getRoomSimpleList(token: string, current: number, pageSize: number, wxid?: string): Promise<any>;
  getEnterpriseGroupChatList(
    token: string,
    current?: number,
    pageSize?: number,
    imBotId?: string,
    wecomUserId?: string,
  ): Promise<any>;
}

export const GROUP_MESSAGE_SENDER = Symbol('GROUP_MESSAGE_SENDER');

/** 群任务域用到的消息发送能力子集（wecom MessageSenderService 的兼容超集）。 */
export interface GroupMessageSender {
  sendMessage(data: Record<string, unknown>): Promise<any>;
}

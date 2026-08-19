// 同源：src/channels/wecom/bot/bot.service.ts —— 改动必须同步。
export interface BotAccount {
  id?: string;
  wxid?: string;
  weixin?: string;
  wecomUserId?: string;
  name?: string;
  nickName?: string;
  avatar?: string;
  online?: boolean;
  status?: number;
  corpName?: string;
  corpId?: string;
  aiStatus?: number;
  aiBotId?: string;
  groupId?: string;
  groupName?: string;
  groupAiBotId?: string;
}

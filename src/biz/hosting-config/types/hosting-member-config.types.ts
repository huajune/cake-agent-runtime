/**
 * 托管成员（经理/账号）统一配置。
 *
 * 把原先分散三处、各按 botImId 手维护的「挂在人身上」的配置收口到一份（system_config）：
 * - 飞书接收人 openId（原 src/infra/feishu/constants/receivers.ts 硬编码）
 * - 海绵 Duliday token（原 sponge_token_config）
 *
 * 以 botImId（wecom 系统分配的稳定数字 id，与硬编码 BOT_TO_RECEIVER 同 key）为 key，
 * 而非可改名的 wecomUserId。未来 web 配置页读写此 key。
 */
export const HOSTING_MEMBER_CONFIG_KEY = 'hosting_member_config';

export interface HostingMemberEntry {
  /** 飞书 @ 的 open_id */
  feishuOpenId?: string;
  /** 飞书显示名 */
  feishuName?: string;
  /** 海绵 Duliday token（明文；system_config 为 service-role RLS，访问受控） */
  dulidayToken?: string;
  /**
   * 企微账号对外昵称（候选人聊天界面看到的名字，如"东升"）。
   * 注入 Agent system prompt 身份段，让模型确知自己叫什么——防止被候选人追问
   * 姓名时现编（badcase chat 6a5dedb2ce406a6aeee1ea62 自称"李娜"）。
   */
  wecomNickname?: string;
  /** 账号人设性别（"男"/"女"）；同上注入身份段，防止性别答反。 */
  gender?: string;
}

export interface HostingMemberConfig {
  /** key = botImId（托管账号 wxid 数字 id，如 '1688855171908166'） */
  members?: Record<string, HostingMemberEntry>;
}

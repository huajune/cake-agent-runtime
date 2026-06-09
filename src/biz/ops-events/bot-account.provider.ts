/**
 * 托管 bot 账号列表的域内抽象（依赖倒置）。
 *
 * `biz/` 禁止依赖 `channels/wecom/`，故运营事件域在此定义接口与注入令牌；
 * 由 `wecom/` 侧的 `BotService` 实现，并在 `BotModule` 把该令牌绑定到 `BotService`
 * （`{ provide: BOT_ACCOUNT_PROVIDER, useExisting: BotService }`）。
 * 这样运营日报 / 分组解析只依赖本接口，不再 import 任何 wecom 具体实现。
 */
export const BOT_ACCOUNT_PROVIDER = Symbol('BOT_ACCOUNT_PROVIDER');

/** 运营日报 / 分组解析用到的托管账号字段子集（BotService.BotAccount 的超集兼容）。 */
export interface BotAccountInfo {
  wxid?: string;
  wecomUserId?: string;
  name?: string;
  groupName?: string;
}

export interface BotAccountProvider {
  getConfiguredBotList(): Promise<BotAccountInfo[]>;
}

/**
 * 海绵 Duliday token 解析上下文。
 *
 * token 配置已统一收口到 system_config.hosting_member_config（按 botImId 数字 wxid 索引），
 * 旧的 sponge_token_config 表已废弃。此处仅保留解析入参的上下文形状。
 */
export interface SpongeTokenResolveContext {
  botImId?: string | null;
  botUserId?: string | null;
  groupId?: string | null;
}

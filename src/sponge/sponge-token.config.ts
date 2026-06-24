/**
 * 海绵 Duliday token 解析上下文。
 *
 * token 配置已统一收口到 system_config.hosting_member_config（按 botImId 数字 wxid 索引），
 * 旧的 sponge_token_config 表已废弃。此处仅保留解析入参的上下文形状。
 */
/**
 * 注意：token 解析现在**只消费 botImId**（数字 wxid，从 hosting_member_config 解析）。
 * botUserId / groupId 仍保留在上下文里以兼容各调用方共用的 ToolBuildContext，但不再参与
 * token 路由——历史上它们用于旧表 sponge_token_config 的多键查找，该表已废弃。
 */
export interface SpongeTokenResolveContext {
  botImId?: string | null;
  botUserId?: string | null;
  groupId?: string | null;
}

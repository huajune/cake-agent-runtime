import type { SpongeTokenResolveContext } from '@sponge/sponge-token.config';
import type { ToolBuildContext } from '@shared-types/tool.types';

export function buildSpongeTokenContext(
  context: ToolBuildContext,
): SpongeTokenResolveContext | undefined {
  // token 唯一按 botImId（数字 wxid）解析；botUserId/groupId 已不参与 token 路由。
  return context.botImId ? { botImId: context.botImId } : undefined;
}

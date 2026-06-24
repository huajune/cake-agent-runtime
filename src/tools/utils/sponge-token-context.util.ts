import type { SpongeTokenResolveContext } from '@sponge/sponge-token.config';
import type { ToolBuildContext } from '@shared-types/tool.types';

export function buildSpongeTokenContext(
  context: ToolBuildContext,
): SpongeTokenResolveContext | undefined {
  // token 解析只消费 botImId；botUserId/groupId 仅随上下文透传，不参与 token 路由（见类型注释）。
  const tokenContext: SpongeTokenResolveContext = {
    botImId: context.botImId,
    botUserId: context.botUserId,
    groupId: context.groupId,
  };

  return tokenContext.botImId || tokenContext.botUserId || tokenContext.groupId
    ? tokenContext
    : undefined;
}

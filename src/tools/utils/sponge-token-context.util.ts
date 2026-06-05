import type { SpongeTokenResolveContext } from '@sponge/sponge-token.config';
import type { ToolBuildContext } from '@shared-types/tool.types';

export function buildSpongeTokenContext(
  context: ToolBuildContext,
): SpongeTokenResolveContext | undefined {
  const tokenContext: SpongeTokenResolveContext = {
    botImId: context.botImId,
    botUserId: context.botUserId,
    groupId: context.groupId,
  };

  return tokenContext.botImId || tokenContext.botUserId || tokenContext.groupId
    ? tokenContext
    : undefined;
}

import { buildSpongeTokenContext } from '@tools/utils/sponge-token-context.util';
import type { ToolBuildContext } from '@shared-types/tool.types';

describe('buildSpongeTokenContext', () => {
  it('returns the token routing identifiers from tool context', () => {
    expect(
      buildSpongeTokenContext({
        botImId: 'bot-im-1',
        botUserId: 'LiYuHang',
        groupId: 'group-1',
      } as ToolBuildContext),
    ).toEqual({
      botImId: 'bot-im-1',
      botUserId: 'LiYuHang',
      groupId: 'group-1',
    });
  });

  it('returns undefined when no token routing identifier is present', () => {
    expect(buildSpongeTokenContext({ userId: 'user-1' } as ToolBuildContext)).toBeUndefined();
  });
});

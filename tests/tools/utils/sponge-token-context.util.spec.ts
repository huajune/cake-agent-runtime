import { buildSpongeTokenContext } from '@tools/utils/sponge-token-context.util';
import type { ToolBuildContext } from '@shared-types/tool.types';

describe('buildSpongeTokenContext', () => {
  it('returns only the botImId token routing identifier from tool context', () => {
    expect(
      buildSpongeTokenContext({
        botImId: 'bot-im-1',
        botUserId: 'LiYuHang',
        groupId: 'group-1',
      } as ToolBuildContext),
    ).toEqual({ botImId: 'bot-im-1' });
  });

  it('returns undefined when botImId is absent', () => {
    expect(
      buildSpongeTokenContext({ botUserId: 'LiYuHang', groupId: 'group-1' } as ToolBuildContext),
    ).toBeUndefined();
    expect(buildSpongeTokenContext({ userId: 'user-1' } as ToolBuildContext)).toBeUndefined();
  });
});

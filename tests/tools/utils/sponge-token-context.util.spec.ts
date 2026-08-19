import { buildSpongeTokenContext } from '@tools/utils/sponge-token-context.util';
import type { ToolBuildContext } from '@shared-types/tool.types';
import { createToolContext } from '../../helpers/tool-context.fixture';

describe('buildSpongeTokenContext', () => {
  it('returns the token routing identifiers from tool context', () => {
    expect(
      buildSpongeTokenContext(
        createToolContext({
          session: { botImId: 'bot-im-1', botUserId: 'LiYuHang', groupId: 'group-1' },
        }),
      ),
    ).toEqual({
      botImId: 'bot-im-1',
      botUserId: 'LiYuHang',
      groupId: 'group-1',
    });
  });

  it('returns undefined when no token routing identifier is present', () => {
    expect(
      buildSpongeTokenContext(createToolContext({ session: { userId: 'user-1' } })),
    ).toBeUndefined();
  });
});

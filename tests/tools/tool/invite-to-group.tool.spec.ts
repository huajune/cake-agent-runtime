import { buildInviteToGroupTool } from '@tools/invite-to-group.tool';
import { ToolBuildContext } from '@shared-types/tool.types';
import { GroupContext } from '@biz/group-task/group-task.types';

describe('buildInviteToGroupTool', () => {
  const mockContext: ToolBuildContext = {
    userId: 'user-1',
    corpId: 'corp-1',
    sessionId: 'sess-1',
    messages: [],
    botUserId: 'chat-bot-weixin',
    botImId: 'chat-bot-im-id',
  };

  const makeGroup = (overrides: Partial<GroupContext> = {}): GroupContext => ({
    imRoomId: 'room-1',
    groupName: '上海兼职群1号',
    city: '上海',
    tag: '兼职群',
    imBotId: 'bot-1',
    token: 'token-1',
    memberCount: 50,
    ...overrides,
  });

  const mockGroupResolver = { resolveGroups: jest.fn() };
  const mockRoomService = { addMember: jest.fn(), addMemberEnterprise: jest.fn() };
  const mockRedisService = { exists: jest.fn(), setex: jest.fn() };
  const mockAlertService = { sendAlert: jest.fn() };
  const mockMemoryService = { saveInvitedGroup: jest.fn() };
  const MEMBER_LIMIT = 200;

  beforeEach(() => jest.clearAllMocks());

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const executeTool = async (input: { city: string; industry?: string }) => {
    const builder = buildInviteToGroupTool(
      mockGroupResolver as any,
      mockRoomService as any,
      mockRedisService as any,
      mockAlertService as any,
      mockMemoryService as any,
      MEMBER_LIMIT,
      'enterprise-token-test',
    );
    const builtTool = builder(mockContext);
    return builtTool.execute(input as any, {
      toolCallId: 'test',
      messages: [],
      abortSignal: undefined as any,
    }) as any;
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */

  it('should return success with direct invite mode for small group', async () => {
    mockGroupResolver.resolveGroups.mockResolvedValue([makeGroup({ memberCount: 50 })]);
    mockRedisService.exists.mockResolvedValue(false);
    mockRoomService.addMemberEnterprise.mockResolvedValue(undefined);
    mockRedisService.setex.mockResolvedValue('OK');
    mockMemoryService.saveInvitedGroup.mockResolvedValue(undefined);

    const result = await executeTool({ city: '上海' });

    expect(result.success).toBe(true);
    expect(result.inviteMode).toBe('direct');
    expect(result.groupName).toBe('上海兼职群1号');
    expect(result.city).toBe('上海');
    expect(mockRoomService.addMemberEnterprise).toHaveBeenCalledWith(
      expect.objectContaining({
        token: 'enterprise-token-test',
        imBotId: 'chat-bot-im-id',
        botUserId: 'chat-bot-weixin',
        contactWxid: 'user-1',
        roomWxid: 'room-1',
      }),
    );
    expect(mockMemoryService.saveInvitedGroup).toHaveBeenCalled();
  });

  it('should return link invite mode when group has 100+ members', async () => {
    mockGroupResolver.resolveGroups.mockResolvedValue([makeGroup({ memberCount: 120 })]);
    mockRedisService.exists.mockResolvedValue(false);
    mockRoomService.addMemberEnterprise.mockResolvedValue(undefined);
    mockRedisService.setex.mockResolvedValue('OK');
    mockMemoryService.saveInvitedGroup.mockResolvedValue(undefined);

    const result = await executeTool({ city: '上海' });

    expect(result.success).toBe(true);
    expect(result.inviteMode).toBe('link');
  });

  it('should return error when no groups available', async () => {
    mockGroupResolver.resolveGroups.mockResolvedValue([]);

    const result = await executeTool({ city: '上海' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('暂无可用群');
  });

  it('should return available cities when city has no match', async () => {
    mockGroupResolver.resolveGroups.mockResolvedValue([
      makeGroup({ city: '北京' }),
      makeGroup({ city: '杭州' }),
    ]);

    const result = await executeTool({ city: '上海' });

    expect(result.success).toBe(false);
    expect(result.availableCities).toEqual(expect.arrayContaining(['北京', '杭州']));
  });

  it('should skip already invited user', async () => {
    mockGroupResolver.resolveGroups.mockResolvedValue([makeGroup()]);
    mockRedisService.exists.mockResolvedValue(true);

    const result = await executeTool({ city: '上海' });

    expect(result.success).toBe(false);
    expect(result.reason).toBe('already_invited');
    expect(mockRoomService.addMemberEnterprise).not.toHaveBeenCalled();
  });

  it('should alert and return group_full when all groups are full', async () => {
    mockGroupResolver.resolveGroups.mockResolvedValue([
      makeGroup({ memberCount: MEMBER_LIMIT + 10 }),
      makeGroup({ imRoomId: 'room-2', groupName: '上海兼职群2号', memberCount: MEMBER_LIMIT + 5 }),
    ]);
    mockAlertService.sendAlert.mockResolvedValue(undefined);

    const result = await executeTool({ city: '上海' });

    expect(result.success).toBe(false);
    expect(result.reason).toBe('group_full');
    expect(mockAlertService.sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({ errorType: 'group_full' }),
    );
  });

  it('should filter by industry when provided', async () => {
    const restaurantGroup = makeGroup({ industry: '餐饮', groupName: '上海餐饮兼职群' });
    const retailGroup = makeGroup({
      imRoomId: 'room-2',
      industry: '零售',
      groupName: '上海零售兼职群',
    });
    mockGroupResolver.resolveGroups.mockResolvedValue([restaurantGroup, retailGroup]);
    mockRedisService.exists.mockResolvedValue(false);
    mockRoomService.addMemberEnterprise.mockResolvedValue(undefined);
    mockRedisService.setex.mockResolvedValue('OK');
    mockMemoryService.saveInvitedGroup.mockResolvedValue(undefined);

    const result = await executeTool({ city: '上海', industry: '餐饮' });

    expect(result.success).toBe(true);
    expect(result.groupName).toBe('上海餐饮兼职群');
  });

  it('should fallback to city groups when industry has no match', async () => {
    mockGroupResolver.resolveGroups.mockResolvedValue([makeGroup({ industry: '餐饮' })]);
    mockRedisService.exists.mockResolvedValue(false);
    mockRoomService.addMemberEnterprise.mockResolvedValue(undefined);
    mockRedisService.setex.mockResolvedValue('OK');
    mockMemoryService.saveInvitedGroup.mockResolvedValue(undefined);

    const result = await executeTool({ city: '上海', industry: '零售' });

    expect(result.success).toBe(true);
    expect(result.groupName).toBe('上海兼职群1号');
  });

  it('should pick group with lowest member count', async () => {
    mockGroupResolver.resolveGroups.mockResolvedValue([
      makeGroup({ imRoomId: 'room-1', groupName: '群A', memberCount: 150 }),
      makeGroup({ imRoomId: 'room-2', groupName: '群B', memberCount: 30 }),
      makeGroup({ imRoomId: 'room-3', groupName: '群C', memberCount: 80 }),
    ]);
    mockRedisService.exists.mockResolvedValue(false);
    mockRoomService.addMemberEnterprise.mockResolvedValue(undefined);
    mockRedisService.setex.mockResolvedValue('OK');
    mockMemoryService.saveInvitedGroup.mockResolvedValue(undefined);

    const result = await executeTool({ city: '上海' });

    expect(result.success).toBe(true);
    expect(result.groupName).toBe('群B');
  });

  it('should handle addMember failure gracefully', async () => {
    mockGroupResolver.resolveGroups.mockResolvedValue([makeGroup()]);
    mockRedisService.exists.mockResolvedValue(false);
    mockRoomService.addMemberEnterprise.mockRejectedValue(new Error('WeChat API timeout'));

    const result = await executeTool({ city: '上海' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('WeChat API timeout');
  });
});

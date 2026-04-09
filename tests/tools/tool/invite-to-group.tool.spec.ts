import { buildInviteToGroupTool } from '@tools/invite-to-group.tool';
import { ToolBuildContext } from '@shared-types/tool.types';
import { GroupContext } from '@biz/group-task/group-task.types';
import { FEISHU_RECEIVER_USERS } from '@infra/feishu/constants/receivers';

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
  const mockGroupMembership = {
    isUserInRoom: jest.fn(),
    markUserInRoom: jest.fn(),
    invalidateRoomCache: jest.fn(),
    refreshRoomCacheByToken: jest.fn(),
  };
  const mockRoomService = { addMemberEnterprise: jest.fn() };
  const mockWebhookService = { sendMessage: jest.fn() };
  const mockCardBuilder = { buildMarkdownCard: jest.fn() };
  const mockMemoryService = { saveInvitedGroup: jest.fn() };
  const MEMBER_LIMIT = 200;

  beforeEach(() => {
    jest.clearAllMocks();
    mockCardBuilder.buildMarkdownCard.mockReturnValue({ msg_type: 'interactive' });
    mockWebhookService.sendMessage.mockResolvedValue(true);
    // 默认用户不在群中
    mockGroupMembership.isUserInRoom.mockResolvedValue(false);
    mockGroupMembership.markUserInRoom.mockResolvedValue(undefined);
    mockGroupMembership.invalidateRoomCache.mockResolvedValue(undefined);
    mockGroupMembership.refreshRoomCacheByToken.mockResolvedValue(undefined);
  });

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const executeTool = async (
    input: { city: string; industry?: string },
    overrideContext?: Partial<ToolBuildContext>,
  ) => {
    const builder = buildInviteToGroupTool(
      mockGroupResolver as any,
      mockGroupMembership as any,
      mockRoomService as any,
      mockWebhookService as any,
      mockCardBuilder as any,
      mockMemoryService as any,
      MEMBER_LIMIT,
      'enterprise-token-test',
    );
    const builtTool = builder({ ...mockContext, ...overrideContext });
    return builtTool.execute(input as any, {
      toolCallId: 'test',
      messages: [],
      abortSignal: undefined as any,
    }) as any;
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */

  it('should return success with direct invite mode for small group', async () => {
    mockGroupResolver.resolveGroups.mockResolvedValue([makeGroup({ memberCount: 50 })]);
    mockGroupMembership.isUserInRoom
      .mockResolvedValueOnce(false) // pre-check
      .mockResolvedValueOnce(true); // confirm after invite
    mockRoomService.addMemberEnterprise.mockResolvedValue({ errcode: 0, errmsg: 'ok' });
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
    expect(mockGroupMembership.markUserInRoom).toHaveBeenCalledWith('room-1', 'user-1');
    expect(mockMemoryService.saveInvitedGroup).toHaveBeenCalled();
  });

  it('should return link invite mode when group has 100+ members', async () => {
    mockGroupResolver.resolveGroups.mockResolvedValue([makeGroup({ memberCount: 120 })]);
    mockGroupMembership.isUserInRoom
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    mockRoomService.addMemberEnterprise.mockResolvedValue({ errcode: 0, errmsg: 'ok' });
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

  it('should block invite when booking failed in same turn', async () => {
    const result = await executeTool(
      { city: '上海' },
      {
        bookingSucceeded: false,
      },
    );

    expect(result.success).toBe(false);
    expect(result.reason).toBe('booking_not_succeeded');
    expect(mockGroupResolver.resolveGroups).not.toHaveBeenCalled();
    expect(mockRoomService.addMemberEnterprise).not.toHaveBeenCalled();
  });

  it('should silently skip when city has no match', async () => {
    mockGroupResolver.resolveGroups.mockResolvedValue([
      makeGroup({ city: '北京' }),
      makeGroup({ city: '杭州' }),
    ]);

    const result = await executeTool({ city: '上海' });

    expect(result.success).toBe(false);
    expect(result.reason).toBe('no_group_in_city');
    expect(result.availableCities).toBeUndefined();
    expect(mockRoomService.addMemberEnterprise).not.toHaveBeenCalled();
  });

  it('should silently skip when user is already in the target group', async () => {
    mockGroupResolver.resolveGroups.mockResolvedValue([makeGroup()]);
    mockGroupMembership.isUserInRoom.mockResolvedValue(true);

    const result = await executeTool({ city: '上海' });

    expect(result.success).toBe(false);
    expect(result.reason).toBe('already_in_group');
    expect(result.groupName).toBe('上海兼职群1号');
    expect(mockGroupMembership.refreshRoomCacheByToken).toHaveBeenCalledWith('room-1', 'token-1');
    expect(mockGroupMembership.isUserInRoom).toHaveBeenCalledWith('room-1', 'user-1', ['room-1']);
    expect(mockRoomService.addMemberEnterprise).not.toHaveBeenCalled();
    expect(mockGroupMembership.markUserInRoom).not.toHaveBeenCalled();
  });

  it('should alert and return group_full when all groups are full', async () => {
    mockGroupResolver.resolveGroups.mockResolvedValue([
      makeGroup({ memberCount: MEMBER_LIMIT + 10 }),
      makeGroup({ imRoomId: 'room-2', groupName: '上海兼职群2号', memberCount: MEMBER_LIMIT + 5 }),
    ]);

    const result = await executeTool({ city: '上海' });

    expect(result.success).toBe(false);
    expect(result.reason).toBe('group_full');
    expect(mockCardBuilder.buildMarkdownCard).toHaveBeenCalledWith(
      expect.objectContaining({
        atUsers: [FEISHU_RECEIVER_USERS.GAO_YAQI],
        title: '上海 所有兼职群已满，需要创建新群',
      }),
    );
    expect(mockWebhookService.sendMessage).toHaveBeenCalledWith('ALERT', {
      msg_type: 'interactive',
    });
  });

  it('should filter by industry when provided', async () => {
    const restaurantGroup = makeGroup({ industry: '餐饮', groupName: '上海餐饮兼职群' });
    const retailGroup = makeGroup({
      imRoomId: 'room-2',
      industry: '零售',
      groupName: '上海零售兼职群',
    });
    mockGroupResolver.resolveGroups.mockResolvedValue([restaurantGroup, retailGroup]);
    mockGroupMembership.isUserInRoom
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    mockRoomService.addMemberEnterprise.mockResolvedValue({ errcode: 0, errmsg: 'ok' });
    mockMemoryService.saveInvitedGroup.mockResolvedValue(undefined);

    const result = await executeTool({ city: '上海', industry: '餐饮' });

    expect(result.success).toBe(true);
    expect(result.groupName).toBe('上海餐饮兼职群');
  });

  it('should fallback to city groups when industry has no match', async () => {
    mockGroupResolver.resolveGroups.mockResolvedValue([makeGroup({ industry: '餐饮' })]);
    mockGroupMembership.isUserInRoom
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    mockRoomService.addMemberEnterprise.mockResolvedValue({ errcode: 0, errmsg: 'ok' });
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
    mockGroupMembership.isUserInRoom
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    mockRoomService.addMemberEnterprise.mockResolvedValue({ errcode: 0, errmsg: 'ok' });
    mockMemoryService.saveInvitedGroup.mockResolvedValue(undefined);

    const result = await executeTool({ city: '上海' });

    expect(result.success).toBe(true);
    expect(result.groupName).toBe('群B');
  });

  it('should handle addMember failure gracefully', async () => {
    mockGroupResolver.resolveGroups.mockResolvedValue([makeGroup()]);
    mockGroupMembership.isUserInRoom.mockResolvedValueOnce(false);
    mockRoomService.addMemberEnterprise.mockRejectedValue(new Error('WeChat API timeout'));

    const result = await executeTool({ city: '上海' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('WeChat API timeout');
  });

  it('should return invite_not_confirmed when join cannot be verified', async () => {
    mockGroupResolver.resolveGroups.mockResolvedValue([makeGroup()]);
    mockGroupMembership.isUserInRoom.mockResolvedValue(false);
    mockRoomService.addMemberEnterprise.mockResolvedValue({ errcode: 0, errmsg: 'ok' });

    const result = await executeTool({ city: '上海' });

    expect(result.success).toBe(false);
    expect(result.reason).toBe('invite_not_confirmed');
    expect(result.groupName).toBe('上海兼职群1号');
    expect(mockGroupMembership.markUserInRoom).not.toHaveBeenCalled();
    expect(mockMemoryService.saveInvitedGroup).not.toHaveBeenCalled();
  });

  it('should return invite_api_rejected when enterprise API returns non-zero errcode', async () => {
    mockGroupResolver.resolveGroups.mockResolvedValue([makeGroup()]);
    mockGroupMembership.isUserInRoom.mockResolvedValueOnce(false);
    mockRoomService.addMemberEnterprise.mockResolvedValue({ errcode: 40003, errmsg: 'forbidden' });

    const result = await executeTool({ city: '上海' });

    expect(result.success).toBe(false);
    expect(result.reason).toBe('invite_api_rejected');
    expect(result.error).toContain('errcode=40003');
    expect(mockGroupMembership.markUserInRoom).not.toHaveBeenCalled();
  });

  it('should fail clearly when enterprise token is missing', async () => {
    const builder = buildInviteToGroupTool(
      mockGroupResolver as any,
      mockGroupMembership as any,
      mockRoomService as any,
      mockWebhookService as any,
      mockCardBuilder as any,
      mockMemoryService as any,
      MEMBER_LIMIT,
      undefined,
    );
    const builtTool = builder(mockContext);

    const result = await builtTool.execute(
      { city: '上海' } as any,
      {
        toolCallId: 'test',
        messages: [],
        abortSignal: undefined as any,
      },
    );

    expect(result).toEqual({
      success: false,
      errorType: 'enterprise_token_missing',
      error: 'STRIDE_ENTERPRISE_TOKEN 未配置，无法执行企业级拉群',
    });
    expect(mockGroupResolver.resolveGroups).not.toHaveBeenCalled();
    expect(mockRoomService.addMemberEnterprise).not.toHaveBeenCalled();
  });

  it('should fail clearly when bot identity is missing', async () => {
    const result = await executeTool(
      { city: '上海' },
      {
        botImId: undefined,
        botUserId: undefined,
      },
    );

    expect(result.success).toBe(false);
    expect(result.reason).toBe('missing_bot_identity');
    expect(mockGroupResolver.resolveGroups).not.toHaveBeenCalled();
    expect(mockRoomService.addMemberEnterprise).not.toHaveBeenCalled();
  });
});

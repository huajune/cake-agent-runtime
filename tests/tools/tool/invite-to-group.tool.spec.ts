import { buildInviteToGroupTool } from '@tools/invite-to-group.tool';
import { ToolBuildContext } from '@shared-types/tool.types';
import { GroupContext } from '@biz/group-task/group-task.types';
import { TOOL_ERROR_TYPES } from '@tools/types/tool-error-types';

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
  const mockRoomService = {
    addMemberEnterprise: jest.fn(),
    getEnterpriseGroupChatList: jest.fn(),
  };
  const mockOpsNotifier = {
    sendGroupFullAlert: jest.fn(),
    sendInviteRejectedAlert: jest.fn(),
  };
  const mockMemoryService = { saveInvitedGroup: jest.fn() };
  const MEMBER_LIMIT = 200;

  beforeEach(() => {
    jest.clearAllMocks();
    mockOpsNotifier.sendGroupFullAlert.mockResolvedValue(true);
    mockOpsNotifier.sendInviteRejectedAlert.mockResolvedValue(true);
    mockRoomService.getEnterpriseGroupChatList.mockResolvedValue({ data: [] });
  });

  const flushAsyncEvents = async () => {
    await new Promise((resolve) => setImmediate(resolve));
  };

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const executeTool = async (
    input: { city: string; industry?: string },
    overrideContext?: Partial<ToolBuildContext>,
  ) => {
    const builder = buildInviteToGroupTool(
      mockGroupResolver as any,
      mockRoomService as any,
      mockOpsNotifier as any,
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

  it('should return direct invite mode for small group (<40)', async () => {
    mockGroupResolver.resolveGroups.mockResolvedValue([makeGroup({ memberCount: 30 })]);
    mockRoomService.addMemberEnterprise.mockResolvedValue({ errcode: 0, errmsg: 'ok' });
    mockMemoryService.saveInvitedGroup.mockResolvedValue(undefined);

    const result = await executeTool({ city: '上海' });

    expect(result.success).toBe(true);
    expect(result.inviteMode).toBe('direct');
    expect(result.groupName).toBe('上海兼职群1号');
    expect(result.city).toBe('上海');
    expect(result.selectionReason).toBe('only_option');
    expect(result.fallbackUsed).toBe(false);
    expect(result.citySnapshot).toEqual({
      totalGroups: 1,
      memberLimit: MEMBER_LIMIT,
      byIndustry: [{ industry: '未分类', groupCount: 1, availableCount: 1 }],
    });
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

  it('should return link invite mode for group with 40+ members', async () => {
    mockGroupResolver.resolveGroups.mockResolvedValue([makeGroup({ memberCount: 50 })]);
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
    expect(result.errorType).toBe(TOOL_ERROR_TYPES.INVITE_NO_GROUP_AVAILABLE);
    expect(result._replyInstruction).toContain('request_handoff');
  });

  it('should block invite when booking failed in same turn', async () => {
    const result = await executeTool(
      { city: '上海' },
      {
        bookingSucceeded: false,
      },
    );

    expect(result.success).toBe(false);
    expect(result.errorType).toBe(TOOL_ERROR_TYPES.INVITE_BOOKING_NOT_SUCCESS);
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
    expect(result.errorType).toBe(TOOL_ERROR_TYPES.INVITE_NO_GROUP_IN_CITY);
    expect(result.availableCities).toBeUndefined();
    expect(mockRoomService.addMemberEnterprise).not.toHaveBeenCalled();
  });

  it('should silently skip when API reports user is already in the target group', async () => {
    mockGroupResolver.resolveGroups.mockResolvedValue([makeGroup()]);
    mockRoomService.addMemberEnterprise.mockResolvedValue({
      errcode: -9,
      errmsg: '群聊中已经存在此好友',
    });

    const result = await executeTool({ city: '上海' });

    expect(result.success).toBe(false);
    expect(result.errorType).toBe(TOOL_ERROR_TYPES.INVITE_ALREADY_IN_GROUP);
    expect(result.groupName).toBe('上海兼职群1号');
    expect(mockRoomService.addMemberEnterprise).toHaveBeenCalled();
  });

  it('should alert and return group_full when all groups are full', async () => {
    mockGroupResolver.resolveGroups.mockResolvedValue([
      makeGroup({ memberCount: MEMBER_LIMIT + 10 }),
      makeGroup({ imRoomId: 'room-2', groupName: '上海兼职群2号', memberCount: MEMBER_LIMIT + 5 }),
    ]);

    const result = await executeTool({ city: '上海' });
    await flushAsyncEvents();

    expect(result.success).toBe(false);
    expect(result.errorType).toBe(TOOL_ERROR_TYPES.INVITE_GROUP_FULL);
    expect(result._replyInstruction).toContain('request_handoff');
    expect(result.citySnapshot).toEqual({
      totalGroups: 2,
      memberLimit: MEMBER_LIMIT,
      byIndustry: [{ industry: '未分类', groupCount: 2, availableCount: 0 }],
    });
    expect(mockOpsNotifier.sendGroupFullAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        city: '上海',
        memberLimit: MEMBER_LIMIT,
        groups: [
          { name: '上海兼职群1号', memberCount: MEMBER_LIMIT + 10 },
          { name: '上海兼职群2号', memberCount: MEMBER_LIMIT + 5 },
        ],
      }),
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
    mockRoomService.addMemberEnterprise.mockResolvedValue({ errcode: 0, errmsg: 'ok' });
    mockMemoryService.saveInvitedGroup.mockResolvedValue(undefined);

    const result = await executeTool({ city: '上海', industry: '餐饮' });

    expect(result.success).toBe(true);
    expect(result.groupName).toBe('上海餐饮兼职群');
    expect(result.matchedIndustry).toBe('餐饮');
    expect(result.fallbackUsed).toBe(false);
    expect(result.selectionReason).toBe('only_option');
    expect(result.citySnapshot.byIndustry).toEqual(
      expect.arrayContaining([
        { industry: '餐饮', groupCount: 1, availableCount: 1 },
        { industry: '零售', groupCount: 1, availableCount: 1 },
      ]),
    );
  });

  it('should fallback to city groups when industry has no match', async () => {
    mockGroupResolver.resolveGroups.mockResolvedValue([makeGroup({ industry: '餐饮' })]);
    mockRoomService.addMemberEnterprise.mockResolvedValue({ errcode: 0, errmsg: 'ok' });
    mockMemoryService.saveInvitedGroup.mockResolvedValue(undefined);

    const result = await executeTool({ city: '上海', industry: '零售' });

    expect(result.success).toBe(true);
    expect(result.groupName).toBe('上海兼职群1号');
    expect(result.matchedIndustry).toBe('餐饮');
    expect(result.fallbackUsed).toBe(true);
  });

  it('should pick group with lowest member count', async () => {
    mockGroupResolver.resolveGroups.mockResolvedValue([
      makeGroup({ imRoomId: 'room-1', groupName: '群A', memberCount: 150 }),
      makeGroup({ imRoomId: 'room-2', groupName: '群B', memberCount: 30 }),
      makeGroup({ imRoomId: 'room-3', groupName: '群C', memberCount: 80 }),
    ]);
    mockRoomService.addMemberEnterprise.mockResolvedValue({ errcode: 0, errmsg: 'ok' });
    mockMemoryService.saveInvitedGroup.mockResolvedValue(undefined);

    const result = await executeTool({ city: '上海' });

    expect(result.success).toBe(true);
    expect(result.groupName).toBe('群B');
    expect(result.selectionReason).toBe('lowest_member_count');
  });

  it('should skip a group whose refreshed enterprise member count reaches the limit', async () => {
    mockGroupResolver.resolveGroups.mockResolvedValue([
      makeGroup({
        imRoomId: 'room-1',
        groupName: '独立客&上海餐饮兼职①群',
        industry: '餐饮',
        memberCount: 50,
      }),
      makeGroup({
        imRoomId: 'room-2',
        groupName: '独立客&上海餐饮兼职②群',
        industry: '餐饮',
        memberCount: 120,
      }),
    ]);
    mockRoomService.getEnterpriseGroupChatList.mockResolvedValue({
      data: [
        {
          imRoomId: 'room-1',
          memberList: Array.from({ length: MEMBER_LIMIT + 1 }, (_, index) => ({
            imContactId: `member-a-${index}`,
          })),
        },
        {
          imRoomId: 'room-2',
          memberList: Array.from({ length: 80 }, (_, index) => ({
            imContactId: `member-b-${index}`,
          })),
        },
      ],
    });
    mockRoomService.addMemberEnterprise.mockResolvedValue({ errcode: 0, errmsg: 'ok' });
    mockMemoryService.saveInvitedGroup.mockResolvedValue(undefined);

    const result = await executeTool({ city: '上海', industry: '餐饮' });

    expect(result.success).toBe(true);
    expect(result.groupName).toBe('独立客&上海餐饮兼职②群');
    expect(result.citySnapshot.byIndustry).toEqual([
      { industry: '餐饮', groupCount: 2, availableCount: 1 },
    ]);
    expect(mockRoomService.addMemberEnterprise).toHaveBeenCalledWith(
      expect.objectContaining({ roomWxid: 'room-2' }),
    );
  });

  it('should alert without inviting when refreshed enterprise counts show all candidates are full', async () => {
    mockGroupResolver.resolveGroups.mockResolvedValue([
      makeGroup({
        imRoomId: 'room-1',
        groupName: '独立客&上海餐饮兼职①群',
        industry: '餐饮',
        memberCount: 50,
      }),
      makeGroup({
        imRoomId: 'room-2',
        groupName: '独立客&上海餐饮兼职②群',
        industry: '餐饮',
        memberCount: 80,
      }),
    ]);
    mockRoomService.getEnterpriseGroupChatList.mockResolvedValue({
      data: [
        {
          imRoomId: 'room-1',
          memberList: Array.from({ length: MEMBER_LIMIT + 1 }, (_, index) => ({
            imContactId: `member-a-${index}`,
          })),
        },
        {
          imRoomId: 'room-2',
          memberList: Array.from({ length: MEMBER_LIMIT }, (_, index) => ({
            imContactId: `member-b-${index}`,
          })),
        },
      ],
    });

    const result = await executeTool({ city: '上海', industry: '餐饮' });
    await flushAsyncEvents();

    expect(result.success).toBe(false);
    expect(result.errorType).toBe(TOOL_ERROR_TYPES.INVITE_GROUP_FULL);
    expect(result.citySnapshot.byIndustry).toEqual([
      { industry: '餐饮', groupCount: 2, availableCount: 0 },
    ]);
    expect(mockRoomService.addMemberEnterprise).not.toHaveBeenCalled();
    expect(mockOpsNotifier.sendGroupFullAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        city: '上海',
        industry: '餐饮',
        groups: [
          { name: '独立客&上海餐饮兼职①群', memberCount: MEMBER_LIMIT + 1 },
          { name: '独立客&上海餐饮兼职②群', memberCount: MEMBER_LIMIT },
        ],
      }),
    );
  });

  it('should try the next candidate when invite API reports the selected group is full', async () => {
    mockGroupResolver.resolveGroups.mockResolvedValue([
      makeGroup({ imRoomId: 'room-1', groupName: '上海兼职群1号', memberCount: 20 }),
      makeGroup({ imRoomId: 'room-2', groupName: '上海兼职群2号', memberCount: 30 }),
    ]);
    mockRoomService.addMemberEnterprise
      .mockResolvedValueOnce({ errcode: -10, errmsg: '群人数达到上限(500)' })
      .mockResolvedValueOnce({ errcode: 0, errmsg: 'ok' });
    mockMemoryService.saveInvitedGroup.mockResolvedValue(undefined);

    const result = await executeTool({ city: '上海' });
    await flushAsyncEvents();

    expect(result.success).toBe(true);
    expect(result.groupName).toBe('上海兼职群2号');
    expect(mockRoomService.addMemberEnterprise).toHaveBeenCalledTimes(2);
    expect(mockRoomService.addMemberEnterprise).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ roomWxid: 'room-1' }),
    );
    expect(mockRoomService.addMemberEnterprise).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ roomWxid: 'room-2' }),
    );
    expect(mockOpsNotifier.sendGroupFullAlert).not.toHaveBeenCalled();
  });

  it('should expose citySnapshot reproducing 零售 fallback when industry is missing', async () => {
    // 还原真实 badcase：上海餐饮 6 群 + 零售 3 群，不传 industry 时按人数兜底选中零售小群
    mockGroupResolver.resolveGroups.mockResolvedValue([
      makeGroup({ imRoomId: 'r1', groupName: '上海餐饮①', industry: '餐饮', memberCount: 156 }),
      makeGroup({ imRoomId: 'r2', groupName: '上海餐饮②', industry: '餐饮', memberCount: 196 }),
      makeGroup({ imRoomId: 'r3', groupName: '上海餐饮③', industry: '餐饮', memberCount: 169 }),
      makeGroup({ imRoomId: 'r4', groupName: '上海餐饮④', industry: '餐饮', memberCount: 198 }),
      makeGroup({ imRoomId: 'r5', groupName: '上海餐饮⑤', industry: '餐饮', memberCount: 199 }),
      makeGroup({ imRoomId: 'r6', groupName: '上海餐饮⑥', industry: '餐饮', memberCount: 124 }),
      makeGroup({ imRoomId: 'r7', groupName: '上海零售①', industry: '零售', memberCount: 198 }),
      makeGroup({ imRoomId: 'r8', groupName: '上海零售②', industry: '零售', memberCount: 198 }),
      makeGroup({ imRoomId: 'r9', groupName: '上海零售③', industry: '零售', memberCount: 15 }),
    ]);
    mockRoomService.addMemberEnterprise.mockResolvedValue({ errcode: 0, errmsg: 'ok' });
    mockMemoryService.saveInvitedGroup.mockResolvedValue(undefined);

    const result = await executeTool({ city: '上海' });

    expect(result.success).toBe(true);
    expect(result.groupName).toBe('上海零售③');
    expect(result.matchedIndustry).toBe('零售');
    expect(result.fallbackUsed).toBe(false);
    expect(result.inviteMode).toBe('direct');
    expect(result.citySnapshot).toEqual({
      totalGroups: 9,
      memberLimit: MEMBER_LIMIT,
      byIndustry: expect.arrayContaining([
        { industry: '餐饮', groupCount: 6, availableCount: 6 },
        { industry: '零售', groupCount: 3, availableCount: 3 },
      ]),
    });
  });

  it('should handle addMember failure gracefully', async () => {
    mockGroupResolver.resolveGroups.mockResolvedValue([makeGroup()]);
    mockRoomService.addMemberEnterprise.mockRejectedValue(new Error('WeChat API timeout'));

    const result = await executeTool({ city: '上海' });

    expect(result.success).toBe(false);
    expect(result.errorType).toBe(TOOL_ERROR_TYPES.INVITE_API_FAILED);
    expect(result.reason).toBe('WeChat API timeout');
    expect(result._replyInstruction).not.toContain('WeChat API timeout');
  });

  it('should return invite_api_rejected and alert when enterprise API returns non-zero errcode', async () => {
    mockGroupResolver.resolveGroups.mockResolvedValue([makeGroup()]);
    mockRoomService.addMemberEnterprise.mockResolvedValue({ errcode: 40003, errmsg: 'forbidden' });

    const result = await executeTool({ city: '上海' });
    await flushAsyncEvents();

    expect(result.success).toBe(false);
    expect(result.errorType).toBe(TOOL_ERROR_TYPES.INVITE_API_REJECTED);
    expect(result.reason).toContain('errcode=40003');
    expect(mockMemoryService.saveInvitedGroup).not.toHaveBeenCalled();
    expect(mockOpsNotifier.sendInviteRejectedAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        city: '上海',
        chatBotImId: 'chat-bot-im-id',
        chatBotUserId: 'chat-bot-weixin',
        rejectedGroups: [
          expect.objectContaining({
            name: '上海兼职群1号',
            error: expect.stringContaining('errcode=40003'),
          }),
        ],
      }),
    );
  });

  it('should try the next candidate when invite API rejects the selected group (e.g. 400400 room not found)', async () => {
    mockGroupResolver.resolveGroups.mockResolvedValue([
      makeGroup({ imRoomId: 'room-1', groupName: '上海零售①' }),
      makeGroup({ imRoomId: 'room-2', groupName: '上海零售②' }),
    ]);
    mockRoomService.addMemberEnterprise
      .mockResolvedValueOnce({ errcode: 400400, errmsg: 'room not found' })
      .mockResolvedValueOnce({ errcode: 0, errmsg: 'ok' });
    mockMemoryService.saveInvitedGroup.mockResolvedValue(undefined);

    const result = await executeTool({ city: '上海' });
    await flushAsyncEvents();

    expect(result.success).toBe(true);
    expect(result.groupName).toBe('上海零售②');
    expect(mockRoomService.addMemberEnterprise).toHaveBeenCalledTimes(2);
    expect(mockOpsNotifier.sendInviteRejectedAlert).not.toHaveBeenCalled();
  });

  it('should send invite_rejected alert (not group_full) when every candidate is rejected', async () => {
    mockGroupResolver.resolveGroups.mockResolvedValue([
      makeGroup({ imRoomId: 'room-1', groupName: '上海零售①', imBotId: 'owner-bot-im' }),
      makeGroup({ imRoomId: 'room-2', groupName: '上海零售②', imBotId: 'owner-bot-im' }),
    ]);
    mockRoomService.addMemberEnterprise.mockResolvedValue({
      errcode: 400400,
      errmsg: 'room not found',
    });

    const result = await executeTool({ city: '上海' });
    await flushAsyncEvents();

    expect(result.success).toBe(false);
    expect(result.errorType).toBe(TOOL_ERROR_TYPES.INVITE_API_REJECTED);
    expect(mockRoomService.addMemberEnterprise).toHaveBeenCalledTimes(2);
    expect(mockOpsNotifier.sendGroupFullAlert).not.toHaveBeenCalled();
    expect(mockOpsNotifier.sendInviteRejectedAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        city: '上海',
        chatBotImId: 'chat-bot-im-id',
        rejectedGroups: expect.arrayContaining([
          expect.objectContaining({ name: '上海零售①', ownerBotImId: 'owner-bot-im' }),
          expect.objectContaining({ name: '上海零售②', ownerBotImId: 'owner-bot-im' }),
        ]),
      }),
    );
  });

  it('should return group_full when API reports group member limit reached', async () => {
    mockGroupResolver.resolveGroups.mockResolvedValue([makeGroup({ memberCount: 199 })]);
    mockRoomService.addMemberEnterprise.mockResolvedValue({
      errcode: -10,
      errmsg: '群人数达到上限(500)',
    });

    const result = await executeTool({ city: '上海' });
    await flushAsyncEvents();

    expect(result.success).toBe(false);
    expect(result.errorType).toBe(TOOL_ERROR_TYPES.INVITE_GROUP_FULL);
    expect(result.groupName).toBe('上海兼职群1号');
    expect(result.citySnapshot.totalGroups).toBe(1);
    expect(mockOpsNotifier.sendGroupFullAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        city: '上海',
        memberLimit: MEMBER_LIMIT,
        groups: [{ name: '上海兼职群1号', memberCount: MEMBER_LIMIT }],
      }),
    );
  });

  it('should fail clearly when enterprise token is missing', async () => {
    const builder = buildInviteToGroupTool(
      mockGroupResolver as any,
      mockRoomService as any,
      mockOpsNotifier as any,
      mockMemoryService as any,
      MEMBER_LIMIT,
      undefined,
    );
    const builtTool = builder(mockContext);

    const result = await builtTool.execute({ city: '上海' } as any, {
      toolCallId: 'test',
      messages: [],
      abortSignal: undefined as any,
    });

    expect(result).toMatchObject({
      success: false,
      errorType: TOOL_ERROR_TYPES.INVITE_ENTERPRISE_TOKEN_MISSING,
      error: TOOL_ERROR_TYPES.INVITE_ENTERPRISE_TOKEN_MISSING,
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
    expect(result.errorType).toBe(TOOL_ERROR_TYPES.INVITE_MISSING_BOT_IDENTITY);
    expect(result._replyInstruction).toContain('request_handoff');
    expect(mockGroupResolver.resolveGroups).not.toHaveBeenCalled();
    expect(mockRoomService.addMemberEnterprise).not.toHaveBeenCalled();
  });
});

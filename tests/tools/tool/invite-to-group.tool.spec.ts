import { buildInviteToGroupTool } from '@tools/invite-to-group.tool';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ToolBuildContext } from '@shared-types/tool.types';
import { GroupContext } from '@biz/group-task/group-task.types';
import { GroupInviteService } from '@biz/group-task/services/group-invite.service';
import { GroupResolverService } from '@biz/group-task/services/group-resolver.service';
import { GroupMembershipService } from '@biz/group-task/services/group-membership.service';
import { RoomService } from '@channels/wecom/room/room.service';
import { MemoryService } from '@memory/memory.service';
import { OpsEventsRecorderService } from '@biz/ops-events/services/ops-events-recorder.service';
import { OpsNotifierService } from '@notification/services/ops-notifier.service';
import { TOOL_ERROR_TYPES } from '@tools/shared/tool-error-types';
import { createToolContext, mergeToolContext } from '../../helpers/tool-context.fixture';

interface InviteContextOverrides {
  token?: string;
  botImId?: string;
  botUserId?: string;
  imContactId?: string;
  imRoomId?: string;
  chatId?: string;
  messages?: unknown[];
  currentUserMessage?: string;
  strategySource?: ToolBuildContext['runtime']['strategySource'];
  bookingSucceeded?: boolean;
  jobListExecuted?: boolean;
}

describe('buildInviteToGroupTool', () => {
  const mockContext: ToolBuildContext = createToolContext({
    session: {
      userId: 'user-1',
      corpId: 'corp-1',
      sessionId: 'sess-1',
      botUserId: 'chat-bot-weixin',
      botImId: 'chat-bot-im-id',
    },
    // 城市 provenance gate 要求 city 有出处：默认让候选人原文提到上海
    turnInput: { messages: [{ role: 'user', content: '你好，我在上海找兼职' }] },
    // 本文件多数用例测选群/投递链路，默认按“首次预约已成功”这一合法拉群入口建模。
    // 两轮同意与非法直拉的时机档位在本文件的专门分组及 shared 单测覆盖。
    ledger: { jobs: { jobListExecuted: true, bookingSucceeded: true } },
  });

  const buildContext = (overrides: InviteContextOverrides = {}) => {
    const has = (key: keyof InviteContextOverrides) =>
      Object.prototype.hasOwnProperty.call(overrides, key);
    return mergeToolContext(mockContext, {
      session: {
        ...(has('token') ? { token: overrides.token } : {}),
        ...(has('botImId') ? { botImId: overrides.botImId } : {}),
        ...(has('botUserId') ? { botUserId: overrides.botUserId } : {}),
        ...(has('imContactId') ? { imContactId: overrides.imContactId } : {}),
        ...(has('imRoomId') ? { imRoomId: overrides.imRoomId } : {}),
        ...(has('chatId') ? { chatId: overrides.chatId } : {}),
      },
      turnInput: {
        ...(has('messages') ? { messages: overrides.messages ?? [] } : {}),
        ...(has('currentUserMessage') ? { currentUserMessage: overrides.currentUserMessage } : {}),
      },
      ledger: {
        jobs: {
          ...(has('bookingSucceeded') ? { bookingSucceeded: overrides.bookingSucceeded } : {}),
          ...(has('jobListExecuted') ? { jobListExecuted: overrides.jobListExecuted } : {}),
        },
      },
      runtime: has('strategySource') ? { strategySource: overrides.strategySource } : {},
    });
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
    syncRoom: jest.fn(),
  };
  const mockOpsNotifier = {
    sendGroupFullAlert: jest.fn(),
    sendInviteRejectedAlert: jest.fn(),
  };
  const mockMemoryService = { saveInvitedGroup: jest.fn() };
  const mockOpsEventsRecorder = { recordEvent: jest.fn().mockResolvedValue(true) };
  const MEMBER_LIMIT = 200;

  const createGroupInviteService = async (options?: {
    groupMembership?: unknown;
    enterpriseToken?: string | null;
  }): Promise<GroupInviteService> => {
    const groupMembership = options?.groupMembership ?? {
      listUserRooms: jest.fn().mockResolvedValue([]),
    };
    const enterpriseToken =
      options && Object.prototype.hasOwnProperty.call(options, 'enterpriseToken')
        ? options.enterpriseToken
        : 'enterprise-token-test';
    const moduleRef = await Test.createTestingModule({
      providers: [
        GroupInviteService,
        { provide: GroupResolverService, useValue: mockGroupResolver },
        { provide: GroupMembershipService, useValue: groupMembership },
        { provide: RoomService, useValue: mockRoomService },
        { provide: MemoryService, useValue: mockMemoryService },
        { provide: OpsEventsRecorderService, useValue: mockOpsEventsRecorder },
        { provide: OpsNotifierService, useValue: mockOpsNotifier },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string, fallback?: string) => {
              if (key === 'GROUP_MEMBER_LIMIT') return String(MEMBER_LIMIT);
              if (key === 'STRIDE_ENTERPRISE_TOKEN') return enterpriseToken;
              return fallback;
            },
          },
        },
      ],
    }).compile();
    return moduleRef.get(GroupInviteService);
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockOpsNotifier.sendGroupFullAlert.mockResolvedValue(true);
    mockOpsNotifier.sendInviteRejectedAlert.mockResolvedValue(true);
    mockRoomService.getEnterpriseGroupChatList.mockResolvedValue({ data: [] });
    mockRoomService.syncRoom.mockResolvedValue({ errcode: 0, errmsg: 'ok' });
  });

  const flushAsyncEvents = async () => {
    await new Promise((resolve) => setImmediate(resolve));
  };

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const executeTool = async (
    input: { city: string; industry?: string },
    overrideContext?: InviteContextOverrides,
    deps?: { groupMembership?: unknown; sessionService?: unknown },
  ) => {
    const service = await createGroupInviteService({
      groupMembership: deps?.groupMembership,
    });
    const groupInviteService = deps?.groupMembership
      ? service
      : ({
          invite: service.invite.bind(service),
          preflightExistingMembership: jest.fn().mockResolvedValue(null),
        } as unknown as GroupInviteService);
    const builder = buildInviteToGroupTool(groupInviteService, deps?.sessionService as any);
    const builtTool = builder(buildContext(overrideContext));
    return builtTool.execute(input as any, {
      toolCallId: 'test',
      context: {},
      messages: [],
      abortSignal: undefined as any,
    }) as any;
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */

  it('should return direct_add delivery for small group (<40)', async () => {
    mockGroupResolver.resolveGroups.mockResolvedValue([makeGroup({ memberCount: 30 })]);
    mockRoomService.addMemberEnterprise.mockResolvedValue({ errcode: 0, errmsg: 'ok' });
    mockMemoryService.saveInvitedGroup.mockResolvedValue(undefined);

    const result = await executeTool({ city: '上海' });
    await flushAsyncEvents();

    expect(result.success).toBe(true);
    expect(result.inviteDelivery).toBe('direct_add');
    expect(result.groupPurpose).toBe('job_pool');
    expect(result.inviteMode).toBeUndefined();
    expect(result.groupName).toBe('上海兼职群1号');
    expect(result._outcome).toContain('直接加入');
    expect(result._replyInstruction).toContain('已帮你加入了');
    expect(result._replyInstruction).toContain('兼职岗位信息');
    expect(result._replyInstruction).toContain('不是面试群');
    expect(result._replyInstruction).toContain('不要输出任何群链接');
    // 拉群成功 → group.invited（按本轮 turn + 群去重，幂等键含 chatId:group:<群名>）
    expect(mockOpsEventsRecorder.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: 'group.invited',
        idempotencyKey: expect.stringContaining(':group:'),
      }),
    );
    expect(result.city).toBe('上海');
    expect(result.selectionReason).toBe('only_option');
    expect(result.fallbackUsed).toBe(false);
    expect(mockGroupResolver.resolveGroups).toHaveBeenCalledWith('兼职群', { forceRefresh: true });
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

  // badcase 63eefu6c / chat 6a68392bce406a6aee39dd0a（2026-07-29）：同会话两次拉群 ——
  // 一次在查岗结论出来前，一次在候选人问"直接去门店面试吗还是怎么样"时。
  describe('时机 gate 端到端（badcase 63eefu6c）', () => {
    it('本轮未查岗就拉群：拒绝且不触达企业接口', async () => {
      const result = await executeTool(
        { city: '上海' },
        { jobListExecuted: false, bookingSucceeded: undefined },
      );

      expect(result.success).toBe(false);
      expect(result.errorType).toBe(TOOL_ERROR_TYPES.INVITE_NO_JOB_RESULT);
      expect(result._replyInstruction).toContain('duliday_job_list');
      expect(result._replyInstruction).toContain('不要调用 request_handoff');
      expect(mockGroupResolver.resolveGroups).not.toHaveBeenCalled();
      expect(mockRoomService.addMemberEnterprise).not.toHaveBeenCalled();
    });

    it('本轮查过岗位但没有两轮协议同意：拒绝且不触达企业接口', async () => {
      const result = await executeTool(
        { city: '上海' },
        { jobListExecuted: true, bookingSucceeded: undefined },
      );

      expect(result.success).toBe(false);
      expect(result.errorType).toBe(TOOL_ERROR_TYPES.INVITE_GROUP_CONSENT_REQUIRED);
      expect(result._replyInstruction).toContain('真实无岗');
      expect(mockGroupResolver.resolveGroups).not.toHaveBeenCalled();
      expect(mockRoomService.addMemberEnterprise).not.toHaveBeenCalled();
    });

    it('历史文本看似两轮否定也只按当前同意工具闸门拒绝，不做正则轮次裁决', async () => {
      const result = await executeTool(
        { city: '上海' },
        {
          jobListExecuted: true,
          bookingSucceeded: undefined,
          currentUserMessage: '没有近的，都有点远',
          messages: [
            { role: 'user', content: '我在上海找兼职' },
            {
              role: 'assistant',
              content: '必胜客（A店）2km，班次09:00-18:00，薪资22元/时',
            },
            { role: 'assistant', content: '你看这家方便吗' },
            { role: 'user', content: '时间太长了，不合适' },
            {
              role: 'assistant',
              content: '成都你六姐（B店）8km，班次18:00-22:00，薪资24元/时',
            },
            { role: 'assistant', content: '你看这家方便吗' },
            { role: 'user', content: '没有近的，都有点远' },
          ],
        },
      );

      expect(result.success).toBe(false);
      expect(result.errorType).toBe(TOOL_ERROR_TYPES.INVITE_GROUP_CONSENT_REQUIRED);
      expect(result.noMatchScript).toBeUndefined();
      expect(result.dissatisfiedRecommendationRounds).toBeUndefined();
      expect(result._replyInstruction).toContain('主 Agent 根据完整对话确认');
      expect(result._replyInstruction).toContain('不要再次调用 invite_to_group');
      expect(mockRoomService.addMemberEnterprise).not.toHaveBeenCalled();
    });

    it('两轮协议第二轮：上一轮已征询且本轮同意时无需重复查岗即可实调邀请', async () => {
      mockGroupResolver.resolveGroups.mockResolvedValue([makeGroup({ memberCount: 10 })]);
      mockRoomService.addMemberEnterprise.mockResolvedValue({ errcode: 0 });

      const result = await executeTool(
        { city: '上海' },
        {
          jobListExecuted: false,
          bookingSucceeded: undefined,
          currentUserMessage: '可以',
          messages: [
            { role: 'user', content: '我在上海找兼职' },
            {
              role: 'assistant',
              content: '可以邀请你进上海兼职岗位信息群，你愿意的话回复我“可以”',
            },
            { role: 'user', content: '可以' },
          ],
        },
      );
      await flushAsyncEvents();

      expect(result.success).toBe(true);
      expect(mockRoomService.addMemberEnterprise).toHaveBeenCalledTimes(1);
    });

    it('候选人正在追问报名/面试怎么走：拒绝拉群，指令回到约面收尾', async () => {
      const result = await executeTool(
        { city: '上海' },
        { currentUserMessage: '直接去门店面试吗还是怎么样', bookingSucceeded: undefined },
      );

      expect(result.success).toBe(false);
      expect(result.errorType).toBe(TOOL_ERROR_TYPES.INVITE_BOOKING_IN_PROGRESS);
      expect(result._replyInstruction).toContain('打断成单');
      expect(mockRoomService.addMemberEnterprise).not.toHaveBeenCalled();
    });

    it('本会话已给同城市拉过群：拒绝重复邀请并带出群名', async () => {
      const sessionService = {
        getSessionState: jest.fn().mockResolvedValue({
          invitedGroups: [{ groupName: '独立客&上海餐饮兼职②群', city: '上海' }],
        }),
        getFacts: jest.fn().mockResolvedValue(null),
      };

      const result = await executeTool({ city: '上海' }, undefined, { sessionService });

      expect(result.success).toBe(false);
      expect(result.errorType).toBe(TOOL_ERROR_TYPES.INVITE_ALREADY_INVITED);
      expect(result._replyInstruction).toContain('独立客&上海餐饮兼职②群');
      expect(mockRoomService.addMemberEnterprise).not.toHaveBeenCalled();
    });

    it('读取 invitedGroups 失败时按空降级，不挡住合法拉群', async () => {
      mockGroupResolver.resolveGroups.mockResolvedValue([makeGroup({ memberCount: 10 })]);
      mockRoomService.addMemberEnterprise.mockResolvedValue({ errcode: 0 });
      const sessionService = {
        getSessionState: jest.fn().mockRejectedValue(new Error('redis down')),
        getFacts: jest.fn().mockResolvedValue(null),
      };

      const result = await executeTool({ city: '上海' }, undefined, { sessionService });
      await flushAsyncEvents();

      expect(result.success).toBe(true);
    });
  });

  it('rejects district-level city input and instructs retry with city-level expectedCity', async () => {
    const result = await executeTool({ city: '静安区', industry: '餐饮' });

    expect(result.success).toBe(false);
    expect(result.errorType).toBe(TOOL_ERROR_TYPES.INVITE_INVALID_CITY_SCOPE);
    expect(result.city).toBe('静安区');
    expect(result.expectedCity).toBe('上海');
    expect(result.industry).toBe('餐饮');
    expect(result._replyInstruction).toContain('重新调用 invite_to_group');
    expect(result._replyInstruction).toContain('不要调用 request_handoff');
    expect(result._replyInstruction).toContain('不要说"该区域暂无兼职群"');
    expect(mockGroupResolver.resolveGroups).not.toHaveBeenCalled();
    expect(mockRoomService.addMemberEnterprise).not.toHaveBeenCalled();
  });

  it('documents that invite_to_group.city must not receive district or region names', () => {
    const builder = buildInviteToGroupTool({
      invite: jest.fn(),
      preflightExistingMembership: jest.fn(),
    } as any);
    const builtTool = builder(mockContext);

    expect(builtTool.description).toContain('候选人所在**城市级**名称');
    expect(builtTool.description).toContain('严禁把区域/区县/镇/街道/商圈/门店地址传给 city');
    expect(builtTool.description).toContain('city="上海"');
  });

  it('should return invite_card delivery for group with 40+ members', async () => {
    mockGroupResolver.resolveGroups.mockResolvedValue([makeGroup({ memberCount: 50 })]);
    mockRoomService.addMemberEnterprise.mockResolvedValue({ errcode: 0, errmsg: 'ok' });
    mockMemoryService.saveInvitedGroup.mockResolvedValue(undefined);

    const result = await executeTool({ city: '上海' });

    expect(result.success).toBe(true);
    expect(result.inviteDelivery).toBe('invite_card');
    expect(result.groupPurpose).toBe('job_pool');
    expect(result.inviteMode).toBeUndefined();
    expect(result._outcome).toContain('邀请卡片');
    expect(result._replyInstruction).toContain('上海兼职群1号');
    expect(result._replyInstruction).toContain('邀请已经发你了');
    expect(result._replyInstruction).toContain('不是面试群');
    expect(result._replyInstruction).toContain('不得把腾讯会议链接');
    expect(result._replyInstruction).toContain(
      '禁止输出、编造或粘贴任何 work.weixin.qq.com 群链接',
    );
  });

  it('should return error when no groups available', async () => {
    mockGroupResolver.resolveGroups.mockResolvedValue([]);

    const result = await executeTool({ city: '上海' });

    expect(result.success).toBe(false);
    expect(result.errorType).toBe(TOOL_ERROR_TYPES.INVITE_NO_GROUP_AVAILABLE);
    // 推荐无岗且本就没有兼职群（非群满）：不转人工，继续托管
    expect(result._replyInstruction).toContain('不要调用 request_handoff');
    expect(result._replyInstruction).toContain('保持托管');
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
    // 该城市本就没有兼职群（非群满）：不转人工，继续托管
    expect(result._replyInstruction).toContain('不要调用 request_handoff');
    expect(result._replyInstruction).toContain('保持托管');
    expect(mockRoomService.addMemberEnterprise).not.toHaveBeenCalled();
  });

  it('returns success with alreadyInGroup flag when API reports user is already in the target group', async () => {
    mockGroupResolver.resolveGroups.mockResolvedValue([makeGroup()]);
    mockRoomService.addMemberEnterprise.mockResolvedValue({
      errcode: -9,
      errmsg: '群聊中已经存在此好友',
    });

    const result = await executeTool({ city: '上海' });

    expect(result.success).toBe(true);
    expect(result.alreadyInGroup).toBe(true);
    expect(result.groupName).toBe('上海兼职群1号');
    expect(result._replyInstruction).toContain('不要承诺拉群');
    expect(result._replyInstruction).toContain('你已经在上海兼职群1号里了');
    expect(mockRoomService.addMemberEnterprise).toHaveBeenCalled();
    expect(mockMemoryService.saveInvitedGroup).toHaveBeenCalled();
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
    expect(mockRoomService.syncRoom).toHaveBeenCalled();
  });

  it('should skip a group whose refreshed enterprise count only matches by chatId', async () => {
    mockGroupResolver.resolveGroups.mockResolvedValue([
      makeGroup({
        imRoomId: 'room-1',
        chatId: 'chat-1',
        groupName: '独立客&上海餐饮兼职①群',
        industry: '餐饮',
        memberCount: 50,
      }),
      makeGroup({
        imRoomId: 'room-2',
        chatId: 'chat-2',
        groupName: '独立客&上海餐饮兼职②群',
        industry: '餐饮',
        memberCount: 80,
      }),
    ]);
    mockRoomService.getEnterpriseGroupChatList.mockResolvedValue({
      data: [
        { chatId: 'chat-1', member_count: 275 },
        { chatId: 'chat-2', member_count: 80 },
      ],
    });
    mockRoomService.addMemberEnterprise.mockResolvedValue({ errcode: 0, errmsg: 'ok' });
    mockMemoryService.saveInvitedGroup.mockResolvedValue(undefined);

    const result = await executeTool({ city: '上海', industry: '餐饮' });

    expect(result.success).toBe(true);
    expect(result.groupName).toBe('独立客&上海餐饮兼职②群');
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
    expect(result.inviteDelivery).toBe('direct_add');
    expect(result.inviteMode).toBeUndefined();
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

  it('should silently close out without alert or handoff when all groups reject with errcode=-8 (candidate blocked/removed bot)', async () => {
    mockGroupResolver.resolveGroups.mockResolvedValue([
      makeGroup({ imRoomId: 'room-1', groupName: '上海餐饮①', memberCount: 30 }),
      makeGroup({ imRoomId: 'room-2', groupName: '上海餐饮②', memberCount: 40 }),
    ]);
    mockRoomService.addMemberEnterprise.mockResolvedValue({
      errcode: -8,
      errmsg: 'is not a friend, wxid: cand-1',
    });

    const result = await executeTool({ city: '上海' });
    await flushAsyncEvents();

    expect(result.success).toBe(false);
    expect(result.errorType).toBe(TOOL_ERROR_TYPES.INVITE_CANDIDATE_NOT_FRIEND);
    // 不发运维告警
    expect(mockOpsNotifier.sendInviteRejectedAlert).not.toHaveBeenCalled();
    expect(mockOpsNotifier.sendGroupFullAlert).not.toHaveBeenCalled();
    // 指令明确不转人工、不提群、自然收口
    expect(result._replyInstruction).toContain('不要调用 request_handoff');
    expect(result._replyInstruction).not.toContain('运维');
    expect(mockMemoryService.saveInvitedGroup).not.toHaveBeenCalled();
  });

  it('treats errcode=-12 (invite card sent, pending consent) as success and stops trying other groups', async () => {
    // badcase batch_6a4f77b6ce406a6aeefd34a9：-12 实为"已发送入群邀请卡片、需对方同意"，
    // 此前被当失败换群重试，上海零售 5 个群连发了 5 张邀请卡片
    mockGroupResolver.resolveGroups.mockResolvedValue([
      makeGroup({ imRoomId: 'room-1', groupName: '上海零售①', memberCount: 50, industry: '零售' }),
      makeGroup({ imRoomId: 'room-2', groupName: '上海零售②', memberCount: 60, industry: '零售' }),
      makeGroup({ imRoomId: 'room-3', groupName: '上海零售③', memberCount: 70, industry: '零售' }),
    ]);
    mockRoomService.addMemberEnterprise.mockResolvedValue({
      errcode: -12,
      errmsg:
        'can not add room member by roomWxid: R:1, contactWxid: w1, wecomErrorTip: 已发送入群邀请给 候选人 ，为了减少打扰，需对方同意邀请后才会加入该外部群聊',
    });
    mockMemoryService.saveInvitedGroup.mockResolvedValue(undefined);

    const result = await executeTool({ city: '上海', industry: '零售' });
    await flushAsyncEvents();

    expect(result.success).toBe(true);
    expect(result.inviteDelivery).toBe('invite_card');
    expect(result.groupName).toBe('上海零售①');
    expect(result._outcome).toContain('入群邀请卡片');
    expect(result._replyInstruction).toContain('邀请已经发你了');
    // 只调一次拉群接口，不再换下一个候选群重发卡片
    expect(mockRoomService.addMemberEnterprise).toHaveBeenCalledTimes(1);
    expect(mockOpsNotifier.sendInviteRejectedAlert).not.toHaveBeenCalled();
    expect(mockMemoryService.saveInvitedGroup).toHaveBeenCalled();
    expect(mockOpsEventsRecorder.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventName: 'group.invited' }),
    );
  });

  it('treats an invite-card-sent errmsg as success even if the errcode differs from -12', async () => {
    mockGroupResolver.resolveGroups.mockResolvedValue([makeGroup({ memberCount: 30 })]);
    mockRoomService.addMemberEnterprise.mockResolvedValue({
      errcode: -99,
      errmsg: 'wecomErrorTip: 已发送入群邀请给 候选人 ，需对方同意邀请后才会加入该外部群聊',
    });
    mockMemoryService.saveInvitedGroup.mockResolvedValue(undefined);

    const result = await executeTool({ city: '上海' });
    await flushAsyncEvents();

    expect(result.success).toBe(true);
    // 已降级为邀请卡片投递，即使群人数<40 也不能按 direct_add 口径说"已帮你加入"
    expect(result.inviteDelivery).toBe('invite_card');
    expect(mockOpsNotifier.sendInviteRejectedAlert).not.toHaveBeenCalled();
  });

  it('should still alert when -8 is mixed with an actionable structural failure (400400)', async () => {
    mockGroupResolver.resolveGroups.mockResolvedValue([
      makeGroup({ imRoomId: 'room-1', groupName: '上海餐饮①', memberCount: 30 }),
      makeGroup({ imRoomId: 'room-2', groupName: '上海餐饮②', memberCount: 30 }),
    ]);
    mockRoomService.addMemberEnterprise
      .mockResolvedValueOnce({ errcode: -8, errmsg: 'is not a friend, wxid: cand-1' })
      .mockResolvedValueOnce({ errcode: 40003, errmsg: 'forbidden' });

    const result = await executeTool({ city: '上海' });
    await flushAsyncEvents();

    expect(result.errorType).toBe(TOOL_ERROR_TYPES.INVITE_API_REJECTED);
    expect(mockOpsNotifier.sendInviteRejectedAlert).toHaveBeenCalled();
  });

  it('should add the chat bot to the group and retry when chat bot cannot see the room', async () => {
    mockGroupResolver.resolveGroups.mockResolvedValue([
      makeGroup({
        imRoomId: 'room-1',
        groupName: '上海零售①',
        imBotId: 'owner-bot-im',
        botUserId: 'owner-bot-weixin',
      }),
    ]);
    mockRoomService.addMemberEnterprise
      .mockResolvedValueOnce({ errcode: 400400, errmsg: 'room not found' })
      .mockResolvedValueOnce({ errcode: 0, errmsg: 'ok' })
      .mockResolvedValueOnce({ errcode: 0, errmsg: 'ok' });
    mockMemoryService.saveInvitedGroup.mockResolvedValue(undefined);

    const result = await executeTool({ city: '上海' });
    await flushAsyncEvents();

    expect(result.success).toBe(true);
    expect(result.groupName).toBe('上海零售①');
    expect(mockRoomService.addMemberEnterprise).toHaveBeenCalledTimes(3);
    expect(mockRoomService.addMemberEnterprise).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        imBotId: 'chat-bot-im-id',
        botUserId: 'chat-bot-weixin',
        roomWxid: 'room-1',
      }),
    );
    expect(mockRoomService.addMemberEnterprise).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        imBotId: 'owner-bot-im',
        botUserId: 'owner-bot-weixin',
        contactWxid: 'chat-bot-im-id',
        roomWxid: 'room-1',
      }),
    );
    expect(mockRoomService.addMemberEnterprise).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        imBotId: 'chat-bot-im-id',
        botUserId: 'chat-bot-weixin',
        contactWxid: 'user-1',
        roomWxid: 'room-1',
      }),
    );
    expect(mockOpsNotifier.sendInviteRejectedAlert).not.toHaveBeenCalled();
  });

  it('should retry with backoff after adding chat bot when room data has not synced yet', async () => {
    jest.useFakeTimers();
    try {
      mockGroupResolver.resolveGroups.mockResolvedValue([
        makeGroup({
          imRoomId: 'room-1',
          groupName: '上海零售①',
          imBotId: 'owner-bot-im',
          botUserId: 'owner-bot-weixin',
        }),
      ]);
      mockRoomService.addMemberEnterprise
        .mockResolvedValueOnce({ errcode: 400400, errmsg: 'room not found' }) // 初次拉候选人
        .mockResolvedValueOnce({ errcode: 0, errmsg: 'ok' }) // 群主 bot 拉接客 bot 入群
        .mockResolvedValueOnce({ errcode: 400400, errmsg: 'room not found' }) // 立即重试：入群尚未生效
        .mockResolvedValueOnce({ errcode: 0, errmsg: 'ok' }); // 退避后重试成功
      mockMemoryService.saveInvitedGroup.mockResolvedValue(undefined);

      const promise = executeTool({ city: '上海' });
      await jest.runAllTimersAsync();
      const result = await promise;

      expect(result.success).toBe(true);
      expect(result.groupName).toBe('上海零售①');
      expect(mockRoomService.addMemberEnterprise).toHaveBeenCalledTimes(4);
      // 每轮重试前都触发接客 bot 的 syncRoom 刷新平台侧群数据
      expect(mockRoomService.syncRoom).toHaveBeenCalledWith(
        'enterprise-token-test',
        'chat-bot-im-id',
      );
      expect(mockOpsNotifier.sendInviteRejectedAlert).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('should give up after exhausting backoff retries and report attempt count', async () => {
    jest.useFakeTimers();
    try {
      mockGroupResolver.resolveGroups.mockResolvedValue([
        makeGroup({
          imRoomId: 'room-1',
          groupName: '上海零售①',
          imBotId: 'owner-bot-im',
          botUserId: 'owner-bot-weixin',
        }),
      ]);
      mockRoomService.addMemberEnterprise
        .mockResolvedValueOnce({ errcode: 400400, errmsg: 'room not found' }) // 初次拉候选人
        .mockResolvedValueOnce({ errcode: 0, errmsg: 'ok' }) // 群主 bot 拉接客 bot 入群
        .mockResolvedValue({ errcode: 400400, errmsg: 'room not found' }); // 全部重试均未生效

      const promise = executeTool({ city: '上海' });
      await jest.runAllTimersAsync();
      const result = await promise;

      expect(result.success).toBe(false);
      expect(result.errorType).toBe(TOOL_ERROR_TYPES.INVITE_API_REJECTED);
      // 1 次立即重试 + 3 次退避重试
      expect(result.reason).toContain('4 attempts with backoff');
      // 1 初次 + 1 addBot + 4 重试
      expect(mockRoomService.addMemberEnterprise).toHaveBeenCalledTimes(6);
      expect(mockOpsNotifier.sendInviteRejectedAlert).toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
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
      makeGroup({
        imRoomId: 'room-1',
        groupName: '上海零售①',
        imBotId: 'owner-bot-im',
        botUserId: 'owner-bot-weixin',
      }),
      makeGroup({
        imRoomId: 'room-2',
        groupName: '上海零售②',
        imBotId: 'owner-bot-im',
        botUserId: 'owner-bot-weixin',
      }),
    ]);
    mockRoomService.addMemberEnterprise.mockResolvedValue({
      errcode: 400400,
      errmsg: 'room not found',
    });

    const result = await executeTool({ city: '上海' });
    await flushAsyncEvents();

    expect(result.success).toBe(false);
    expect(result.errorType).toBe(TOOL_ERROR_TYPES.INVITE_API_REJECTED);
    expect(mockRoomService.addMemberEnterprise).toHaveBeenCalledTimes(4);
    expect(mockOpsNotifier.sendGroupFullAlert).not.toHaveBeenCalled();
    expect(mockOpsNotifier.sendInviteRejectedAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        city: '上海',
        chatBotImId: 'chat-bot-im-id',
        rejectedGroups: expect.arrayContaining([
          expect.objectContaining({
            name: '上海零售①',
            ownerBotImId: 'owner-bot-im',
            error: expect.stringContaining('add chat bot to group rejected'),
          }),
          expect.objectContaining({
            name: '上海零售②',
            ownerBotImId: 'owner-bot-im',
            error: expect.stringContaining('add chat bot to group rejected'),
          }),
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
    const builder = buildInviteToGroupTool({
      preflightExistingMembership: jest.fn().mockResolvedValue(null),
      invite: jest.fn().mockResolvedValue({
        success: false,
        reason: 'enterprise_token_missing',
      }),
    } as unknown as GroupInviteService);
    const builtTool = builder(mockContext);

    const result = await builtTool.execute({ city: '上海' } as any, {
      toolCallId: 'test',
      context: {},
      messages: [],
      abortSignal: undefined as any,
    });

    expect(result).toMatchObject({
      success: false,
      errorType: TOOL_ERROR_TYPES.INVITE_ENTERPRISE_TOKEN_MISSING,
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

  describe('city provenance gate (badcase recvk28F1xrsKj)', () => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const executeToolWithSession = async (
      input: { city: string; industry?: string },
      sessionService: unknown,
      overrideContext?: InviteContextOverrides,
    ) => {
      const service = await createGroupInviteService();
      const groupInviteService = {
        invite: service.invite.bind(service),
        preflightExistingMembership: jest.fn().mockResolvedValue(null),
      } as unknown as GroupInviteService;
      const builder = buildInviteToGroupTool(groupInviteService, sessionService as any);
      const builtTool = builder(buildContext(overrideContext));
      return builtTool.execute(input as any, {
        toolCallId: 'test',
        context: {},
        messages: [],
        abortSignal: undefined as any,
      }) as any;
    };
    /* eslint-enable @typescript-eslint/no-explicit-any */

    const makeSessionService = (cityValue: string | null, confidence: 'high' | 'low' = 'high') => ({
      getFacts: jest.fn().mockResolvedValue(
        cityValue
          ? {
              preferences: {
                city: { value: cityValue, confidence, source: 'rule', evidence: 'explicit_city' },
              },
            }
          : { preferences: { city: null } },
      ),
    });

    it('rejects with city_unverified when city has no source (no session fact, not in user text)', async () => {
      const result = await executeTool({ city: '杭州' });

      expect(result.success).toBe(false);
      expect(result.errorType).toBe(TOOL_ERROR_TYPES.INVITE_CITY_UNVERIFIED);
      expect(result._replyInstruction).toContain('确认所在城市');
      expect(mockGroupResolver.resolveGroups).not.toHaveBeenCalled();
    });

    it('rejects with city_conflict and expectedCity when session fact disagrees', async () => {
      const sessionService = makeSessionService('上海');
      const result = await executeToolWithSession({ city: '杭州' }, sessionService);

      expect(result.success).toBe(false);
      expect(result.errorType).toBe(TOOL_ERROR_TYPES.INVITE_CITY_CONFLICT);
      expect(result.expectedCity).toBe('上海');
      expect(mockGroupResolver.resolveGroups).not.toHaveBeenCalled();
    });

    it('allows via session fact when candidate never typed the city this session', async () => {
      const sessionService = makeSessionService('杭州');
      mockGroupResolver.resolveGroups.mockResolvedValue([]);

      const result = await executeToolWithSession({ city: '杭州市' }, sessionService, {
        messages: [{ role: 'user', content: '在吗' }],
      });

      // gate 放行后进入正常流程（无群数据 → no_group_available），证明未被 gate 拦截
      expect(result.errorType).toBe(TOOL_ERROR_TYPES.INVITE_NO_GROUP_AVAILABLE);
      expect(mockGroupResolver.resolveGroups).toHaveBeenCalled();
    });

    it('ignores low-confidence session city and falls back to user text grounding', async () => {
      const sessionService = makeSessionService('北京', 'low');
      mockGroupResolver.resolveGroups.mockResolvedValue([]);

      const result = await executeToolWithSession({ city: '上海' }, sessionService);

      expect(result.errorType).toBe(TOOL_ERROR_TYPES.INVITE_NO_GROUP_AVAILABLE);
    });

    it('degrades to user-text-only grounding when session facts read fails', async () => {
      const sessionService = {
        getFacts: jest.fn().mockRejectedValue(new Error('redis down')),
      };
      mockGroupResolver.resolveGroups.mockResolvedValue([]);

      const result = await executeToolWithSession({ city: '上海' }, sessionService);

      expect(result.errorType).toBe(TOOL_ERROR_TYPES.INVITE_NO_GROUP_AVAILABLE);
    });

    it('keeps district-scope rejection ahead of the provenance gate', async () => {
      const result = await executeTool({ city: '静安区' });

      expect(result.errorType).toBe(TOOL_ERROR_TYPES.INVITE_INVALID_CITY_SCOPE);
    });
  });

  describe('前置已在群闸门 (badcase batch_6a4790c7)', () => {
    // badcase 场景：候选人已在苏州群，模型无视注入调用 invite_to_group(city=苏州)，
    // 且"苏州"在会话记忆/候选人原文中均无出处。旧行为：city_unverified 引导模型
    // 追问城市继续推进拉群；新行为：已在群实时核验短路成功，不再要求城市出处。
    const noCityContext = { messages: [{ role: 'user' as const, content: '花桥中骏有岗位吗' }] };

    it('candidate already in requested-city group short-circuits success even without city provenance', async () => {
      mockGroupResolver.resolveGroups.mockResolvedValue([
        makeGroup({ imRoomId: 'room-sz', groupName: '独立客&苏州餐饮兼职群', city: '苏州' }),
      ]);
      const groupMembership = {
        listUserRooms: jest.fn().mockResolvedValue(['room-sz']),
      };

      const result = await executeTool({ city: '苏州', industry: '餐饮' }, noCityContext, {
        groupMembership,
      });
      await flushAsyncEvents();

      expect(result.success).toBe(true);
      expect(result.alreadyInGroup).toBe(true);
      expect(result.groupName).toBe('独立客&苏州餐饮兼职群');
      expect(result._replyInstruction).toContain('不要承诺拉群');
      expect(groupMembership.listUserRooms).toHaveBeenCalledWith('user-1', ['room-sz']);
      // 短路发生在企业接口之前
      expect(mockRoomService.addMemberEnterprise).not.toHaveBeenCalled();
      // 记忆写入，防同会话重复触发
      expect(mockMemoryService.saveInvitedGroup).toHaveBeenCalled();
    });

    it('candidate not in any group falls through to the provenance gate (city_unverified preserved)', async () => {
      mockGroupResolver.resolveGroups.mockResolvedValue([
        makeGroup({ imRoomId: 'room-sz', groupName: '独立客&苏州餐饮兼职群', city: '苏州' }),
      ]);
      const groupMembership = {
        listUserRooms: jest.fn().mockResolvedValue([]),
      };

      const result = await executeTool({ city: '苏州' }, noCityContext, { groupMembership });

      expect(result.success).toBe(false);
      expect(result.errorType).toBe(TOOL_ERROR_TYPES.INVITE_CITY_UNVERIFIED);
      expect(mockRoomService.addMemberEnterprise).not.toHaveBeenCalled();
    });

    it('membership check failure degrades silently to the original flow', async () => {
      mockGroupResolver.resolveGroups.mockResolvedValue([
        makeGroup({ imRoomId: 'room-sz', groupName: '独立客&苏州餐饮兼职群', city: '苏州' }),
      ]);
      const groupMembership = {
        listUserRooms: jest.fn().mockRejectedValue(new Error('redis down')),
      };

      const result = await executeTool({ city: '苏州' }, noCityContext, { groupMembership });

      expect(result.success).toBe(false);
      expect(result.errorType).toBe(TOOL_ERROR_TYPES.INVITE_CITY_UNVERIFIED);
    });

    it('membership in another city does not bypass the provenance gate', async () => {
      // 候选人在上海群，但模型请求的是苏州——跨城市在群不构成"目标城市已达成"
      mockGroupResolver.resolveGroups.mockResolvedValue([
        makeGroup({ imRoomId: 'room-sh', groupName: '上海兼职群1号', city: '上海' }),
        makeGroup({ imRoomId: 'room-sz', groupName: '独立客&苏州餐饮兼职群', city: '苏州' }),
      ]);
      const groupMembership = {
        listUserRooms: jest.fn().mockResolvedValue([]),
      };

      const result = await executeTool({ city: '苏州' }, noCityContext, { groupMembership });

      expect(result.success).toBe(false);
      expect(result.errorType).toBe(TOOL_ERROR_TYPES.INVITE_CITY_UNVERIFIED);
      // 只用苏州群的 roomId 做核验，不把上海群算进来
      expect(groupMembership.listUserRooms).toHaveBeenCalledWith('user-1', ['room-sz']);
    });
  });

  describe('testing strategy source (test-suite 重放链路)', () => {
    it('returns simulated success without touching enterprise APIs', async () => {
      const groupMembership = { listUserRooms: jest.fn().mockResolvedValue([]) };
      const result = await executeTool(
        { city: '上海' },
        { strategySource: 'testing' },
        { groupMembership },
      );

      expect(result.success).toBe(true);
      expect(result.simulated).toBe(true);
      expect(result.inviteDelivery).toBe('invite_card');
      expect(groupMembership.listUserRooms).not.toHaveBeenCalled();
      expect(mockGroupResolver.resolveGroups).not.toHaveBeenCalled();
      expect(mockRoomService.addMemberEnterprise).not.toHaveBeenCalled();
    });

    it('still enforces the city provenance gate before simulating', async () => {
      const result = await executeTool({ city: '杭州' }, { strategySource: 'testing' });

      expect(result.success).toBe(false);
      expect(result.errorType).toBe(TOOL_ERROR_TYPES.INVITE_CITY_UNVERIFIED);
    });

    it('still rejects district-level city input before simulating', async () => {
      const result = await executeTool({ city: '静安区' }, { strategySource: 'testing' });

      expect(result.errorType).toBe(TOOL_ERROR_TYPES.INVITE_INVALID_CITY_SCOPE);
    });
  });
});

import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { GroupInviteService } from '@biz/group-task/services/group-invite.service';
import { GroupMembershipService } from '@biz/group-task/services/group-membership.service';
import { GroupResolverService } from '@biz/group-task/services/group-resolver.service';
import { OpsEventsRecorderService } from '@biz/ops-events/services/ops-events-recorder.service';
import { RoomService } from '@channels/wecom/room/room.service';
import { MemoryService } from '@memory/memory.service';
import type { SessionStateService } from '@memory/short-term/session-state.service';
import { OpsNotifierService } from '@notification/services/ops-notifier.service';
import {
  buildGroupInviteInput,
  readSessionCityForInvite,
  runGroupInvitePipeline,
} from '@tools/invite/group-invite-pipeline';
import { createToolContext } from '../../helpers/tool-context.fixture';

/**
 * 拉群共用流水线：invite_to_group 工具与报名后运行时拉群同走这一段闸门与执行。
 * 顺序固定：重复邀请 gate → 前置已在群闸门 → 城市 provenance gate → testing 模拟 → 真实邀请。
 * 区县入参（"静安区"）的 INVALID_CITY_SCOPE 拒绝发生在工具层、流水线之前，不在本文件覆盖。
 */
describe('runGroupInvitePipeline', () => {
  const logger = new Logger('test');
  const groupInviteService = {
    preflightExistingMembership: jest.fn(),
    invite: jest.fn(),
  };
  const sessionService = {
    getSessionState: jest.fn(),
    getFacts: jest.fn(),
  };

  const cityFact = (city: string, confidence: 'high' | 'medium' | 'low' = 'high') => ({
    preferences: {
      city: { value: city, confidence, source: 'candidate_quote', evidence: '原文' },
    },
  });

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    groupInviteService.preflightExistingMembership.mockResolvedValue(null);
    groupInviteService.invite.mockResolvedValue({
      success: true,
      groupName: '上海餐饮群',
      inviteDelivery: 'invite_card',
    });
    sessionService.getSessionState.mockResolvedValue({ invitedGroups: [] });
    sessionService.getFacts.mockResolvedValue(cityFact('上海'));
  });

  const buildContext = (contextOverrides: Parameters<typeof createToolContext>[0] = {}) =>
    createToolContext({
      session: {
        corpId: 'corp-1',
        userId: 'user-1',
        sessionId: 'session-1',
        botImId: 'bot-A',
        botUserId: 'wecom-user-A',
        turnId: 'turn-1',
        contactName: '兮兮',
        chatId: 'chat-1',
      },
      ...contextOverrides,
    });

  const run = (
    overrides: Partial<Parameters<typeof runGroupInvitePipeline>[0]> = {},
    contextOverrides: Parameters<typeof createToolContext>[0] = {},
  ) =>
    runGroupInvitePipeline({
      context: buildContext(contextOverrides),
      city: '上海',
      groupInviteService: groupInviteService as unknown as GroupInviteService,
      sessionService: sessionService as unknown as SessionStateService,
      logger,
      ...overrides,
    });

  describe('重复邀请 gate（第一道）', () => {
    it('本会话已给同城市拉过群：短路 already_invited 并带出群名，不触达任何服务', async () => {
      sessionService.getSessionState.mockResolvedValue({
        invitedGroups: [{ groupName: '独立客&上海餐饮兼职②群', city: '上海', invitedAt: 'x' }],
      });

      const outcome = await run();

      expect(outcome).toEqual({
        kind: 'already_invited',
        verdict: {
          decision: 'reject',
          reason: 'already_invited_city',
          invitedGroupName: '独立客&上海餐饮兼职②群',
        },
      });
      expect(groupInviteService.preflightExistingMembership).not.toHaveBeenCalled();
      expect(groupInviteService.invite).not.toHaveBeenCalled();
      expect(sessionService.getFacts).not.toHaveBeenCalled();
    });

    it('已拉过的是别的城市：放行（候选人换城市是合法场景）', async () => {
      sessionService.getSessionState.mockResolvedValue({
        invitedGroups: [{ groupName: '杭州餐饮群', city: '杭州' }],
      });

      const outcome = await run();

      expect(outcome.kind).toBe('invited');
      expect(groupInviteService.invite).toHaveBeenCalledTimes(1);
    });

    it('未注入 sessionService 时用归档快照 archive.invitedGroups 判重', async () => {
      const outcome = await run(
        { sessionService: undefined },
        {
          archive: { invitedGroups: [{ groupName: '上海餐饮群①', city: '上海', invitedAt: 'x' }] },
        },
      );

      expect(outcome).toMatchObject({
        kind: 'already_invited',
        verdict: { invitedGroupName: '上海餐饮群①' },
      });
      expect(groupInviteService.invite).not.toHaveBeenCalled();
    });

    it('读取会话状态失败时回落归档快照，不挡住合法拉群', async () => {
      sessionService.getSessionState.mockRejectedValue(new Error('redis down'));

      const outcome = await run({}, { archive: { invitedGroups: [] } });

      expect(outcome.kind).toBe('invited');
      expect(groupInviteService.invite).toHaveBeenCalledTimes(1);
    });
  });

  describe('前置已在群闸门（第二道）', () => {
    it('候选人已在目标城市群：短路 already_in_group，不要求城市出处、不触达邀请接口', async () => {
      const membership = { success: true, alreadyInGroup: true, groupName: '上海零售群' };
      groupInviteService.preflightExistingMembership.mockResolvedValue(membership);
      sessionService.getFacts.mockResolvedValue(null);

      const outcome = await run({ city: '苏州' }, { turnInput: { messages: [] } });

      expect(outcome).toEqual({ kind: 'already_in_group', result: membership });
      expect(groupInviteService.preflightExistingMembership).toHaveBeenCalledWith(
        expect.objectContaining({ city: '苏州', contactWxid: 'user-1' }),
      );
      // 城市 gate 在闸门之后，已在群短路时根本不读城市事实
      expect(sessionService.getFacts).not.toHaveBeenCalled();
      expect(groupInviteService.invite).not.toHaveBeenCalled();
    });

    it('前置闸门未命中（null）时继续走城市 gate 与真实邀请', async () => {
      groupInviteService.preflightExistingMembership.mockResolvedValue(null);

      const outcome = await run();

      expect(outcome.kind).toBe('invited');
      expect(groupInviteService.preflightExistingMembership).toHaveBeenCalledTimes(1);
      expect(groupInviteService.invite).toHaveBeenCalledTimes(1);
    });

    it('闸门排在重复邀请 gate 之后：同城市已拉过时不再触达群成员接口', async () => {
      sessionService.getSessionState.mockResolvedValue({
        invitedGroups: [{ groupName: '上海餐饮群', city: '上海' }],
      });
      groupInviteService.preflightExistingMembership.mockResolvedValue({
        success: true,
        alreadyInGroup: true,
        groupName: '上海餐饮群',
      });

      const outcome = await run();

      expect(outcome.kind).toBe('already_invited');
      expect(groupInviteService.preflightExistingMembership).not.toHaveBeenCalled();
    });
  });

  describe('城市 provenance gate（第三道）', () => {
    it('city 无任何出处（无会话事实、原文未提、无地名推断）：city_rejected/city_unverified', async () => {
      sessionService.getFacts.mockResolvedValue(null);

      const outcome = await run({ city: '杭州' }, { turnInput: { messages: [] } });

      expect(outcome).toEqual({
        kind: 'city_rejected',
        verdict: { decision: 'reject', reason: 'city_unverified' },
      });
      expect(groupInviteService.invite).not.toHaveBeenCalled();
    });

    it('会话记忆城市与入参不一致：city_conflict 并给出 expectedCity 供纠正', async () => {
      sessionService.getFacts.mockResolvedValue(cityFact('上海'));

      const outcome = await run({ city: '杭州' }, { turnInput: { messages: [] } });

      expect(outcome).toEqual({
        kind: 'city_rejected',
        verdict: { decision: 'reject', reason: 'city_conflict', expectedCity: '上海' },
      });
      expect(groupInviteService.invite).not.toHaveBeenCalled();
    });

    it('候选人只报了区名（地名白名单推断出城市）：district_inference 放行', async () => {
      sessionService.getFacts.mockResolvedValue(null);

      const outcome = await run(
        { city: '上海' },
        {
          turnInput: { messages: [{ role: 'user', content: '我在静安区找兼职' }] },
          ledger: { geo: { signalCities: new Set(['上海']) } },
        },
      );

      expect(outcome.kind).toBe('invited');
      expect(groupInviteService.invite).toHaveBeenCalledWith(
        expect.objectContaining({ city: '上海' }),
      );
    });

    it('候选人原文提过城市：user_text 放行，即使会话事实置信不足', async () => {
      sessionService.getFacts.mockResolvedValue(cityFact('北京', 'low'));

      const outcome = await run(
        { city: '上海' },
        { turnInput: { messages: [{ role: 'user', content: '我在上海找兼职' }] } },
      );

      expect(outcome.kind).toBe('invited');
    });

    it('本轮 geocode 确权城市（cityAttestation）作第四档出处放行', async () => {
      sessionService.getFacts.mockResolvedValue(null);

      const outcome = await run(
        { city: '苏州' },
        {
          turnInput: { messages: [] },
          ledger: {
            geo: {
              cityAttestation: { city: '苏州', evidence: 'amap 解析', source: 'geocode_unique' },
            },
          },
        },
      );

      expect(outcome.kind).toBe('invited');
      expect(groupInviteService.invite).toHaveBeenCalledWith(
        expect.objectContaining({ city: '苏州' }),
      );
    });

    it('读取城市事实失败时按无事实降级，仍可凭原文出处放行', async () => {
      sessionService.getFacts.mockRejectedValue(new Error('redis down'));

      const outcome = await run(
        { city: '上海' },
        { turnInput: { messages: [{ role: 'user', content: '我在上海' }] } },
      );

      expect(outcome.kind).toBe('invited');
    });
  });

  describe('testing 链路（第四道）', () => {
    it('strategySource=testing：跳过群成员核验、返回模拟成功、不调 invite', async () => {
      const outcome = await run({}, { runtime: { strategySource: 'testing' } });

      expect(outcome).toEqual({ kind: 'simulated', groupName: '上海兼职群（测试模拟）' });
      expect(groupInviteService.preflightExistingMembership).not.toHaveBeenCalled();
      expect(groupInviteService.invite).not.toHaveBeenCalled();
    });

    it('testing 链路仍先过城市 provenance gate', async () => {
      sessionService.getFacts.mockResolvedValue(null);

      const outcome = await run(
        { city: '杭州' },
        { runtime: { strategySource: 'testing' }, turnInput: { messages: [] } },
      );

      expect(outcome).toMatchObject({
        kind: 'city_rejected',
        verdict: { reason: 'city_unverified' },
      });
    });

    it('testing 链路仍先过重复邀请 gate', async () => {
      sessionService.getSessionState.mockResolvedValue({
        invitedGroups: [{ groupName: '上海餐饮群', city: '上海' }],
      });

      const outcome = await run({}, { runtime: { strategySource: 'testing' } });

      expect(outcome.kind).toBe('already_invited');
    });
  });

  describe('真实邀请（第五道）：透传 GroupInviteService.invite 结果', () => {
    it('invite_card 结果原样透传，并把会话身份/城市/行业组装进 GroupInviteInput', async () => {
      const outcome = await run({ industry: '餐饮' });

      expect(outcome).toEqual({
        kind: 'invited',
        result: { success: true, groupName: '上海餐饮群', inviteDelivery: 'invite_card' },
      });
      expect(groupInviteService.invite).toHaveBeenCalledWith({
        corpId: 'corp-1',
        userId: 'user-1',
        sessionId: 'session-1',
        botImId: 'bot-A',
        botUserId: 'wecom-user-A',
        contactWxid: 'user-1',
        city: '上海',
        industry: '餐饮',
        turnKey: 'turn-1',
        messageId: 'turn-1',
        contactName: '兮兮',
        chatId: 'chat-1',
      });
    });

    it('direct_add 结果原样透传', async () => {
      const result = {
        success: true,
        groupName: '上海餐饮群',
        inviteDelivery: 'direct_add',
        selectionReason: 'only_option',
      };
      groupInviteService.invite.mockResolvedValue(result);

      const outcome = await run();

      expect(outcome).toEqual({ kind: 'invited', result });
    });

    it('服务返回业务失败（无群/群满）时仍是 invited 形态，由调用方按 reason 处置', async () => {
      groupInviteService.invite.mockResolvedValue({ success: false, reason: 'group_full' });

      const outcome = await run();

      expect(outcome).toEqual({
        kind: 'invited',
        result: { success: false, reason: 'group_full' },
      });
    });

    it('invite 抛错时流水线不吞异常，原样向上抛给调用方 catch', async () => {
      groupInviteService.invite.mockRejectedValue(new Error('WeChat API timeout'));

      await expect(run()).rejects.toThrow('WeChat API timeout');
    });

    it('preflightExistingMembership 抛错同样透传（服务内部本应静默降级为 null）', async () => {
      groupInviteService.preflightExistingMembership.mockRejectedValue(new Error('boom'));

      await expect(run()).rejects.toThrow('boom');
      expect(groupInviteService.invite).not.toHaveBeenCalled();
    });
  });

  describe('errcode=-12（已发邀请卡片、待对方同意）经真实 GroupInviteService 视为成功', () => {
    const mockGroupResolver = { resolveGroups: jest.fn() };
    const mockRoomService = {
      addMemberEnterprise: jest.fn(),
      getEnterpriseGroupChatList: jest.fn(),
      syncRoom: jest.fn(),
    };
    const mockOpsNotifier = {
      sendGroupFullAlert: jest.fn().mockResolvedValue(true),
      sendInviteRejectedAlert: jest.fn().mockResolvedValue(true),
    };
    const mockMemoryService = { saveInvitedGroup: jest.fn().mockResolvedValue(undefined) };
    const mockOpsEventsRecorder = { recordEvent: jest.fn().mockResolvedValue(true) };

    const createRealGroupInviteService = async (): Promise<GroupInviteService> => {
      const moduleRef = await Test.createTestingModule({
        providers: [
          GroupInviteService,
          { provide: GroupResolverService, useValue: mockGroupResolver },
          {
            provide: GroupMembershipService,
            useValue: { listUserRooms: jest.fn().mockResolvedValue([]) },
          },
          { provide: RoomService, useValue: mockRoomService },
          { provide: MemoryService, useValue: mockMemoryService },
          { provide: OpsEventsRecorderService, useValue: mockOpsEventsRecorder },
          { provide: OpsNotifierService, useValue: mockOpsNotifier },
          {
            provide: ConfigService,
            useValue: {
              get: (key: string, fallback?: string) => {
                if (key === 'GROUP_MEMBER_LIMIT') return '200';
                if (key === 'STRIDE_ENTERPRISE_TOKEN') return 'enterprise-token-test';
                return fallback;
              },
            },
          },
        ],
      }).compile();
      return moduleRef.get(GroupInviteService);
    };

    it('-12 不算失败：只调一次企业接口、结果透传为 invite_card 成功', async () => {
      mockGroupResolver.resolveGroups.mockResolvedValue([
        {
          imRoomId: 'room-1',
          groupName: '上海零售①',
          city: '上海',
          tag: '兼职群',
          imBotId: 'bot-1',
          token: 'token-1',
          memberCount: 50,
          industry: '零售',
        },
        {
          imRoomId: 'room-2',
          groupName: '上海零售②',
          city: '上海',
          tag: '兼职群',
          imBotId: 'bot-1',
          token: 'token-1',
          memberCount: 60,
          industry: '零售',
        },
      ]);
      mockRoomService.getEnterpriseGroupChatList.mockResolvedValue({ data: [] });
      mockRoomService.addMemberEnterprise.mockResolvedValue({
        errcode: -12,
        errmsg: 'wecomErrorTip: 已发送入群邀请给 候选人 ，需对方同意邀请后才会加入该外部群聊',
      });
      const service = await createRealGroupInviteService();

      const outcome = await runGroupInvitePipeline({
        context: buildContext({
          turnInput: { messages: [{ role: 'user', content: '我在上海找兼职' }] },
        }),
        city: '上海',
        industry: '零售',
        groupInviteService: service,
        sessionService: sessionService as unknown as SessionStateService,
        logger,
      });

      expect(outcome).toMatchObject({
        kind: 'invited',
        result: { success: true, groupName: '上海零售①', inviteDelivery: 'invite_card' },
      });
      expect(mockRoomService.addMemberEnterprise).toHaveBeenCalledTimes(1);
      expect(mockOpsNotifier.sendInviteRejectedAlert).not.toHaveBeenCalled();
      expect(mockMemoryService.saveInvitedGroup).toHaveBeenCalled();
    });
  });
});

describe('buildGroupInviteInput', () => {
  it('botImId/botUserId 缺失时补空串，chatId 缺失时回落 sessionId，turnKey 缺失时用时间戳', () => {
    jest.spyOn(Date, 'now').mockReturnValue(1700000000000);
    try {
      const context = createToolContext({
        session: { corpId: 'corp-1', userId: 'user-1', sessionId: 'session-1' },
      });

      expect(buildGroupInviteInput(context, '上海')).toEqual({
        corpId: 'corp-1',
        userId: 'user-1',
        sessionId: 'session-1',
        botImId: '',
        botUserId: '',
        contactWxid: 'user-1',
        city: '上海',
        industry: undefined,
        turnKey: '1700000000000',
        messageId: undefined,
        contactName: undefined,
        chatId: 'session-1',
      });
    } finally {
      jest.restoreAllMocks();
    }
  });
});

describe('readSessionCityForInvite', () => {
  const logger = new Logger('test');
  const context = createToolContext({
    session: { corpId: 'corp-1', userId: 'user-1', sessionId: 'session-1' },
  });

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const withFacts = (facts: unknown) =>
    ({ getFacts: jest.fn().mockResolvedValue(facts) }) as unknown as SessionStateService;

  it('未注入 sessionService 返回 null', async () => {
    await expect(readSessionCityForInvite(context, undefined, logger)).resolves.toBeNull();
  });

  it('高置信城市事实返回去空白后的城市名', async () => {
    const sessionService = withFacts({
      preferences: { city: { value: ' 上海 ', confidence: 'high', source: 'rule' } },
    });
    await expect(readSessionCityForInvite(context, sessionService, logger)).resolves.toBe('上海');
  });

  it('置信不足（medium/low）或值为空/非字符串时返回 null', async () => {
    await expect(
      readSessionCityForInvite(
        context,
        withFacts({ preferences: { city: { value: '上海', confidence: 'medium' } } }),
        logger,
      ),
    ).resolves.toBeNull();
    await expect(
      readSessionCityForInvite(
        context,
        withFacts({ preferences: { city: { value: '  ', confidence: 'high' } } }),
        logger,
      ),
    ).resolves.toBeNull();
    await expect(
      readSessionCityForInvite(
        context,
        withFacts({ preferences: { city: { value: 123, confidence: 'high' } } }),
        logger,
      ),
    ).resolves.toBeNull();
    await expect(readSessionCityForInvite(context, withFacts(null), logger)).resolves.toBeNull();
  });

  it('读取抛错时按无事实降级返回 null，不向上抛', async () => {
    const sessionService = {
      getFacts: jest.fn().mockRejectedValue(new Error('redis down')),
    } as unknown as SessionStateService;
    await expect(readSessionCityForInvite(context, sessionService, logger)).resolves.toBeNull();
  });
});

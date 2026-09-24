import { Logger } from '@nestjs/common';
import type { GroupInviteService } from '@biz/group-task/services/group-invite.service';
import type { SessionStateService } from '@memory/short-term/session-state.service';
import {
  buildPostBookingGroupInviteGuide,
  describePostBookingGroupInviteForEvent,
  runPostBookingGroupInvite,
} from '@tools/invite/post-booking-group-invite';
import { createToolContext } from '../../helpers/tool-context.fixture';

/**
 * 报名成功后运行时拉群（PRD R3）：触发条件全是确定信息，闸门与 invite_to_group 共用。
 */
describe('runPostBookingGroupInvite', () => {
  const logger = new Logger('test');
  const groupInviteService = {
    preflightExistingMembership: jest.fn(),
    invite: jest.fn(),
  };
  const sessionService = {
    getSessionState: jest.fn(),
    getFacts: jest.fn(),
  };

  const highCity = (city: string) => ({
    preferences: {
      city: { value: city, confidence: 'high', source: 'candidate_quote', evidence: '原文' },
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
    sessionService.getFacts.mockResolvedValue(highCity('上海'));
  });

  const run = (
    overrides: Partial<Parameters<typeof runPostBookingGroupInvite>[0]> = {},
    contextOverrides: Parameters<typeof createToolContext>[0] = {},
  ) => {
    const context = createToolContext({
      session: {
        corpId: 'corp-1',
        userId: 'user-1',
        sessionId: 'session-1',
        botImId: 'bot-A',
        botUserId: 'wecom-user-A',
        turnId: 'turn-1',
      },
      ...contextOverrides,
    });
    return runPostBookingGroupInvite({
      context,
      groupInviteService: groupInviteService as unknown as GroupInviteService,
      sessionService: sessionService as unknown as SessionStateService,
      logger,
      isAdditionalCandidate: false,
      hasOtherActiveBookings: false,
      ...overrides,
    }).then((outcome) => ({ outcome, context }));
  };

  it('首次报名、私聊、会话城市高置信：直接拉群并把结果写进回合账本', async () => {
    const { outcome, context } = await run();

    expect(outcome).toEqual({
      attempted: true,
      success: true,
      city: '上海',
      groupName: '上海餐饮群',
      delivery: 'invite_card',
    });
    expect(groupInviteService.invite).toHaveBeenCalledWith(
      expect.objectContaining({ city: '上海', contactWxid: 'user-1', turnKey: 'turn-1' }),
    );
    expect(context.ledger.jobs.postBookingGroupInvite).toEqual(outcome);
  });

  it('群人数少时按直接拉入回执', async () => {
    groupInviteService.invite.mockResolvedValue({
      success: true,
      groupName: '上海餐饮群',
      inviteDelivery: 'direct_add',
    });
    const { outcome } = await run();
    expect(outcome.delivery).toBe('direct_add');
    expect(buildPostBookingGroupInviteGuide(outcome)).toContain(
      '直接加入兼职岗位信息群「上海餐饮群」',
    );
    expect(buildPostBookingGroupInviteGuide(outcome)).toContain('不要再调用 invite_to_group');
  });

  it('候选人已在群（前置闸门）按成功且 alreadyInGroup 回执，不触达邀请接口', async () => {
    groupInviteService.preflightExistingMembership.mockResolvedValue({
      success: true,
      alreadyInGroup: true,
      groupName: '上海零售群',
    });
    const { outcome } = await run();
    expect(outcome).toMatchObject({ attempted: true, success: true, alreadyInGroup: true });
    expect(groupInviteService.invite).not.toHaveBeenCalled();
    expect(buildPostBookingGroupInviteGuide(outcome)).toContain(
      '已经在兼职岗位信息群「上海零售群」里',
    );
  });

  it('群聊里报名不拉群', async () => {
    const { outcome } = await run({}, { session: { imRoomId: 'room-1' } });
    expect(outcome).toEqual({ attempted: false, success: false, skippedReason: 'group_chat' });
    expect(groupInviteService.invite).not.toHaveBeenCalled();
    expect(sessionService.getFacts).not.toHaveBeenCalled();
  });

  it('代报同行人不拉群', async () => {
    const { outcome } = await run({ isAdditionalCandidate: true });
    expect(outcome.skippedReason).toBe('additional_candidate');
    expect(groupInviteService.invite).not.toHaveBeenCalled();
  });

  it('候选人名下已有其他在途工单：不是首次报名，不拉群', async () => {
    const { outcome } = await run({ hasOtherActiveBookings: true });
    expect(outcome.skippedReason).toBe('not_first_booking');
    expect(groupInviteService.invite).not.toHaveBeenCalled();
  });

  it('城市未知（会话无高置信城市、本轮无确权）时跳过并给原因', async () => {
    sessionService.getFacts.mockResolvedValue({
      preferences: {
        city: { value: '上海', confidence: 'medium', source: 'llm_extract', evidence: '猜测' },
      },
    });
    const { outcome } = await run();
    expect(outcome).toEqual({ attempted: false, success: false, skippedReason: 'city_unknown' });
    expect(groupInviteService.invite).not.toHaveBeenCalled();
    expect(buildPostBookingGroupInviteGuide(outcome)).toContain('原因: city_unknown');
    expect(buildPostBookingGroupInviteGuide(outcome)).toContain('不要向候选人提及群相关内容');
  });

  it('会话没有城市事实时回落本轮 geocode 确权城市', async () => {
    sessionService.getFacts.mockResolvedValue(null);
    const { outcome } = await run(
      {},
      {
        ledger: {
          geo: {
            cityAttestation: {
              city: '苏州',
              evidence: 'amap 解析',
              source: 'geocode_unique',
            },
          },
        },
      },
    );
    expect(outcome).toMatchObject({ attempted: true, success: true, city: '苏州' });
    expect(groupInviteService.invite).toHaveBeenCalledWith(
      expect.objectContaining({ city: '苏州' }),
    );
  });

  it('本会话已给同城市拉过群：跳过并带出群名（重复邀请 gate）', async () => {
    sessionService.getSessionState.mockResolvedValue({
      invitedGroups: [{ groupName: '上海餐饮群②', city: '上海', invitedAt: 'x' }],
    });
    const { outcome } = await run();
    expect(outcome).toMatchObject({
      attempted: false,
      success: false,
      skippedReason: 'already_invited',
      groupName: '上海餐饮群②',
    });
    expect(groupInviteService.invite).not.toHaveBeenCalled();
  });

  it('城市无群：attempted 但失败并带原因，不抛错', async () => {
    groupInviteService.invite.mockResolvedValue({ success: false, reason: 'no_group_in_city' });
    const { outcome } = await run();
    expect(outcome).toEqual({
      attempted: true,
      success: false,
      city: '上海',
      groupName: undefined,
      failureReason: 'no_group_in_city',
    });
    expect(describePostBookingGroupInviteForEvent(outcome).outcome).toBe('failed:no_group_in_city');
  });

  it('拉群服务抛异常时吞掉并记 exception，不影响调用方', async () => {
    groupInviteService.invite.mockRejectedValue(new Error('boom'));
    const { outcome } = await run();
    expect(outcome).toMatchObject({ attempted: true, success: false, failureReason: 'exception' });
  });

  it('未注入拉群服务时记 service_unavailable', async () => {
    const { outcome } = await run({ groupInviteService: undefined });
    expect(outcome.skippedReason).toBe('service_unavailable');
  });

  it('testing 链路返回模拟成功、不触达企业接口', async () => {
    const { outcome } = await run({}, { runtime: { strategySource: 'testing' } });
    expect(outcome).toMatchObject({
      attempted: true,
      success: true,
      simulated: true,
      delivery: 'invite_card',
    });
    expect(groupInviteService.preflightExistingMembership).not.toHaveBeenCalled();
    expect(groupInviteService.invite).not.toHaveBeenCalled();
  });

  it('运营事件描述：成功/已在群/跳过/失败四种口径', () => {
    expect(
      describePostBookingGroupInviteForEvent({
        attempted: true,
        success: true,
        groupName: 'g',
        delivery: 'direct_add',
        city: '上海',
      }),
    ).toMatchObject({ outcome: 'invited', delivery: 'direct_add', group_name: 'g', city: '上海' });
    expect(
      describePostBookingGroupInviteForEvent({
        attempted: true,
        success: true,
        alreadyInGroup: true,
      }).outcome,
    ).toBe('already_in_group');
    expect(
      describePostBookingGroupInviteForEvent({
        attempted: false,
        success: false,
        skippedReason: 'group_chat',
      }).outcome,
    ).toBe('skipped:group_chat');
    expect(
      describePostBookingGroupInviteForEvent({
        attempted: true,
        success: false,
        failureReason: 'group_full',
      }).outcome,
    ).toBe('failed:group_full');
  });
});

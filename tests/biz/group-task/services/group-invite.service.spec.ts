import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { GroupInviteService } from '@biz/group-task/services/group-invite.service';
import { GroupResolverService } from '@biz/group-task/services/group-resolver.service';
import { GroupMembershipService } from '@biz/group-task/services/group-membership.service';
import { GroupContext } from '@biz/group-task/group-task.types';
import { RoomService } from '@channels/wecom/room/room.service';
import { MemoryService } from '@memory/memory.service';
import { OpsEventsRecorderService } from '@biz/ops-events/services/ops-events-recorder.service';
import { OpsNotifierService } from '@notification/services/ops-notifier.service';

describe('GroupInviteService', () => {
  const memberLimit = 200;
  const groupResolver = { resolveGroups: jest.fn() };
  const groupMembership = { listUserRooms: jest.fn() };
  const roomService = {
    addMemberEnterprise: jest.fn(),
    getEnterpriseGroupChatList: jest.fn(),
    syncRoom: jest.fn(),
  };
  const memoryService = { saveInvitedGroup: jest.fn() };
  const opsEventsRecorder = { recordEvent: jest.fn() };
  const opsNotifier = {
    sendGroupFullAlert: jest.fn(),
    sendInviteRejectedAlert: jest.fn(),
  };

  let service: GroupInviteService;

  const input = {
    corpId: 'corp-1',
    userId: 'user-1',
    sessionId: 'session-1',
    botImId: 'chat-bot-im',
    botUserId: 'chat-bot-user',
    contactWxid: 'user-1',
    city: '上海',
    industry: '餐饮',
    turnKey: 'turn-1',
  };

  const makeGroup = (overrides: Partial<GroupContext> = {}): GroupContext => ({
    imRoomId: 'room-1',
    groupName: '上海餐饮兼职群',
    city: '上海',
    industry: '餐饮',
    tag: '兼职群',
    imBotId: 'chat-bot-im',
    botUserId: 'chat-bot-user',
    token: 'group-token',
    memberCount: 30,
    ...overrides,
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    groupMembership.listUserRooms.mockResolvedValue([]);
    roomService.getEnterpriseGroupChatList.mockResolvedValue({ data: [] });
    roomService.syncRoom.mockResolvedValue({ errcode: 0 });
    memoryService.saveInvitedGroup.mockResolvedValue(undefined);
    opsEventsRecorder.recordEvent.mockResolvedValue(true);
    opsNotifier.sendGroupFullAlert.mockResolvedValue(true);
    opsNotifier.sendInviteRejectedAlert.mockResolvedValue(true);

    const moduleRef = await Test.createTestingModule({
      providers: [
        GroupInviteService,
        { provide: GroupResolverService, useValue: groupResolver },
        { provide: GroupMembershipService, useValue: groupMembership },
        { provide: RoomService, useValue: roomService },
        { provide: MemoryService, useValue: memoryService },
        { provide: OpsEventsRecorderService, useValue: opsEventsRecorder },
        { provide: OpsNotifierService, useValue: opsNotifier },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string, fallback?: string) => {
              if (key === 'GROUP_MEMBER_LIMIT') return String(memberLimit);
              if (key === 'STRIDE_ENTERPRISE_TOKEN') return 'enterprise-token';
              return fallback;
            },
          },
        },
      ],
    }).compile();
    service = moduleRef.get(GroupInviteService);
  });

  it('invites the candidate to the lowest-count available group', async () => {
    groupResolver.resolveGroups.mockResolvedValue([
      makeGroup({ imRoomId: 'room-2', groupName: '上海餐饮群2', memberCount: 80 }),
      makeGroup({ imRoomId: 'room-1', groupName: '上海餐饮群1', memberCount: 20 }),
    ]);
    roomService.addMemberEnterprise.mockResolvedValue({ errcode: 0 });

    const result = await service.invite(input);

    expect(result).toMatchObject({
      success: true,
      groupName: '上海餐饮群1',
      inviteDelivery: 'direct_add',
      selectionReason: 'lowest_member_count',
    });
    expect(roomService.addMemberEnterprise).toHaveBeenCalledWith(
      expect.objectContaining({ roomWxid: 'room-1', contactWxid: 'user-1' }),
    );
  });

  it('treats errcode -10 as full and sends the group-full alert', async () => {
    groupResolver.resolveGroups.mockResolvedValue([makeGroup({ memberCount: 199 })]);
    roomService.addMemberEnterprise.mockResolvedValue({ errcode: -10, errmsg: '群人数达到上限' });

    const result = await service.invite(input);

    expect(result).toMatchObject({
      success: false,
      reason: 'group_full',
      groupName: '上海餐饮兼职群',
    });
    expect(opsNotifier.sendGroupFullAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        city: '上海',
        groups: [{ name: '上海餐饮兼职群', memberCount: memberLimit }],
      }),
    );
  });

  it('treats errcode -9 as already in group and backfills memory', async () => {
    groupResolver.resolveGroups.mockResolvedValue([makeGroup()]);
    roomService.addMemberEnterprise.mockResolvedValue({
      errcode: -9,
      errmsg: 'user already in room',
    });

    const result = await service.invite(input);

    expect(result).toMatchObject({
      success: true,
      alreadyInGroup: true,
      groupName: '上海餐饮兼职群',
    });
    expect(memoryService.saveInvitedGroup).toHaveBeenCalled();
  });

  it('treats errcode -12 as one delivered invite card instead of retrying other groups', async () => {
    groupResolver.resolveGroups.mockResolvedValue([
      makeGroup({ imRoomId: 'room-1' }),
      makeGroup({ imRoomId: 'room-2', groupName: '上海餐饮群2' }),
    ]);
    roomService.addMemberEnterprise.mockResolvedValue({
      errcode: -12,
      errmsg: '已发送入群邀请给候选人',
    });

    const result = await service.invite(input);

    expect(result).toMatchObject({
      success: true,
      inviteDelivery: 'invite_card',
      inviteCardPendingConsent: true,
    });
    expect(roomService.addMemberEnterprise).toHaveBeenCalledTimes(1);
  });

  it('adds the chat bot to an owner-bot group and retries the candidate invite', async () => {
    groupResolver.resolveGroups.mockResolvedValue([
      makeGroup({ imBotId: 'owner-bot-im', botUserId: 'owner-bot-user' }),
    ]);
    roomService.addMemberEnterprise
      .mockResolvedValueOnce({ code: 400400, message: 'room not found' })
      .mockResolvedValueOnce({ errcode: 0 })
      .mockResolvedValueOnce({ errcode: 0 });

    const result = await service.invite(input);

    expect(result.success).toBe(true);
    expect(roomService.addMemberEnterprise).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        imBotId: 'owner-bot-im',
        botUserId: 'owner-bot-user',
        contactWxid: 'chat-bot-im',
      }),
    );
    expect(roomService.syncRoom).toHaveBeenCalledWith('enterprise-token', 'chat-bot-im');
  });

  it('returns no-group when no candidate group exists in the requested city', async () => {
    groupResolver.resolveGroups.mockResolvedValue([makeGroup({ city: '北京' })]);

    const result = await service.invite(input);

    expect(result).toEqual({ success: false, reason: 'no_group_in_city' });
    expect(roomService.addMemberEnterprise).not.toHaveBeenCalled();
  });

  it('persists invitedGroups and records group.invited with the turn-scoped key', async () => {
    groupResolver.resolveGroups.mockResolvedValue([makeGroup()]);
    roomService.addMemberEnterprise.mockResolvedValue({ errcode: 0 });

    await service.invite(input);

    expect(memoryService.saveInvitedGroup).toHaveBeenCalledWith(
      'corp-1',
      'user-1',
      'session-1',
      expect.objectContaining({ groupName: '上海餐饮兼职群', city: '上海' }),
    );
    expect(opsEventsRecorder.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: 'group.invited',
        idempotencyKey: 'session-1:group:上海餐饮兼职群:turn-1',
      }),
    );
  });
});

import { Test, type TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ReplyTurnsService } from '@biz/reply-execution/reply-turns.service';
import { ReplyRecoveryLeaseService } from '@biz/reply-execution/reply-recovery-lease.service';
import type { ReplyTurn } from '@biz/reply-execution/reply-execution.types';
import { CronRunnerService } from '@infra/queue/cron-runner.service';
import { IncidentReporterService } from '@observability/incidents/incident-reporter.service';
import { GroupRouteCredentialsService } from '@channels/wecom/message/credentials/group-route-credentials.service';
import { ReplyWorkflowService } from '@channels/wecom/message/application/reply-workflow.service';
import { ReplyRecoveryService } from '@channels/wecom/message/delivery/reply-recovery.service';

const NOW = Date.parse('2026-11-04T07:00:00.000Z');

function groupTurn(
  overrides: Partial<ReplyTurn> = {},
  primaryOverrides: Record<string, unknown> = {},
): ReplyTurn {
  return {
    deliveryPolicy: 'frozen',
    corpId: 'corp-original',
    accountId: 'bot-original',
    chatId: 'chat-original',
    logicalTurnId: 'turn-original',
    inputIds: ['input-original'],
    inputOccurredAt: new Date(NOW - 60_000).toISOString(),
    mode: 'execute',
    status: 'planned',
    owner: 'owner-original',
    fence: 1,
    plan: {
      version: 1,
      text: 'original first\noriginal second',
      segments: [
        { index: 0, text: 'original first', actionId: 'action-first', requestId: 'request-first' },
        {
          index: 1,
          text: 'original second',
          actionId: 'action-second',
          requestId: 'request-second',
        },
      ],
    },
    recovery: {
      primary: {
        _apiType: 'group',
        orgId: 'corp-original',
        imBotId: 'bot-original',
        chatId: 'chat-original',
        groupId: 'group-original',
        ...primaryOverrides,
      },
    },
    ...overrides,
  };
}

describe('ReplyRecoveryService route and recovery boundaries', () => {
  let module: TestingModule;
  let service: ReplyRecoveryService;
  const turns = {
    repository: { due: jest.fn(), redact: jest.fn() },
    defer: jest.fn(),
  };
  const workflow = { resumePersistedReply: jest.fn() };
  const assertOwned = jest.fn<Promise<void>, []>();
  const leases = { run: jest.fn() };
  const config = { get: jest.fn() };
  const crons = { runBatches: jest.fn() };
  const incidents = { notifyAsync: jest.fn() };
  const credentials = { resolveForRecovery: jest.fn() };

  beforeEach(async () => {
    jest.resetAllMocks();
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    assertOwned.mockResolvedValue(undefined);
    leases.run.mockImplementation(
      async (_chatId: string, task: (owned: () => Promise<void>) => Promise<void>) =>
        task(assertOwned),
    );
    turns.repository.due.mockResolvedValue([]);
    turns.defer.mockResolvedValue(undefined);
    workflow.resumePersistedReply.mockResolvedValue(undefined);
    config.get.mockReturnValue('enterprise-current-token');
    credentials.resolveForRecovery.mockResolvedValue({
      token: 'group-current-token',
      groupId: 'group-original',
    });
    module = await Test.createTestingModule({
      providers: [
        ReplyRecoveryService,
        { provide: ReplyTurnsService, useValue: turns },
        { provide: ReplyWorkflowService, useValue: workflow },
        { provide: ReplyRecoveryLeaseService, useValue: leases },
        { provide: ConfigService, useValue: config },
        { provide: CronRunnerService, useValue: crons },
        { provide: IncidentReporterService, useValue: incidents },
        { provide: GroupRouteCredentialsService, useValue: credentials },
      ],
    }).compile();
    service = module.get(ReplyRecoveryService);
  });

  afterEach(async () => {
    await module.close();
    jest.restoreAllMocks();
  });

  function expectManual(reason: string, turnId = 'turn-original'): void {
    expect(incidents.notifyAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'reply.manual_review_required',
        error: expect.objectContaining({ message: `${turnId}: ${reason}` }),
        dedupe: { key: `reply.manual_review_required:${turnId}` },
      }),
    );
  }

  it('resumes the original group plan with a fresh directory token without changing route or identity', async () => {
    const turn = groupTurn({}, { token: 'stale-legacy-token' });
    const original = structuredClone(turn);
    turns.repository.due.mockResolvedValue([turn]);

    await service.recoverDue();

    expect(credentials.resolveForRecovery).toHaveBeenCalledWith({
      corpId: 'corp-original',
      accountId: 'bot-original',
      groupId: 'group-original',
    });
    expect(config.get).not.toHaveBeenCalled();
    expect(workflow.resumePersistedReply).toHaveBeenCalledWith(
      turn,
      'group-current-token',
      assertOwned,
    );
    expect(turn).toEqual(original);
    expect(incidents.notifyAsync).not.toHaveBeenCalled();
    expect(leases.run).toHaveBeenCalledWith(turn.chatId, expect.any(Function));
    expect(assertOwned).toHaveBeenCalledTimes(1);
    expect(turns.defer).toHaveBeenCalledWith(turn);
    expect(assertOwned.mock.invocationCallOrder[0]).toBeLessThan(
      turns.defer.mock.invocationCallOrder[0],
    );
  });

  it.each([
    ['missing frozen group', undefined],
    ['account moved out of frozen group', 'group-original'],
    ['current credential unavailable', 'group-original'],
  ])(
    'requests manual review for %s and never substitutes the enterprise token',
    async (_reason, groupId) => {
      const turn = groupTurn({}, { groupId });
      turns.repository.due.mockResolvedValue([turn]);
      credentials.resolveForRecovery.mockResolvedValue(null);

      await service.recoverDue();

      expect(credentials.resolveForRecovery).toHaveBeenCalledWith({
        corpId: turn.corpId,
        accountId: turn.accountId,
        groupId,
      });
      expectManual('group_credential_resolution');
      expect(workflow.resumePersistedReply).not.toHaveBeenCalled();
      expect(config.get).not.toHaveBeenCalled();
      expect(assertOwned).toHaveBeenCalledTimes(1);
      expect(turns.defer).toHaveBeenCalledWith(turn);
    },
  );

  it.each([undefined, 'enterprise'])(
    'keeps enterprise route %s on the enterprise token despite an available group directory token',
    async (apiType) => {
      const turn = groupTurn({}, { _apiType: apiType });
      turns.repository.due.mockResolvedValue([turn]);
      config.get.mockReturnValue('  enterprise-current-token  ');

      await service.recoverDue();

      expect(credentials.resolveForRecovery).not.toHaveBeenCalled();
      expect(config.get).toHaveBeenCalledWith('STRIDE_ENTERPRISE_TOKEN');
      expect(workflow.resumePersistedReply).toHaveBeenCalledWith(
        turn,
        'enterprise-current-token',
        assertOwned,
      );
    },
  );

  it('does not replace a missing enterprise credential with an available group credential', async () => {
    const turn = groupTurn({}, { _apiType: 'enterprise' });
    turns.repository.due.mockResolvedValue([turn]);
    config.get.mockReturnValue(' ');

    await service.recoverDue();

    expect(credentials.resolveForRecovery).not.toHaveBeenCalled();
    expect(workflow.resumePersistedReply).not.toHaveBeenCalled();
    expect(turns.defer).toHaveBeenCalledWith(turn);
  });

  it.each([
    { orgId: 'different-corp' },
    { imBotId: 'different-account' },
    { chatId: 'different-chat' },
  ])(
    'rejects conflicting frozen primary identity %j before resolving any credential',
    async (primary) => {
      const turn = groupTurn({}, primary);
      turns.repository.due.mockResolvedValue([turn]);

      await service.recoverDue();

      expectManual('recovery_identity_mismatch');
      expect(credentials.resolveForRecovery).not.toHaveBeenCalled();
      expect(config.get).not.toHaveBeenCalled();
      expect(workflow.resumePersistedReply).not.toHaveBeenCalled();
      expect(assertOwned).toHaveBeenCalledTimes(1);
      expect(turns.defer).toHaveBeenCalledWith(turn);
    },
  );

  it.each(['settled', 'acked'] as const)(
    'repairs %s confirmation with no token or directory lookup',
    async (status) => {
      const turn = groupTurn({ status }, { groupId: undefined });
      turns.repository.due.mockResolvedValue([turn]);
      config.get.mockReturnValue(undefined);
      credentials.resolveForRecovery.mockRejectedValue(new Error('directory unavailable'));

      await service.recoverDue();

      expect(credentials.resolveForRecovery).not.toHaveBeenCalled();
      expect(config.get).not.toHaveBeenCalled();
      expect(workflow.resumePersistedReply).toHaveBeenCalledWith(turn, '', assertOwned);
      expect(incidents.notifyAsync).not.toHaveBeenCalled();
      expect(turns.defer).toHaveBeenCalledWith(turn);
    },
  );

  it('defers one directory failure and continues to recover the next turn', async () => {
    const failed = groupTurn();
    const next = groupTurn(
      { logicalTurnId: 'next-turn', chatId: 'next-chat' },
      { chatId: 'next-chat' },
    );
    turns.repository.due.mockResolvedValue([failed, next]);
    credentials.resolveForRecovery
      .mockRejectedValueOnce(new Error('directory unavailable'))
      .mockResolvedValueOnce({ token: 'next-current-token', groupId: 'group-original' });

    await service.recoverDue();

    expect(workflow.resumePersistedReply).toHaveBeenCalledTimes(1);
    expect(workflow.resumePersistedReply).toHaveBeenCalledWith(
      next,
      'next-current-token',
      assertOwned,
    );
    expect(turns.defer.mock.calls).toEqual([[failed], [next]]);
    expect(leases.run).toHaveBeenCalledTimes(2);
  });

  it('requests manual review after the recovery deadline when directory lookup keeps failing', async () => {
    const turn = groupTurn({ inputOccurredAt: new Date(NOW - 86400_001).toISOString() });
    turns.repository.due.mockResolvedValue([turn]);
    credentials.resolveForRecovery.mockRejectedValue(new Error('directory unavailable'));

    await service.recoverDue();

    expectManual('recovery_deadline');
    expect(workflow.resumePersistedReply).not.toHaveBeenCalled();
    expect(turns.defer).toHaveBeenCalledWith(turn);
  });

  it('does no credential lookup, resume or defer when the conversation lease is not acquired', async () => {
    turns.repository.due.mockResolvedValue([groupTurn()]);
    leases.run.mockResolvedValue(undefined);

    await service.recoverDue();

    expect(credentials.resolveForRecovery).not.toHaveBeenCalled();
    expect(workflow.resumePersistedReply).not.toHaveBeenCalled();
    expect(turns.defer).not.toHaveBeenCalled();
  });

  it('does not defer after lease ownership is lost, and releases its running guard for another scan', async () => {
    const turn = groupTurn();
    turns.repository.due.mockResolvedValue([turn]);
    assertOwned.mockRejectedValueOnce(new Error('lease lost'));

    await service.recoverDue();

    expect(turns.defer).not.toHaveBeenCalled();
    await service.recoverDue();
    expect(turns.repository.due).toHaveBeenCalledTimes(2);
    expect(turns.defer).toHaveBeenCalledTimes(1);
    expect(turns.defer).toHaveBeenCalledWith(turn);
  });

  it('defers the original plan after a workflow error without calling it again within the scan', async () => {
    const turn = groupTurn();
    turns.repository.due.mockResolvedValue([turn]);
    workflow.resumePersistedReply.mockRejectedValue(new Error('delivery pending'));

    await service.recoverDue();

    expect(workflow.resumePersistedReply).toHaveBeenCalledTimes(1);
    expect(assertOwned).toHaveBeenCalledTimes(1);
    expect(turns.defer).toHaveBeenCalledWith(turn);
  });
});

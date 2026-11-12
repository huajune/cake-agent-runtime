import { Test, type TestingModule } from '@nestjs/testing';
import { ReplyTurnsService } from '@biz/reply-execution/reply-turns.service';
import { ReplyRecoveryLeaseService } from '@biz/reply-execution/reply-recovery-lease.service';
import type { ReplyTurn } from '@biz/reply-execution/reply-execution.types';
import { CronRunnerService } from '@infra/queue/cron-runner.service';
import { IncidentReporterService } from '@observability/incidents/incident-reporter.service';
import { ReplyWorkflowService } from '@channels/wecom/message/application/reply-workflow.service';
import { ReplyRecoveryService } from '@channels/wecom/message/delivery/reply-recovery.service';

const NOW = Date.parse('2026-11-04T07:00:00.000Z');

function groupTurn(
  overrides: Partial<ReplyTurn> = {},
  primaryOverrides: Record<string, unknown> = {},
): ReplyTurn {
  return {
    deliveryPolicy: 'single_pass',
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
    projectionStatus: 'complete',
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
    interrupt: jest.fn(),
  };
  const workflow = { resumeInputCompletion: jest.fn() };
  const assertOwned = jest.fn<Promise<void>, []>();
  const leases = { run: jest.fn() };
  const crons = { runBatches: jest.fn() };
  const incidents = { notifyAsync: jest.fn() };

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
    workflow.resumeInputCompletion.mockResolvedValue(undefined);
    turns.interrupt.mockImplementation(async (turn: ReplyTurn) => ({ ...turn, status: 'settled' }));
    module = await Test.createTestingModule({
      providers: [
        ReplyRecoveryService,
        { provide: ReplyTurnsService, useValue: turns },
        { provide: ReplyWorkflowService, useValue: workflow },
        { provide: ReplyRecoveryLeaseService, useValue: leases },
        { provide: CronRunnerService, useValue: crons },
        { provide: IncidentReporterService, useValue: incidents },
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

  it.each(['settled', 'acked'] as const)(
    'repairs %s input without route credentials or a sender',
    async (status) => {
      const turn = groupTurn({ status });
      turns.repository.due.mockResolvedValue([turn]);
      turns.interrupt.mockResolvedValue(turn);
      await service.recoverDue();
      expect(workflow.resumeInputCompletion).toHaveBeenCalledWith(turn, assertOwned);
      expect(incidents.notifyAsync).not.toHaveBeenCalled();
      expect(turns.defer).toHaveBeenCalledWith(turn);
    },
  );
  it('keeps unconfirmed business effects for manual review without acknowledging', async () => {
    const turn = groupTurn({ projectionStatus: 'none' });
    turns.repository.due.mockResolvedValue([turn]);
    await service.recoverDue();
    expectManual('business_effects_unconfirmed');
    expect(workflow.resumeInputCompletion).not.toHaveBeenCalled();
    expect(turns.interrupt).not.toHaveBeenCalled();
    expect(turns.defer).toHaveBeenCalledWith(turn);
  });
  it('reports an interrupted delivery and repairs only the input', async () => {
    const turn = groupTurn();
    const terminal = { ...turn, status: 'settled', deliveryResult: { outcome: 'interrupted' } };
    turns.repository.due.mockResolvedValue([turn]);
    turns.interrupt.mockResolvedValue(terminal);
    await service.recoverDue();
    expectManual('ordinary_reply_interrupted_no_resend');
    expect(workflow.resumeInputCompletion).toHaveBeenCalledWith(terminal, assertOwned);
  });
  it('defers one failed repair and continues to the next input', async () => {
    const first = groupTurn();
    const next = groupTurn({ logicalTurnId: 'next-turn', chatId: 'next-chat' });
    turns.repository.due.mockResolvedValue([first, next]);
    workflow.resumeInputCompletion.mockRejectedValueOnce(new Error('Redis unavailable'));
    await service.recoverDue();
    expect(workflow.resumeInputCompletion).toHaveBeenCalledTimes(2);
    expect(turns.defer.mock.calls).toEqual([[first], [next]]);
  });
  it('does no input repair or defer when the conversation lease is not acquired', async () => {
    turns.repository.due.mockResolvedValue([groupTurn()]);
    leases.run.mockResolvedValue(undefined);

    await service.recoverDue();

    expect(workflow.resumeInputCompletion).not.toHaveBeenCalled();
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

  it('defers the original input after a workflow error without calling it again within the scan', async () => {
    const turn = groupTurn();
    turns.repository.due.mockResolvedValue([turn]);
    workflow.resumeInputCompletion.mockRejectedValue(new Error('delivery pending'));

    await service.recoverDue();

    expect(workflow.resumeInputCompletion).toHaveBeenCalledTimes(1);
    expect(assertOwned).toHaveBeenCalledTimes(1);
    expect(turns.defer).toHaveBeenCalledWith(turn);
  });
});

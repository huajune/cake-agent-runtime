import { Test, type TestingModule } from '@nestjs/testing';
import {
  BusinessTenantResolver,
  businessTenant,
  runForTenant,
} from '@infra/supabase/business-tenant';
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
    resumeDelivery: jest.fn(),
    interrupt: jest.fn(),
    requestReview: jest.fn(),
    reviewNotified: jest.fn(),
  };
  const workflow = { resumeInputCompletion: jest.fn(), resumeDelivery: jest.fn() };
  const assertOwned = jest.fn<Promise<void>, []>();
  const leases = { run: jest.fn() };
  const crons = { runBatches: jest.fn() };
  const incidents = { notify: jest.fn() };
  const tenants = { resolve: jest.fn() };

  beforeEach(async () => {
    jest.resetAllMocks();
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    tenants.resolve.mockResolvedValue(['original-tenant']);
    assertOwned.mockResolvedValue(undefined);
    leases.run.mockImplementation(
      async (_chatId: string, task: (owned: () => Promise<void>) => Promise<void>) =>
        task(assertOwned),
    );
    turns.repository.due.mockResolvedValue([]);
    turns.defer.mockResolvedValue(undefined);
    turns.requestReview.mockImplementation(async (turn, reviewReason) => ({
      ...turn,
      reviewRequired: true,
      reviewReason,
    }));
    incidents.notify.mockResolvedValue(true);
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
        { provide: BusinessTenantResolver, useValue: tenants },
      ],
    }).compile();
    service = module.get(ReplyRecoveryService);
  });

  afterEach(async () => {
    await module.close();
    jest.restoreAllMocks();
  });

  function expectManual(reason: string, turnId = 'turn-original'): void {
    expect(incidents.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'reply.manual_review_required',
        error: `${turnId}: ${reason}`,
        dedupe: { key: `reply.manual_review_required:${turnId}` },
      }),
    );
  }

  it('resumes delivery and completes the input under its saved tenant', async () => {
    const turn = groupTurn();
    turn.recovery.tenantId = 'original-tenant';
    turn.recovery.replySegments = ['原回复'];
    turns.repository.due.mockResolvedValue([turn]);
    turns.resumeDelivery.mockResolvedValue(turn);
    const scopes: Array<string | null | undefined> = [];
    workflow.resumeDelivery.mockImplementation(async () => {
      scopes.push(businessTenant());
      return { ...turn, status: 'settled' };
    });
    workflow.resumeInputCompletion.mockImplementation(async () => scopes.push(businessTenant()));
    await runForTenant('different-tenant', () => service.recoverDue());
    expect(scopes).toEqual(['original-tenant', 'original-tenant']);
    expect(tenants.resolve).not.toHaveBeenCalled();
  });

  it.each([['one'], ['merged', 'input']])(
    'looks up older turns by the historical bot and original time (%s)',
    async (...inputIds: string[]) => {
      const turn = groupTurn({ inputIds });
      turns.repository.due.mockResolvedValue([turn]);
      let recoveredTenant: ReturnType<typeof businessTenant>;
      workflow.resumeInputCompletion.mockImplementation(async () => {
        recoveredTenant = businessTenant();
      });
      await service.recoverDue();
      expect(tenants.resolve).toHaveBeenCalledWith([
        {
          botId: turn.accountId,
          at: Date.parse(turn.inputOccurredAt),
          messageId: inputIds.length === 1 ? inputIds[0] : undefined,
        },
      ]);
      expect(workflow.resumeInputCompletion).toHaveBeenCalledTimes(1);
      expect(recoveredTenant).toBe('original-tenant');
    },
  );

  it('defers unresolved input without sending or acknowledging it', async () => {
    const turn = groupTurn();
    turn.recovery.replySegments = ['原回复'];
    turns.repository.due.mockResolvedValue([turn]);
    turns.resumeDelivery.mockResolvedValue(turn);
    tenants.resolve.mockResolvedValue([null]);
    await service.recoverDue();
    expect(workflow.resumeDelivery).not.toHaveBeenCalled();
    expect(workflow.resumeInputCompletion).not.toHaveBeenCalled();
    expect(turns.defer).toHaveBeenCalledWith(turn);
  });

  it.each(['settled', 'acked'] as const)(
    'repairs %s input without route credentials or a sender',
    async (status) => {
      const turn = groupTurn({ status });
      turns.repository.due.mockResolvedValue([turn]);
      turns.interrupt.mockResolvedValue(turn);
      await service.recoverDue();
      if (status === 'settled')
        expect(workflow.resumeInputCompletion).toHaveBeenCalledWith(turn, assertOwned);
      else expect(workflow.resumeInputCompletion).not.toHaveBeenCalled();
      expect(incidents.notify).not.toHaveBeenCalled();
      expect(turns.defer).not.toHaveBeenCalled();
    },
  );
  it('keeps unconfirmed business effects for manual review without acknowledging', async () => {
    const turn = groupTurn({ projectionStatus: 'none' });
    turns.repository.due.mockResolvedValue([turn]);
    await service.recoverDue();
    expectManual('business_effects_unconfirmed');
    expect(workflow.resumeInputCompletion).not.toHaveBeenCalled();
    expect(turns.interrupt).toHaveBeenCalledWith(turn);
    expect(turns.reviewNotified).toHaveBeenCalledTimes(1);
    expect(turns.defer).not.toHaveBeenCalled();
    turns.interrupt.mockResolvedValue({
      ...turn,
      status: 'settled',
      reviewRequired: true,
      reviewReason: 'business_effects_unconfirmed',
      reviewNotifiedAt: new Date(NOW).toISOString(),
    });
    await service.recoverDue();
    expect(incidents.notify).toHaveBeenCalledTimes(1);
  });
  it('keeps notification pending after a failed send and marks it only after confirmation', async () => {
    const turn = groupTurn({
      status: 'settled',
      projectionStatus: 'none',
      reviewRequired: true,
      reviewReason: 'business_effects_unconfirmed',
    });
    turns.repository.due.mockResolvedValue([turn]);
    incidents.notify.mockResolvedValueOnce(false);
    await service.recoverDue();
    expect(turns.defer).toHaveBeenCalledWith(turn);
    expect(turns.reviewNotified).not.toHaveBeenCalled();
    await service.recoverDue();
    expect(turns.reviewNotified).toHaveBeenCalledWith(turn);
    expect(workflow.resumeInputCompletion).not.toHaveBeenCalled();
  });
  it('reports an interrupted delivery and repairs only the input', async () => {
    const turn = groupTurn();
    const terminal = { ...turn, status: 'settled', deliveryResult: { outcome: 'interrupted' } };
    turns.repository.due.mockResolvedValue([turn]);
    turns.interrupt.mockResolvedValue(terminal);
    await service.recoverDue();
    expectManual('ordinary_reply_interrupted_no_resend');
    expect(workflow.resumeInputCompletion).toHaveBeenCalledWith(
      expect.objectContaining(terminal),
      assertOwned,
    );
  });
  it('defers one failed repair and continues to the next input', async () => {
    const first = groupTurn();
    const next = groupTurn({ logicalTurnId: 'next-turn', chatId: 'next-chat' });
    turns.repository.due.mockResolvedValue([first, next]);
    workflow.resumeInputCompletion.mockRejectedValueOnce(new Error('Redis unavailable'));
    await service.recoverDue();
    expect(workflow.resumeInputCompletion).toHaveBeenCalledTimes(2);
    expect(turns.defer.mock.calls).toEqual([[{ ...first, status: 'settled' }]]);
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
    expect(turns.defer).not.toHaveBeenCalled();
    expect(workflow.resumeInputCompletion).toHaveBeenCalledTimes(1);
  });

  it('defers the original input after a workflow error without calling it again within the scan', async () => {
    const turn = groupTurn();
    turns.repository.due.mockResolvedValue([turn]);
    workflow.resumeInputCompletion.mockRejectedValue(new Error('delivery pending'));

    await service.recoverDue();

    expect(workflow.resumeInputCompletion).toHaveBeenCalledTimes(1);
    expect(assertOwned).toHaveBeenCalledTimes(2);
    expect(turns.defer).toHaveBeenCalledWith({ ...turn, status: 'settled' });
  });

  it('uses the new owner and fence when a recovered send must wait for its original receipt', async () => {
    const turn = groupTurn();
    turn.recovery.replySegments = ['原回复'];
    const claimed = { ...turn, owner: 'recovery-owner', fence: turn.fence + 1 };
    turns.repository.due.mockResolvedValue([turn]);
    turns.resumeDelivery.mockResolvedValue(claimed);
    workflow.resumeDelivery.mockRejectedValue(new Error('awaiting receipt'));
    await service.recoverDue();
    expect(turns.defer).toHaveBeenCalledWith(claimed);
    expect(workflow.resumeInputCompletion).not.toHaveBeenCalled();
  });
});

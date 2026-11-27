import { ConfigService } from '@nestjs/config';
import { runForTenant } from '@infra/supabase/business-tenant';
import { ReplyTurnsService } from '@biz/reply-execution/reply-turns.service';
import { ReplyDeferredError, type ReplyTurn } from '@biz/reply-execution/reply-execution.types';

const now = '2026-10-21T04:00:00Z';
const scope = { corpId: 'corp', accountId: 'account', chatId: 'chat' };
const turn: ReplyTurn = {
  deliveryPolicy: 'single_pass',
  ...scope,
  logicalTurnId: 'turn',
  inputIds: ['a', 'b'],
  inputOccurredAt: now,
  mode: 'execute',
  status: 'planned',
  owner: 'owner',
  fence: 1,
  recovery: { primary: { orgId: 'corp', imBotId: 'account', chatId: 'chat' } },
};
function setup(mode = 'execute', cutover: string | null = '2026-10-20T00:00:00Z') {
  const repository = { transition: jest.fn().mockResolvedValue(turn) };
  const config = { get: (key: string) => (key === 'ACTION_EXECUTION_MODE' ? mode : cutover) };
  return {
    repository,
    service: new ReplyTurnsService(repository as never, config as ConfigService),
  };
}
describe('durable reply input boundaries', () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(new Date(now)));
  afterEach(() => jest.useRealTimers());
  it('persists the verified business tenant rather than a caller-provided recovery field', async () => {
    const { service, repository } = setup();
    await runForTenant('henan', () =>
      service.open(scope, ['a'], now, { ...turn.recovery, tenantId: 'other' }),
    );
    expect(repository.transition).toHaveBeenCalledWith(
      'open',
      expect.objectContaining({ recovery: { ...turn.recovery, tenantId: 'henan' } }),
    );
  });
  it('returns the original complete membership when only the second input is retried with new input', async () => {
    const { service } = setup();
    expect(await service.open(scope, ['b', 'new'], now, turn.recovery)).toMatchObject({
      logicalTurnId: 'turn',
      inputIds: ['a', 'b'],
    });
  });
  it.each(['execute', 'off', 'observe'])(
    'does not bypass old execute obligations when %s reads fail',
    async (mode) => {
      const { service, repository } = setup(mode);
      repository.transition.mockRejectedValue(new Error('ambiguous read'));
      await expect(service.open(scope, ['a'], now, turn.recovery)).rejects.toBeInstanceOf(
        ReplyDeferredError,
      );
    },
  );
  it('only samples observe failure before a cutover exists', async () => {
    const { service, repository } = setup('observe', null);
    repository.transition.mockRejectedValue(new Error('unavailable'));
    expect(await service.open(scope, ['a'], now, turn.recovery)).toBeUndefined();
    expect(repository.transition).not.toHaveBeenCalled();
  });
  it('does not promote an observation record into an executable identity', async () => {
    const { service, repository } = setup();
    repository.transition.mockResolvedValue({ ...turn, mode: 'observe' });
    await expect(service.open(scope, ['a'], now, turn.recovery)).rejects.toThrow('cutover_review');
  });
  it('rejects inputs before cutover and expired recovery identities', async () => {
    const { service, repository } = setup();
    await expect(service.open(scope, ['a'], '2026-01-01T00:00:00Z', turn.recovery)).rejects.toThrow(
      'boundary',
    );
    expect(repository.transition).not.toHaveBeenCalled();
  });
  it('renews an active worker beyond the original ten minutes and stops at completion', async () => {
    const { service, repository } = setup();
    const owned = jest.fn().mockResolvedValue(undefined);
    let finish!: () => void;
    const result = service.withGenerationLease(
      turn,
      owned,
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await jest.advanceTimersByTimeAsync(11 * 60_000);
    expect(owned).toHaveBeenCalledTimes(11);
    expect(repository.transition).toHaveBeenCalledTimes(11);
    expect(repository.transition).toHaveBeenLastCalledWith(
      'renew',
      expect.objectContaining({ owner: turn.owner, fence: turn.fence }),
    );
    owned.mockRejectedValueOnce(new Error('Redis owner changed'));
    await jest.advanceTimersByTimeAsync(60_000);
    expect(repository.transition).toHaveBeenCalledTimes(11);
    finish();
    await result;
    await jest.advanceTimersByTimeAsync(60_000);
    expect(repository.transition).toHaveBeenCalledTimes(11);
  });
  it('requires confirmed effects and terminal writes before acknowledging input', async () => {
    const { service, repository } = setup();
    repository.transition.mockRejectedValue(new Error('write may have committed'));
    await expect(service.saveEffects(turn, {})).rejects.toThrow('save_effects_not_confirmed');
    await expect(service.settle(turn)).rejects.toThrow('settle_not_confirmed');
  });
});

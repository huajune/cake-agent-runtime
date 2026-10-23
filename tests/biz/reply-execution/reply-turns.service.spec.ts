import { ConfigService } from '@nestjs/config';
import { ReplyTurnsService } from '@biz/reply-execution/reply-turns.service';
import { ReplyDeferredError, type ReplyTurn } from '@biz/reply-execution/reply-execution.types';

const now = '2026-10-21T04:00:00Z';
const scope = { corpId: 'corp', accountId: 'account', chatId: 'chat' };
const turn: ReplyTurn = {
  ...scope,
  logicalTurnId: 'turn',
  inputIds: ['a', 'b'],
  inputOccurredAt: now,
  mode: 'execute',
  status: 'planned',
  owner: 'owner',
  fence: 1,
  plan: { version: 1, text: 'original', segments: [] },
  recovery: {},
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
  it('returns the original complete membership when only the second input is retried with new input', async () => {
    const { service } = setup();
    expect(await service.open(scope, ['b', 'new'], now)).toMatchObject({
      logicalTurnId: 'turn',
      inputIds: ['a', 'b'],
    });
  });
  it.each(['execute', 'off', 'observe'])(
    'does not bypass old execute obligations when %s reads fail',
    async (mode) => {
      const { service, repository } = setup(mode);
      repository.transition.mockRejectedValue(new Error('ambiguous read'));
      await expect(service.open(scope, ['a'], now)).rejects.toBeInstanceOf(ReplyDeferredError);
    },
  );
  it('only samples observe failure before a cutover exists', async () => {
    const { service, repository } = setup('observe', null);
    repository.transition.mockRejectedValue(new Error('unavailable'));
    expect(await service.open(scope, ['a'], now)).toBeUndefined();
    expect(repository.transition).not.toHaveBeenCalled();
  });
  it('does not promote an observation record into an executable identity', async () => {
    const { service, repository } = setup();
    repository.transition.mockResolvedValue({ ...turn, mode: 'observe' });
    await expect(service.open(scope, ['a'], now)).rejects.toThrow('cutover_review');
  });
  it('rejects inputs before cutover and expired recovery identities', async () => {
    const { service, repository } = setup();
    await expect(service.open(scope, ['a'], '2026-01-01T00:00:00Z')).rejects.toThrow('boundary');
    expect(repository.transition).not.toHaveBeenCalled();
  });
  it('requires confirmed plan and terminal writes before acknowledging input', async () => {
    const { service, repository } = setup();
    repository.transition.mockRejectedValue(new Error('write may have committed'));
    await expect(service.savePlan(turn, turn.plan!)).rejects.toThrow('plan_not_confirmed');
    await expect(service.settle(turn)).rejects.toThrow('settle_not_confirmed');
  });
});

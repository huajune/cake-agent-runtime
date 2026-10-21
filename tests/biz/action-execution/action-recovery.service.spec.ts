import { ActionRecoveryService } from '@biz/action-execution/action-recovery.service';
import { ActionRepairProcessor } from '@biz/action-execution/action-repair.queue';
import type { ActionRecord } from '@biz/action-execution/action-execution.types';

const record = {
  actionId: 'action',
  intent: { kind: 'booking' },
  status: 'unknown',
  owner: 'owner',
  fence: 1,
  attempts: 2,
  localSync: 'complete',
  recoveryDeadline: '2099-01-01T00:00:00Z',
} as ActionRecord;
function setup(row = record) {
  const records = {
    due: jest.fn().mockResolvedValue([row]),
    claim: jest.fn().mockResolvedValue(row),
    terminalEvidence: jest.fn().mockResolvedValue({ conflicting: false }),
    settle: jest.fn(async (_r, result) => ({
      ...row,
      status: result.status,
      localSync: result.status === 'succeeded' ? 'pending' : 'complete',
    })),
    defer: jest.fn(),
    markSynced: jest.fn(),
  };
  const handler = {
    reconcile: jest.fn().mockResolvedValue({
      status: 'unknown',
      evidence: { kind: 'already_satisfied', goalSatisfied: true, requestTerminated: false },
    }),
    sync: jest.fn(),
  };
  const registry = { get: jest.fn().mockReturnValue(handler) };
  return {
    records,
    handler,
    registry,
    service: new ActionRecoveryService(records as never, registry as never),
  };
}
describe('bounded action reconciliation', () => {
  it('keeps an unresolved request unknown when only its goal is satisfied', async () => {
    const { service, records, handler } = setup();
    await service.recoverDue();
    expect(handler.sync).not.toHaveBeenCalled();
    expect(records.settle).toHaveBeenCalledWith(
      record,
      expect.objectContaining({ status: 'unknown' }),
    );
    expect(records.defer).toHaveBeenCalledWith(expect.anything(), expect.any(String));
  });
  it('query failure never becomes a definitive failure or a new dispatch', async () => {
    const { service, records, handler } = setup();
    handler.reconcile.mockRejectedValue(new Error('query unavailable'));
    await service.recoverDue();
    expect(records.settle).not.toHaveBeenCalled();
    expect(records.defer).toHaveBeenCalledWith(record, expect.any(String));
  });
  it('finds succeeded plus pending sync without a repair queue job', async () => {
    const row = { ...record, status: 'succeeded' as const, localSync: 'pending' as const };
    const { service, records, handler } = setup(row);
    await service.recoverDue();
    expect(handler.reconcile).not.toHaveBeenCalled();
    expect(handler.sync).toHaveBeenCalledWith(row);
    expect(records.markSynced).toHaveBeenCalledWith(row);
  });
  it('stops bounded recovery with a visible manual flag without relabeling failure', async () => {
    const row = { ...record, attempts: 7 };
    const { service, records, handler } = setup(row);
    await service.recoverDue();
    expect(handler.reconcile).not.toHaveBeenCalled();
    expect(records.defer).toHaveBeenCalledWith(row, null);
    expect(records.settle).not.toHaveBeenCalled();
  });
  it('uses a late terminal success as evidence and only repairs local state', async () => {
    const { service, records, handler } = setup();
    records.terminalEvidence.mockResolvedValue({
      conflicting: false,
      completion: {
        status: 'succeeded',
        result: { id: 1 },
        evidence: { kind: 'completed', requestTerminated: true },
      },
    });
    await service.recoverDue();
    expect(handler.reconcile).not.toHaveBeenCalled();
    expect(handler.sync).toHaveBeenCalled();
    expect(records.markSynced).toHaveBeenCalled();
  });
  it('preserves conflicting evidence for manual review', async () => {
    const { service, records, handler } = setup();
    records.terminalEvidence.mockResolvedValue({ conflicting: true });
    await service.recoverDue();
    expect(records.defer).toHaveBeenCalledWith(record, null);
    expect(handler.reconcile).not.toHaveBeenCalled();
    expect(records.settle).not.toHaveBeenCalled();
  });
  it('queued settlement never calls the business request', async () => {
    const { records, registry, handler } = setup();
    const processor = new ActionRepairProcessor(records as never, registry as never);
    await processor.settle({
      data: { record, completion: { status: 'succeeded', result: { id: 1 } } },
    } as never);
    expect(records.settle).toHaveBeenCalledTimes(1);
    expect(handler.reconcile).not.toHaveBeenCalled();
    expect(handler.sync).toHaveBeenCalledTimes(1);
  });
});

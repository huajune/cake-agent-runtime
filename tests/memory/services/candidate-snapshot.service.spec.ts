import { CandidateSnapshotService } from '@memory/services/candidate-snapshot.service';
import type { RedisStore } from '@memory/stores/redis.store';
import type { PrecheckSnapshot } from '@resolution/evidence/snapshot';
import { PRECHECK_SNAPSHOT_TTL_SECONDS } from '@resolution/evidence/snapshot';

function buildSnapshot(): PrecheckSnapshot {
  return {
    precheckId: 'pc_turn1_100',
    factsVersion: 7,
    messageWatermark: '2:5:我叫王玥',
    jobId: 100,
    effectiveProfile: { factsVersion: 7, messageWatermark: '2:5:我叫王玥', fields: {} },
    acceptedClaimIds: ['rule_name_1'],
    missingFields: [],
    confirmedFields: [],
    createdAt: '2026-08-05T10:00:00+08:00',
    expiresAt: '2026-08-05T12:00:00+08:00',
  };
}

describe('CandidateSnapshotService', () => {
  function buildService(overrides?: Partial<Pick<RedisStore, 'get' | 'set'>>) {
    const redisStore = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
      ...overrides,
    };
    return {
      service: new CandidateSnapshotService(redisStore as unknown as RedisStore),
      redisStore,
    };
  }

  it('save：key 按 corp/user/precheckId 隔离，TTL 用快照常量', async () => {
    const { service, redisStore } = buildService();
    await service.save('corp1', 'user1', buildSnapshot());
    expect(redisStore.set).toHaveBeenCalledWith(
      'precheck-snapshot:corp1:user1:pc_turn1_100',
      expect.objectContaining({ precheckId: 'pc_turn1_100' }),
      PRECHECK_SNAPSHOT_TTL_SECONDS,
    );
  });

  it('load：命中返回快照本体', async () => {
    const snapshot = buildSnapshot();
    const { service } = buildService({
      get: jest.fn().mockResolvedValue({ key: 'k', content: snapshot, updatedAt: 'now' }),
    });
    const loaded = await service.load('corp1', 'user1', 'pc_turn1_100');
    expect(loaded?.precheckId).toBe('pc_turn1_100');
    expect(loaded?.factsVersion).toBe(7);
  });

  it('load：key 不存在或形状不合法返回 null', async () => {
    const { service } = buildService();
    expect(await service.load('corp1', 'user1', 'missing')).toBeNull();

    const malformed = buildService({
      get: jest.fn().mockResolvedValue({ key: 'k', content: { foo: 'bar' }, updatedAt: 'now' }),
    });
    expect(await malformed.service.load('corp1', 'user1', 'pc_x')).toBeNull();
  });

  it('fail open：Redis 读写异常不抛出（save 静默、load 返回 null）', async () => {
    const { service } = buildService({
      get: jest.fn().mockRejectedValue(new Error('redis down')),
      set: jest.fn().mockRejectedValue(new Error('redis down')),
    });
    await expect(service.save('corp1', 'user1', buildSnapshot())).resolves.toBeUndefined();
    await expect(service.load('corp1', 'user1', 'pc_turn1_100')).resolves.toBeNull();
  });
});

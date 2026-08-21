import { Test } from '@nestjs/testing';
import { SessionService } from '@memory/session/session.service';
import { SessionFactsService } from '@memory/session/facts.service';
import { SessionWorkbenchService } from '@memory/session/workbench.service';
import { RedisStore } from '@memory/stores/redis.store';
import { MemoryConfig } from '@memory/memory.config';
import { LlmExecutorService } from '@/llm/llm-executor.service';
import { SpongeService } from '@sponge/sponge.service';
import { SystemConfigService } from '@biz/hosting-config/services/system-config.service';

describe('SessionService reengagement store presentation state', () => {
  const job = {
    jobId: 519709,
    brandName: '奥乐齐',
    jobName: '分拣打包',
    storeName: '长白',
    cityName: '上海',
    regionName: '杨浦',
    laborForm: '全职',
    salaryDesc: '6200-9800 元/月',
    jobCategoryName: '分拣员',
    distanceKm: 2.1,
  };

  let service: SessionService;
  let hashState: Record<string, unknown>;

  beforeEach(async () => {
    hashState = {
      lastCandidatePool: [job],
      presentedJobs: [],
      currentFocusJob: null,
    };
    const redisStore = {
      getHash: jest.fn(async () => ({ ...hashState })),
      get: jest.fn().mockResolvedValue(null),
      patchHash: jest.fn(async (_key: string, patch: Record<string, unknown>) => {
        Object.assign(hashState, patch);
      }),
      backfillHash: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(false),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        SessionService,
        SessionFactsService,
        SessionWorkbenchService,
        { provide: RedisStore, useValue: redisStore },
        {
          provide: MemoryConfig,
          useValue: {
            sessionTtl: 86400,
            sessionExtractionIncrementalMessages: 10,
            consolidationGapSeconds: 86400,
          },
        },
        { provide: LlmExecutorService, useValue: { generateStructured: jest.fn() } },
        { provide: SpongeService, useValue: { fetchBrandList: jest.fn() } },
        { provide: SystemConfigService, useValue: { getExtractModelOverride: jest.fn() } },
      ],
    }).compile();
    service = moduleRef.get(SessionService);
  });

  it('increments presentation rounds even when the presented job set is deduplicated', async () => {
    await service.savePresentedJobs('corp-1', 'user-1', 'sess-1', [job]);
    await service.savePresentedJobs('corp-1', 'user-1', 'sess-1', [job]);

    expect(hashState.presentedJobs).toEqual([job]);
    expect(hashState.storePresentationRounds).toBe(2);
  });

  it('derives the round count and does not clear it when invalid jobs are pruned', async () => {
    hashState.presentedJobs = [job];
    hashState.storePresentationRounds = 2;

    expect(await service.getReengagementState('corp-1', 'user-1', 'sess-1')).toMatchObject({
      storePresentationRounds: 2,
    });

    await service.dropInvalidatedJobs('corp-1', 'user-1', 'sess-1', [job.jobId]);
    expect(hashState.presentedJobs).toEqual([]);
    expect(hashState.storePresentationRounds).toBe(2);
  });
});

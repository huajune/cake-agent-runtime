import { BadcaseEvidenceResolverService } from '@biz/test-suite/services/badcase-evidence-resolver.service';
import { buildBadcaseRecordIdFilter } from '@biz/test-suite/utils/badcase-evidence-filter.util';
import { ReviewStatus } from '@biz/test-suite/enums/test.enum';

describe('buildBadcaseRecordIdFilter', () => {
  it('拼出 jsonb contains 的 or 过滤串', () => {
    expect(buildBadcaseRecordIdFilter(['recA', 'recB'])).toBe(
      'source_trace->badcaseRecordIds.cs.["recA"],source_trace->badcaseRecordIds.cs.["recB"]',
    );
  });

  it('去重并丢弃非法字符的 ID，避免拼进查询串', () => {
    expect(buildBadcaseRecordIdFilter(['recA', 'recA', 'rec")或注入', '  '])).toBe(
      'source_trace->badcaseRecordIds.cs.["recA"]',
    );
  });

  it('全部非法或为空时返回 null，让调用方短路而不是退化成全表扫', () => {
    expect(buildBadcaseRecordIdFilter([])).toBeNull();
    expect(buildBadcaseRecordIdFilter(['*', ''])).toBeNull();
  });
});

describe('BadcaseEvidenceResolverService', () => {
  const executionRepository = {
    findScenarioEvidenceByBadcaseRecordIds: jest.fn(),
    findByConversationSnapshotIds: jest.fn(),
  };
  const snapshotRepository = { findByBadcaseRecordIds: jest.fn() };
  const service = new BadcaseEvidenceResolverService(
    executionRepository as never,
    snapshotRepository as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    executionRepository.findScenarioEvidenceByBadcaseRecordIds.mockResolvedValue([]);
    executionRepository.findByConversationSnapshotIds.mockResolvedValue([]);
    snapshotRepository.findByBadcaseRecordIds.mockResolvedValue([]);
  });

  it('两侧最近证据都通过时 overallStatus 为 passed', async () => {
    executionRepository.findScenarioEvidenceByBadcaseRecordIds.mockResolvedValue([
      {
        id: 'exec-1',
        case_id: 'case-1',
        batch_id: 'batch-s1',
        review_status: ReviewStatus.PASSED,
        reviewer_source: 'claude',
        reviewed_at: '2026-07-29T10:00:00.000Z',
        created_at: '2026-07-29T09:00:00.000Z',
        source_trace: { badcaseRecordIds: ['recA'] },
      },
    ]);
    snapshotRepository.findByBadcaseRecordIds.mockResolvedValue([
      {
        id: 'snap-1',
        conversation_id: 'conv-1',
        batch_id: 'batch-c1',
        created_at: '2026-07-29T11:00:00.000Z',
        source_trace: { badcaseRecordIds: ['recA'] },
      },
    ]);
    executionRepository.findByConversationSnapshotIds.mockResolvedValue([
      {
        id: 'turn-1',
        conversation_snapshot_id: 'snap-1',
        batch_id: 'batch-c1',
        review_status: ReviewStatus.PASSED,
        reviewer_source: 'claude',
        reviewed_at: '2026-07-29T11:30:00.000Z',
        created_at: '2026-07-29T11:10:00.000Z',
      },
    ]);

    const ledgers = await service.resolveLedgers(['recA']);

    expect(ledgers.get('recA')?.overallStatus).toBe('passed');
    expect(ledgers.get('recA')?.scenario[0]).toEqual(
      expect.objectContaining({
        batchId: 'batch-s1',
        assetIds: ['case-1'],
        reviewStatus: 'passed',
      }),
    );
    expect(ledgers.get('recA')?.conversation[0]).toEqual(
      expect.objectContaining({ batchId: 'batch-c1', reviewStatus: 'passed' }),
    );
  });

  it('只有一侧通过时是 partial，不允许关闭', async () => {
    executionRepository.findScenarioEvidenceByBadcaseRecordIds.mockResolvedValue([
      {
        id: 'exec-1',
        case_id: 'case-1',
        batch_id: 'batch-s1',
        review_status: ReviewStatus.PASSED,
        reviewer_source: 'claude',
        reviewed_at: '2026-07-29T10:00:00.000Z',
        created_at: '2026-07-29T09:00:00.000Z',
        source_trace: { badcaseRecordIds: ['recA'] },
      },
    ]);

    const ledgers = await service.resolveLedgers(['recA']);

    expect(ledgers.get('recA')?.overallStatus).toBe('partial');
  });

  it('最近一次批次失败即判 failed，且以 created_at 最新的批次为准', async () => {
    executionRepository.findScenarioEvidenceByBadcaseRecordIds.mockResolvedValue([
      {
        id: 'exec-old',
        case_id: 'case-1',
        batch_id: 'batch-old',
        review_status: ReviewStatus.PASSED,
        reviewer_source: 'claude',
        reviewed_at: '2026-07-20T10:00:00.000Z',
        created_at: '2026-07-20T09:00:00.000Z',
        source_trace: { badcaseRecordIds: ['recA'] },
      },
      {
        id: 'exec-new',
        case_id: 'case-1',
        batch_id: 'batch-new',
        review_status: ReviewStatus.FAILED,
        reviewer_source: 'claude',
        reviewed_at: '2026-07-29T10:00:00.000Z',
        created_at: '2026-07-29T09:00:00.000Z',
        source_trace: { badcaseRecordIds: ['recA'] },
      },
    ]);

    const ledgers = await service.resolveLedgers(['recA']);

    expect(ledgers.get('recA')?.scenario[0].batchId).toBe('batch-new');
    expect(ledgers.get('recA')?.overallStatus).toBe('failed');
  });

  it('同批次内一条未评审即整批 pending', async () => {
    executionRepository.findScenarioEvidenceByBadcaseRecordIds.mockResolvedValue([
      {
        id: 'exec-1',
        case_id: 'case-1',
        batch_id: 'batch-s1',
        review_status: ReviewStatus.PASSED,
        reviewer_source: 'claude',
        reviewed_at: '2026-07-29T10:00:00.000Z',
        created_at: '2026-07-29T09:00:00.000Z',
        source_trace: { badcaseRecordIds: ['recA'] },
      },
      {
        id: 'exec-2',
        case_id: 'case-2',
        batch_id: 'batch-s1',
        review_status: ReviewStatus.PENDING,
        reviewer_source: null,
        reviewed_at: null,
        created_at: '2026-07-29T09:05:00.000Z',
        source_trace: { badcaseRecordIds: ['recA'] },
      },
    ]);

    const ledgers = await service.resolveLedgers(['recA']);

    expect(ledgers.get('recA')?.scenario[0].reviewStatus).toBe('pending');
  });

  it('不把执行上顺带挂着的其他 recordId 计入本次结果', async () => {
    executionRepository.findScenarioEvidenceByBadcaseRecordIds.mockResolvedValue([
      {
        id: 'exec-1',
        case_id: 'case-1',
        batch_id: 'batch-s1',
        review_status: ReviewStatus.PASSED,
        reviewer_source: 'claude',
        reviewed_at: '2026-07-29T10:00:00.000Z',
        created_at: '2026-07-29T09:00:00.000Z',
        source_trace: { badcaseRecordIds: ['recA', 'recOther'] },
      },
    ]);

    const ledgers = await service.resolveLedgers(['recA']);

    expect(ledgers.has('recA')).toBe(true);
    expect(ledgers.has('recOther')).toBe(false);
  });

  it('查不到任何证据的 recordId 不进 Map', async () => {
    await expect(service.resolveLedgers(['recA'])).resolves.toEqual(new Map());
  });

  it('反查异常时降级为空台账，不把异常抛给回写链路', async () => {
    executionRepository.findScenarioEvidenceByBadcaseRecordIds.mockRejectedValue(
      new Error('DB down'),
    );

    await expect(service.resolveLedgers(['recA'])).resolves.toEqual(new Map());
  });
});

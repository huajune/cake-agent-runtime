import { MemoryEnrichmentService } from '@memory/services/memory-enrichment.service';
import { FALLBACK_EXTRACTION } from '@memory/session/session-facts.types';
import type { AgentMemoryContext } from '@memory/types/memory-runtime.types';
import { getRuleFact } from '@resolution/evidence/merge';
import { testRuleFact, testRuleFacts } from '../helpers/rule-fact-claims.fixture';

describe('MemoryEnrichmentService', () => {
  const mockCandidate = {
    lookupGenderFromCustomerDetail: jest.fn(),
  };

  let service: MemoryEnrichmentService;

  const baseSnapshot = (): AgentMemoryContext => ({
    shortTerm: { messageWindow: [] },
    sessionMemory: null,
    ruleFacts: null,
    stageState: { currentStage: null },
    longTerm: { semantic: { profile: null } },
  });

  beforeEach(() => {
    jest.clearAllMocks();
    service = new MemoryEnrichmentService(mockCandidate as never);
  });

  it('returns the same snapshot reference when nothing to enrich', async () => {
    mockCandidate.lookupGenderFromCustomerDetail.mockResolvedValue(null);
    const snapshot = baseSnapshot();

    const result = await service.enrich(snapshot, { token: 't', imBotId: 'b', imContactId: 'c' });

    expect(result).toBe(snapshot);
  });

  it('skips lookup when longTerm profile already has gender', async () => {
    const snapshot: AgentMemoryContext = {
      ...baseSnapshot(),
      longTerm: {
        semantic: {
          profile: {
            gender: {
              value: '女',
              confidence: 'high',
              source: 'system',
              evidence: '测试写入',
              updatedAt: '2026-05-22T10:00:00.000Z',
            },
          } as never,
        },
      },
    };

    await service.enrich(snapshot, { token: 't', imBotId: 'b', imContactId: 'c' });

    expect(mockCandidate.lookupGenderFromCustomerDetail).not.toHaveBeenCalled();
  });

  it('skips lookup when sessionMemory facts already has gender', async () => {
    const snapshot: AgentMemoryContext = {
      ...baseSnapshot(),
      sessionMemory: {
        facts: {
          ...FALLBACK_EXTRACTION,
          interview_info: { ...FALLBACK_EXTRACTION.interview_info, gender: '男' },
        },
        lastCandidatePool: null,
        presentedJobs: null,
        currentFocusJob: null,
      } as never,
    };

    await service.enrich(snapshot, { token: 't', imBotId: 'b', imContactId: 'c' });

    expect(mockCandidate.lookupGenderFromCustomerDetail).not.toHaveBeenCalled();
  });

  it('skips lookup when ruleFacts already has gender', async () => {
    const snapshot: AgentMemoryContext = {
      ...baseSnapshot(),
      ruleFacts: testRuleFacts(testRuleFact('interview_info.gender', '男', '性别识别：男')),
    };

    await service.enrich(snapshot, { token: 't', imBotId: 'b', imContactId: 'c' });

    expect(mockCandidate.lookupGenderFromCustomerDetail).not.toHaveBeenCalled();
  });

  it('supplements gender into ruleFacts when external lookup succeeds', async () => {
    mockCandidate.lookupGenderFromCustomerDetail.mockResolvedValue('男');
    const snapshot = baseSnapshot();

    const result = await service.enrich(snapshot, {
      token: 't',
      imBotId: 'b',
      imContactId: 'c',
    });

    expect(mockCandidate.lookupGenderFromCustomerDetail).toHaveBeenCalledWith({
      token: 't',
      imBotId: 'b',
      imContactId: 'c',
    });
    expect(getRuleFact(result.ruleFacts, 'interview_info.gender')).toEqual(
      expect.objectContaining({
        value: '男',
        confidence: 'low',
        producer: 'system',
        evidence: expect.objectContaining({ label: '客户详情接口补充性别：男' }),
      }),
    );
    expect(result.ruleFacts?.reasoning).toContain('客户详情接口');
    expect(snapshot.ruleFacts).toBeNull(); // 原快照不被污染
  });

  it('only looks up once after the system gender has been persisted for the next turn', async () => {
    mockCandidate.lookupGenderFromCustomerDetail.mockResolvedValue('男');

    await service.enrich(baseSnapshot(), { token: 't', imBotId: 'b', imContactId: 'c' });
    const nextTurnSnapshot: AgentMemoryContext = {
      ...baseSnapshot(),
      sessionMemory: {
        facts: {
          ...FALLBACK_EXTRACTION,
          interview_info: {
            ...FALLBACK_EXTRACTION.interview_info,
            gender: {
              value: '男',
              confidence: 'low',
              source: 'system',
              evidence: '客户详情接口补充性别：男',
            },
            gender_source: {
              value: 'system',
              confidence: 'low',
              source: 'system',
              evidence: '客户详情接口补充性别来源：系统标签',
            },
          },
        },
        lastCandidatePool: null,
        presentedJobs: null,
        currentFocusJob: null,
      } as never,
    };

    await service.enrich(nextTurnSnapshot, { token: 't', imBotId: 'b', imContactId: 'c' });

    expect(mockCandidate.lookupGenderFromCustomerDetail).toHaveBeenCalledTimes(1);
  });

  it('preserves existing ruleFacts fields when merging gender', async () => {
    mockCandidate.lookupGenderFromCustomerDetail.mockResolvedValue('女');
    const snapshot: AgentMemoryContext = {
      ...baseSnapshot(),
      ruleFacts: testRuleFacts(testRuleFact('preferences.salary', '30元/时', '薪资识别：30元/时')),
    };

    const result = await service.enrich(snapshot, {
      token: 't',
      imBotId: 'b',
      imContactId: 'c',
    });

    expect(getRuleFact(result.ruleFacts, 'preferences.salary')).toEqual(
      expect.objectContaining({ value: '30元/时' }),
    );
    expect(getRuleFact(result.ruleFacts, 'interview_info.gender')).toEqual(
      expect.objectContaining({ value: '女' }),
    );
    expect(result.ruleFacts?.reasoning).toContain('薪资识别');
    expect(result.ruleFacts?.reasoning).toContain('客户详情接口补充性别：女');
  });

  it('swallows lookup error and returns original snapshot', async () => {
    mockCandidate.lookupGenderFromCustomerDetail.mockRejectedValue(new Error('network'));
    const snapshot = baseSnapshot();

    const result = await service.enrich(snapshot, {
      token: 't',
      imBotId: 'b',
      imContactId: 'c',
    });

    expect(result).toBe(snapshot);
  });
});

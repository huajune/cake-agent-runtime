import { MemoryEnrichmentService } from '@memory/enrichment.service';
import { FALLBACK_EXTRACTION } from '@memory/short-term/short-term.types';
import type { AgentMemoryContext } from '@memory/recall.types';
import { getTurnHint } from '@resolution/evidence/merge';
import { testTurnHint, testTurnHints } from '../helpers/turn-hints.fixture';

describe('MemoryEnrichmentService', () => {
  const mockCandidate = {
    lookupGenderFromCustomerDetail: jest.fn(),
  };

  let service: MemoryEnrichmentService;

  const baseSnapshot = (): AgentMemoryContext => ({
    shortTerm: {
      messageWindow: [],
      sessionState: null,
      stage: { currentStage: null },
    },
    turnHints: null,
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

  it('skips lookup when short-term session state facts already has gender', async () => {
    const snapshot: AgentMemoryContext = {
      ...baseSnapshot(),
      shortTerm: {
        ...baseSnapshot().shortTerm,
        sessionState: {
          facts: {
            ...FALLBACK_EXTRACTION,
            interview_info: { ...FALLBACK_EXTRACTION.interview_info, gender: '男' },
          },
          lastCandidatePool: null,
          presentedJobs: null,
          currentFocusJob: null,
        } as never,
      },
    };

    await service.enrich(snapshot, { token: 't', imBotId: 'b', imContactId: 'c' });

    expect(mockCandidate.lookupGenderFromCustomerDetail).not.toHaveBeenCalled();
  });

  it('skips lookup when turnHints already has gender', async () => {
    const snapshot: AgentMemoryContext = {
      ...baseSnapshot(),
      turnHints: testTurnHints(testTurnHint('interview_info.gender', '男', '性别识别：男')),
    };

    await service.enrich(snapshot, { token: 't', imBotId: 'b', imContactId: 'c' });

    expect(mockCandidate.lookupGenderFromCustomerDetail).not.toHaveBeenCalled();
  });

  it('supplements gender into turnHints when external lookup succeeds', async () => {
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
    expect(getTurnHint(result.turnHints, 'interview_info.gender')).toEqual(
      expect.objectContaining({
        value: '男',
        confidence: 'low',
        producer: 'system',
        evidence: expect.objectContaining({ label: '客户详情接口补充性别：男' }),
      }),
    );
    expect(getTurnHint(result.turnHints, 'interview_info.gender_source')).toBeNull();
    expect(result.turnHints?.reasoning).toContain('客户详情接口');
    expect(snapshot.turnHints).toBeNull(); // 原快照不被污染
  });

  it('only looks up once after the system gender has been persisted for the next turn', async () => {
    mockCandidate.lookupGenderFromCustomerDetail.mockResolvedValue('男');

    await service.enrich(baseSnapshot(), { token: 't', imBotId: 'b', imContactId: 'c' });
    const nextTurnSnapshot: AgentMemoryContext = {
      ...baseSnapshot(),
      shortTerm: {
        ...baseSnapshot().shortTerm,
        sessionState: {
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
              gender_source: null,
            },
          },
          lastCandidatePool: null,
          presentedJobs: null,
          currentFocusJob: null,
        } as never,
      },
    };

    await service.enrich(nextTurnSnapshot, { token: 't', imBotId: 'b', imContactId: 'c' });

    expect(mockCandidate.lookupGenderFromCustomerDetail).toHaveBeenCalledTimes(1);
  });

  it('preserves existing turnHints fields when merging gender', async () => {
    mockCandidate.lookupGenderFromCustomerDetail.mockResolvedValue('女');
    const snapshot: AgentMemoryContext = {
      ...baseSnapshot(),
      turnHints: testTurnHints(testTurnHint('preferences.salary', '30元/时', '薪资识别：30元/时')),
    };

    const result = await service.enrich(snapshot, {
      token: 't',
      imBotId: 'b',
      imContactId: 'c',
    });

    expect(getTurnHint(result.turnHints, 'preferences.salary')).toEqual(
      expect.objectContaining({ value: '30元/时' }),
    );
    expect(getTurnHint(result.turnHints, 'interview_info.gender')).toEqual(
      expect.objectContaining({ value: '女' }),
    );
    expect(result.turnHints?.reasoning).toContain('薪资识别');
    expect(result.turnHints?.reasoning).toContain('客户详情接口补充性别：女');
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

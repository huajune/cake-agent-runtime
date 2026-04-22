import { MemoryEnrichmentService } from '@memory/services/memory-enrichment.service';
import { FALLBACK_EXTRACTION } from '@memory/types/session-facts.types';
import type { AgentMemoryContext } from '@memory/types/memory-runtime.types';

describe('MemoryEnrichmentService', () => {
  const mockCandidate = {
    lookupGenderFromCustomerDetail: jest.fn(),
  };

  let service: MemoryEnrichmentService;

  const baseSnapshot = (): AgentMemoryContext => ({
    shortTerm: { messageWindow: [] },
    sessionMemory: null,
    highConfidenceFacts: null,
    procedural: { currentStage: null, fromStage: null, advancedAt: null, reason: null },
    longTerm: { profile: null },
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
      longTerm: { profile: { gender: '女' } as never },
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

  it('skips lookup when highConfidenceFacts already has gender', async () => {
    const snapshot: AgentMemoryContext = {
      ...baseSnapshot(),
      highConfidenceFacts: {
        ...FALLBACK_EXTRACTION,
        interview_info: { ...FALLBACK_EXTRACTION.interview_info, gender: '男' },
        reasoning: 'existing',
      },
    };

    await service.enrich(snapshot, { token: 't', imBotId: 'b', imContactId: 'c' });

    expect(mockCandidate.lookupGenderFromCustomerDetail).not.toHaveBeenCalled();
  });

  it('supplements gender into highConfidenceFacts when external lookup succeeds', async () => {
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
    expect(result.highConfidenceFacts?.interview_info.gender).toBe('男');
    expect(result.highConfidenceFacts?.reasoning).toContain('客户详情接口');
    expect(snapshot.highConfidenceFacts).toBeNull(); // 原快照不被污染
  });

  it('preserves existing highConfidenceFacts fields when merging gender', async () => {
    mockCandidate.lookupGenderFromCustomerDetail.mockResolvedValue('女');
    const snapshot: AgentMemoryContext = {
      ...baseSnapshot(),
      highConfidenceFacts: {
        ...FALLBACK_EXTRACTION,
        preferences: { ...FALLBACK_EXTRACTION.preferences, brands: ['来伊份'] },
        reasoning: '品牌别名识别',
      },
    };

    const result = await service.enrich(snapshot, {
      token: 't',
      imBotId: 'b',
      imContactId: 'c',
    });

    expect(result.highConfidenceFacts?.preferences.brands).toEqual(['来伊份']);
    expect(result.highConfidenceFacts?.interview_info.gender).toBe('女');
    expect(result.highConfidenceFacts?.reasoning).toContain('品牌别名识别');
    expect(result.highConfidenceFacts?.reasoning).toContain('客户详情接口补充性别：女');
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

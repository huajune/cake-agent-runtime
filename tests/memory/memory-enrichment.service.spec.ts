import { MemoryEnrichmentService } from '@memory/services/memory-enrichment.service';
import {
  FALLBACK_EXTRACTION,
  type HighConfidenceFacts,
  type HighConfidenceValue,
} from '@memory/types/session-facts.types';
import type { AgentMemoryContext } from '@memory/types/memory-runtime.types';

function highConfidence<T>(value: T, evidence: string): HighConfidenceValue<T> {
  return { value, confidence: 'high', source: 'rule', evidence };
}

function emptyHighConfidenceFacts(): HighConfidenceFacts {
  return {
    interview_info: {
      name: null,
      phone: null,
      gender: null,
      gender_source: null,
      age: null,
      applied_store: null,
      applied_position: null,
      interview_time: null,
      is_student: null,
      education: null,
      has_health_certificate: null,
    },
    preferences: {
      brands: null,
      salary: null,
      position: null,
      schedule: null,
      city: null,
      district: null,
      location: null,
      labor_form: null,
      delayed_intent: null,
      short_term: null,
      open_position: null,
      time_windows: null,
      schedule_constraint: null,
      available_after: null,
    },
    reasoning: 'test',
  };
}

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
      longTerm: {
        profile: {
          gender: {
            value: '女',
            confidence: 'high',
            source: 'booking',
            evidence: '测试写入',
            updatedAt: '2026-05-22T10:00:00.000Z',
          },
        } as never,
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

  it('skips lookup when highConfidenceFacts already has gender', async () => {
    const snapshot: AgentMemoryContext = {
      ...baseSnapshot(),
      highConfidenceFacts: {
        ...emptyHighConfidenceFacts(),
        interview_info: {
          ...emptyHighConfidenceFacts().interview_info,
          gender: highConfidence('男', '性别识别：男'),
        },
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
    expect(result.highConfidenceFacts?.interview_info.gender).toEqual(
      expect.objectContaining({
        value: '男',
        confidence: 'low',
        source: 'system',
        evidence: '客户详情接口补充性别：男',
      }),
    );
    expect(result.highConfidenceFacts?.reasoning).toContain('客户详情接口');
    expect(snapshot.highConfidenceFacts).toBeNull(); // 原快照不被污染
  });

  it('preserves existing highConfidenceFacts fields when merging gender', async () => {
    mockCandidate.lookupGenderFromCustomerDetail.mockResolvedValue('女');
    const snapshot: AgentMemoryContext = {
      ...baseSnapshot(),
      highConfidenceFacts: {
        ...emptyHighConfidenceFacts(),
        preferences: {
          ...emptyHighConfidenceFacts().preferences,
          brands: highConfidence(['来伊份'], '品牌别名识别：来伊份'),
        },
        reasoning: '品牌别名识别',
      },
    };

    const result = await service.enrich(snapshot, {
      token: 't',
      imBotId: 'b',
      imContactId: 'c',
    });

    expect(result.highConfidenceFacts?.preferences.brands).toEqual(
      expect.objectContaining({ value: ['来伊份'] }),
    );
    expect(result.highConfidenceFacts?.interview_info.gender).toEqual(
      expect.objectContaining({ value: '女' }),
    );
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

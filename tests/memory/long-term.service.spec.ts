import { LongTermService } from '@memory/services/long-term.service';
import {
  FALLBACK_EXTRACTION,
  sessionFactValue,
  toSessionFacts,
} from '@memory/types/session-facts.types';

describe('LongTermService', () => {
  const mockSupabaseStore = {
    getProfile: jest.fn(),
    upsertProfileFacts: jest.fn().mockResolvedValue(undefined),
    getSummaryData: jest.fn(),
    appendSummary: jest.fn().mockResolvedValue(undefined),
    markLastSettledMessageAt: jest.fn().mockResolvedValue(undefined),
  };

  let service: LongTermService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new LongTermService(mockSupabaseStore as never);
  });

  describe('getProfile', () => {
    it('should return null when no profile exists', async () => {
      mockSupabaseStore.getProfile.mockResolvedValue(null);

      const profile = await service.getProfile('corp1', 'user1');

      expect(profile).toBeNull();
    });

    it('should return profile from store', async () => {
      mockSupabaseStore.getProfile.mockResolvedValue({
        name: {
          value: '张三',
          confidence: 'high',
          source: 'booking',
          evidence: '报名成功后写入',
          updatedAt: '2026-05-22T10:00:00.000Z',
        },
        phone: null,
        gender: null,
        age: null,
        is_student: {
          value: true,
          confidence: 'medium',
          source: 'extraction',
          evidence: '会话沉淀提取',
          updatedAt: '2026-05-22T10:00:00.000Z',
        },
        education: null,
        has_health_certificate: null,
      });

      const profile = await service.getProfile('corp1', 'user1');

      expect(profile?.name?.value).toBe('张三');
      expect(profile?.is_student?.value).toBe(true);
    });
  });

  describe('saveProfile', () => {
    it('should skip saving when all fields are null', async () => {
      await service.saveProfile('corp1', 'user1', { name: null, phone: null });

      expect(mockSupabaseStore.upsertProfileFacts).not.toHaveBeenCalled();
    });

    it('should save only non-null fields with enrichment medium facts', async () => {
      await service.saveProfile('corp1', 'user1', { name: '张三', phone: null, gender: '男' });

      expect(mockSupabaseStore.upsertProfileFacts).toHaveBeenCalledWith(
        'corp1',
        'user1',
        {
          name: expect.objectContaining({
            value: '张三',
            source: 'enrichment',
            confidence: 'medium',
          }),
          gender: expect.objectContaining({
            value: '男',
            source: 'enrichment',
            confidence: 'medium',
          }),
        },
        undefined,
      );
    });
  });

  describe('writeFromBooking', () => {
    it('should call upsertProfileFacts with booking source and high confidence', async () => {
      await service.writeFromBooking('corp1', 'user1', {
        name: '张三',
        phone: '13800138000',
        age: 22,
        gender: '男',
      });

      expect(mockSupabaseStore.upsertProfileFacts).toHaveBeenCalledWith(
        'corp1',
        'user1',
        {
          name: expect.objectContaining({ value: '张三', source: 'booking', confidence: 'high' }),
          phone: expect.objectContaining({
            value: '13800138000',
            source: 'booking',
            confidence: 'high',
          }),
          age: expect.objectContaining({ value: '22', source: 'booking', confidence: 'high' }),
          gender: expect.objectContaining({ value: '男', source: 'booking', confidence: 'high' }),
        },
      );
    });

    it('should convert age from number to string', async () => {
      await service.writeFromBooking('corp1', 'user1', {
        name: '李四',
        phone: '13900139000',
        age: 18,
        gender: '女',
      });

      const call = mockSupabaseStore.upsertProfileFacts.mock.calls[0];
      expect(call[2].age.value).toBe('18');
    });

    it('should include updatedAt ISO timestamp in each profile fact', async () => {
      const before = new Date().toISOString();
      await service.writeFromBooking('corp1', 'user1', {
        name: '王五',
        phone: '13700137000',
        age: 30,
        gender: '男',
      });
      const after = new Date().toISOString();

      const facts = mockSupabaseStore.upsertProfileFacts.mock.calls[0][2];
      expect(facts.name.updatedAt >= before).toBe(true);
      expect(facts.name.updatedAt <= after).toBe(true);
    });

    it('should swallow errors from upsertProfileFacts silently', async () => {
      mockSupabaseStore.upsertProfileFacts.mockRejectedValueOnce(new Error('DB error'));

      await expect(
        service.writeFromBooking('corp1', 'user1', {
          name: '张三',
          phone: '13800138000',
          age: 22,
          gender: '男',
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe('writeFromSettlement', () => {
    it('should preserve original session fact metadata in profile evidence', async () => {
      const sessionFacts = toSessionFacts(
        {
          ...FALLBACK_EXTRACTION,
          interview_info: {
            ...FALLBACK_EXTRACTION.interview_info,
            name: '张三',
            age: '24',
          },
          reasoning: '候选人提供了姓名和年龄',
        },
        {
          confidence: 'medium',
          source: 'llm',
          evidence: 'LLM 结构化提取：候选人提供了姓名和年龄',
        },
      );
      sessionFacts.interview_info.name = sessionFactValue('张三', {
        confidence: 'high',
        source: 'rule',
        evidence: '结构化姓名识别：张三',
      });

      await service.writeFromSettlement('corp1', 'user1', sessionFacts);

      const savedFacts = mockSupabaseStore.upsertProfileFacts.mock.calls[0][2];
      expect(savedFacts.name).toEqual(
        expect.objectContaining({
          value: '张三',
          source: 'extraction',
          confidence: 'medium',
          evidence: expect.stringContaining('原字段来源=rule'),
        }),
      );
      expect(savedFacts.name.evidence).toContain('原字段置信度=high');
      expect(savedFacts.name.evidence).toContain('原证据=结构化姓名识别：张三');
      expect(savedFacts.age).toEqual(
        expect.objectContaining({
          value: '24',
          source: 'extraction',
          confidence: 'medium',
          evidence: expect.stringContaining('原字段来源=llm'),
        }),
      );
    });
  });

  describe('getSummaryData', () => {
    it('should return null when no data', async () => {
      mockSupabaseStore.getSummaryData.mockResolvedValue(null);

      const result = await service.getSummaryData('corp1', 'user1');

      expect(result).toBeNull();
    });

    it('should return summary data', async () => {
      const data = {
        recent: [
          { summary: 'test', sessionId: 's1', startTime: '2026-03-15', endTime: '2026-03-15' },
        ],
        archive: 'old stuff',
        lastSettledMessageAt: '2026-03-15T10:00:00.000Z',
      };
      mockSupabaseStore.getSummaryData.mockResolvedValue(data);

      const result = await service.getSummaryData('corp1', 'user1');

      expect(result?.recent).toHaveLength(1);
      expect(result?.archive).toBe('old stuff');
      expect(result?.lastSettledMessageAt).toBe('2026-03-15T10:00:00.000Z');
    });
  });
});

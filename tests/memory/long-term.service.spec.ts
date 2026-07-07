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
    getPreferenceFacts: jest.fn(),
    upsertPreferenceFacts: jest.fn().mockResolvedValue(undefined),
    getSummaryData: jest.fn(),
    appendSummary: jest.fn().mockResolvedValue(undefined),
    markLastSettledMessageAt: jest.fn().mockResolvedValue(undefined),
    upsertMessageMetadata: jest.fn().mockResolvedValue(undefined),
    getActiveBookings: jest.fn(),
    setActiveBooking: jest.fn().mockResolvedValue(undefined),
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

      expect(mockSupabaseStore.upsertProfileFacts).toHaveBeenCalledWith('corp1', 'user1', {
        name: expect.objectContaining({ value: '张三', source: 'booking', confidence: 'high' }),
        phone: expect.objectContaining({
          value: '13800138000',
          source: 'booking',
          confidence: 'high',
        }),
        age: expect.objectContaining({ value: '22', source: 'booking', confidence: 'high' }),
        gender: expect.objectContaining({ value: '男', source: 'booking', confidence: 'high' }),
      });
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

    it('should stamp origin session/bot lineage onto settled profile and preference facts', async () => {
      const sessionFacts = toSessionFacts(
        {
          ...FALLBACK_EXTRACTION,
          interview_info: {
            ...FALLBACK_EXTRACTION.interview_info,
            name: '张三',
          },
          preferences: {
            ...FALLBACK_EXTRACTION.preferences,
            brands: ['肯德基'],
          },
          reasoning: '候选人提供了姓名与品牌意向',
        },
        { confidence: 'medium', source: 'llm', evidence: 'LLM 结构化提取' },
      );

      await service.writeFromSettlement('corp1', 'user1', sessionFacts, {
        sessionId: 'chat-A',
        botImId: 'bot-wxid-A',
      });

      const savedProfile = mockSupabaseStore.upsertProfileFacts.mock.calls[0][2];
      expect(savedProfile.name).toEqual(
        expect.objectContaining({ originSessionId: 'chat-A', originBotId: 'bot-wxid-A' }),
      );
      const savedPrefs = mockSupabaseStore.upsertPreferenceFacts.mock.calls[0][2];
      expect(savedPrefs.brands).toEqual(
        expect.objectContaining({ originSessionId: 'chat-A', originBotId: 'bot-wxid-A' }),
      );
    });

    it('should omit origin lineage fields when origin is not provided', async () => {
      const sessionFacts = toSessionFacts(
        {
          ...FALLBACK_EXTRACTION,
          interview_info: { ...FALLBACK_EXTRACTION.interview_info, name: '张三' },
          reasoning: 'x',
        },
        { confidence: 'medium', source: 'llm', evidence: 'LLM 结构化提取' },
      );

      await service.writeFromSettlement('corp1', 'user1', sessionFacts);

      const savedProfile = mockSupabaseStore.upsertProfileFacts.mock.calls[0][2];
      expect(savedProfile.name.originSessionId).toBeUndefined();
      expect(savedProfile.name.originBotId).toBeUndefined();
    });

    it('should settle stable preferences into long-term preference facts', async () => {
      const sessionFacts = toSessionFacts(
        {
          ...FALLBACK_EXTRACTION,
          preferences: {
            ...FALLBACK_EXTRACTION.preferences,
            brands: ['肯德基', '必胜客'],
            position: ['后厨'],
            schedule: '下午',
            city: { value: '上海', confidence: 'high', evidence: 'explicit_city' },
            district: ['浦东新区'],
            // 单次求职 episode 的临时态：不应沉淀
            short_term: true,
            time_windows: ['17点后'],
            open_position: false,
          },
          reasoning: '候选人意向提取',
        },
        { confidence: 'medium', source: 'llm', evidence: 'LLM 结构化提取' },
      );

      await service.writeFromSettlement('corp1', 'user1', sessionFacts);

      expect(mockSupabaseStore.upsertPreferenceFacts).toHaveBeenCalledTimes(1);
      const saved = mockSupabaseStore.upsertPreferenceFacts.mock.calls[0][2];
      expect(saved.brands).toEqual(
        expect.objectContaining({
          value: ['肯德基', '必胜客'],
          source: 'extraction',
          confidence: 'medium',
        }),
      );
      expect(saved.city).toEqual(expect.objectContaining({ value: '上海' }));
      expect(saved.position).toEqual(expect.objectContaining({ value: ['后厨'] }));
      expect(saved.schedule).toEqual(expect.objectContaining({ value: '下午' }));
      expect(saved.district).toEqual(expect.objectContaining({ value: ['浦东新区'] }));
      // 临时态字段不沉淀
      expect(saved.short_term).toBeUndefined();
      expect(saved.time_windows).toBeUndefined();
      expect(saved.open_position).toBeUndefined();
    });

    it('should skip preference write when no stable preferences exist', async () => {
      const sessionFacts = toSessionFacts(
        {
          ...FALLBACK_EXTRACTION,
          interview_info: { ...FALLBACK_EXTRACTION.interview_info, name: '张三' },
          reasoning: '仅身份信息',
        },
        { confidence: 'medium', source: 'llm', evidence: 'LLM 结构化提取' },
      );

      await service.writeFromSettlement('corp1', 'user1', sessionFacts);

      expect(mockSupabaseStore.upsertPreferenceFacts).not.toHaveBeenCalled();
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

  describe('updateActiveBookingInterviewTime', () => {
    it('should merge new interview time into existing booking, preserving job/brand/store metadata', async () => {
      mockSupabaseStore.getActiveBookings.mockResolvedValue([
        {
          work_order_id: 111,
          linked_at: '2026-07-01T10:00:00.000Z',
          job_id: 55,
          interview_time: '2026-07-05 14:00',
          brand_name: '肯德基',
          store_name: '朝阳店',
          job_name: '服务员',
        },
        {
          work_order_id: 222,
          linked_at: '2026-07-02T10:00:00.000Z',
          job_id: 66,
          interview_time: '2026-07-06 10:00',
          brand_name: '瑞幸',
          store_name: '静安店',
          job_name: '店员',
        },
      ]);

      await service.updateActiveBookingInterviewTime('corp1', 'user1', 111, '2026-07-08 15:30');

      // setActiveBooking 是整条覆盖写：合并回写必须带上目标工单的全部已有元数据
      expect(mockSupabaseStore.setActiveBooking).toHaveBeenCalledTimes(1);
      expect(mockSupabaseStore.setActiveBooking).toHaveBeenCalledWith('corp1', 'user1', 111, {
        job_id: 55,
        interview_time: '2026-07-08 15:30',
        brand_name: '肯德基',
        store_name: '朝阳店',
        job_name: '服务员',
      });
    });

    it('should write a new-time-only entry when no matching active booking exists', async () => {
      mockSupabaseStore.getActiveBookings.mockResolvedValue([]);

      await service.updateActiveBookingInterviewTime('corp1', 'user1', 333, '2026-07-09 09:00');

      expect(mockSupabaseStore.setActiveBooking).toHaveBeenCalledWith('corp1', 'user1', 333, {
        job_id: null,
        interview_time: '2026-07-09 09:00',
        brand_name: null,
        store_name: null,
        job_name: null,
      });
    });

    it('should not inherit metadata from a different work order', async () => {
      mockSupabaseStore.getActiveBookings.mockResolvedValue([
        {
          work_order_id: 999,
          linked_at: '2026-07-01T10:00:00.000Z',
          job_id: 77,
          interview_time: '2026-07-05 14:00',
          brand_name: '奥乐齐',
          store_name: '缤谷广场',
          job_name: '理货员',
        },
      ]);

      await service.updateActiveBookingInterviewTime('corp1', 'user1', 333, '2026-07-09 09:00');

      expect(mockSupabaseStore.setActiveBooking).toHaveBeenCalledWith('corp1', 'user1', 333, {
        job_id: null,
        interview_time: '2026-07-09 09:00',
        brand_name: null,
        store_name: null,
        job_name: null,
      });
    });

    it('should swallow store errors without throwing', async () => {
      mockSupabaseStore.getActiveBookings.mockRejectedValue(new Error('DB down'));

      await expect(
        service.updateActiveBookingInterviewTime('corp1', 'user1', 111, '2026-07-08 15:30'),
      ).resolves.toBeUndefined();
      expect(mockSupabaseStore.setActiveBooking).not.toHaveBeenCalled();
    });
  });

  describe('updateMessageMetadata', () => {
    it('should delegate metadata updates to store', async () => {
      await service.updateMessageMetadata('corp1', 'user1', {
        imBotId: 'im-bot-1',
        imContactId: 'im-contact-1',
      });

      expect(mockSupabaseStore.upsertMessageMetadata).toHaveBeenCalledWith('corp1', 'user1', {
        imBotId: 'im-bot-1',
        imContactId: 'im-contact-1',
      });
    });
  });
});

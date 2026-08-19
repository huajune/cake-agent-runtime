import { buildInterviewBookingTool } from '@tools/duliday-interview-booking.tool';
import { TOOL_ERROR_TYPES } from '@tools/types/tool-error-types';
import type { PrecheckSnapshot } from '@resolution/evidence/snapshot';
import { computeCandidateMessageWatermark } from '@resolution/evidence/snapshot';
import { createToolContext } from '../../helpers/tool-context.fixture';

/**
 * booking 侧裁决权改造（宪法 P11 / 执行清单工序 D3·E2）。
 *
 * D3 报名级字段确认级终审网：公证三问全过也不等于值是对的——「我姐今年24」引文真实、
 * 形状合法、不回声，三问一路绿灯。只有候选人本人一句明确表态能把它挡下来。
 * E2 姓名闸门换 quote 作证：解锁不再靠闸门自己长一条确认识别正则。
 */

const TIME_SUFFIX = '[消息发送时间：2026-08-12 10:00:00]';
/** 候选人自陈原文：手机号出处闸门（正向证据）与快照水位都基于它。 */
const CANDIDATE_MESSAGES = [{ role: 'user', content: `我叫王玥，电话13812345678 ${TIME_SUFFIX}` }];
const WATERMARK = computeCandidateMessageWatermark(['我叫王玥，电话13812345678']);

/* eslint-disable @typescript-eslint/no-explicit-any */
function buildSnapshot(overrides: Partial<PrecheckSnapshot> = {}): PrecheckSnapshot {
  return {
    precheckId: 'pc_turn1_100',
    factsVersion: 1,
    messageWatermark: WATERMARK,
    jobId: 100,
    effectiveProfile: {
      factsVersion: 1,
      messageWatermark: WATERMARK,
      fields: {
        name: { value: '王玥', status: 'accepted' },
        phone: { value: '13812345678', status: 'accepted' },
        age: { value: 25, status: 'accepted' },
        gender: { value: 2, status: 'accepted' },
        healthCertificate: { value: 1, status: 'accepted' },
      },
    },
    acceptedClaimIds: [],
    missingFields: [],
    confirmedFields: [],
    createdAt: '2026-08-12T10:00:00+08:00',
    expiresAt: '2026-08-12T12:00:00+08:00',
    ...overrides,
  };
}

describe('booking 报名级字段终审与姓名作证（P11 工序 D3/E2）', () => {
  const mockSpongeService = {
    fetchJobs: jest.fn(),
    bookInterview: jest.fn(),
    uploadAttachmentFromUrl: jest.fn(),
    getCachedWorkOrderById: jest.fn().mockResolvedValue(null),
  };

  const validInput = {
    name: '王玥',
    phone: '13812345678',
    age: 25,
    genderId: 2,
    jobId: 100,
    interviewTime: '2026-08-14 14:00:00',
    operateType: 6,
    hasHealthCertificate: 1,
    precheckId: 'pc_turn1_100',
    prechecked: { nextAction: 'ready_to_book' as const, missingFieldsCount: 0 },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockSpongeService.getCachedWorkOrderById.mockResolvedValue(null);
    mockSpongeService.bookInterview.mockResolvedValue({ success: true, data: { id: 777 } });
    mockSpongeService.fetchJobs.mockResolvedValue({
      jobs: [
        {
          basicInfo: { jobId: 100, brandName: 'KFC', jobName: '服务员', storeInfo: {} },
          hiringRequirement: {
            basicPersonalRequirements: { minAge: 18, maxAge: 45, genderRequirement: '不限' },
            certificate: {},
          },
          interviewProcess: { firstInterview: {}, interviewSupplement: [] },
        },
      ],
    });
  });

  const run = async (
    input: Record<string, any>,
    options: {
      mode?: 'shadow' | 'enforce';
      snapshot?: PrecheckSnapshot | null;
      messages?: unknown[];
    } = {},
  ) => {
    const context = createToolContext({
      session: { userId: 'user-1', corpId: 'corp-1', sessionId: 'sess-1', botUserId: 'manager-1' },
      // jobId provenance 闸门：本会话召回过该岗位才允许提交（与本用例无关的既有闸门）。
      archive: { isRecalledJobId: () => true, recalledJobIds: [100] },
      turnInput: { messages: options.messages ?? CANDIDATE_MESSAGES },
    });
    const tool = buildInterviewBookingTool(
      mockSpongeService as never,
      { notifyInterviewBookingResult: jest.fn().mockResolvedValue(true) } as never,
      { pauseUser: jest.fn().mockResolvedValue(undefined) } as never,
      {
        writeFromBooking: jest.fn().mockResolvedValue(undefined),
        setActiveBooking: jest.fn().mockResolvedValue(undefined),

        getActiveBookings: jest.fn().mockResolvedValue([]),
      } as never,
      { recordEvent: jest.fn().mockResolvedValue(undefined) } as never,
      {
        mode: options.mode ?? 'shadow',
        snapshots: {
          load: jest.fn().mockResolvedValue(options.snapshot ?? null),
        } as never,
        observer: { emit: jest.fn() },
      },
    )(context);
    return (await tool.execute(input as any, {
      toolCallId: 't',
      context: {},
      messages: [],
      abortSignal: undefined as any,
    })) as any;
  };

  describe('工序 D3：报名级字段确认级终审网', () => {
    it('enforce 下年龄未经候选人确认 → 拒绝提交，并给出确认配方', async () => {
      const result = await run(validInput, { mode: 'enforce', snapshot: buildSnapshot() });

      expect(result.success).toBe(false);
      expect(result.errorType).toBe(TOOL_ERROR_TYPES.BOOKING_MISSING_FIELDS);
      expect(result.unconfirmedCriticalFields).toEqual(['age']);
      // 出口必须可执行：告诉模型确认怎么做、claim 怎么提交（宪法 P11 代价路由）。
      expect(result._replyInstruction).toContain('operation="confirm"');
      expect(mockSpongeService.bookInterview).not.toHaveBeenCalled();
    });

    it('年龄已达确认级 → 放行', async () => {
      const result = await run(validInput, {
        mode: 'enforce',
        snapshot: buildSnapshot({ confirmedFields: ['age'] }),
      });

      expect(result.success).toBe(true);
      expect(mockSpongeService.bookInterview).toHaveBeenCalled();
    });

    it('shadow 下不拦（迁移三阶段 P0 零行为变化）', async () => {
      const result = await run(validInput, { snapshot: buildSnapshot() });

      expect(result.success).toBe(true);
      expect(mockSpongeService.bookInterview).toHaveBeenCalled();
    });

    it('快照缺失按 fail open 放行（Redis 抖动不得阻断报名）', async () => {
      const result = await run(validInput, { mode: 'enforce', snapshot: null });

      expect(result.success).toBe(true);
    });
  });

  describe('工序 E2：姓名闸门换 quote 作证', () => {
    /** 打招呼语昵称：负向出处证据，`isFromAutoGreeting` 命中即拒。 */
    const greetingMessages = [
      { role: 'user', content: `我是小玥 ${TIME_SUFFIX}` },
      { role: 'user', content: `电话13812345678 ${TIME_SUFFIX}` },
    ];

    it('负向出处（打招呼语昵称）在无作证时照旧拒——闸门不被改造削弱', async () => {
      const result = await run(
        { ...validInput, name: '小玥', precheckId: undefined },
        { messages: greetingMessages },
      );

      expect(result.success).toBe(false);
      expect(result.suspiciousName).toBe('小玥');
    });

    it('shadow 下 statement claim 不解锁打招呼语负向证据', async () => {
      const watermark = computeCandidateMessageWatermark(['我是小玥', '电话13812345678']);
      const result = await run(
        { ...validInput, name: '小玥' },
        {
          messages: greetingMessages,
          snapshot: buildSnapshot({
            messageWatermark: watermark,
            effectiveProfile: {
              factsVersion: 1,
              messageWatermark: watermark,
              fields: {
                name: {
                  value: '小玥',
                  status: 'accepted',
                  acceptedClaimId: 'claim-name-statement',
                },
                phone: { value: '13812345678', status: 'accepted' },
                age: { value: 25, status: 'accepted' },
                gender: { value: 2, status: 'accepted' },
                healthCertificate: { value: 1, status: 'accepted' },
              },
            },
          }),
        },
      );

      expect(result.success).toBe(false);
      expect(result.suspiciousName).toBe('小玥');
      expect(mockSpongeService.bookInterview).not.toHaveBeenCalled();
    });

    it('enforce 下确认级姓名 claim 可压过打招呼语负向证据', async () => {
      const watermark = computeCandidateMessageWatermark(['我是小玥', '电话13812345678']);
      const result = await run(
        { ...validInput, name: '小玥' },
        {
          mode: 'enforce',
          messages: greetingMessages,
          snapshot: buildSnapshot({
            messageWatermark: watermark,
            confirmedFields: ['name', 'age'],
            acceptedClaimIds: ['claim-name-confirm'],
            effectiveProfile: {
              factsVersion: 1,
              messageWatermark: watermark,
              fields: {
                name: {
                  value: '小玥',
                  status: 'accepted',
                  acceptedClaimId: 'claim-name-confirm',
                },
                phone: { value: '13812345678', status: 'accepted' },
                age: { value: 25, status: 'accepted' },
                gender: { value: 2, status: 'accepted' },
                healthCertificate: { value: 1, status: 'accepted' },
              },
            },
          }),
        },
      );

      expect(result.success).toBe(true);
      expect(mockSpongeService.bookInterview).toHaveBeenCalled();
    });

    it('enforce 下 statement 级 accepted claim 不解锁打招呼语负向证据', async () => {
      const watermark = computeCandidateMessageWatermark(['我是小玥', '电话13812345678']);
      const result = await run(
        { ...validInput, name: '小玥' },
        {
          mode: 'enforce',
          messages: greetingMessages,
          snapshot: buildSnapshot({
            messageWatermark: watermark,
            confirmedFields: ['age'],
            acceptedClaimIds: ['claim-name-statement'],
            effectiveProfile: {
              factsVersion: 1,
              messageWatermark: watermark,
              fields: {
                name: {
                  value: '小玥',
                  status: 'accepted',
                  acceptedClaimId: 'claim-name-statement',
                },
                phone: { value: '13812345678', status: 'accepted' },
                age: { value: 25, status: 'accepted' },
                gender: { value: 2, status: 'accepted' },
                healthCertificate: { value: 1, status: 'accepted' },
              },
            },
          }),
        },
      );

      expect(result.success).toBe(false);
      expect(result.suspiciousName).toBe('小玥');
      expect(mockSpongeService.bookInterview).not.toHaveBeenCalled();
    });

    it('session 基线虽为 accepted 但无 acceptedClaimId，不解锁负向证据', async () => {
      const watermark = computeCandidateMessageWatermark(['我是小玥', '电话13812345678']);
      const result = await run(
        { ...validInput, name: '小玥' },
        {
          mode: 'enforce',
          messages: greetingMessages,
          snapshot: buildSnapshot({
            messageWatermark: watermark,
            confirmedFields: ['name', 'age'],
            effectiveProfile: {
              factsVersion: 1,
              messageWatermark: watermark,
              fields: {
                name: { value: '小玥', status: 'accepted', source: 'session' },
                phone: { value: '13812345678', status: 'accepted' },
                age: { value: 25, status: 'accepted' },
                gender: { value: 2, status: 'accepted' },
                healthCertificate: { value: 1, status: 'accepted' },
              },
            },
          }),
        },
      );

      expect(result.success).toBe(false);
      expect(result.suspiciousName).toBe('小玥');
      expect(mockSpongeService.bookInterview).not.toHaveBeenCalled();
    });

    it('shadow 下确认级 claim 仍走 legacy 路径，不直接作证放行', async () => {
      const watermark = computeCandidateMessageWatermark(['我是小玥', '电话13812345678']);
      const result = await run(
        { ...validInput, name: '小玥' },
        {
          messages: greetingMessages,
          snapshot: buildSnapshot({
            messageWatermark: watermark,
            confirmedFields: ['name'],
            acceptedClaimIds: ['claim-name-confirm'],
            effectiveProfile: {
              factsVersion: 1,
              messageWatermark: watermark,
              fields: {
                name: {
                  value: '小玥',
                  status: 'accepted',
                  acceptedClaimId: 'claim-name-confirm',
                },
                phone: { value: '13812345678', status: 'accepted' },
                age: { value: 25, status: 'accepted' },
                gender: { value: 2, status: 'accepted' },
                healthCertificate: { value: 1, status: 'accepted' },
              },
            },
          }),
        },
      );

      expect(result.success).toBe(false);
      expect(result.suspiciousName).toBe('小玥');
      expect(mockSpongeService.bookInterview).not.toHaveBeenCalled();
    });
  });
});
/* eslint-enable @typescript-eslint/no-explicit-any */

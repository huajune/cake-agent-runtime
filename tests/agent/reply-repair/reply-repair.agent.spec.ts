import { ReplyRepairAgent, type ReplyRepairInput } from '@agent/reply-repair/reply-repair.agent';
import { RepairEvidenceBuilder } from '@agent/reply-repair/repair-evidence.builder';
import { createTurnLedger } from '@agent/generator/preparation/turn-ledger';
import type { AgentToolCall } from '@agent/generator/generator.types';
import { finalizeVisualFactSheet } from '@resolution/signal/visual';
import { ModelRole } from '@/llm/llm.types';

describe('ReplyRepairAgent', () => {
  let llm: { generate: jest.Mock };
  let service: ReplyRepairAgent;

  beforeEach(() => {
    llm = {
      generate: jest.fn().mockResolvedValue({
        text: '已帮你约好明天 14:00 面试，到店说独立客介绍就行。',
      }),
    };
    service = new ReplyRepairAgent(llm as never, new RepairEvidenceBuilder());
  });

  it('uses the repair role with a focused text repair prompt and grounded evidence', async () => {
    const result = await service.repair({
      userMessage: '那帮我约明天下午',
      originalReply: '约好了，到时候过去就行',
      violations: [
        {
          type: 'confirmed_booking_time_missing',
          evidence: 'booking 工具返回了确认时间，但回复漏掉',
          suggestion: '补充确认时间',
        },
      ],
      feedbackToGenerator: '把面试确认时间补进回复',
      ruleIds: ['confirmed_booking_time_missing'],
      toolCalls: [
        {
          toolName: 'duliday_interview_booking',
          args: {},
          result: {
            success: true,
            workOrderId: 'wo-1',
            _confirmedInterviewTimeHuman: '明天 14:00',
            _onSiteScript: '到店说独立客介绍',
          },
        },
      ],
      repairContext: {
        recentMessages: [
          { role: 'user', content: '上海有餐饮兼职吗' },
          { role: 'assistant', content: '可以，我帮你看看' },
        ],
        factLines: ['城市：上海', '意向行业：餐饮'],
        profileLines: [],
        longTermPreferenceLines: [],
        currentStage: 'job_consultation',
        jobLines: [],
        invitedGroupLines: ['- 上海餐饮兼职群（上海/餐饮，邀请于 2026-07-09）'],
        groupInventory: {
          city: '上海',
          hasAnyGroup: true,
          lines: ['- 餐饮：1 个群（均有空位）'],
        },
      },
    });

    expect(result).toBe('已帮你约好明天 14:00 面试，到店说独立客介绍就行。');
    expect(llm.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        role: ModelRole.Repair,
        system: expect.stringContaining('你没有任何工具'),
      }),
    );
    const call = llm.generate.mock.calls[0][0];
    // 待修草稿 + 接地材料 + 策略全部进 system（渲染后，无裸 JSON 内部键名）
    expect(call.system).toContain('# 待修复的草稿回复');
    expect(call.system).toContain('约好了，到时候过去就行');
    expect(call.system).toContain('确认面试时间：明天 14:00');
    expect(call.system).toContain('修复上下文');
    expect(call.system).toContain('上海餐饮兼职群');
    expect(call.system).toContain('餐饮：1 个群');
    expect(call.system).toContain('出站策略');
    // 时间锚：repair 晚于历史消息发生，无锚会照抄历史里的相对日期
    //（badcase batch_6a66f559…："明天 7 月 28 日"在 7-28 当天投递）
    expect(call.system).toContain('# 当前时间（相对日期以此为准）');
    expect(call.system).toContain('今天：');
    expect(call.system).toContain('明天：');
    expect(call.system).not.toContain('confirmedInterviewTimeHuman');
    expect(call.system).not.toContain('duliday_interview_booking(');
    expect(call.system).not.toContain('wo-1');
    // 真实对话历史走 messages 槽，不再塞进 system
    expect(call.messages).toEqual([
      { role: 'user', content: '上海有餐饮兼职吗' },
      { role: 'assistant', content: '可以，我帮你看看' },
    ]);
    expect(call.system).not.toContain('## 近期对话');
  });

  it('strips markdown fences from model output', async () => {
    llm.generate.mockResolvedValueOnce({
      text: '```text\n好的，我这边帮你改成更自然的说法。\n```',
    });

    await expect(
      service.repair({
        originalReply: '生硬回复',
        violations: [{ type: 'bad_tone', evidence: '生硬', suggestion: '自然一点' }],
        ruleIds: ['bad_tone'],
        toolCalls: [],
      }),
    ).resolves.toBe('好的，我这边帮你改成更自然的说法。');
  });
  it('重复报名修复时，模型只收到已有预约事实和时间，不收到工单号', async () => {
    await service.repair({
      userMessage: '已经报上了吗',
      originalReply: '系统有问题，稍后重试',
      violations: [
        {
          type: 'booking_receipt_mismatch',
          evidence: '预约已存在',
          suggestion: '如实告知已有预约',
        },
      ],
      feedbackToGenerator: '告知已经约上，无需重复报名',
      ruleIds: ['booking_receipt_mismatch'],
      toolCalls: [
        {
          toolName: 'duliday_interview_booking',
          args: {},
          result: {
            success: false,
            errorType: 'booking.already_booked',
            existingWorkOrderId: 468104,
            _existingInterviewTimeHuman: '9月25日（周五）14:00',
          },
        },
      ],
    });
    const prompt = llm.generate.mock.calls[0][0];
    expect(prompt.system).toContain('预约已经存在');
    expect(prompt.system).toContain('9月25日（周五）14:00');
    expect(JSON.stringify(prompt)).not.toContain('468104');
  });

  // 群邀请 / 定位发送 / 图片事实三类证据曾只进 packet、不进修复 prompt：
  // 修复模型看不到报名后运行时拉群的结果、没发出去的定位和截图字段归属。
  describe('副作用与图片证据进入修复 prompt', () => {
    const repairWith = async (
      toolCalls: AgentToolCall[],
      extra: Partial<ReplyRepairInput> = {},
    ): Promise<string> => {
      await service.repair({
        originalReply: '草稿',
        violations: [{ type: 'bad_tone', evidence: '生硬', suggestion: '自然一点' }],
        ruleIds: ['bad_tone'],
        toolCalls,
        ...extra,
      });
      return llm.generate.mock.calls[0][0].system as string;
    };

    const bookingWithInvite = (groupInvite: Record<string, unknown>): AgentToolCall => ({
      toolName: 'duliday_interview_booking',
      args: { jobId: 100 },
      result: { success: true, workOrderId: 'wo-1', groupInvite },
      status: 'ok',
    });

    it('报名后运行时直接拉群：渲染已入群与群名', async () => {
      const system = await repairWith([
        bookingWithInvite({
          attempted: true,
          success: true,
          groupName: '上海餐饮群',
          delivery: 'direct_add',
        }),
      ]);

      expect(system).toContain('【群邀请】');
      expect(system).toContain('已把候选人直接拉进群「上海餐饮群」');
    });

    it('邀请卡片只说已发邀请，不说已入群', async () => {
      const system = await repairWith([
        bookingWithInvite({
          attempted: true,
          success: true,
          groupName: '上海餐饮群',
          delivery: 'invite_card',
        }),
      ]);

      expect(system).toContain('已发送群「上海餐饮群」的入群邀请卡片，候选人点卡片后才入群');
      expect(system).not.toContain('直接拉进群');
    });

    it('候选人本来就在群里：明确本轮没有新拉群', async () => {
      const system = await repairWith([
        bookingWithInvite({
          attempted: true,
          success: true,
          alreadyInGroup: true,
          groupName: '上海餐饮群',
        }),
      ]);

      expect(system).toContain('候选人本来就在群「上海餐饮群」里，本轮没有新拉群或新发邀请');
    });

    it('运行时跳过拉群：带原因并禁止声称已拉群', async () => {
      const system = await repairWith([
        bookingWithInvite({ attempted: false, success: false, skippedReason: 'city_unknown' }),
      ]);

      expect(system).toContain(
        '本轮没有拉群或发出邀请（city_unknown），不得说本轮已拉群或已发邀请',
      );
    });

    it('线上面试不需要定位：即使工具 success 也渲染为未发送', async () => {
      const system = await repairWith(
        [
          {
            toolName: 'send_store_location',
            args: { jobId: 100 },
            result: {
              success: true,
              destination: 'interview',
              interviewMethod: '线上面试',
              interviewAddress: null,
              locationNotRequired: true,
            },
            status: 'ok',
          },
        ],
        { committedSideEffects: '本轮已成功执行副作用工具：send_store_location' },
      );

      expect(system).toContain('【定位发送】');
      expect(system).toContain('未发送定位：面试形式为线上面试，不需要到店');
      expect(system).not.toContain('已发送面试地点定位');
    });

    it('面试地点与门店不同：渲染实际发出的面试定位并提示不得混用地址', async () => {
      const system = await repairWith([
        {
          toolName: 'send_store_location',
          args: { jobId: 100 },
          result: {
            success: true,
            destination: 'interview',
            storeName: '静安寺店',
            storeAddress: '南京西路 1 号',
            interviewAddress: '延安中路 99 号 3 楼',
            addressConflict: true,
            sentAddress: '延安中路 99 号 3 楼',
          },
          status: 'ok',
        },
      ]);

      expect(system).toContain('已发送面试地点定位：延安中路 99 号 3 楼');
      expect(system).toContain('工作门店：静安寺店，南京西路 1 号');
      expect(system).toContain('面试地点与工作门店不是同一处，两个地址不得混用');
    });

    it('定位发送失败：渲染未发送与原因，保留工具给出的门店文字信息', async () => {
      const system = await repairWith([
        {
          toolName: 'send_store_location',
          args: { jobId: 100 },
          result: {
            success: false,
            errorType: 'store_location.unavailable',
            destination: 'store',
            storeName: '静安寺店',
            storeAddress: '南京西路 1 号',
          },
          status: 'error',
        },
      ]);

      expect(system).toContain('定位未发送（store_location.unavailable），不得说位置已发');
      expect(system).toContain('工作门店：静安寺店，南京西路 1 号');
    });

    it('图片事实按归属分组，unknown 与第三方同组，不混进候选人本人', async () => {
      const ledger = createTurnLedger();
      const raw = {
        kind: 'chat_screenshot',
        description: '对方发来门店地址和联系电话',
        fields: [
          { key: 'phone', value: '13800138000', ownership: 'candidate' },
          { key: 'brand', value: '大米先生', ownership: 'publisher' },
          { key: 'phone', value: '13900139000', ownership: 'third_party' },
          { key: 'address', value: '南京西路 1 号', ownership: 'unknown' },
        ],
      };
      ledger.recordVisualFacts(finalizeVisualFactSheet(raw, raw.description), {
        messageId: 'image-1',
      });

      const system = await repairWith([], { turnLedger: ledger });

      expect(system).toContain('【本轮图片事实】');
      expect(system).toContain('只有「候选人本人」的字段能当作候选人自己的信息');
      expect(system).toContain('- 聊天截图：对方发来门店地址和联系电话');
      expect(system).toContain('  · 候选人本人：手机号=13800138000\n');
      expect(system).toContain('  · 发布方：品牌=大米先生\n');
      expect(system).toContain('  · 第三方/归属不明：手机号=13900139000；地址=南京西路 1 号');
    });

    it('未拿到账本时仍渲染 save_image_description 的降级描述', async () => {
      const system = await repairWith([
        {
          toolName: 'save_image_description',
          args: { messageId: 'msg-1', description: '一张门店排班表照片，写着早班 07:00-11:00' },
          result: { success: true },
          status: 'ok',
        },
      ]);

      expect(system).toContain('- 图片：一张门店排班表照片，写着早班 07:00-11:00');
    });
  });
});

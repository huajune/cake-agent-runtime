import { FeishuCardBuilderService } from '@infra/feishu/services/card-builder.service';
import { GeneralHandoffCardRenderer } from '@notification/renderers/general-handoff-card.renderer';
import type {
  GeneralHandoffNotificationMessage,
  GeneralHandoffNotificationPayload,
} from '@notification/types/general-handoff-notification.types';
import {
  SessionFactsSchema,
  type SessionFacts,
  type WeworkSessionState,
} from '@memory/types/session-facts.types';

type RendererInput = Parameters<GeneralHandoffCardRenderer['buildCard']>[0];

function buildSessionState(
  override: Partial<WeworkSessionState['facts']['interview_info']> = {},
): WeworkSessionState {
  return {
    facts: SessionFactsSchema.parse({
      interview_info: {
        name: '张三',
        phone: '13800000000',
        gender: '男',
        gender_source: null,
        age: '23',
        applied_store: null,
        applied_position: null,
        interview_time: null,
        is_student: null,
        education: null,
        has_health_certificate: null,
        ...override,
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
    }) as SessionFacts,
    lastCandidatePool: null,
    presentedJobs: null,
    currentFocusJob: null,
    invitedGroups: null,
  };
}

function buildPayload(override: Partial<RendererInput> = {}): RendererInput {
  const base: GeneralHandoffNotificationPayload = {
    alertLabel: '无活跃 case 但需介入',
    reason: '候选人触发 request_handoff（no_active_case 分支）',
    actionAdvice: '建议联系候选人确认意向',
    corpId: 'corp-1',
    contactName: 'wx_candidate',
    botUserName: '招募经理A',
    chatId: 'chat-123',
    pausedUserId: 'chat-123',
    currentMessageContent: '我想找人帮忙',
    recentMessages: [{ role: 'user', content: '我想找人帮忙', timestamp: 1712044860000 }],
    sessionState: buildSessionState(),
  };
  return { ...base, ...override } as RendererInput;
}

describe('GeneralHandoffCardRenderer', () => {
  let renderer: GeneralHandoffCardRenderer;
  let cardBuilder: jest.Mocked<FeishuCardBuilderService>;

  beforeEach(() => {
    cardBuilder = {
      buildMarkdownCard: jest.fn().mockImplementation((payload) => payload),
    } as unknown as jest.Mocked<FeishuCardBuilderService>;

    renderer = new GeneralHandoffCardRenderer(cardBuilder);
  });

  describe('buildCard', () => {
    it('merges alertLabel into title and uses red color when isTest is false', () => {
      const card = renderer.buildCard(buildPayload());

      expect(card).toEqual(
        expect.objectContaining({
          title: '🚨 候选人需人工介入 · 无活跃 case 但需介入',
          color: 'red',
        }),
      );
      expect(card.content as string).not.toContain('测试ing');
    });

    it('appends test banner and renames title when isTest is true', () => {
      const card = renderer.buildCard(buildPayload({ isTest: true }));

      expect((card as { title: string }).title).toBe(
        '🚨 候选人需人工介入 · 无活跃 case 但需介入 · 测试ing',
      );
      expect(card.content as string).toContain('测试ing（来自回归批次，无需 @ 招募经理）');
    });

    it('highlights reason / actionAdvice and renders bolded inline labels', () => {
      const card = renderer.buildCard(buildPayload());
      const content = card.content as string;

      expect(content).not.toContain('场景：');
      expect(content).toContain(
        "> <font color='red'>**命中原因**：候选人触发 request_handoff（no_active_case 分支）</font>",
      );
      expect(content).toContain("> <font color='red'>**建议动作**：建议联系候选人确认意向</font>");
      expect(content).toContain('**当前消息**：我想找人帮忙');
      expect(content).toContain('会话ID：chat-123');
      expect(content).toContain('暂停ID：chat-123');
      expect(content).toContain('处理完请到 Web 托管后台手动恢复托管。');
    });

    it('omits the action-advice line when actionAdvice is empty', () => {
      const card = renderer.buildCard(buildPayload({ actionAdvice: undefined }));
      expect(card.content as string).not.toContain('**建议动作**');
    });

    it('renders dash placeholder when currentMessageContent is empty', () => {
      const card = renderer.buildCard(buildPayload({ currentMessageContent: '' }));
      expect(card.content as string).toContain('**当前消息**：-');
    });

    it('prepends urgency banner for time-sensitive reason codes', () => {
      const card = renderer.buildCard(buildPayload({ reasonCode: 'modify_appointment' }));
      expect(card.content as string).toContain(
        "> <font color='red'>**⏱ 时效敏感**：候选人可能已在途或正在等待，请尽快跟进</font>",
      );
    });

    it('omits urgency banner for non-urgent or missing reason codes', () => {
      const nonUrgent = renderer.buildCard(buildPayload({ reasonCode: 'salary_admin_inquiry' }));
      expect(nonUrgent.content as string).not.toContain('时效敏感');

      const missing = renderer.buildCard(buildPayload());
      expect(missing.content as string).not.toContain('时效敏感');
    });

    it('renders job data gap block with focus job for salary_admin_inquiry', () => {
      const sessionState = buildSessionState();
      sessionState.currentFocusJob = {
        jobId: 528517,
        brandName: 'M Stand',
        jobName: 'M Stand-广州K11店-店员-小时工',
        storeName: '广州K11店',
        cityName: '广州',
        regionName: '天河区',
        laborForm: '兼职',
        salaryDesc: '25元/小时',
        jobCategoryName: '店员',
      };
      const card = renderer.buildCard(
        buildPayload({
          reasonCode: 'salary_admin_inquiry',
          missingJobInfo: ['试用期', '工作餐'],
          sessionState,
        }),
      );
      const content = card.content as string;

      expect(content).toContain('岗位数据缺口（可在岗位库补录）');
      expect(content).toContain('岗位：M Stand-广州K11店-店员-小时工（jobId 528517）');
      expect(content).toContain('缺失信息：试用期、工作餐');
      expect(card).toEqual(expect.objectContaining({ color: 'purple' }));
    });

    it('keeps red color for non-salary reason codes', () => {
      const card = renderer.buildCard(buildPayload({ reasonCode: 'modify_appointment' }));
      expect(card).toEqual(expect.objectContaining({ color: 'red' }));
    });

    it('falls back to placeholder when focus job is missing, omits block without missingJobInfo', () => {
      const withGapNoJob = renderer.buildCard(
        buildPayload({ missingJobInfo: ['转正政策'] }),
      );
      expect(withGapNoJob.content as string).toContain('未定位到焦点岗位');

      const noGap = renderer.buildCard(buildPayload({ missingJobInfo: [] }));
      expect(noGap.content as string).not.toContain('岗位数据缺口');
    });

    it('renders work order id when provided and omits it otherwise', () => {
      const withOrder = renderer.buildCard(buildPayload({ workOrderId: 123456 }));
      expect(withOrder.content as string).toContain('关联工单：123456');

      const withoutOrder = renderer.buildCard(buildPayload({ workOrderId: null }));
      expect(withoutOrder.content as string).not.toContain('关联工单：');
    });

    it('propagates atUsers / atAll to the card builder', () => {
      renderer.buildCard(buildPayload({ atAll: true }));
      expect(cardBuilder.buildMarkdownCard).toHaveBeenCalledWith(
        expect.objectContaining({ atAll: true }),
      );
    });
  });

  describe('formatRecentMessages', () => {
    it('shows fallback text when recentMessages is empty', () => {
      const card = renderer.buildCard(buildPayload({ recentMessages: [] }));
      expect(card.content as string).toContain('暂无上下文');
    });

    it('keeps only the last 10 messages and tags role correctly', () => {
      const recentMessages: GeneralHandoffNotificationMessage[] = Array.from(
        { length: 15 },
        (_, i) => ({
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: `msg-${i}`,
          timestamp: 1712044860000 + i * 60_000,
        }),
      );

      const card = renderer.buildCard(buildPayload({ recentMessages }));
      const content = card.content as string;

      // First 5 messages should be truncated
      expect(content).not.toContain('msg-0');
      expect(content).not.toContain('msg-4');
      // Last 10 should remain
      expect(content).toContain('msg-5');
      expect(content).toContain('msg-14');
      // role mapping
      expect(content).toMatch(/候选人] msg-6/); // even index → user
      expect(content).toMatch(/招募经理] msg-7/); // odd index → assistant
    });
  });

  describe('formatCandidateInfo', () => {
    it('renders interview_info fields when sessionState is present', () => {
      const card = renderer.buildCard(buildPayload());
      const content = card.content as string;

      expect(content).toContain('微信昵称：wx_candidate');
      expect(content).toContain('姓名：张三');
      expect(content).toContain('电话：13800000000');
      expect(content).toContain('年龄：23');
      expect(content).toContain('托管账号：招募经理A');
    });

    it('skips name/phone/age when sessionState is null but keeps id fields', () => {
      const card = renderer.buildCard(buildPayload({ sessionState: null }));
      const content = card.content as string;

      expect(content).toContain('微信昵称：wx_candidate');
      expect(content).not.toContain('姓名：');
      expect(content).not.toContain('电话：');
      expect(content).not.toContain('年龄：');
      expect(content).toContain('会话ID：chat-123');
      expect(content).toContain('暂停ID：chat-123');
    });

    it('skips botUserName when it is whitespace-only', () => {
      const card = renderer.buildCard(buildPayload({ botUserName: '   ' }));
      expect(card.content as string).not.toContain('托管账号：');
    });

    it('skips contactName line when contactName is missing', () => {
      const card = renderer.buildCard(buildPayload({ contactName: undefined }));
      expect(card.content as string).not.toContain('微信昵称：');
    });
  });
});

import { FeishuCardBuilderService } from '@infra/feishu/services/card-builder.service';
import { GeneralHandoffCardRenderer } from '@notification/renderers/general-handoff-card.renderer';
import type {
  GeneralHandoffNotificationMessage,
  GeneralHandoffNotificationPayload,
} from '@notification/types/general-handoff-notification.types';
import type { WeworkSessionState } from '@memory/types/session-facts.types';

type RendererInput = Parameters<GeneralHandoffCardRenderer['buildCard']>[0];

function buildSessionState(
  override: Partial<WeworkSessionState['facts']['interview_info']> = {},
): WeworkSessionState {
  return {
    facts: {
      interview_info: {
        name: '张三',
        phone: '13800000000',
        gender: '男',
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
      },
      reasoning: 'test',
    },
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
    summary: '候选人需要人工帮助',
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
    it('uses production title and yellow color when isTest is false', () => {
      const card = renderer.buildCard(buildPayload());

      expect(card).toEqual(
        expect.objectContaining({
          title: '⚠️ 候选人需人工介入（无活跃 case）',
          color: 'yellow',
        }),
      );
      expect(card.content as string).not.toContain('测试ing');
    });

    it('appends test banner and renames title when isTest is true', () => {
      const card = renderer.buildCard(buildPayload({ isTest: true }));

      expect((card as { title: string }).title).toBe(
        '⚠️ 候选人需人工介入（无活跃 case · 测试ing）',
      );
      expect(card.content as string).toContain(
        '测试ing（来自回归批次，无需 @ 招募经理）',
      );
    });

    it('renders scene / reason / chatId / pausedUserId / handover-hint sections', () => {
      const card = renderer.buildCard(buildPayload());
      const content = card.content as string;

      expect(content).toContain('场景：无活跃 case 但需介入');
      expect(content).toContain('命中原因：候选人触发 request_handoff（no_active_case 分支）');
      expect(content).toContain('当前消息：我想找人帮忙');
      expect(content).toContain('会话ID：chat-123');
      expect(content).toContain('暂停ID：chat-123');
      expect(content).toContain('处理完请到 Web 托管后台手动恢复托管。');
    });

    it('omits the summary line when summary is empty', () => {
      const card = renderer.buildCard(buildPayload({ summary: undefined }));
      expect(card.content as string).not.toContain('情况摘要');
    });

    it('renders dash placeholder when currentMessageContent is empty', () => {
      const card = renderer.buildCard(buildPayload({ currentMessageContent: '' }));
      expect(card.content as string).toContain('当前消息：-');
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

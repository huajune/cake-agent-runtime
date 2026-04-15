import { FeishuCardBuilderService } from '@infra/feishu/services/card-builder.service';
import { FEISHU_RECEIVER_USERS } from '@infra/feishu/constants/receivers';
import { ConversationRiskCardRenderer } from '@notification/renderers/conversation-risk-card.renderer';

describe('ConversationRiskCardRenderer', () => {
  let renderer: ConversationRiskCardRenderer;
  let cardBuilder: jest.Mocked<FeishuCardBuilderService>;

  beforeEach(() => {
    cardBuilder = {
      buildMarkdownCard: jest.fn().mockImplementation((payload) => payload),
    } as unknown as jest.Mocked<FeishuCardBuilderService>;

    renderer = new ConversationRiskCardRenderer(cardBuilder);
  });

  it('should render conversation risk card with context and actions', () => {
    const card = renderer.buildConversationRiskCard({
      riskLabel: '投诉/举报风险',
      summary: '候选人出现明确投诉风险',
      reason: '命中关键词：投诉、骗子',
      contactName: 'Alice',
      chatId: 'chat-123',
      pausedUserId: 'chat-123',
      currentMessageContent: '你们是不是骗子，我要投诉',
      recentMessages: [
        { role: 'assistant', content: '您好，请问想看哪个岗位？', timestamp: 1712044800000 },
        { role: 'user', content: '你们是不是骗子，我要投诉', timestamp: 1712044860000 },
      ],
      sessionState: {
        facts: {
          interview_info: {
            name: 'Alice',
            phone: '13800000000',
            gender: '女',
            age: '23',
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
            position: ['服务员'],
            schedule: null,
            city: '上海',
            district: ['浦东'],
            location: null,
            labor_form: null,
          },
          reasoning: 'test',
        },
        lastCandidatePool: null,
        presentedJobs: null,
        currentFocusJob: {
          jobId: 1,
          brandName: '蜀地源',
          jobName: '服务员',
          storeName: '陆家嘴店',
          cityName: '上海',
          regionName: '浦东',
          laborForm: null,
          salaryDesc: '5000-6000',
          jobCategoryName: '前厅',
        },
        invitedGroups: null,
      },
      atUsers: [FEISHU_RECEIVER_USERS.GAO_YAQI],
    });

    expect(card).toEqual(
      expect.objectContaining({
        title: '交流异常 · 人工介入',
        color: 'red',
        atUsers: [FEISHU_RECEIVER_USERS.GAO_YAQI],
      }),
    );
    expect((card.content as string)).toContain('系统已自动暂停托管');
    expect((card.content as string)).toContain('风险类型：投诉/举报风险');
    expect((card.content as string)).toContain('风险摘要：候选人出现明确投诉风险');
    expect((card.content as string)).toContain('昵称：Alice');
    expect((card.content as string)).toContain('品牌：蜀地源');
    expect((card.content as string)).toContain('AI 已停止回复');
    expect((card.content as string)).not.toContain('暂停ID：');
  });

  it('should avoid rendering noisy nickname and empty job section', () => {
    const card = renderer.buildConversationRiskCard({
      riskLabel: '投诉/举报风险',
      summary: '候选人明确表示要举报',
      reason: '命中关键词：举报',
      contactName: '7881300085910772',
      chatId: 'chat-123',
      pausedUserId: 'chat-123',
      currentMessageContent: '我要举报',
      recentMessages: [{ role: 'user', content: '我要举报', timestamp: 1712044860000 }],
      sessionState: {
        facts: {
          interview_info: {
            name: null,
            phone: null,
            gender: null,
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
          },
          reasoning: 'test',
        },
        lastCandidatePool: null,
        presentedJobs: null,
        currentFocusJob: null,
        invitedGroups: null,
      },
    });

    expect((card.content as string)).not.toContain('昵称：7881300085910772');
    expect((card.content as string)).not.toContain('**岗位信息**');
  });
});

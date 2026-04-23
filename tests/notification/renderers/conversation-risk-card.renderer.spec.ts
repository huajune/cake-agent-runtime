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
      botUserName: '招募经理A',
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
            city: { value: '上海', confidence: 'high', evidence: 'explicit_city' },
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
        title: '🚨 交流异常 · 需要人工介入',
        color: 'red',
        atUsers: [FEISHU_RECEIVER_USERS.GAO_YAQI],
      }),
    );
    expect((card.content as string)).toContain('风险类型：投诉/举报风险');
    expect((card.content as string)).not.toContain('风险摘要：候选人出现明确投诉风险');
    expect((card.content as string)).toContain('当前消息：\n> 你们是不是骗子，我要投诉');
    expect((card.content as string)).toContain('微信昵称：Alice');
    expect((card.content as string)).toContain('姓名：Alice');
    expect((card.content as string)).toContain('托管账号：招募经理A');
    expect((card.content as string)).toContain('品牌：蜀地源');
    expect((card.content as string)).toContain('请处理完成后手动恢复托管。');
    expect((card.content as string)).not.toContain('暂停ID：');
  });

  it('should render contactName as wechat nickname and hide empty job section', () => {
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

    expect((card.content as string)).toContain('微信昵称：7881300085910772');
    expect((card.content as string)).not.toContain('**岗位信息**');
  });

  it('should hide age ranges that look like job requirements', () => {
    const card = renderer.buildConversationRiskCard({
      riskLabel: '辱骂/攻击',
      summary: '候选人出现明显辱骂或攻击性表达',
      reason: '命中关键词：滚',
      contactName: '候选人A',
      chatId: 'chat-123',
      pausedUserId: 'chat-123',
      currentMessageContent: '滚犊子，要我这么多信息',
      recentMessages: [{ role: 'user', content: '滚犊子，要我这么多信息', timestamp: 1712044860000 }],
      sessionState: {
        facts: {
          interview_info: {
            name: null,
            phone: null,
            gender: null,
            age: '18到35岁',
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
            position: ['小时工', '日结小时工'],
            schedule: null,
            city: { value: '上海', confidence: 'high', evidence: 'explicit_city' },
            district: ['杨浦'],
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

    expect((card.content as string)).not.toContain('年龄：18到35岁');
    expect((card.content as string)).toContain('城市：上海');
    expect((card.content as string)).toContain('区域：杨浦');
  });

  it('should hide generic summary and duplicated system action block', () => {
    const card = renderer.buildConversationRiskCard({
      riskLabel: '辱骂/攻击',
      summary: '候选人出现明显辱骂或攻击性表达',
      reason: '命中关键词：滚',
      contactName: '候选人A',
      chatId: 'chat-123',
      pausedUserId: 'chat-123',
      currentMessageContent: '滚犊子，要我这么多信息',
      recentMessages: [{ role: 'user', content: '滚犊子，要我这么多信息', timestamp: 1712044860000 }],
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

    expect((card.content as string)).toContain('风险类型：辱骂/攻击');
    expect((card.content as string)).not.toContain('风险摘要：候选人出现明显辱骂或攻击性表达');
    expect((card.content as string)).not.toContain('**系统动作**');
    expect((card.content as string)).not.toContain('AI 已停止回复');
  });
});

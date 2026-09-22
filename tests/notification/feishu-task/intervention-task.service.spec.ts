import type {
  GeneralHandoffInterventionPayload,
  RiskInterventionPayload,
} from '@biz/intervention/intervention.service';
import { LongTermService } from '@memory/long-term/long-term.service';
import {
  DEFAULT_FIELD_NAMES,
  FEISHU_TASK_CONFIG_KEY,
  InterventionTaskService,
} from '@notification/feishu-task/intervention-task.service';
import { SpongeService } from '@sponge/sponge.service';

type FieldCall = {
  guid: string;
  text_value?: string;
  number_value?: string;
  single_select_value?: string;
};

describe('InterventionTaskService', () => {
  const client = {
    resolveFieldGuid: jest.fn(async (_tasklist: string, name: string) => `field:${name}`),
    resolveOptionGuid: jest.fn(
      async (_tasklist: string, field: string, option: string) => `opt:${field}:${option}`,
    ),
    resolveSectionGuid: jest.fn(async (_tasklist: string, name: string) => `section:${name}`),
    createTask: jest.fn(),
    updateTask: jest.fn(),
    addComment: jest.fn(),
    addMembers: jest.fn(),
  };
  const redis = { get: jest.fn(), setex: jest.fn() };
  const env: Record<string, string> = {
    FEISHU_TASK_TASKLIST_GUID: 'tl-1',
    FEISHU_TASK_OWNER_OPEN_IDS_JSON: JSON.stringify({
      supervisor: ['ou_boss'],
      default: ['ou_default'],
    }),
  };
  const configService = { get: jest.fn((key: string) => env[key]) };
  const systemConfig = { getConfigValue: jest.fn() };
  const hostingMember = {
    getByBotImId: jest.fn(async () => ({ wecomNickname: '东升', feishuOpenId: 'ou_dongsheng' })),
    resolveFeishuReceiver: jest.fn(async () => ({ openId: 'ou_dongsheng', name: '祝东升' })),
  };
  const alertNotifier = { sendAlert: jest.fn(async () => true) };
  const longTerm = { tryGetActiveBookings: jest.fn(async () => null) };
  const sponge = { fetchSignupWorkOrders: jest.fn() };
  // ModuleRef 懒解析：按 token 分发（LongTermService / SpongeService 都不进 FeishuTaskModule）
  const moduleRef = {
    get: jest.fn((token: unknown) => {
      if (token === LongTermService) return longTerm;
      if (token === SpongeService) return sponge;
      throw new Error(`unexpected token ${String(token)}`);
    }),
  };

  let service: InterventionTaskService;

  const basePayload: GeneralHandoffInterventionPayload = {
    kind: 'general_handoff',
    source: 'agent_tool',
    alertLabel: '改约/取消',
    reasonCode: 'modify_appointment',
    reason: '候选人要改到周四下午；原定周三',
    actionAdvice: '联系门店改时间',
    workOrderId: 555,
    chatId: 'wrkChat1',
    corpId: 'ww-real',
    userId: 'user-1',
    pauseTargetId: 'wrkChat1',
    botImId: '1688854363869800',
    botUserName: 'bot-xiaozhu',
    contactName: '小明',
    currentMessageContent: '周四下午可以吗',
    recentMessages: [{ role: 'user', content: '周四下午可以吗', timestamp: 1_790_000_000_000 }],
    sessionState: null,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    // clearAllMocks 不还原 mockImplementation，显式重置字段解析默认行为（缺列用例会覆盖它）
    client.resolveFieldGuid.mockImplementation(
      async (_tasklist: string, name: string) => `field:${name}`,
    );
    jest.useFakeTimers().setSystemTime(new Date('2026-09-22T02:00:00Z')); // 上海周二 10:00
    systemConfig.getConfigValue.mockResolvedValue({ enabled: true });
    redis.get.mockResolvedValue(null);
    redis.setex.mockResolvedValue(undefined);
    client.createTask.mockResolvedValue({ guid: 'task-new' });
    client.updateTask.mockResolvedValue(true);
    client.addComment.mockResolvedValue('c1');
    client.addMembers.mockResolvedValue(true);
    longTerm.tryGetActiveBookings.mockResolvedValue(null);
    sponge.fetchSignupWorkOrders.mockResolvedValue({ workOrders: [] });

    service = new InterventionTaskService(
      client as never,
      redis as never,
      configService as never,
      systemConfig as never,
      hostingMember as never,
      alertNotifier as never,
      moduleRef as never,
    );
    service.onApplicationBootstrap();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('DEFAULT_FIELD_NAMES 键顺序即清单表头列顺序（列顺序 = 创建顺序，不可重排）', () => {
    expect(Object.keys(DEFAULT_FIELD_NAMES)).toEqual([
      'priority',
      'category',
      'nickname',
      'reasonCode',
      'name',
      'phone',
      'hostingAccount',
      'workOrderId',
      'interviewTime',
      'interventionCount',
    ]);
    // 已随清单删除的列：岗位 ID / 品牌门店 只留描述正文；状态用飞书自带勾选；备注/本可由蛋糕完成 不再建
    for (const removed of [
      '岗位 ID',
      '品牌门店',
      '本可由蛋糕完成',
      '状态',
      '备注',
      '介入触发时间',
    ]) {
      expect(Object.values(DEFAULT_FIELD_NAMES)).not.toContain(removed);
    }
  });

  it('开关关闭时不调飞书', async () => {
    systemConfig.getConfigValue.mockResolvedValue({ enabled: false });
    await service.submit(basePayload);
    expect(client.createTask).not.toHaveBeenCalled();
    expect(systemConfig.getConfigValue).toHaveBeenCalledWith(FEISHU_TASK_CONFIG_KEY);
  });

  it('测试链路（corpId=test）不建任务', async () => {
    await service.submit({ ...basePayload, corpId: 'test' });
    expect(client.createTask).not.toHaveBeenCalled();
  });

  it('新建：标题前缀 + 自定义字段 + 内置开始时间 + 负责人 + 到期 + Redis 合并键', async () => {
    longTerm.tryGetActiveBookings.mockResolvedValue([
      {
        work_order_id: 555,
        linked_at: '2026-09-21T00:00:00Z',
        job_id: 99,
        interview_time: '2026-09-22 12:00:00',
      },
    ]);
    await service.submit(basePayload);

    expect(client.createTask).toHaveBeenCalledTimes(1);
    const input = client.createTask.mock.calls[0][0];
    // 标题只留「昵称 · 原因码标签」，不拼【急·大类】/门店/一句话原因/面试时间
    expect(input.summary).toBe('小明 · 改约/取消自助失败');
    // active_booking 指针命中该工单且有面试时间 → 不调海绵
    expect(sponge.fetchSignupWorkOrders).not.toHaveBeenCalled();
    expect(input.tasklistGuid).toBe('tl-1');
    expect(input.sectionGuid).toBe('section:📅 预约协调'); // 分组名 = 表情 + 大类名，不带 T 编号
    expect(input.members).toEqual([{ id: 'ou_dongsheng', type: 'user', role: 'assignee' }]);
    // 触发时刻走内置开始时间，不建自定义字段
    expect(input.startAt.toISOString()).toBe('2026-09-22T02:00:00.000Z');
    // 面试 12:00 − 1h = 11:00 早于常规 12:00
    expect(input.dueAt.toISOString()).toBe('2026-09-22T03:00:00.000Z');
    expect(input.description).toContain('【工单】555');
    expect(input.description).toContain('【岗位】jobId 99');
    expect(input.clientToken).toMatch(/^[0-9a-f]{40}$/);

    const fields = input.customFields as FieldCall[];
    const byGuid = Object.fromEntries(fields.map((f) => [f.guid, f]));
    expect(byGuid['field:状态']).toBeUndefined(); // 完成状态用飞书自带勾选，不建字段
    expect(byGuid['field:优先级'].single_select_value).toBe('opt:优先级:急');
    expect(byGuid['field:第几次介入'].number_value).toBe('1');
    expect(byGuid['field:候选人昵称'].text_value).toBe('小明');
    expect(byGuid['field:托管账号'].single_select_value).toBe('opt:托管账号:东升');
    expect(byGuid['field:工单号'].text_value).toBe('555');
    expect(byGuid['field:介入触发时间']).toBeUndefined();
    expect(fields.map((f) => f.guid)).not.toContain('field:介入触发时间');
    expect(byGuid['field:面试时间'].text_value).toBe('2026-09-22 12:00');
    expect(byGuid['field:介入大类'].single_select_value).toBe('opt:介入大类:预约协调');
    // 原因码选项名取权威目录标签
    expect(byGuid['field:原因码'].single_select_value).toBe('opt:原因码:改约/取消自助失败');
    expect(byGuid['field:岗位 ID']).toBeUndefined(); // 已删列：岗位 ID 只留在描述正文
    expect(byGuid['field:品牌门店']).toBeUndefined();
    expect(byGuid['field:候选人姓名']).toBeUndefined(); // 未收集留空

    // 自动建选项时带 color_index：优先级急=3、大类/原因码同为 T2 orange(5)、托管账号 blue(30)
    expect(client.resolveOptionGuid).toHaveBeenCalledWith('tl-1', '优先级', '急', 3);
    expect(client.resolveOptionGuid).toHaveBeenCalledWith('tl-1', '介入大类', '预约协调', 5);
    expect(client.resolveOptionGuid).toHaveBeenCalledWith('tl-1', '原因码', '改约/取消自助失败', 5);
    expect(client.resolveOptionGuid).toHaveBeenCalledWith('tl-1', '托管账号', '东升', 30);

    expect(redis.setex).toHaveBeenCalledWith(
      'feishu-task:intervention:v1:chat:wrkChat1:T2',
      7 * 24 * 60 * 60,
      expect.objectContaining({ taskGuid: 'task-new', count: 1, priority: 'urgent' }),
    );
    expect(alertNotifier.sendAlert).not.toHaveBeenCalled();
  });

  it('清单里不存在的字段（运营手动删列）静默跳过，其余字段照写，不告警', async () => {
    const missing = new Set(['面试时间', '优先级']);
    client.resolveFieldGuid.mockImplementation(async (_tasklist: string, name: string) =>
      missing.has(name) ? null : `field:${name}`,
    );
    longTerm.tryGetActiveBookings.mockResolvedValue([
      {
        work_order_id: 555,
        linked_at: '2026-09-21T00:00:00Z',
        job_id: 99,
        interview_time: '2026-09-22 12:00:00',
      },
    ]);

    await expect(service.submit(basePayload)).resolves.toBeUndefined();

    expect(client.createTask).toHaveBeenCalledTimes(1);
    const fields = client.createTask.mock.calls[0][0].customFields as FieldCall[];
    const guids = fields.map((f) => f.guid);
    expect(guids).not.toContain('field:面试时间');
    expect(guids).not.toContain('field:优先级');
    expect(guids).toEqual(
      expect.arrayContaining(['field:介入大类', 'field:原因码', 'field:候选人昵称']),
    );
    // 单选字段缺失时不应去建选项
    expect(client.resolveOptionGuid).not.toHaveBeenCalledWith(
      'tl-1',
      '优先级',
      expect.anything(),
      expect.anything(),
    );
    expect(alertNotifier.sendAlert).not.toHaveBeenCalled();
  });

  it('合并：命中 Redis 键时更新 due/优先级/标题并追加评论，不新建', async () => {
    redis.get.mockResolvedValue({
      taskGuid: 'task-old',
      firstTriggeredAt: '2026-09-21T02:00:00.000Z',
      count: 1,
      priority: 'normal',
    });
    await service.submit({
      ...basePayload,
      reasonCode: 'booking_capacity_full',
      reason: '名额满了',
    });

    expect(client.createTask).not.toHaveBeenCalled();
    expect(client.updateTask).toHaveBeenCalledWith(
      'task-old',
      expect.objectContaining({ summary: '小明 · 岗位报名名额已满（第 2 次）' }),
    );
    const update = client.updateTask.mock.calls[0][1];
    expect(update.startAt).toBeUndefined(); // 开始时间保持首次触发时刻，合并不改
    const fields = update.customFields as FieldCall[];
    expect(fields.find((f) => f.guid === 'field:第几次介入')?.number_value).toBe('2');
    expect(client.addComment).toHaveBeenCalledWith(
      'task-old',
      expect.stringContaining('第 2 次介入'),
    );
    expect(redis.setex).toHaveBeenCalledWith(
      'feishu-task:intervention:v1:chat:wrkChat1:T2',
      7 * 24 * 60 * 60,
      expect.objectContaining({ taskGuid: 'task-old', count: 2, priority: 'today' }),
    );
  });

  it('合并时优先级取更急者；标题次数后缀按当前次数替换', async () => {
    redis.get.mockResolvedValue({ taskGuid: 'task-old', count: 3, priority: 'urgent' });
    await service.submit({
      ...basePayload,
      reasonCode: 'booking_capacity_full',
      reason: '名额满了',
    });
    expect(client.updateTask).toHaveBeenCalledWith(
      'task-old',
      expect.objectContaining({ summary: '小明 · 岗位报名名额已满（第 4 次）' }),
    );
    const fields = client.updateTask.mock.calls[0][1].customFields as FieldCall[];
    expect(fields.find((f) => f.guid === 'field:优先级')?.single_select_value).toBe(
      'opt:优先级:急',
    );
    expect(redis.setex).toHaveBeenCalledWith(
      'feishu-task:intervention:v1:chat:wrkChat1:T2',
      7 * 24 * 60 * 60,
      expect.objectContaining({ count: 4, priority: 'urgent' }),
    );
  });

  it('面试临近（T2 且面试早于起算点）时标题加「面试将至」', async () => {
    longTerm.tryGetActiveBookings.mockResolvedValue([
      {
        work_order_id: 555,
        linked_at: '2026-09-21T00:00:00Z',
        job_id: 99,
        interview_time: '2026-09-22 09:00:00', // 早于触发时刻 10:00
      },
    ]);
    await service.submit(basePayload);
    const input = client.createTask.mock.calls[0][0];
    expect(input.summary).toBe('小明 · 改约/取消自助失败 · 面试将至');
  });

  it('无昵称时标题用「候选人」占位', async () => {
    await service.submit({ ...basePayload, contactName: '' });
    expect(client.createTask.mock.calls[0][0].summary).toBe('候选人 · 改约/取消自助失败');
  });

  it('active_booking 无该工单指针时回落海绵：填面试时间、jobId、品牌-项目', async () => {
    longTerm.tryGetActiveBookings.mockResolvedValue(null);
    sponge.fetchSignupWorkOrders.mockResolvedValue({
      workOrders: [
        {
          workOrderId: 555,
          interviewTime: '2026-09-22 12:00',
          jobId: 77,
          brandName: '瑞幸',
          projectName: '徐家汇店',
        },
      ],
    });
    await service.submit(basePayload);

    expect(sponge.fetchSignupWorkOrders).toHaveBeenCalledWith(
      { workOrderId: 555 },
      { botImId: '1688854363869800' },
    );
    const input = client.createTask.mock.calls[0][0];
    const fields = input.customFields as FieldCall[];
    expect(fields.find((f) => f.guid === 'field:面试时间')?.text_value).toBe('2026-09-22 12:00');
    expect(input.description).toContain('瑞幸-徐家汇店');
    expect(input.description).toContain('jobId 77');
    // 面试 12:00 − 1h = 11:00 早于常规 12:00（海绵面试时间同样参与时限）
    expect(input.dueAt.toISOString()).toBe('2026-09-22T03:00:00.000Z');
  });

  it('指针命中该工单但无面试时间时也回落海绵', async () => {
    longTerm.tryGetActiveBookings.mockResolvedValue([
      { work_order_id: 555, linked_at: '2026-09-21T00:00:00Z', job_id: 99, interview_time: null },
    ]);
    sponge.fetchSignupWorkOrders.mockResolvedValue({
      workOrders: [{ workOrderId: 555, interviewTime: '2026-09-23 14:00', jobId: 99 }],
    });
    await service.submit(basePayload);
    expect(sponge.fetchSignupWorkOrders).toHaveBeenCalledTimes(1);
    const fields = client.createTask.mock.calls[0][0].customFields as FieldCall[];
    expect(fields.find((f) => f.guid === 'field:面试时间')?.text_value).toBe('2026-09-23 14:00');
  });

  it('海绵回落失败不抛错：面试时间留空，任务照建，不告警', async () => {
    longTerm.tryGetActiveBookings.mockResolvedValue(null);
    sponge.fetchSignupWorkOrders.mockRejectedValue(new Error('sponge down'));
    await expect(service.submit(basePayload)).resolves.toBeUndefined();
    expect(client.createTask).toHaveBeenCalledTimes(1);
    const fields = client.createTask.mock.calls[0][0].customFields as FieldCall[];
    expect(fields.find((f) => f.guid === 'field:面试时间')).toBeUndefined();
    expect(alertNotifier.sendAlert).not.toHaveBeenCalled();
  });

  it('合并更新失败（任务已删）时回退新建', async () => {
    redis.get.mockResolvedValue({ taskGuid: 'task-gone', count: 1, priority: 'normal' });
    client.updateTask.mockResolvedValue(false);
    await service.submit(basePayload);
    expect(client.createTask).toHaveBeenCalledTimes(1);
    expect(client.addComment).not.toHaveBeenCalled();
  });

  it('T5 按岗位合并，不挂会话', async () => {
    const sessionState = {
      currentFocusJob: { jobId: 4242, brandName: '瑞幸', storeName: '徐家汇店' },
    } as unknown as GeneralHandoffInterventionPayload['sessionState'];
    await service.submit({
      ...basePayload,
      reasonCode: 'salary_admin_inquiry',
      reason: '几号发工资答不上',
      missingJobInfo: ['发薪日'],
      workOrderId: null,
      sessionState,
    });
    expect(redis.get).toHaveBeenCalledWith('feishu-task:intervention:v1:job:4242:T5');
    const input = client.createTask.mock.calls[0][0];
    expect(input.sectionGuid).toBe('section:📋 岗位数据/口径缺口');
    expect(input.summary).toBe('小明 · 岗位口径答不上（需补岗位数据）');
    expect(input.description).toContain('瑞幸-徐家汇店'); // 门店只进正文，不进标题
    expect(sponge.fetchSignupWorkOrders).not.toHaveBeenCalled(); // 无 workOrderId 不查海绵
    expect(input.description).toContain('【缺失字段】发薪日');
    expect(input.members).toEqual([{ id: 'ou_dongsheng', type: 'user', role: 'assignee' }]); // T5 未配置 → 回退托管账号
  });

  it('T7 风险类：负责人取主管，不贴对话原文', async () => {
    const risk: RiskInterventionPayload = {
      ...basePayload,
      kind: 'conversation_risk',
      source: 'regex_intercept',
      riskType: 'abuse',
      riskLabel: '辱骂/攻击',
      summary: '候选人辱骂',
      reason: '命中辱骂关键词',
    };
    await service.submit(risk);
    const input = client.createTask.mock.calls[0][0];
    expect(input.summary).toBe('小明 · 辱骂/攻击');
    expect(input.members).toEqual([{ id: 'ou_boss', type: 'user', role: 'assignee' }]);
    expect(input.description).not.toContain('候选人] 周四下午可以吗');
    expect(input.description).toContain('详见企微会话');
  });

  it('创建失败时发飞书告警，不抛错', async () => {
    client.createTask.mockResolvedValue(null);
    await expect(service.submit(basePayload)).resolves.toBeUndefined();
    expect(alertNotifier.sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'feishu_task.create_failed' }),
    );
    expect(redis.setex).not.toHaveBeenCalled();
  });

  it('依赖抛异常时吞掉并告警', async () => {
    redis.get.mockRejectedValue(new Error('redis down'));
    client.createTask.mockRejectedValue(new Error('boom'));
    await expect(service.submit(basePayload)).resolves.toBeUndefined();
    expect(alertNotifier.sendAlert).toHaveBeenCalledTimes(1);
  });
});

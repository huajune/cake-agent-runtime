import { OpsDailyReportCronService } from '@biz/ops-events/ops-daily-report.cron';

const sampleRow = {
  report_date: '2026-06-09',
  bot_im_id: 'bot-1',
  manager_name: 'gaoyaqi',
  group_name: '琪琪组',
  friends_added_count: 10,
  agent_opening_sent_count: 9,
  break_ice_count: 8,
  candidate_message_count: 20,
  agent_reply_count: 18,
  job_recommend_count: 7,
  precheck_pass_count: 5,
  booking_success_count: 3,
  booking_fail_count: 1,
  group_invite_count: 2,
  handoff_count: 1,
  interview_pass_count: 1,
  candidate_summary: '张三 13800000000',
  booking_brands: ['瑞幸', '奥乐齐'],
};

function buildService(overrides: Record<string, string>) {
  const configService = {
    get: jest.fn((key: string, def?: string) => overrides[key] ?? def),
  };
  const dailyOpsReportRepository = { findByReportDate: jest.fn() };
  const bitableApi = { getFields: jest.fn(), batchCreateRecords: jest.fn() };
  const spongeService = {
    fetchSelfSignupWorkOrders: jest.fn().mockResolvedValue({ total: 0, workOrders: [] }),
    fetchSignupWorkOrders: jest.fn().mockResolvedValue({ total: 0, workOrders: [] }),
  };
  const botService = {
    getConfiguredBotList: jest.fn().mockResolvedValue([]),
  };
  const service = new OpsDailyReportCronService(
    configService as never,
    dailyOpsReportRepository as never,
    bitableApi as never,
    spongeService as never,
    botService as never,
  );
  return { service, dailyOpsReportRepository, bitableApi, spongeService, botService };
}

describe('OpsDailyReportCronService.pushReport', () => {
  it('dry-runs (no feishu write) when not enabled', async () => {
    const { service, dailyOpsReportRepository, bitableApi, spongeService } = buildService({
      FEISHU_OPS_REPORT_ENABLED: 'false',
    });
    dailyOpsReportRepository.findByReportDate.mockResolvedValue([sampleRow]);

    const result = await service.pushReport('2026-06-09');

    expect(result).toEqual({ rows: 1, written: 0 });
    expect(bitableApi.getFields).not.toHaveBeenCalled();
    expect(bitableApi.batchCreateRecords).not.toHaveBeenCalled();
    expect(spongeService.fetchSelfSignupWorkOrders).not.toHaveBeenCalled();
  });

  it('returns early on empty data', async () => {
    const { service, dailyOpsReportRepository, bitableApi } = buildService({
      FEISHU_OPS_REPORT_ENABLED: 'true',
    });
    dailyOpsReportRepository.findByReportDate.mockResolvedValue([]);

    const result = await service.pushReport('2026-06-09');

    expect(result).toEqual({ rows: 0, written: 0 });
    expect(bitableApi.getFields).not.toHaveBeenCalled();
  });

  it('skips weekend dates without querying the repository or feishu', async () => {
    const { service, dailyOpsReportRepository, bitableApi } = buildService({
      FEISHU_OPS_REPORT_ENABLED: 'true',
      FEISHU_OPS_REPORT_APP_TOKEN: 'app-1',
      FEISHU_OPS_REPORT_TABLE_ID: 'tbl-1',
    });

    // 2026-06-07 是周日，应直接跳过（周末不出日报）。
    const result = await service.pushReport('2026-06-07');

    expect(result).toEqual({ rows: 0, written: 0 });
    expect(dailyOpsReportRepository.findByReportDate).not.toHaveBeenCalled();
    expect(bitableApi.getFields).not.toHaveBeenCalled();
  });

  it('writes only fields matching the real table headers when enabled', async () => {
    const { service, dailyOpsReportRepository, bitableApi, spongeService } = buildService({
      FEISHU_OPS_REPORT_ENABLED: 'true',
      FEISHU_OPS_REPORT_APP_TOKEN: 'app-1',
      FEISHU_OPS_REPORT_TABLE_ID: 'tbl-1',
    });
    dailyOpsReportRepository.findByReportDate.mockResolvedValue([sampleRow]);
    spongeService.fetchSelfSignupWorkOrders
      .mockResolvedValueOnce({
        total: 2,
        workOrders: [
          { workOrderId: 1001, brandName: '瑞幸' },
          { workOrderId: 1002, brandName: '奥乐齐' },
        ],
      })
      .mockResolvedValueOnce({ total: 0, workOrders: [] });
    // 表里只有这些列：日期(date) / 小组(text) / 加好友数(number) / 品牌(multi-select)。
    // 公式字段「星期」应跳过，让飞书根据日期自动计算。
    bitableApi.getFields.mockResolvedValue([
      { field_id: 'f1', field_name: '日期', type: 5 },
      { field_id: 'f2', field_name: '小组', type: 1 },
      { field_id: 'f3', field_name: '加好友数', type: 2 },
      { field_id: 'f4', field_name: '报名品牌（品牌名称简写）', type: 4 },
      { field_id: 'f5', field_name: '星期', type: 20 },
    ]);
    bitableApi.batchCreateRecords.mockResolvedValue({ created: 1, failed: 0 });

    const result = await service.pushReport('2026-06-09');

    expect(result).toEqual({ rows: 1, written: 1 });
    expect(bitableApi.batchCreateRecords).toHaveBeenCalledTimes(1);
    const records = bitableApi.batchCreateRecords.mock.calls[0][2];
    const writtenFields = records[0].fields;
    expect(Object.keys(writtenFields).sort()).toEqual([
      '加好友数',
      '小组',
      '报名品牌（品牌名称简写）',
      '日期',
    ]);
    expect(writtenFields['小组']).toBe('琪琪组');
    expect(writtenFields['加好友数']).toBe(10);
    expect(writtenFields['报名品牌（品牌名称简写）']).toEqual(['瑞幸', '奥乐齐']);
    expect(writtenFields).not.toHaveProperty('星期');
    // 日期是 datetime 字段 → 转成 epoch ms（number）
    expect(typeof writtenFields['日期']).toBe('number');
  });

  it('merges wxid/wecomUserId/prod-sync rows for the same current bot before writing', async () => {
    const { service, dailyOpsReportRepository, bitableApi, botService } = buildService({
      FEISHU_OPS_REPORT_ENABLED: 'true',
      FEISHU_OPS_REPORT_APP_TOKEN: 'app-1',
      FEISHU_OPS_REPORT_TABLE_ID: 'tbl-1',
    });
    botService.getConfiguredBotList.mockResolvedValue([
      {
        wxid: '1688855171908166',
        wecomUserId: 'CongLingKaiShiDeXianShiShiJie',
        name: '李宇杭',
        groupName: '宇航组',
      },
    ]);
    dailyOpsReportRepository.findByReportDate.mockResolvedValue([
      {
        ...sampleRow,
        bot_im_id: '1688855171908166',
        manager_name: 'LiYuHang',
        group_name: '宇航组',
        friends_added_count: 7,
        break_ice_count: 6,
      },
      {
        ...sampleRow,
        bot_im_id: 'prod-sync:CongLingKaiShiDeXianShiShiJie',
        manager_name: 'CongLingKaiShiDeXianShiShiJie',
        group_name: '未分组',
        friends_added_count: 2,
        break_ice_count: 1,
      },
    ]);
    bitableApi.getFields.mockResolvedValue([
      { field_id: 'f1', field_name: '小组', type: 1 },
      { field_id: 'f2', field_name: '添加好友数', type: 2 },
      { field_id: 'f3', field_name: '主动回复数', type: 2 },
      { field_id: 'f4', field_name: '招募经理', type: 1 },
    ]);
    bitableApi.batchCreateRecords.mockResolvedValue({ created: 1, failed: 0 });

    const result = await service.pushReport('2026-06-09');

    expect(result).toEqual({ rows: 1, written: 1 });
    const records = bitableApi.batchCreateRecords.mock.calls[0][2];
    expect(records).toHaveLength(1);
    // 「招募经理」取当前托管 bot 的 name/nickName（看板下拉斜杠左边的显示名），即 manager_name。
    expect(records[0].fields).toEqual({
      小组: '宇航组',
      添加好友数: 9,
      主动回复数: 7,
      招募经理: '李宇杭',
    });
  });

  it('overrides booking/pass counts and candidate info from sponge self signup data', async () => {
    const { service, dailyOpsReportRepository, bitableApi, spongeService } = buildService({
      FEISHU_OPS_REPORT_ENABLED: 'true',
      FEISHU_OPS_REPORT_APP_TOKEN: 'app-1',
      FEISHU_OPS_REPORT_TABLE_ID: 'tbl-1',
    });
    dailyOpsReportRepository.findByReportDate.mockResolvedValue([sampleRow]);
    spongeService.fetchSelfSignupWorkOrders
      .mockResolvedValueOnce({
        total: 2,
        workOrders: [
          { workOrderId: 1001, brandName: '瑞幸' },
          { workOrderId: 1002, brandName: '奥乐齐' },
        ],
      })
      .mockResolvedValueOnce({
        total: 1,
        workOrders: [{ workOrderId: 1001, interviewPassTime: '2026-06-09 16:00:00' }],
      });
    spongeService.fetchSignupWorkOrders
      .mockResolvedValueOnce({
        candidateName: '海绵张三',
        total: 1,
        workOrders: [{ workOrderId: 1001 }],
      })
      .mockResolvedValueOnce({
        candidateName: '海绵李四',
        total: 1,
        workOrders: [{ workOrderId: 1002 }],
      });
    bitableApi.getFields.mockResolvedValue([
      { field_id: 'f1', field_name: '今日报名成功数', type: 2 },
      { field_id: 'f2', field_name: '今日面试通过数', type: 2 },
      { field_id: 'f3', field_name: '候选人基本信息', type: 1 },
      { field_id: 'f4', field_name: '报名品牌', type: 1 },
    ]);
    bitableApi.batchCreateRecords.mockResolvedValue({ created: 1, failed: 0 });

    const result = await service.pushReport('2026-06-09');

    expect(result).toEqual({ rows: 1, written: 1 });
    expect(spongeService.fetchSelfSignupWorkOrders).toHaveBeenNthCalledWith(
      1,
      {
        queryParam: {
          signUpStartTime: '2026-06-09 00:00:00',
          signUpEndTime: '2026-06-09 23:59:59',
        },
      },
      { botImId: 'bot-1' },
    );
    expect(spongeService.fetchSelfSignupWorkOrders).toHaveBeenNthCalledWith(
      2,
      {
        queryParam: {
          interviewPassStartTime: '2026-06-09 00:00:00',
          interviewPassEndTime: '2026-06-09 23:59:59',
        },
      },
      { botImId: 'bot-1' },
    );
    expect(spongeService.fetchSignupWorkOrders).toHaveBeenNthCalledWith(
      1,
      { workOrderId: 1001 },
      { botImId: 'bot-1' },
    );
    expect(spongeService.fetchSignupWorkOrders).toHaveBeenNthCalledWith(
      2,
      { workOrderId: 1002 },
      { botImId: 'bot-1' },
    );
    const records = bitableApi.batchCreateRecords.mock.calls[0][2];
    expect(records[0].fields).toEqual({
      今日报名成功数: 2,
      今日面试通过数: 1,
      候选人基本信息: '海绵张三\n海绵李四',
      报名品牌: '瑞幸、奥乐齐',
    });
  });

  it('falls back to projected booking/pass counts when sponge lookup fails', async () => {
    const { service, dailyOpsReportRepository, bitableApi, spongeService } = buildService({
      FEISHU_OPS_REPORT_ENABLED: 'true',
      FEISHU_OPS_REPORT_APP_TOKEN: 'app-1',
      FEISHU_OPS_REPORT_TABLE_ID: 'tbl-1',
    });
    dailyOpsReportRepository.findByReportDate.mockResolvedValue([sampleRow]);
    spongeService.fetchSelfSignupWorkOrders.mockRejectedValue(new Error('缺少 DULIDAY_API_TOKEN'));
    bitableApi.getFields.mockResolvedValue([
      { field_id: 'f1', field_name: '今日报名成功数', type: 2 },
      { field_id: 'f2', field_name: '今日面试通过数', type: 2 },
      { field_id: 'f3', field_name: '候选人基本信息', type: 1 },
      { field_id: 'f4', field_name: '报名品牌', type: 1 },
      { field_id: 'f5', field_name: '添加好友数', type: 2 },
    ]);
    bitableApi.batchCreateRecords.mockResolvedValue({ created: 1, failed: 0 });

    await service.pushReport('2026-06-09');

    const records = bitableApi.batchCreateRecords.mock.calls[0][2];
    expect(records[0].fields).toEqual({
      今日报名成功数: 3,
      今日面试通过数: 1,
      添加好友数: 10,
    });
    expect(records[0].fields).not.toHaveProperty('候选人基本信息');
    expect(records[0].fields).not.toHaveProperty('报名品牌');
  });
});

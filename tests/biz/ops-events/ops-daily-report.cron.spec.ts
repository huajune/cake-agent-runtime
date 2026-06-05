import { OpsDailyReportCronService } from '@biz/ops-events/ops-daily-report.cron';

const sampleRow = {
  report_date: '2026-05-31',
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
  const service = new OpsDailyReportCronService(
    configService as never,
    dailyOpsReportRepository as never,
    bitableApi as never,
  );
  return { service, dailyOpsReportRepository, bitableApi };
}

describe('OpsDailyReportCronService.pushReport', () => {
  it('dry-runs (no feishu write) when not enabled', async () => {
    const { service, dailyOpsReportRepository, bitableApi } = buildService({
      FEISHU_OPS_REPORT_ENABLED: 'false',
    });
    dailyOpsReportRepository.findByReportDate.mockResolvedValue([sampleRow]);

    const result = await service.pushReport('2026-05-31');

    expect(result).toEqual({ rows: 1, written: 0 });
    expect(bitableApi.getFields).not.toHaveBeenCalled();
    expect(bitableApi.batchCreateRecords).not.toHaveBeenCalled();
  });

  it('returns early on empty data', async () => {
    const { service, dailyOpsReportRepository, bitableApi } = buildService({
      FEISHU_OPS_REPORT_ENABLED: 'true',
    });
    dailyOpsReportRepository.findByReportDate.mockResolvedValue([]);

    const result = await service.pushReport('2026-05-31');

    expect(result).toEqual({ rows: 0, written: 0 });
    expect(bitableApi.getFields).not.toHaveBeenCalled();
  });

  it('writes only fields matching the real table headers when enabled', async () => {
    const { service, dailyOpsReportRepository, bitableApi } = buildService({
      FEISHU_OPS_REPORT_ENABLED: 'true',
      FEISHU_OPS_REPORT_APP_TOKEN: 'app-1',
      FEISHU_OPS_REPORT_TABLE_ID: 'tbl-1',
    });
    dailyOpsReportRepository.findByReportDate.mockResolvedValue([sampleRow]);
    // 表里只有这几列：日期(date) / 小组(text) / 加好友数(number)，其余 REPORT_COLUMNS 应被跳过
    bitableApi.getFields.mockResolvedValue([
      { field_id: 'f1', field_name: '日期', type: 5 },
      { field_id: 'f2', field_name: '小组', type: 1 },
      { field_id: 'f3', field_name: '加好友数', type: 2 },
    ]);
    bitableApi.batchCreateRecords.mockResolvedValue({ created: 1, failed: 0 });

    const result = await service.pushReport('2026-05-31');

    expect(result).toEqual({ rows: 1, written: 1 });
    expect(bitableApi.batchCreateRecords).toHaveBeenCalledTimes(1);
    const records = bitableApi.batchCreateRecords.mock.calls[0][2];
    const writtenFields = records[0].fields;
    expect(Object.keys(writtenFields).sort()).toEqual(['加好友数', '小组', '日期']);
    expect(writtenFields['小组']).toBe('琪琪组');
    expect(writtenFields['加好友数']).toBe(10);
    // 日期是 datetime 字段 → 转成 epoch ms（number）
    expect(typeof writtenFields['日期']).toBe('number');
  });
});

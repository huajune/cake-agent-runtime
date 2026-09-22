import { Logger } from '@nestjs/common';
import { OobReconcileScanCronService } from '@agent/reengagement/oob-reconcile-scan.cron';

describe('OobReconcileScanCronService', () => {
  const hosting = { listTokenConfiguredBotImIds: jest.fn() };
  const sponge = { fetchSelfSignupWorkOrdersV2: jest.fn() };
  const phoneIndex = { lookupByPhone: jest.fn() };
  const reconcile = { reconcile: jest.fn() };
  const redis = { setNx: jest.fn(), eval: jest.fn() };
  const systemConfig = { getConfigValue: jest.fn() };
  const config = { get: jest.fn((_key: string, fallback?: unknown) => fallback) };
  const tracer = { emit: jest.fn() };

  const service = () =>
    new OobReconcileScanCronService(
      hosting as never,
      sponge as never,
      phoneIndex as never,
      reconcile as never,
      redis as never,
      systemConfig as never,
      config as never,
      tracer as never,
    );

  const supplierRow = (over: Record<string, unknown> = {}) => ({
    workOrderId: 1,
    phone: '18271421690',
    candidateName: '张三',
    signupSource: 'SUPPLIER',
    currentStatus: '约面待确认',
    ...over,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    hosting.listTokenConfiguredBotImIds.mockResolvedValue(['bot-A']);
    sponge.fetchSelfSignupWorkOrdersV2.mockResolvedValue({ total: 0, workOrders: [] });
    phoneIndex.lookupByPhone.mockResolvedValue(null);
    reconcile.reconcile.mockResolvedValue({
      status: 'done',
      scheduled: 2,
      supplierOwned: 1,
      linkedEvents: 1,
    });
    redis.setNx.mockResolvedValue(true);
    redis.eval.mockResolvedValue(1);
    systemConfig.getConfigValue.mockResolvedValue({ enabled: true });
    config.get.mockImplementation((key: string, fallback?: unknown) =>
      key === 'NODE_ENV' ? 'production' : fallback,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('scan 的闸门', () => {
    it('运行时开关默认关：system_config 没配或 enabled!==true 时不跑', async () => {
      systemConfig.getConfigValue.mockResolvedValue(null);
      await service().scan();
      expect(redis.setNx).not.toHaveBeenCalled();
      expect(sponge.fetchSelfSignupWorkOrdersV2).not.toHaveBeenCalled();
    });

    it('只在生产 NODE_ENV 执行', async () => {
      config.get.mockImplementation((key: string, fallback?: unknown) =>
        key === 'NODE_ENV' ? 'development' : fallback,
      );
      await service().scan();
      expect(systemConfig.getConfigValue).not.toHaveBeenCalled();
      expect(sponge.fetchSelfSignupWorkOrdersV2).not.toHaveBeenCalled();
    });

    it('整轮 Redis 互斥：拿不到锁跳过，拿到锁后按持有者脚本释放', async () => {
      redis.setNx.mockResolvedValue(false);
      await service().scan();
      expect(sponge.fetchSelfSignupWorkOrdersV2).not.toHaveBeenCalled();
      expect(redis.eval).not.toHaveBeenCalled();

      redis.setNx.mockResolvedValue(true);
      await service().scan();
      expect(redis.setNx).toHaveBeenCalledWith(
        'oob:reconcile-scan:lock:v1',
        expect.any(String),
        30 * 60,
      );
      expect(redis.eval).toHaveBeenCalledWith(
        expect.stringContaining("redis.call('del', KEYS[1])"),
        ['oob:reconcile-scan:lock:v1'],
        [expect.any(String)],
      );
    });
  });

  describe('runOnce', () => {
    it('按已配 token 的账号拉 self/list/v2（报名近 15 天、在途、5 秒超时），筛 SUPPLIER 并按手机号反查会话对账', async () => {
      const now = Date.parse('2026-09-22T02:00:00Z');
      sponge.fetchSelfSignupWorkOrdersV2.mockResolvedValue({
        total: 3,
        workOrders: [
          supplierRow(),
          supplierRow({ workOrderId: 2, signupSource: 'AI', phone: '13800000001' }),
          supplierRow({ workOrderId: 3, phone: '13800000002' }),
        ],
      });
      phoneIndex.lookupByPhone.mockImplementation(async (phone: string) =>
        phone === '18271421690'
          ? { corpId: 'corp-1', userId: 'user-1', chatId: 'chat-1', botImId: 'bot-A', phone }
          : null,
      );

      const summary = await service().runOnce({ enabled: true }, now);

      expect(sponge.fetchSelfSignupWorkOrdersV2).toHaveBeenCalledWith(
        {
          pageNum: 1,
          pageSize: 100,
          queryParam: {
            signUpStartTime: '2026-09-07 10:00:00',
            currentStatus: ['约面待确认', '约面成功'],
          },
        },
        { botImId: 'bot-A' },
        { timeoutMs: 5000 },
      );
      expect(reconcile.reconcile).toHaveBeenCalledTimes(1);
      expect(reconcile.reconcile).toHaveBeenCalledWith({
        corpId: 'corp-1',
        userId: 'user-1',
        chatId: 'chat-1',
        botImId: 'bot-A',
        phone: '18271421690',
        trigger: 'scan',
      });
      expect(summary).toMatchObject({
        status: 'done',
        accounts: 1,
        rows: 3,
        supplierRows: 2,
        resolved: 1,
        unresolved: 1,
        reconciled: 1,
        scheduled: 2,
      });
      expect(tracer.emit).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'oob_reconcile_scan', status: 'done', supplierRows: 2 }),
      );
    });

    it('索引会话属于别的托管账号时不对账（账号边界），计入 botMismatch', async () => {
      sponge.fetchSelfSignupWorkOrdersV2.mockResolvedValue({
        total: 1,
        workOrders: [supplierRow()],
      });
      phoneIndex.lookupByPhone.mockResolvedValue({
        corpId: 'corp-1',
        userId: 'user-1',
        chatId: 'chat-1',
        botImId: 'bot-B',
        phone: '18271421690',
      });
      const summary = await service().runOnce();
      expect(reconcile.reconcile).not.toHaveBeenCalled();
      expect(summary).toMatchObject({ botMismatch: 1, resolved: 0 });
    });

    it('单轮条数上限与翻页上限：满页继续翻，达到上限停止', async () => {
      const page = (n: number) => ({
        total: 250,
        workOrders: Array.from({ length: 100 }, (_, i) =>
          supplierRow({ workOrderId: n * 1000 + i, signupSource: 'AI' }),
        ),
      });
      sponge.fetchSelfSignupWorkOrdersV2
        .mockResolvedValueOnce(page(1))
        .mockResolvedValueOnce(page(2))
        .mockResolvedValueOnce({ total: 250, workOrders: [supplierRow({ signupSource: 'AI' })] });

      const summary = await service().runOnce({ enabled: true, maxRowsPerRun: 150 });
      // 150 行预算：第一页 100 行后仍未达上限继续翻第二页，第二页后 200>=150 停止
      expect(sponge.fetchSelfSignupWorkOrdersV2).toHaveBeenCalledTimes(2);
      expect(summary.rows).toBe(200);

      sponge.fetchSelfSignupWorkOrdersV2.mockReset();
      sponge.fetchSelfSignupWorkOrdersV2.mockResolvedValue(page(1));
      await service().runOnce({ enabled: true, maxPagesPerAccount: 1, maxRowsPerRun: 10_000 });
      expect(sponge.fetchSelfSignupWorkOrdersV2).toHaveBeenCalledTimes(1);
    });

    it('账号拉取失败指数退避重试 3 次后计入 accountFailures，不中断其它账号', async () => {
      jest.useFakeTimers();
      hosting.listTokenConfiguredBotImIds.mockResolvedValue(['bot-A', 'bot-B']);
      sponge.fetchSelfSignupWorkOrdersV2.mockImplementation(
        async (_params, ctx: { botImId: string }) => {
          if (ctx.botImId === 'bot-A') throw new Error('海绵工单查询失败: 504');
          return { total: 0, workOrders: [] };
        },
      );
      const pending = service().runOnce();
      await jest.advanceTimersByTimeAsync(1000 + 2000 + 10);
      const summary = await pending;
      jest.useRealTimers();

      expect(
        sponge.fetchSelfSignupWorkOrdersV2.mock.calls.filter(([, ctx]) => ctx.botImId === 'bot-A'),
      ).toHaveLength(3);
      expect(summary).toMatchObject({ accountFailures: 1, accounts: 2 });
    });

    it('没有已配 token 的账号 → skipped，不打海绵', async () => {
      hosting.listTokenConfiguredBotImIds.mockResolvedValue([]);
      const summary = await service().runOnce();
      expect(summary).toMatchObject({ status: 'skipped', reason: 'no_token_configured_accounts' });
      expect(sponge.fetchSelfSignupWorkOrdersV2).not.toHaveBeenCalled();
    });
  });
});

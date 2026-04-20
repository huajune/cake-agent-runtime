import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bull';
import { GroupTaskProcessor } from '@biz/group-task/queue/group-task.processor';
import { CompletionService } from '@agent/completion.service';
import { RedisService } from '@infra/redis/redis.service';
import { GroupResolverService } from '@biz/group-task/services/group-resolver.service';
import { NotificationSenderService } from '@biz/group-task/services/notification-sender.service';
import { BrandRotationService } from '@biz/group-task/services/brand-rotation.service';
import { OrderGrabStrategy } from '@biz/group-task/strategies/order-grab.strategy';
import { PartTimeJobStrategy } from '@biz/group-task/strategies/part-time-job.strategy';
import { StoreManagerStrategy } from '@biz/group-task/strategies/store-manager.strategy';
import { WorkTipsStrategy } from '@biz/group-task/strategies/work-tips.strategy';
import {
  GROUP_TASK_QUEUE_NAME,
  GroupTaskJobName,
  PlanJobData,
  PrepareJobData,
  SendJobData,
  SummarizeJobData,
  groupTaskDailySentKey,
  groupTaskMsgKey,
  groupTaskResultKey,
} from '@biz/group-task/queue/group-task-queue.constants';
import { GroupTaskType, TimeSlot } from '@biz/group-task/group-task.types';

/**
 * 群任务 Bull 处理器的幂等 + 故障恢复语义是止住"部署打断发群"的关键，
 * 本 spec 专注：
 *   - plan 能把群切成 prepare job 并在空群时直接 summarize
 *   - prepare 只调用一次 fetchData / AI，然后按 delay 扇出 send
 *   - send 在"已发送幂等键"存在时短路跳过，在发送成功后写入幂等键
 *   - send 发送失败时不写幂等键，让 Bull 重试生效
 *   - summarize 聚合各群 result，回落 failed 表示"结果丢失"的群
 */
describe('GroupTaskProcessor', () => {
  let processor: GroupTaskProcessor;
  let queueMock: { add: jest.Mock; on: jest.Mock; process: jest.Mock; client: { status: string } };
  let redisMock: {
    setex: jest.Mock;
    get: jest.Mock;
    exists: jest.Mock;
    del: jest.Mock;
    getClient: jest.Mock;
  };
  let groupResolver: { resolveGroups: jest.Mock };
  let notificationSender: {
    sendToGroup: jest.Mock;
    sendTextToGroup: jest.Mock;
    reportToFeishu: jest.Mock;
  };
  let brandRotation: { recordPushedBrand: jest.Mock };
  let completion: { generateSimple: jest.Mock };
  let partTimeStrategy: {
    type: GroupTaskType;
    tagPrefix: string;
    needsAI: boolean;
    fetchData: jest.Mock;
    buildPrompt: jest.Mock;
    prepareTask?: jest.Mock;
    appendFooter?: jest.Mock;
  };

  const mkGroup = (overrides: Partial<Record<string, unknown>> = {}) => ({
    imRoomId: 'room-1',
    groupName: '群A',
    city: '上海',
    industry: '餐饮',
    tag: '兼职群',
    imBotId: 'bot-1',
    token: 'token-1',
    ...overrides,
  });

  beforeEach(async () => {
    queueMock = {
      add: jest.fn().mockResolvedValue({ id: 'queued' }),
      on: jest.fn(),
      process: jest.fn(),
      client: { status: 'ready' },
    };

    redisMock = {
      setex: jest.fn().mockResolvedValue(undefined),
      get: jest.fn().mockResolvedValue(null),
      exists: jest.fn().mockResolvedValue(0),
      del: jest.fn().mockResolvedValue(1),
      getClient: jest.fn(),
    };

    groupResolver = {
      resolveGroups: jest.fn().mockResolvedValue([]),
    };

    notificationSender = {
      sendToGroup: jest.fn().mockResolvedValue(undefined),
      sendTextToGroup: jest.fn().mockResolvedValue(undefined),
      reportToFeishu: jest.fn().mockResolvedValue(undefined),
    };

    brandRotation = {
      recordPushedBrand: jest.fn().mockResolvedValue(undefined),
    };

    completion = {
      generateSimple: jest.fn().mockResolvedValue('AI 生成消息'),
    };

    partTimeStrategy = {
      type: GroupTaskType.PART_TIME_JOB,
      tagPrefix: '兼职群',
      needsAI: true,
      fetchData: jest.fn(),
      buildPrompt: jest.fn().mockReturnValue({ systemPrompt: 'sys', userMessage: 'usr' }),
      prepareTask: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GroupTaskProcessor,
        { provide: getQueueToken(GROUP_TASK_QUEUE_NAME), useValue: queueMock },
        { provide: CompletionService, useValue: completion },
        { provide: RedisService, useValue: redisMock },
        { provide: GroupResolverService, useValue: groupResolver },
        { provide: NotificationSenderService, useValue: notificationSender },
        { provide: BrandRotationService, useValue: brandRotation },
        {
          provide: OrderGrabStrategy,
          useValue: { type: GroupTaskType.ORDER_GRAB, tagPrefix: '抢单群' },
        },
        { provide: PartTimeJobStrategy, useValue: partTimeStrategy },
        {
          provide: StoreManagerStrategy,
          useValue: { type: GroupTaskType.STORE_MANAGER, tagPrefix: '店长群' },
        },
        {
          provide: WorkTipsStrategy,
          useValue: { type: GroupTaskType.WORK_TIPS, tagPrefix: '工作群' },
        },
      ],
    }).compile();

    processor = module.get(GroupTaskProcessor);
  });

  const invokeHandler = async <T>(name: GroupTaskJobName, data: T): Promise<unknown> => {
    const handler = (processor as unknown as Record<string, (job: unknown) => Promise<unknown>>)[
      name === GroupTaskJobName.PLAN
        ? 'handlePlan'
        : name === GroupTaskJobName.PREPARE
          ? 'handlePrepare'
          : name === GroupTaskJobName.SEND
            ? 'handleSend'
            : 'handleSummarize'
    ];
    return handler.call(processor, { data } as unknown);
  };

  describe('plan', () => {
    it('should enqueue summarize immediately when no groups match', async () => {
      groupResolver.resolveGroups.mockResolvedValue([]);

      const planData: PlanJobData = {
        execId: 'exec-empty',
        type: GroupTaskType.PART_TIME_JOB,
        timeSlot: undefined,
        dryRun: false,
        sendDelayMs: 0,
        startedAt: Date.UTC(2026, 3, 20, 5, 30, 0),
        trigger: 'cron',
      };

      await invokeHandler(GroupTaskJobName.PLAN, planData);

      // meta 写入 + summarize 入队；没有 prepare
      const addedJobNames = queueMock.add.mock.calls.map((c) => c[0]);
      expect(addedJobNames).toEqual([GroupTaskJobName.SUMMARIZE]);
      expect(partTimeStrategy.prepareTask).not.toHaveBeenCalled();
    });

    it('should split groups by city+industry and stagger send via globalIndex', async () => {
      const groups = [
        mkGroup({ imRoomId: 'r-sh-餐', groupName: '上海餐1' }),
        mkGroup({ imRoomId: 'r-sh-餐-2', groupName: '上海餐2' }),
        mkGroup({ imRoomId: 'r-sh-零', groupName: '上海零', industry: '零售' }),
      ];
      groupResolver.resolveGroups.mockResolvedValue(groups);

      const planData: PlanJobData = {
        execId: 'exec-plan',
        type: GroupTaskType.PART_TIME_JOB,
        timeSlot: undefined,
        dryRun: false,
        sendDelayMs: 60_000,
        startedAt: Date.UTC(2026, 3, 20, 5, 30, 0),
        trigger: 'cron',
      };

      await invokeHandler(GroupTaskJobName.PLAN, planData);

      const prepareCalls = queueMock.add.mock.calls.filter(
        (c) => c[0] === GroupTaskJobName.PREPARE,
      );
      expect(prepareCalls).toHaveLength(2);

      // targets 带 globalIndex，后续 prepare 生成 send job 时用
      const allTargets = prepareCalls.flatMap((c) => (c[1] as PrepareJobData).targets);
      const indices = allTargets.map((t) => t.globalIndex).sort();
      expect(indices).toEqual([0, 1, 2]);

      // summarize 的 delay 覆盖整次预计耗时
      const summarizeCall = queueMock.add.mock.calls.find(
        (c) => c[0] === GroupTaskJobName.SUMMARIZE,
      );
      expect(summarizeCall?.[2].delay).toBeGreaterThanOrEqual(2 * 60_000);
    });
  });

  describe('prepare', () => {
    it('should skip sends and write skipped results when strategy reports no data', async () => {
      partTimeStrategy.fetchData.mockResolvedValue({
        hasData: false,
        payload: {},
        summary: '无岗位',
      });

      const prepareData: PrepareJobData = {
        execId: 'exec-1',
        type: GroupTaskType.PART_TIME_JOB,
        timeSlot: undefined,
        dryRun: false,
        groupKey: '上海_餐饮',
        targets: [
          { group: mkGroup({ imRoomId: 'r-1', groupName: '群1' }), globalIndex: 0 },
          { group: mkGroup({ imRoomId: 'r-2', groupName: '群2' }), globalIndex: 1 },
        ],
        totalGroups: 2,
        sendDelayMs: 0,
        execDate: '20260420',
      };

      await invokeHandler(GroupTaskJobName.PREPARE, prepareData);

      expect(queueMock.add).not.toHaveBeenCalled();
      // 2 个群各写了一条 skipped 结果
      expect(redisMock.setex).toHaveBeenCalledWith(
        groupTaskResultKey('exec-1', 'r-1'),
        expect.any(Number),
        expect.objectContaining({ status: 'skipped' }),
      );
      expect(redisMock.setex).toHaveBeenCalledWith(
        groupTaskResultKey('exec-1', 'r-2'),
        expect.any(Number),
        expect.objectContaining({ status: 'skipped' }),
      );
    });

    it('should generate AI message once and fan-out N send jobs with staggered delay', async () => {
      partTimeStrategy.fetchData.mockResolvedValue({
        hasData: true,
        payload: { brand: '必胜客', followUpMessage: '欢迎咨询' },
        summary: '上海/餐饮 - 必胜客: 3 个岗位',
      });

      const targets = [
        { group: mkGroup({ imRoomId: 'r-a', groupName: 'A' }), globalIndex: 0 },
        { group: mkGroup({ imRoomId: 'r-b', groupName: 'B' }), globalIndex: 1 },
      ];
      const prepareData: PrepareJobData = {
        execId: 'exec-1',
        type: GroupTaskType.PART_TIME_JOB,
        timeSlot: undefined,
        dryRun: false,
        groupKey: '上海_餐饮',
        targets,
        totalGroups: 2,
        sendDelayMs: 60_000,
        execDate: '20260420',
      };

      await invokeHandler(GroupTaskJobName.PREPARE, prepareData);

      // AI 只调一次（同组共享）
      expect(completion.generateSimple).toHaveBeenCalledTimes(1);

      const sendCalls = queueMock.add.mock.calls.filter((c) => c[0] === GroupTaskJobName.SEND);
      expect(sendCalls).toHaveLength(2);
      // delay 按 globalIndex 错峰
      expect(sendCalls[0][2].delay).toBe(0);
      expect(sendCalls[1][2].delay).toBe(60_000);
      // 每个 send 的 msgRedisKey 相同，读同一份缓存
      expect(sendCalls[0][1].msgRedisKey).toBe(
        groupTaskMsgKey('exec-1', '上海_餐饮'),
      );
      expect(sendCalls[0][1].msgRedisKey).toBe(sendCalls[1][1].msgRedisKey);

      // 消息缓存也写了 Redis
      expect(redisMock.setex).toHaveBeenCalledWith(
        groupTaskMsgKey('exec-1', '上海_餐饮'),
        expect.any(Number),
        expect.objectContaining({
          message: 'AI 生成消息',
          followUpMessage: '欢迎咨询',
          brand: '必胜客',
        }),
      );
    });
  });

  describe('send', () => {
    const baseSend: SendJobData = {
      execId: 'exec-1',
      type: GroupTaskType.PART_TIME_JOB,
      timeSlot: undefined,
      dryRun: false,
      group: { ...mkGroup(), imRoomId: 'r-1', groupName: '群1' },
      groupKey: '上海_餐饮',
      msgRedisKey: groupTaskMsgKey('exec-1', '上海_餐饮'),
      execDate: '20260420',
      totalGroups: 1,
    };

    it('should short-circuit when daily idempotency key already exists', async () => {
      redisMock.exists.mockResolvedValue(1);

      await invokeHandler(GroupTaskJobName.SEND, baseSend);

      expect(notificationSender.sendToGroup).not.toHaveBeenCalled();
      // 仍写入一条 skipped 结果供 summarize 用
      expect(redisMock.setex).toHaveBeenCalledWith(
        groupTaskResultKey('exec-1', 'r-1'),
        expect.any(Number),
        expect.objectContaining({ status: 'skipped' }),
      );
    });

    it('should send, then set idempotency key and record brand rotation on success', async () => {
      redisMock.exists.mockResolvedValue(0);
      redisMock.get.mockResolvedValue({
        message: 'hi',
        followUpMessage: 'follow',
        brand: '必胜客',
        summary: 's',
      });

      await invokeHandler(GroupTaskJobName.SEND, baseSend);

      expect(notificationSender.sendToGroup).toHaveBeenCalledWith(
        baseSend.group,
        'hi',
        GroupTaskType.PART_TIME_JOB,
        false,
      );
      expect(notificationSender.sendTextToGroup).toHaveBeenCalledWith(
        baseSend.group,
        'follow',
        false,
      );
      expect(redisMock.setex).toHaveBeenCalledWith(
        groupTaskDailySentKey(
          GroupTaskType.PART_TIME_JOB,
          '20260420',
          undefined,
          'r-1',
        ),
        expect.any(Number),
        '1',
      );
      expect(brandRotation.recordPushedBrand).toHaveBeenCalledWith('r-1', '必胜客');
    });

    it('should rethrow without setting idempotency key when send fails (Bull retry can then re-run)', async () => {
      redisMock.exists.mockResolvedValue(0);
      redisMock.get.mockResolvedValue({ message: 'hi', summary: 's' });
      notificationSender.sendToGroup.mockRejectedValue(new Error('企微限流'));

      await expect(invokeHandler(GroupTaskJobName.SEND, baseSend)).rejects.toThrow('企微限流');

      // 未写入 dailySent key；幂等门仍是打开的，Bull 重试可以再次发送
      const idemCall = redisMock.setex.mock.calls.find(
        ([key]) => typeof key === 'string' && key.startsWith('group-task:sent:'),
      );
      expect(idemCall).toBeUndefined();
      // 但 failed 结果记录已写入，给 summarize 看
      expect(redisMock.setex).toHaveBeenCalledWith(
        groupTaskResultKey('exec-1', 'r-1'),
        expect.any(Number),
        expect.objectContaining({ status: 'failed', error: '企微限流' }),
      );
    });

    it('should throw when message cache is lost (Bull will retry; if expired, alert surfaces)', async () => {
      redisMock.exists.mockResolvedValue(0);
      redisMock.get.mockResolvedValue(null);

      await expect(invokeHandler(GroupTaskJobName.SEND, baseSend)).rejects.toThrow(
        /消息缓存丢失/,
      );
    });
  });

  describe('summarize', () => {
    it('should aggregate per-group results and report to Feishu', async () => {
      redisMock.get
        .mockResolvedValueOnce({
          groupKey: '上海_餐饮',
          groupName: 'A',
          status: 'sent',
          summary: 'ok',
          updatedAt: 1,
        })
        .mockResolvedValueOnce({
          groupKey: '上海_餐饮',
          groupName: 'B',
          status: 'failed',
          summary: 'ok',
          error: '企微限流',
          updatedAt: 1,
        });

      const summarizeData: SummarizeJobData = {
        execId: 'exec-1',
        type: GroupTaskType.PART_TIME_JOB,
        timeSlot: undefined,
        dryRun: false,
        totalGroups: 2,
        startedAt: Date.now() - 1000,
        groupIds: ['r-a', 'r-b'],
      };

      await invokeHandler(GroupTaskJobName.SUMMARIZE, summarizeData);

      expect(notificationSender.reportToFeishu).toHaveBeenCalledTimes(1);
      const [result, dryRun] = notificationSender.reportToFeishu.mock.calls[0];
      expect(result).toMatchObject({
        type: GroupTaskType.PART_TIME_JOB,
        totalGroups: 2,
        successCount: 1,
        failedCount: 1,
      });
      expect(result.errors).toEqual([{ groupName: 'B', error: '企微限流' }]);
      expect(dryRun).toBe(false);
    });

    it('should mark missing snapshots as failed (caught mid-exec / cache expired)', async () => {
      redisMock.get.mockResolvedValue(null);

      const summarizeData: SummarizeJobData = {
        execId: 'exec-1',
        type: GroupTaskType.PART_TIME_JOB,
        timeSlot: TimeSlot.AFTERNOON,
        dryRun: true,
        totalGroups: 1,
        startedAt: Date.now() - 1000,
        groupIds: ['r-lost'],
      };

      await invokeHandler(GroupTaskJobName.SUMMARIZE, summarizeData);

      const [result] = notificationSender.reportToFeishu.mock.calls[0];
      expect(result.failedCount).toBe(1);
      expect(result.errors[0].groupName).toBe('r-lost');
    });
  });
});

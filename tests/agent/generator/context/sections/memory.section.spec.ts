import { MemorySection } from '@agent/generator/context/sections/semantic/memory.section';
import type { MemoryPromptView } from '@agent/generator/context/sections/semantic/memory.section';
import {
  hasCurrentBookingInformation,
  renderBookingPrompt,
  visibleBookingEntries,
  visibleBookingJobIds,
} from '@agent/generator/context/sections/semantic/memory.section';
import { promptModelOf, renderSection } from '../../../../helpers/prompt-model.fixture';

describe('MemorySection', () => {
  const renderer = new MemorySection();
  const baseCtx: { memory?: MemoryPromptView } = {};
  const section = {
    build: (input: { memory?: MemoryPromptView }) =>
      renderSection(renderer, promptModelOf({ memory: input.memory })),
    buildBlocks: (input: { memory?: MemoryPromptView }) =>
      renderer.build(promptModelOf({ memory: input.memory })),
  };

  it('renders the adjudicated typed memory view', () => {
    const memory = {
      adjudication: {
        profile: {
          name: {
            value: '张三',
            confidence: 'high',
            source: 'user',
            evidence: '用户提供',
            updatedAt: '2026-09-01T00:00:00.000Z',
          },
        },
        jobIntent: null,
        sessionState: null,
        conflicts: [],
        displayTurnHints: null,
        pendingTurnHintFields: [],
      },
      booking: { state: 'none' },
      realtimeGroups: [{ groupName: '上海餐饮群', city: '上海' }],
      contactBrandAliases: [],
      currentLaborFormIntent: { kind: 'ignore' },
      activeLaborForm: null,
    } as unknown as MemoryPromptView;

    expect(section.build({ ...baseCtx, memory })).toContain('[用户档案]');
    expect(section.build({ ...baseCtx, memory })).toContain('姓名: 张三');
    expect(section.buildBlocks({ ...baseCtx, memory }).map((block) => block.id)).toEqual([
      'candidate-memory',
      'realtime-group-status',
      'booking-context',
    ]);
  });

  it('should return empty string when memory block is missing', () => {
    expect(section.build(baseCtx)).toBe('');
  });

  it('numbers only the bookings it actually renders（缺展示字段的工单不留空号）', () => {
    const snapshot = {
      state: 'active' as const,
      source: 'active_booking' as const,
      syncing: false,
      entries: [
        // 首个工单字段全缺 → 渲染为空、被跳过；编号必须从「预约 1」开始，
        // 否则模型会看到「预约 2」而追问一个不存在的「预约 1」。
        { workOrder: {} as never },
        {
          workOrder: {
            jobId: 42,
            brandName: '品牌 A',
            storeName: '门店 A',
            jobName: '服务员',
          } as never,
        },
      ],
    };

    const rendered = renderBookingPrompt(snapshot);

    expect(rendered).toContain('预约 1');
    expect(rendered).not.toContain('预约 2');
    expect(visibleBookingEntries(snapshot)).toHaveLength(1);
    expect(visibleBookingJobIds(snapshot)).toEqual([42]);
  });

  it('treats a syncing-only snapshot as visible booking information', () => {
    const snapshot = {
      state: 'active' as const,
      source: 'active_booking' as const,
      syncing: true,
      entries: [],
    };

    expect(visibleBookingEntries(snapshot)).toHaveLength(0);
    expect(hasCurrentBookingInformation(snapshot)).toBe(true);
    expect(visibleBookingJobIds(snapshot)).toEqual([]);
  });

  // 以下渲染断言原在 preparation.service.spec 的整链路上，随拆分被删；
  // 文案与 jobId provenance 的口径此前无处守着。
  const bookingSnapshotOf = (
    workOrder: Record<string, unknown>,
    location?: Record<string, unknown>,
  ) =>
    ({
      state: 'active',
      source: 'active_booking',
      syncing: false,
      entries: [{ workOrder, location }],
    }) as never;

  it('renders the interview time plus the expiry and cross-advisor disclosure rules', () => {
    const rendered = renderBookingPrompt(
      bookingSnapshotOf({
        workOrderId: 449822,
        jobId: 520361,
        brandName: '奥乐齐',
        projectName: '1035 银都',
        jobName: '社会兼职',
        currentStatus: '约面待确认',
        signUpTime: '2026-07-14 13:53:49',
        interviewTime: '2026-07-19 13:00:00',
      }),
    );

    expect(rendered).toContain('面试时间: 2026-07-19 13:00:00');
    expect(rendered).toContain('不得声称还在等门店确认时间');
    expect(rendered).toContain('必须先向候选人核实当天是否到场面试');
    expect(rendered).toContain('不得主动插入该预约的状态');
  });

  it('omits the interview time line when the work order has none（老版本海绵响应容缺）', () => {
    const rendered = renderBookingPrompt(
      bookingSnapshotOf({ workOrderId: 88003, brandName: '瑞幸', currentStatus: '约面待确认' }),
    );

    expect(rendered).toContain('工单号: 88003');
    expect(rendered).not.toContain('面试时间: ');
  });

  it('renders both the store address and the offline interview address', () => {
    const rendered = renderBookingPrompt(
      bookingSnapshotOf(
        {
          workOrderId: 449822,
          jobId: 520361,
          brandName: '成都你六姐',
          currentStatus: '约面待确认',
        },
        {
          storeAddress: '上海东方渔人码头成都你六姐F1楼',
          interviewMethod: '线下面试',
          interviewAddress: '新店开业前在成都你六姐（上海控江旭辉店）面试',
        },
      ),
    );

    expect(rendered).toContain('工作门店地址: 上海东方渔人码头成都你六姐F1楼');
    expect(rendered).toContain('面试地址: 新店开业前在成都你六姐（上海控江旭辉店）面试');
    expect(rendered).toContain('面试形式: 线下面试');
    expect(rendered).toContain('只有明确为线下/到店/现场面试才允许');
  });

  it('keeps a residual offline address out of an online interview', () => {
    const rendered = renderBookingPrompt(
      bookingSnapshotOf(
        { workOrderId: 1, brandName: '瑞幸', currentStatus: '约面待确认' },
        { storeAddress: '上海市某工作门店', interviewMethod: '线上面试' },
      ),
    );

    expect(rendered).toContain('面试形式: 线上面试');
    expect(rendered).not.toContain('面试地址: ');
  });

  it('admits a numeric-string jobId into provenance, matching the rendered prompt', () => {
    const snapshot = bookingSnapshotOf({
      workOrderId: 449822,
      jobId: '520361',
      brandName: '奥乐齐',
      currentStatus: '约面待确认',
    });

    expect(renderBookingPrompt(snapshot)).toContain('奥乐齐');
    expect(visibleBookingJobIds(snapshot)).toEqual([520361]);
  });

  it('withholds provenance for a work order whose block renders empty', () => {
    // 渲染为空 ⇒ 模型看不到这个岗位 ⇒ 它的 jobId 不能当作出处放行 booking/precheck。
    const snapshot = bookingSnapshotOf({ workOrderId: 1, jobId: 777 });

    expect(renderBookingPrompt(snapshot)).toBe('');
    expect(visibleBookingJobIds(snapshot)).toEqual([]);
  });
});

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
});

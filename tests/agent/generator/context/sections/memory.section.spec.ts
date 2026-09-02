import { MemorySection } from '@agent/generator/context/sections/semantic/memory.section';
import { PromptContext } from '@agent/generator/context/sections/section.interface';

describe('MemorySection', () => {
  const section = new MemorySection();
  const baseCtx: PromptContext = {
    scenario: 'candidate-consultation',
    channelType: 'private',
    strategyConfig: {} as PromptContext['strategyConfig'],
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
    } as unknown as PromptContext['memory'];

    expect(section.build({ ...baseCtx, memory })).toContain('[用户档案]');
    expect(section.build({ ...baseCtx, memory })).toContain('姓名: 张三');
    expect(section.buildBlocks({ ...baseCtx, memory }).map((block) => block.id)).toEqual([
      'memory',
      'realtime-group-status',
      'booking-context',
    ]);
  });

  it('should return empty string when memory block is missing', () => {
    expect(section.build(baseCtx)).toBe('');
  });
});

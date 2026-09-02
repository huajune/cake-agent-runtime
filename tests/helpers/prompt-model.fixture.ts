import type { PromptModel } from '@agent/generator/context/prompt-model.types';
import type { PromptSection } from '@agent/generator/context/sections/section.interface';
import { renderPromptSection } from '@agent/generator/context/sections/section.interface';

export function promptModelOf(overrides: Partial<PromptModel> = {}): PromptModel {
  return {
    scenario: 'candidate-consultation',
    channelType: 'private',
    currentTimeText: '2026/09/02 星期三 08:00',
    identity: {},
    strategy: {
      roleSetting: { content: '' },
      persona: { textDimensions: [] },
      redLines: { rules: [], thresholds: [] },
      thresholds: [],
      stages: [],
      currentStage: null,
    },
    memory: {
      adjudication: {
        profile: null,
        jobIntent: null,
        sessionState: null,
        conflicts: [],
        displayTurnHints: null,
        pendingTurnHintFields: [],
      },
      booking: { state: 'none' },
      realtimeGroups: [],
      contactBrandAliases: [],
      currentLaborFormIntent: { kind: 'ignore' },
      activeLaborForm: null,
    },
    groupInventory: undefined,
    turnHints: {
      current: null,
      pendingConfirmation: null,
      currentTurnTexts: [],
    },
    hardConstraints: { facts: null, brandState: null },
    security: {},
    criticalTurnInstructions: [],
    ...overrides,
  };
}

export function renderSection(section: PromptSection, model: PromptModel): string {
  return renderPromptSection(section, model);
}

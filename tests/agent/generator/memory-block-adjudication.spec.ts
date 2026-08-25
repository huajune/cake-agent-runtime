import { buildMemoryBlock } from '@agent/generator/context/sections/semantic/memory.section';
import {
  adjudicatePromptMemory,
  normalizeFactTimeKey,
  selectPromptFactWinner,
  type TurnStartMemory,
} from '@agent/generator/working-memory/prompt-memory-adjudicator';
import { TurnHintsSection } from '@agent/generator/context/sections/working/turn-hints.section';
import type { PromptContext } from '@agent/generator/context/sections/section.interface';
import {
  createEmptyUserProfileFacts,
  userProfileFactValue,
  type JobIntentFacts,
  type UserProfileFacts,
} from '@memory/long-term/long-term.types';
import type { SessionFacts } from '@memory/short-term/short-term.types';
import { cityFixture, sessionFactsOf } from '../../helpers/session-facts.fixture';
import { testTurnHint, testTurnHints } from '../../helpers/turn-hints.fixture';

describe('memory block deterministic adjudication', () => {
  const baseCtx: PromptContext = {
    scenario: 'candidate-consultation',
    channelType: 'private',
    strategyConfig: {} as PromptContext['strategyConfig'],
  };

  it('deduplicates the same cross-layer value at the current-session authority', () => {
    const profile = profileWithName('张三', 'medium', '2026-08-25T12:00:00.000Z');
    const sessionFacts = sessionFactsOf(
      { interview_info: { name: '张三' } },
      { confidence: 'high', extractedAt: '2026-08-24T12:00:00.000Z' },
    );
    const memory = memoryOf({ profile, sessionFacts });

    const view = adjudicatePromptMemory(memory);
    const memoryBlock = buildMemoryBlock(view, '');

    expect(memoryBlock.match(/姓名: 张三/g)).toHaveLength(1);
    expect(memoryBlock).not.toContain('[记忆冲突裁决]');
    expect(profile.name?.value).toBe('张三');
    expect(sessionFacts.interview_info.name?.value).toBe('张三');
  });

  it('keeps current-session authority even when the historical profile is newer and more confident', () => {
    const profile = profileWithName('档案名', 'high', '2026-08-25T12:00:00.000Z');
    const sessionFacts = sessionFactsOf(
      { interview_info: { name: '本次名' } },
      { confidence: 'medium', extractedAt: '2026-08-24T11:00:00.000Z' },
    );
    const memory = memoryOf({ profile, sessionFacts });

    const view = adjudicatePromptMemory(memory);
    const memoryBlock = buildMemoryBlock(view, '');

    expect(memoryBlock).not.toContain('- 姓名: 档案名');
    expect(memoryBlock).toContain('- 姓名: 本次名');
    expect(memoryBlock).toContain('档案记 档案名，本次称 本次名');
    expect(memoryBlock).toContain('采用本次会话');
    expect(memoryBlock).toContain('不得因存在冲突而留空或静默');
    expect(profile.name?.value).toBe('档案名');
    expect(sessionFacts.interview_info.name?.value).toBe('本次名');
  });

  it('normalizes updatedAt/extractedAt and conservatively preserves missing time', () => {
    const instant = '2026-08-25T11:00:00.000Z';
    expect(normalizeFactTimeKey({ value: 'a', confidence: 'high', updatedAt: instant })).toBe(
      Date.parse(instant),
    );
    expect(normalizeFactTimeKey({ value: 'b', confidence: 'high', extractedAt: instant })).toBe(
      Date.parse(instant),
    );
    expect(normalizeFactTimeKey({ value: 'c', confidence: 'high' })).toBeNull();
    expect(
      normalizeFactTimeKey({ value: 'd', confidence: 'high', updatedAt: 'not-a-time' }),
    ).toBeNull();

    const olderHigh = {
      scope: 'session' as const,
      envelope: { value: 'high', confidence: 'high', extractedAt: '2026-08-24T11:00:00.000Z' },
    };
    const newerMedium = {
      scope: 'session' as const,
      envelope: {
        value: 'medium',
        confidence: 'medium',
        extractedAt: '2026-08-25T11:00:00.000Z',
      },
    };
    expect(selectPromptFactWinner(olderHigh, newerMedium)).toBe(olderHigh);

    const newerHigh = {
      scope: 'session' as const,
      envelope: { value: 'newer', confidence: 'high', extractedAt: '2026-08-25T11:00:00.000Z' },
    };
    expect(selectPromptFactWinner(olderHigh, newerHigh)).toBe(newerHigh);

    const missingTime = {
      scope: 'session' as const,
      envelope: { value: 'missing', confidence: 'high' },
    };
    expect(selectPromptFactWinner(missingTime, newerHigh)).toBe(missingTime);
  });

  it('keeps an archive-only profile explicitly historical and unconfirmed', () => {
    const memory = memoryOf({
      profile: profileWithName('档案名', 'high', '2026-08-25T10:00:00.000Z'),
    });
    const memoryBlock = buildMemoryBlock(adjudicatePromptMemory(memory), '');

    expect(memoryBlock).toContain('[用户档案]');
    expect(memoryBlock).toContain('历史会话沉淀');
    expect(memoryBlock).toContain('未经本次会话确认');
  });

  it('keeps the merged memory section output byte-identical to the former formatter', () => {
    const memory = memoryOf({
      profile: profileWithName('档案名', 'high', '2026-08-25T10:00:00.000Z'),
    });
    const memoryBlock = buildMemoryBlock(adjudicatePromptMemory(memory), '');

    expect(memoryBlock).toBe(
      [
        '',
        '',
        '[用户档案]',
        '',
        '_以下字段来自**历史会话沉淀**，未经本次会话确认。使用规则：',
        '- 预填报名表/提交预约前，必须向候选人披露并逐项确认（口径如"帮你把之前登记过的信息带出来了，你看下对不对"），不得不加说明地当作候选人本次刚提供的信息直接使用；',
        '- 向候选人复述这些信息时用披露句式（"我记得你之前提过…现在还是吗"），不得说成候选人本次已确认；',
        '- 候选人表示某项不对/不认识时，立即弃用该历史值，按候选人本次说法重新收集。_',
        '',
        '- 姓名: 档案名（置信度: high，来源: archive，更新于: 2026-08-25）',
      ].join('\n'),
    );
  });

  it('deduplicates equal turn hints, marks differences pending, and keeps new hints normal', () => {
    const sessionFacts = sessionFactsOf({ preferences: { city: cityFixture('上海') } });
    const equalHints = testTurnHints(
      testTurnHint('preferences.city', '上海', 'explicit_city'),
      testTurnHint('preferences.district', ['杨浦区'], '区域识别：杨浦区'),
    );
    const equalView = adjudicatePromptMemory(memoryOf({ sessionFacts, turnHints: equalHints }));

    expect(equalView.displayTurnHints?.claims.map((claim) => claim.field)).toEqual([
      'preferences.district',
    ]);
    expect(equalView.pendingTurnHintFields).toEqual([]);

    const differentHints = testTurnHints(
      testTurnHint('preferences.city', '北京', 'explicit_city'),
      testTurnHint('preferences.district', ['杨浦区'], '区域识别：杨浦区'),
    );
    const differentView = adjudicatePromptMemory(
      memoryOf({ sessionFacts, turnHints: differentHints }),
    );
    const output = new TurnHintsSection().build({
      ...baseCtx,
      sessionFacts,
      displayTurnHints: differentView.displayTurnHints,
      pendingTurnHintFields: differentView.pendingTurnHintFields,
    });

    expect(differentView.pendingTurnHintFields).toEqual(['preferences.city']);
    expect(output).toContain('[本轮解析线索]');
    expect(output).toContain('意向区域: 杨浦区');
    expect(output).toContain('[本轮待确认线索]');
    expect(output).toContain('待确认更新');
    expect(output).toContain('意向城市: 北京');
  });

  it('compares turn hints with a long-term winner even when no session fact exists', () => {
    const jobIntent: JobIntentFacts = {
      city: userProfileFactValue('上海', {
        confidence: 'high',
        source: 'archive',
        evidence: 'test',
        updatedAt: '2026-08-25T10:00:00.000Z',
      }),
    };
    const turnHints = testTurnHints(testTurnHint('preferences.city', '北京', 'explicit_city'));

    const view = adjudicatePromptMemory(memoryOf({ jobIntent, turnHints }));
    const output = new TurnHintsSection().build({
      ...baseCtx,
      sessionFacts: null,
      displayTurnHints: view.displayTurnHints,
      pendingTurnHintFields: view.pendingTurnHintFields,
    });

    expect(view.pendingTurnHintFields).toEqual(['preferences.city']);
    expect(output).toContain('[本轮待确认线索]');
    expect(output).toContain('意向城市: 北京');
  });
});

function profileWithName(
  name: string,
  confidence: 'medium' | 'high',
  updatedAt: string,
): UserProfileFacts {
  const profile = createEmptyUserProfileFacts();
  profile.name = userProfileFactValue(name, {
    confidence,
    source: 'archive',
    evidence: 'test',
    updatedAt,
  });
  return profile;
}

function memoryOf(input: {
  profile?: UserProfileFacts | null;
  jobIntent?: JobIntentFacts | null;
  sessionFacts?: SessionFacts | null;
  turnHints?: TurnStartMemory['turnHints'];
}): TurnStartMemory {
  return {
    shortTerm: {
      messageWindow: [],
      sessionState: input.sessionFacts
        ? {
            facts: input.sessionFacts,
            lastCandidatePool: null,
            presentedJobs: null,
            currentFocusJob: null,
          }
        : null,
      stage: { currentStage: null, fromStage: null, advancedAt: null, reason: null },
    },
    longTerm: {
      semantic: {
        profile: input.profile ?? null,
        jobIntent: input.jobIntent ?? null,
      },
    },
    turnHints: input.turnHints ?? null,
  } as unknown as TurnStartMemory;
}

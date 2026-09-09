import {
  GUARDRAIL_DECISION,
  GUARDRAIL_REPAIR_MODE,
  GUARDRAIL_REPAIR_MODES,
  GUARDRAIL_RISK_LEVEL,
  GUARDRAIL_RISK_LEVELS,
  OUTPUT_DECISIONS,
} from '@/types/guardrail.contract';
import { GENERATOR_TOOL_MODES } from '@/agent/generator/generator.types';
import { LLM_THINKING_EFFORTS } from '@/llm/llm.types';
import {
  AGENT_THINKING_EFFORTS,
  AGENT_THINKING_MODES,
} from '@/biz/hosting-config/types/hosting-config.types';

/**
 * 词表单一居所守卫（期 1：守卫与工具契约族）。
 *
 * 这些词表要么被序列化进**发给审查模型的 JSON schema**（decision/confidence/
 * repairMode），要么是 **class-validator 运行时闸门**（@IsIn）——两类都不受
 * typecheck 保护，故在这里锁死取值与顺序。
 */
describe('词表单一居所 · 期 1', () => {
  describe('发给审查模型的 schema 取值与顺序不得漂移', () => {
    it('OUTPUT_DECISIONS 保持严重度升序五档', () => {
      expect([...OUTPUT_DECISIONS]).toEqual(['pass', 'observe', 'revise', 'replan', 'block']);
    });

    it('GUARDRAIL_RISK_LEVELS 保持 low→high', () => {
      expect([...GUARDRAIL_RISK_LEVELS]).toEqual(['low', 'medium', 'high']);
    });

    // 2026-09-09：replan 以原意（同参数重生成，不注入反馈、不裁工具）重新占位为第四档规则动作，
    // 见 guardrail-quality-system.md §2/§3。2026-07 旧实现（带反馈 + 只读工具白名单）不得复活。
    it('GUARDRAIL_REPAIR_MODES 为 rewrite + replan 两档', () => {
      expect([...GUARDRAIL_REPAIR_MODES]).toEqual(['rewrite', 'replan']);
    });

    it('replan 在三个出站词表里同名同义', () => {
      expect([...OUTPUT_DECISIONS]).toContain('replan');
      expect([...GUARDRAIL_REPAIR_MODES]).toContain('replan');
      expect(Object.values(GUARDRAIL_DECISION)).toContain('replan');
    });
  });

  describe('元组与其权威对象成员集合恒等', () => {
    it('OUTPUT_DECISIONS ⊆ GUARDRAIL_DECISION 且无编造值', () => {
      const all = Object.values(GUARDRAIL_DECISION);
      for (const d of OUTPUT_DECISIONS) expect(all).toContain(d);
    });

    it('GUARDRAIL_RISK_LEVELS 覆盖 GUARDRAIL_RISK_LEVEL 全部成员', () => {
      expect([...GUARDRAIL_RISK_LEVELS].sort()).toEqual(Object.values(GUARDRAIL_RISK_LEVEL).sort());
    });

    it('GUARDRAIL_REPAIR_MODES 覆盖 GUARDRAIL_REPAIR_MODE 全部成员', () => {
      expect([...GUARDRAIL_REPAIR_MODES].sort()).toEqual(
        Object.values(GUARDRAIL_REPAIR_MODE).sort(),
      );
    });
  });

  describe('@IsIn / Swagger 元数据的词表（运行时闸门，typecheck 管不到）', () => {
    it('GENERATOR_TOOL_MODES 取值与顺序不变', () => {
      expect([...GENERATOR_TOOL_MODES]).toEqual(['scenario', 'readonly', 'none']);
    });

    it('LLM_THINKING_EFFORTS 取值与顺序不变', () => {
      expect([...LLM_THINKING_EFFORTS]).toEqual(['low', 'medium', 'high']);
    });

    it('AGENT_THINKING_EFFORTS 就是 LLM_THINKING_EFFORTS（不再是同构副本）', () => {
      expect(AGENT_THINKING_EFFORTS).toBe(LLM_THINKING_EFFORTS);
    });

    it('AGENT_THINKING_MODES 取值与顺序不变', () => {
      expect([...AGENT_THINKING_MODES]).toEqual(['fast', 'deep']);
    });
  });

  describe('裁决合并：新表在 4 个在产档位上与旧有序数组等价', () => {
    // 旧实现（origin/develop）：PRIORITY.find(d => d === a || d === b) ?? PASS
    const legacyMerge = (a: string, b: string): string =>
      ['block', 'revise', 'observe', 'pass'].find((d) => d === a || d === b) ?? 'pass';
    // 新实现的等价形式（output-guardrail.service.ts mergeByPriority）
    const rank: Record<string, number> = {
      block: 4,
      revise: 3,
      observe: 2,
      pass: 1,
    };
    const newMerge = (a: string, b: string): string => (rank[a] >= rank[b] ? a : b);

    const LIVE = ['block', 'revise', 'observe', 'pass'];
    const pairs = LIVE.flatMap((a) => LIVE.map((b) => [a, b] as const));

    it.each(pairs)('merge(%s, %s) 与旧实现一致', (a, b) => {
      expect(newMerge(a, b)).toBe(legacyMerge(a, b));
    });

    // 下面这条不是"期望行为"，而是把危险**钉在案发现场**：任何未登记的裁决在优先级合并
    // 里都会静默 fail-open 成放行。所以新档位必须同时登记进 mergeRuleDecision 的优先级序
    // （2026-09-09 replan 回归词表时即如此登记：block > replan > revise > observe > pass）。
    it('未登记的裁决在优先级合并里会 fail-open——故新档位必须登记优先级', () => {
      expect(newMerge('unregistered_tier', 'pass')).toBe('pass');
      expect(legacyMerge('unregistered_tier', 'pass')).toBe('pass');
    });
  });
});

import {
  GUARDRAIL_DECISION,
  GUARDRAIL_ACTION,
  GUARDRAIL_REPAIR_MODE,
  GUARDRAIL_REPAIR_MODES,
  GUARDRAIL_RISK_LEVEL,
  GUARDRAIL_RISK_LEVELS,
  OUTPUT_DECISIONS,
  type InputDecision,
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
    it('OUTPUT_DECISIONS 只保留四档草稿处理意见', () => {
      expect([...OUTPUT_DECISIONS]).toEqual(['pass', 'observe', 'repair', 'replan']);
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

  it('Input 拦截与最终处置不能重新混入草稿处理词表', () => {
    expect(OUTPUT_DECISIONS).not.toContain('block');
    expect(OUTPUT_DECISIONS).not.toContain('revise');
    expect(OUTPUT_DECISIONS).not.toContain('handoff');
    expect(GUARDRAIL_DECISION.HANDOFF).toBe('handoff');
  });

  it('Input 只保留 pass/handoff，统一动作与决策枚举不再包含 block', () => {
    const inputDecisions: Record<InputDecision, true> = { pass: true, handoff: true };
    expect(Object.keys(inputDecisions)).toEqual(['pass', 'handoff']);
    expect(GUARDRAIL_ACTION.HANDOFF).toBe('handoff');
    expect(GUARDRAIL_ACTION).not.toHaveProperty('BLOCK');
    expect(GUARDRAIL_DECISION).not.toHaveProperty('BLOCK');
    expect(Object.values(GUARDRAIL_ACTION)).not.toContain('block');
    expect(Object.values(GUARDRAIL_DECISION)).not.toContain('block');
  });
});

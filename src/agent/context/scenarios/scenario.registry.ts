/**
 * 场景 → section 组合注册表
 *
 * 每个场景定义自己需要的 section 列表（有序）。
 * ContextService 按此顺序拼接各 section 的输出。
 */
export const SCENARIO_SECTIONS: Record<string, string[]> = {
  'candidate-consultation': ['identity', 'base-manual', 'policy', 'runtime-context', 'final-check'],
  'group-operations': ['identity', 'datetime', 'channel'],
  evaluation: ['identity'],
};

/** 默认场景（未指定时使用） */
export const DEFAULT_SCENARIO = 'candidate-consultation';

/**
 * 场景 → section 组合注册表
 *
 * 每个场景定义自己需要的 section 列表（有序）。
 * ContextService 按此顺序拼接各 section 的输出。
 */
export const SCENARIO_SECTIONS: Record<string, string[]> = {
  'candidate-consultation': [
    // semantic · 配置档（策略角色 + 托管账号身份）
    'identity',
    // procedural · 静态档（候选人咨询手册）
    'base-manual',
    // procedural · 配置档（策略红线 + 业务阈值）
    'policy',
    // working 主导 · 动态档（混合编排 episodic/procedural 输入）
    'runtime-context',
    // working · 动态档（按本轮城市实时渲染）
    'group-inventory',
    // procedural · 静态档（发送前自检）
    'final-check',
  ],
  'group-operations': [
    // semantic · 配置档
    'identity',
    // working · 动态档
    'datetime',
    // procedural · 静态档
    'channel',
  ],
  evaluation: [
    // semantic · 配置档
    'identity',
  ],
};

/** 默认场景（未指定时使用） */
export const DEFAULT_SCENARIO = 'candidate-consultation';

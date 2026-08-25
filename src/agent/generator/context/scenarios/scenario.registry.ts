/**
 * 场景 → section 组合注册表
 *
 * 每个场景定义自己需要的 section 列表（有序）。
 * ContextService 按此顺序拼接各 section 的输出。
 */
export const SCENARIO_SECTIONS: Record<string, string[]> = {
  'candidate-consultation': [
    // procedural · 配置档（策略角色 + 托管账号身份）
    'identity',
    // procedural · 静态档（候选人咨询手册）
    'base-manual',
    // procedural · 配置档（策略红线 + 业务阈值）
    'policy',
    // working 主导 · 动态档（混合编排 semantic/procedural 输入）
    'runtime-context',
    // semantic · 动态档（按本轮城市渲染群库事实）
    'group-inventory',
    // procedural · 静态档（发送前自检）
    'final-check',
  ],
  'group-operations': [
    // procedural · 配置档
    'identity',
    // working · 动态档
    'datetime',
    // procedural · 静态档
    'channel',
  ],
  evaluation: [
    // procedural · 配置档
    'identity',
  ],
};

/** 默认场景（未指定时使用） */
export const DEFAULT_SCENARIO = 'candidate-consultation';

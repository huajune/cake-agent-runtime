/**
 * 场景 → section 组合注册表
 *
 * 每个场景定义自己需要的 section 列表（有序）。
 * ContextService 按此顺序拼接各 section 的输出。
 */
export const SCENARIO_SECTIONS: Record<string, string[]> = {
  'candidate-consultation': [
    // procedural · 静态档（候选人咨询手册）
    'base-manual',
    // procedural · 静态档（发送前自检手册）
    'final-check',
    // procedural · 静态档（渠道规范；私聊为空）
    'channel',
    // procedural · 静态档（全阶段地图 + 阶段推进协议）
    'stage-overview',
    // procedural · 配置档（策略红线）
    'red-lines',
    // procedural · 配置档（业务阈值）
    'thresholds',
    // procedural · 配置档（策略角色 + 托管账号身份）
    'identity',
    // semantic · 动态档（跨轮档案 + 当前会话事实）
    'memory',
    // working · 动态档（本轮解析增量）
    'turn-hints',
    // working · 动态档（本轮查询硬约束）
    'hard-constraints',
    // working · 动态档（当前时间）
    'datetime',
    // semantic · 动态档（按本轮城市渲染群库事实）
    'group-inventory',
    // procedural · 动态档（当前阶段策略，固定置于 system 尾部）
    'stage-strategy',
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

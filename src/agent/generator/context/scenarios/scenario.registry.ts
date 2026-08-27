/**
 * 场景 → section 组合注册表
 *
 * 每个场景定义自己需要的 section 列表（有序）。
 * ContextService 按此顺序拼接各 section 的输出。
 */
export const SCENARIO_SECTIONS: Record<string, string[]> = {
  'candidate-consultation': [
    // procedural · 配置档（开篇人设；低频配置档前置无缓存代价）
    'identity',
    // procedural · 静态档（候选人咨询手册）
    'base-manual',
    // procedural · 静态档（渠道规范；私聊为空）
    'channel',
    // procedural · 静态档（全阶段地图 + 阶段推进协议）
    'stage-overview',
    // procedural · 配置档（策略红线）
    'red-lines',
    // procedural · 配置档（业务阈值）
    'thresholds',
    // semantic · 动态档（跨轮档案 + 当前会话事实）
    'memory',
    // working · 动态档（本轮解析增量）
    'turn-hints',
    // working · 动态档（本轮查询硬约束）
    'hard-constraints',
    // working · 动态档（当前时间）
    'datetime',
    // working · 动态档（按本轮城市渲染平台群库数据）
    'group-inventory',
    // procedural · 动态档（当前阶段策略）
    'stage-strategy',
    // procedural · 复合档（发送前防线统一规则表：次末位常驻自检块 recitation 收口 +
    // 末位命中才产出的本轮动态硬禁令块，块 id 仍为 final-check / critical-turn-guard）
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

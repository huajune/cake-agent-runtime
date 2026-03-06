/**
 * 全局共享常量
 */

/**
 * 💜 主题颜色配置
 *
 * 用于 Chart.js 等需要 JavaScript 颜色值的场景
 * 节日期间切换新春主题时，注释掉紫色主题并取消下方新春主题的注释
 */

// === 💜 紫色主题 (当前启用) ===
export const THEME_COLORS = {
  // 主色 - 靛蓝紫
  primary: '#6366f1',
  primaryLight: '#818cf8',
  primaryDark: '#4f46e5',
  // 强调色 - 紫罗兰
  accent: '#8b5cf6',
  accentLight: '#a78bfa',
  // 透明度变体
  primary02: 'rgba(99, 102, 241, 0.02)',
  primary10: 'rgba(99, 102, 241, 0.1)',
  primary20: 'rgba(99, 102, 241, 0.2)',
  primary30: 'rgba(99, 102, 241, 0.3)',
  accent02: 'rgba(139, 92, 246, 0.02)',
  accent10: 'rgba(139, 92, 246, 0.1)',
  accent20: 'rgba(139, 92, 246, 0.2)',
  accent30: 'rgba(139, 92, 246, 0.3)',
} as const;

// === 🧧 新春主题 (节日期间启用) ===
// export const THEME_COLORS = {
//   // 主色 - 中国红
//   primary: '#dc2626',
//   primaryLight: '#ef4444',
//   primaryDark: '#b91c1c',
//   // 强调色 - 金色
//   accent: '#f59e0b',
//   accentLight: '#fbbf24',
//   // 透明度变体
//   primary02: 'rgba(220, 38, 38, 0.02)',
//   primary10: 'rgba(220, 38, 38, 0.1)',
//   primary20: 'rgba(220, 38, 38, 0.2)',
//   primary30: 'rgba(220, 38, 38, 0.3)',
//   accent02: 'rgba(245, 158, 11, 0.02)',
//   accent10: 'rgba(245, 158, 11, 0.1)',
//   accent20: 'rgba(245, 158, 11, 0.2)',
//   accent30: 'rgba(245, 158, 11, 0.3)',
// } as const;

/**
 * 测试场景分类（与飞书表格一致）
 *
 * 用于：
 * - 测试/验证集页面：标记用例所属场景
 * - 飞书回写：同步到飞书多维表格的"分类"字段
 */
export const TEST_SCENARIO_TYPES = [
  '1-品牌识别错误',
  '2-地区识别错误',
  '3-岗位推荐问题', // 包含：条件不符、推荐不匹配、详情不准确
  '4-情绪处理不当',
  '5-预约流程出错',
  '6-其他',
] as const;

export type TestScenarioType = (typeof TEST_SCENARIO_TYPES)[number];

/**
 * 测试场景选项（用于下拉选择框）
 */
export const TEST_SCENARIO_OPTIONS = [
  { value: '', label: '请选择场景...' },
  ...TEST_SCENARIO_TYPES.map((type) => ({ value: type, label: type })),
] as const;

/**
 * Agent 错误原因分类（问题归因）
 *
 * 用于：
 * - 测试/验证集页面：评审时标记失败原因
 * - 对话调试页面：反馈弹窗标记错误类型
 */
export const AGENT_ERROR_TYPES = [
  '工具误触发',       // 不该调用却调用了（如用户说"好的"却触发岗位查询）
  '工具漏调用',       // 该调用却没调用（如用户问岗位却没查询）
  '工具参数错误',     // 调用了但参数不对（如品牌名/地区名错误）
  '回复内容错误',     // 回复了但内容不准确或不相关
  '未理解用户意图',   // 完全理解偏了（如把昵称当聊天内容）
  '情绪处理不当',     // 对用户情绪（不满、沮丧）处理不好
  '上下文丢失',       // 没记住之前聊过的内容
  '其他问题',         // 其他无法归类的问题
] as const;

export type AgentErrorType = (typeof AGENT_ERROR_TYPES)[number];

/**
 * 错误原因选项（用于下拉选择框）
 */
export const AGENT_ERROR_TYPE_OPTIONS = [
  { value: '', label: '请选择原因...' },
  ...AGENT_ERROR_TYPES.map((type) => ({ value: type, label: type })),
] as const;

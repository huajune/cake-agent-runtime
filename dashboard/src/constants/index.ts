/**
 * 全局共享常量
 */

/**
 * 测试场景分类（与飞书表格一致）
 *
 * 用于：
 * - 测试集页面：标记用例所属场景
 * - 飞书回写：同步到飞书多维表格的"分类"字段
 */
export const TEST_SCENARIO_TYPES = [
  '2-品牌识别错误',
  '3-地区识别错误',
  '4-年龄/工时/距离等条件不符',
  '5-过度反应',
  '6-用户负面情绪处理不当',
  '8-岗位推荐不准确',
  '9-岗位详情不准确',
  '10-面试信息收集错误',
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
 * - 测试集页面：评审时标记失败原因
 * - 对话测试页面：反馈弹窗标记错误类型
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

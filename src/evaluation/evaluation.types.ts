/**
 * Evaluation 模块类型定义
 *
 * 只保留对话解析（ConversationParserService）需要的结构；
 * LLM 相似度评分器已于 2026-09-02 删除（口径见 docs/architecture/agent-quality-evaluation.md）。
 */

/**
 * 解析后的对话消息
 */
export interface ParsedMessage {
  /** 角色: user(候选人) | assistant(招募经理) */
  role: 'user' | 'assistant';
  /** 消息内容 */
  content: string;
  /** 发送时间（原始格式，如 "12/04 17:20"） */
  timestamp?: string;
}

/**
 * 回归验证轮次数据
 */
export interface ConversationTurn {
  /** 轮次编号（从1开始） */
  turnNumber: number;
  /** 历史上下文（前 N-1 轮的完整对话） */
  history: ParsedMessage[];
  /** 当前轮用户消息 */
  userMessage: string;
  /** 参考输出；真实对话拆轮时为历史下一条真人回复，动态工具场景不能当硬断言 */
  expectedOutput: string;
}

/**
 * 对话解析结果
 */
export interface ConversationParseResult {
  /** 是否解析成功 */
  success: boolean;
  /** 解析后的消息列表 */
  messages: ParsedMessage[];
  /** 总轮数（候选人发言次数） */
  totalTurns: number;
  /** 错误信息（如果失败） */
  error?: string;
}

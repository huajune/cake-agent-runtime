/**
 * ChatTester 组件常量
 */

// 场景分类选项：复用全局测试场景类型定义
export { TEST_SCENARIO_OPTIONS as SCENARIO_TYPE_OPTIONS } from '@/constants';

// 历史记录示例格式
export const HISTORY_PLACEHOLDER = `粘贴对话记录，格式如：
[12/04 14:23 候选人] 你好
[12/04 14:24 招募经理] 你好，有什么可以帮您？`;

// API 配置
export const CHAT_API_ENDPOINT = '/test-suite/chat/ai-stream';
export const DEFAULT_SCENARIO = 'candidate-consultation';

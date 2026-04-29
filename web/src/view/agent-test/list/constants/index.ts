/**
 * ChatTester 组件常量
 */

// BadCase 反馈场景分类：运营可见字段，只描述问题发生的业务场景。
// 不复用测试集分类/错误原因，避免把内部根因口径暴露到反馈入口。
export const FEEDBACK_SCENARIO_TYPES = [
  '1-品牌/门店识别',
  '2-地区/位置/距离',
  '3-岗位推荐-范围/门店/距离',
  '4-岗位推荐-条件/班次不匹配',
  '5-岗位详情/薪资/福利口径',
  '6-预约/收资流程',
  '7-已约面/改期/入职跟进',
  '8-多消息/引用/上下文承接',
  '9-拉群/无岗维护',
  '10-图片/证件识别',
  '11-情绪/话术',
  '12-人工/非Agent归因',
  '13-其他',
] as const;

export const SCENARIO_TYPE_OPTIONS = [
  { value: '', label: '请选择场景...' },
  ...FEEDBACK_SCENARIO_TYPES.map((type) => ({ value: type, label: type })),
];

// 历史记录示例格式
export const HISTORY_PLACEHOLDER = `粘贴对话记录，格式如：
[12/04 14:23 候选人] 你好
[12/04 14:24 招募经理] 你好，有什么可以帮您？`;

// API 配置
export const CHAT_API_ENDPOINT = '/test-suite/chat/ai-stream';
export const DEFAULT_SCENARIO = 'candidate-consultation';

// 拉群链路默认 ID（来源：Ariel 历史会话）
export const DEFAULT_GROUP_INVITE_IDS: {
  userId: string;
  botUserId: string;
  botImId: string;
} = {
  userId: '7881300085910772',
  botUserId: 'ZhuJie',
  botImId: '1688854747775509',
};

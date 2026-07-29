/**
 * ChatTester 组件常量
 */

// BadCase 反馈场景分类：运营可见字段，只描述问题发生的业务场景。
// 不复用测试集分类/错误原因，避免把内部根因口径暴露到反馈入口。
// 1-13 与《BadCase 治理进展同步》"已修复问题类型"口径一致；14/15 是反馈入口专属兜底项。
export const FEEDBACK_SCENARIO_TYPES = [
  '1-地区、城市与位置识别',
  '2-品牌与门店识别',
  '3-就近岗位推荐',
  '4-岗位条件与班次匹配',
  '5-岗位详情、薪资与福利',
  '6-报名与收资',
  '7-预约、取消与改期',
  '8-线上面试与到店引导',
  '9-无岗承接与拉群',
  '10-重复回复与收口节奏',
  '11-图片与上下文理解',
  '12-内部术语与异常输出',
  '13-敏感条件与合规表达',
  '14-人工/非Agent归因',
  '15-其他',
] as const;

export const BADCASE_PRIORITY_OPTIONS = [
  { value: 'P0', label: 'P0 - 阻断业务或高风险' },
  { value: 'P1', label: 'P1 - 影响关键转化链路' },
  { value: 'P2', label: 'P2 - 一般体验问题' },
] as const;

export const SCENARIO_TYPE_OPTIONS = [
  { value: '', label: '请选择场景...' },
  ...FEEDBACK_SCENARIO_TYPES.map((type) => ({ value: type, label: type })),
];

// 复聊（二次触达）BadCase 专属场景分类：描述触达决策/内容层面的问题
export const REENGAGEMENT_SCENARIO_TYPES = [
  '1-不该触达（工单/条件误判）',
  '2-触达时机错误（过早/过晚）',
  '3-重复打扰（"已提醒过"误判）',
  '4-场景挂错',
  '5-话术事实错误（岗位/时间/状态不符）',
  '6-语气/话术不当',
  '7-取消/改期后仍按旧状态触达',
  '8-其他',
] as const;

export const REENGAGEMENT_SCENARIO_TYPE_OPTIONS = [
  { value: '', label: '请选择场景...' },
  ...REENGAGEMENT_SCENARIO_TYPES.map((type) => ({ value: type, label: type })),
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

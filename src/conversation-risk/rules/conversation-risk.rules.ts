export const ABUSE_KEYWORDS = [
  '傻逼',
  '傻x',
  '煞笔',
  '脑残',
  // 不收 '有病'：候选人常说"家里有病人 / 我爸有病要照顾"等真实诉求，substring
  // 匹配会误伤为辱骂。要骂人通常会用 '神经病 / 傻逼 / sb / 操你' 等明确词。
  '神经病',
  '垃圾',
  '废物',
  '滚',
  '去死',
  '王八蛋',
  '妈的',
  '操你',
  '他妈',
  'sb',
  'cnm',
] as const;

export const COMPLAINT_RISK_KEYWORDS = [
  '投诉',
  '举报',
  '曝光',
  '劳动局',
  '仲裁',
  '骗人',
  '骗子',
  '坑',
  '报警',
  '维权',
  '欺骗',
  '黑心',
] as const;

export const ESCALATION_KEYWORDS = [
  '怎么还',
  '怎么不回',
  '为什么不回',
  '一直不回',
  '到底',
  '什么情况',
  '几个意思',
  '回我',
  '人呢',
  '在吗',
  '赶紧',
  '马上回',
] as const;

/**
 * 历史面试结果追问：候选人问上次面试过没过、结果何时出。Agent 无权限查面试评价，
 * 凭空回答要么编造要么显得漠视候选人关切，产品要求立即转人工（stash 捞回：确定性检测落地，
 * 与 guardrail.contract INPUT_RISK_TYPES.INTERVIEW_RESULT_INQUIRY / catalog 声明对齐）。
 */
export const INTERVIEW_RESULT_INQUIRY_KEYWORDS = [
  '为什么没通过',
  '为什么没过面试',
  '面试没通过',
  '面试失败了',
  '上次面试结果',
  '面试结果怎么样',
  '没收到面试结果',
] as const;

export const SOFT_NEGATIVE_KEYWORDS = [
  '不靠谱',
  '离谱',
  '忽悠',
  '敷衍',
  '无语',
  '恶心',
  '失望',
  '太差',
  '太慢',
  '玩我',
  '耍我',
] as const;

export const CONVERSATION_RISK_ALERT_WINDOW_MS = 5 * 60 * 1000;

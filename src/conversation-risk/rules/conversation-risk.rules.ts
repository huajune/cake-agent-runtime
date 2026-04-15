export const ABUSE_KEYWORDS = [
  '傻逼',
  '傻x',
  '煞笔',
  '脑残',
  '有病',
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

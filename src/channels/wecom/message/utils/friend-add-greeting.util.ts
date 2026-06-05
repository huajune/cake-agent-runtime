/**
 * 微信「加好友握手语」识别。
 *
 * 候选人通过企微加好友时，微信会以普通 user 消息（source=MOBILE_PUSH）推送一条握手语。
 * 生产 chat_messages 实测，形态有三类：
 *   1. 纯系统消息：「请求添加你为朋友」「我通过了你的(朋友|联系人)验证请求，现在我们可以开始聊天了」
 *   2. 纯默认招呼语：「我是{昵称}」（微信加好友默认填充，多为昵称/emoji，无求职意图）
 *   3. 带求职意图的招呼语：「我是找工作的 / 我是兼职 / 我是应聘的 / 我是boss」等
 *
 * 「破冰(candidate.engaged)」只统计候选人首条**真实**消息：第 1、2 类（纯默认招呼语）应排除，
 * 第 3 类带求职意图的要算破冰。本函数判定「是否纯默认招呼语」。
 *
 * 注意：friend.added（加好友数）不依赖本函数——任何首条消息都代表新好友，靠幂等键去重即可。
 */

/** 纯微信系统消息（精确匹配即排除）。 */
const PURE_SYSTEM_GREETINGS = new Set<string>(['请求添加你为朋友']);

/** 「我通过了你的(朋友|联系人)验证请求…」系统消息。 */
const VERIFY_REQUEST_RE = /^我通过了你的.{0,6}验证请求/;

/**
 * 求职意图关键词：「我是…」招呼语命中任一即视为带意图（算破冰，不排除）。
 * 全部小写匹配（中文不受影响）。宁可漏判为「带意图」（多算破冰）也不误杀真实候选人。
 * 业务侧可按 badcase 增删。
 */
const JOB_INTENT_KEYWORDS = [
  '找工作',
  '工作',
  '兼职',
  '全职',
  '应聘',
  '求职',
  '招聘',
  '小时工',
  '钟点',
  '临时工',
  '日结',
  '长期工',
  '打工',
  '上班',
  '找活',
  '暑假',
  '寒假',
  '学生',
  'boss',
  '直聘',
  '收银',
  '服务员',
  '保洁',
  '分拣',
  '洗碗',
  '后厨',
  '应届',
];

/** 「我是{昵称}」默认招呼语的最大长度（含「我是」前缀）；超长一般是真实自我介绍/群转介，按破冰计。 */
const MAX_DEFAULT_GREETING_LENGTH = 12;

/**
 * 判断是否为「加好友纯默认招呼语」（应从破冰统计中排除）。
 * 带求职意图的「我是找工作的」等返回 false（仍计破冰）。
 */
export function isPureFriendAddGreeting(content: string | null | undefined): boolean {
  if (!content) return false;
  const text = content.trim();
  if (!text) return false;

  if (PURE_SYSTEM_GREETINGS.has(text)) return true;
  if (VERIFY_REQUEST_RE.test(text)) return true;

  if (text.startsWith('我是')) {
    const lower = text.toLowerCase();
    // 带求职意图 → 算破冰，不排除
    if (JOB_INTENT_KEYWORDS.some((kw) => lower.includes(kw))) return false;
    // 纯「我是{昵称}」默认招呼语：长度宽松限制，避免把长句自我介绍/群转介误判成招呼语
    return text.length <= MAX_DEFAULT_GREETING_LENGTH;
  }

  return false;
}

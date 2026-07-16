import { extractMessageText } from '@tools/duliday/precheck/collection-strategy.util';

/**
 * 候选人「学生 / 社会人士」身份自认的唯一识别器。
 *
 * 背景：身份判定贯穿 事实抽取 → precheck 证据闸门 → booking 复核 → 出站守卫 四层，
 * 此前各层各写各的正则、各用各的清洗规则，产生两类事故：
 * - badcase 6a448d09：precheck 白名单过窄，候选人怎么答都不被认，同一问题被追问 4 遍；
 * - 2026-07-15：v10.13.0 的整句锚定修复被短期记忆注入的 `[消息发送时间：…]` 后缀
 *   全量击穿（识别器不剥该后缀，锚定永远失败）；识别器漏判进一步污染
 *   identity_misregistration_coaching 守卫的证据，把诚实回复误判成造假教唆。
 *
 * 契约：所有需要判定"候选人是否明确自报身份"的调用方（precheck / booking /
 * 出站守卫）都必须走本模块，不得各自实现同类正则。
 */

export type CandidateIdentity = '学生' | '社会人士';

// —— 消息装饰清洗 ————————————————————————————————————————————————
// 企微引用块：引用的是对方消息，不代表候选人自述。
const QUOTE_BLOCK_RE = /\[引用[^\n]*?\]\s*/g;
// 短期记忆注入的时间后缀（src/memory/services/session.service.ts），与
// name-guard / candidate-field-parser 的剥离口径一致；debounce 合并消息可能
// 内嵌多个，全局剥离并保留换行以维持子句边界。
const TIME_CONTEXT_RE = /\s*\[消息发送时间：[^\]]*\]/gu;

/** 剥离引用块与时间戳装饰。所有身份匹配前必须先过这一步。 */
export function stripMessageDecorations(text: string): string {
  return text.replace(QUOTE_BLOCK_RE, '').replace(TIME_CONTEXT_RE, '\n').trim();
}

// —— 单值答案分类（宽松子串级）——————————————————————————————————————
// 只用于"这段文本就是身份答案"的上下文：表单行的值、candidateIsStudent 工具入参。
// 自由聊天消息严禁走本函数（"社会人士岗位有吗"会误判），走 matchIdentityStatement。
export function classifyIdentityAnswerText(value: string): CandidateIdentity | null {
  const text = value.trim();
  if (!text) return null;
  // LLM 常把 is_student 布尔序列化成 "true"/"False"/"是"/"否"（按字段绝对语义解析）
  if (/^(false|否|no|不是|0)$/i.test(text)) return '社会人士';
  if (/^(true|是|yes|1)$/i.test(text)) return '学生';
  // 否定/社会侧优先：先排除"不是学生"再匹配"学生"
  if (
    /社会人士|社会人|不是学生|非学生|不算学生|已毕业|毕业了|上班族|已经工作|工作了|在上班/.test(
      text,
    )
  ) {
    return '社会人士';
  }
  if (/学生|在读|上学|本科在读|研究生|大一|大二|大三|大四|高中生|大学生/.test(text)) {
    return '学生';
  }
  return null;
}

// —— 自由消息中的身份自认（严格级）——————————————————————————————————
// 子句级锚定：候选人常把多字段挤进一条消息（"男 已经工作了"），整句锚定会被无关
// 前缀击穿；按空白/标点切子句后逐段匹配，容忍"我/是/还/确定/就是"等口语前缀。
// 疑问尾词（吗/呢/吧）刻意排除在后缀外，"已经工作了吗"这类反问不构成自认。
const STUDENT_CLAUSE_RE =
  /^(?:我|本人)?(?:现在|目前)?(?:确定|确认|肯定)?(?:还)?(?:就)?(?:是)?(?:学生|大学生|在校生|在读学生|在校学生|高中生|在读|在上学|还在上学)(?:的|哈|哦|呀|啊)?$/u;
const SOCIAL_CLAUSE_RE =
  /^(?:我|本人)?(?:现在|目前)?(?:确定|确认|肯定)?(?:就)?(?:是)?(?:社会人士|社会人|不是学生|非学生|已经?(?:毕业|工作|上班)(?:了|啦)?|毕业了|上班族)(?:的|哈|哦|呀|啊)?$/u;
// 表单行：括号说明放宽为任意文本——Agent 会把模板写成"身份（学生还是社会人士）："
// 等变体（2026-07-15 生产 19 个 chat），候选人照抄回填必须能被认。值交给宽松分类器。
const FORM_LINE_RE = /身份(?:[（(][^（）()]*[）)])?\s*[：:]\s*([^\n，。；！？、]{1,16})/u;
const CLAUSE_SPLIT_RE = /[\s，。！？；、,.!?;\n\r~～]+/u;

/** 识别单条消息文本中的身份自认；无明确自认返回 null。 */
export function matchIdentityStatement(rawText: string): CandidateIdentity | null {
  const text = stripMessageDecorations(rawText);
  if (!text) return null;
  const formMatch = FORM_LINE_RE.exec(text);
  if (formMatch) {
    const fromForm = classifyIdentityAnswerText(formMatch[1] ?? '');
    if (fromForm) return fromForm;
  }
  if (/我(?:现在)?是学生|(?:本科|大专|高中|硕士|研究生|博士)在读|我还在读|我在上学/u.test(text)) {
    return '学生';
  }
  if (/我是社会人士|我不是学生|我是非学生|我已经?毕业|我毕业了|我已经?工作了/u.test(text)) {
    return '社会人士';
  }
  for (const clause of text.split(CLAUSE_SPLIT_RE)) {
    if (!clause) continue;
    if (STUDENT_CLAUSE_RE.test(clause)) return '学生';
    if (SOCIAL_CLAUSE_RE.test(clause)) return '社会人士';
  }
  return null;
}

// —— 确认式问答 ————————————————————————————————————————————————
/**
 * 识别 assistant 的"单值身份确认问句"（如「你是"社会人士"对吧」）。
 *
 * 只认确认词紧跟身份词的句式；含"还是"的二选一问句（"学生还是已经工作了"）
 * 对其回答"是的"语义不定，必须返回 null。
 */
export function detectIdentityConfirmQuestion(rawText: string): CandidateIdentity | null {
  const text = stripMessageDecorations(rawText);
  if (!text || /还是/u.test(text)) return null;
  if (
    /(?:是|选|填)\s*[「『“"'』」”]*社会人士[』」”"'\s]*(?:对吧|对不对|是吧|是吗|吗)/u.test(text)
  ) {
    return '社会人士';
  }
  if (/(?:是|选|填)\s*[「『“"'』」”]*学生[』」”"'\s]*(?:对吧|对不对|是吧|是吗|吗)/u.test(text)) {
    return '学生';
  }
  return null;
}

const BARE_AFFIRMATION_RE =
  /^(?:是的|是啊|是呀|是|对的|对呀|对啊|对|嗯嗯|嗯|好的|好|没错|确认|确定)$/u;
const BARE_NEGATION_RE = /^(?:不是|不对|不|没有|错了)/u;

// —— 会话级身份判定 ————————————————————————————————————————————
type ConversationMessage = Record<string, unknown>;

function readMessageText(message: unknown): { role: unknown; text: string } | null {
  if (!message || typeof message !== 'object') return null;
  const record = message as ConversationMessage;
  const raw = extractMessageText(record.content);
  if (!raw) return null;
  return { role: record.role, text: stripMessageDecorations(raw) };
}

/**
 * 扫描对话窗口，返回候选人**最新**一次明确身份自认。
 *
 * 除直接自认外，还识别确认式问答：assistant 发出单值确认问句后，候选人的
 * 纯肯定应答（"是的"）构成自认；否定应答只撤销悬挂问句，不反推相反身份。
 */
export function findLatestExplicitIdentity(messages: unknown[]): CandidateIdentity | null {
  let latest: CandidateIdentity | null = null;
  let pendingConfirm: CandidateIdentity | null = null;
  for (const message of messages) {
    const parsed = readMessageText(message);
    if (!parsed || !parsed.text) continue;
    if (parsed.role === 'assistant') {
      pendingConfirm = detectIdentityConfirmQuestion(parsed.text);
      continue;
    }
    if (parsed.role !== 'user') continue;
    const stated = matchIdentityStatement(parsed.text);
    if (stated) {
      latest = stated;
      pendingConfirm = null;
      continue;
    }
    if (pendingConfirm) {
      const compact = parsed.text.replace(/[！。～!.~\s]+$/u, '');
      if (BARE_AFFIRMATION_RE.test(compact)) {
        latest = pendingConfirm;
        pendingConfirm = null;
      } else if (BARE_NEGATION_RE.test(compact)) {
        pendingConfirm = null;
      }
      // 非应答消息（debounce 合并的寒暄等）不清除悬挂问句，等后续消息继续判定。
    }
  }
  return latest;
}

// —— 身份追问统计 ————————————————————————————————————————————
// assistant 侧"身份追问"识别：二选一式 / 单值确认式 / 系统身份核对式 / 复读式。
// 表单模板行"身份（学生/社会人士）："不含这些确认动词，刻意不计入追问次数。
const IDENTITY_ASK_RES: RegExp[] = [
  /学生还是|还是学生/u,
  /身份[^\n]{0,16}(?:确认|核对|勾|选项|选择|选一下|填一下)/u,
  /(?:确认|核对|补)[^\n]{0,8}身份/u,
  /回一句[^\n]{0,6}(?:社会人士|学生)/u,
];

/** 判定一条 assistant 消息是否在向候选人追问身份。 */
export function isIdentityAskMessage(rawText: string): boolean {
  const text = stripMessageDecorations(rawText);
  if (!text) return false;
  return (
    detectIdentityConfirmQuestion(text) !== null ||
    IDENTITY_ASK_RES.some((pattern) => pattern.test(text))
  );
}

/**
 * 统计 assistant 已向候选人追问身份的轮数，以及最近一次追问后候选人是否已回复。
 *
 * badcase 6a448d09：识别器不认候选人回答时，模型在 4 个 turn 里把同一个身份问题
 * 问了 4 遍。该统计供 identityFieldGuard 升级判断：追问 ≥2 次且候选人已作答仍
 * 无法核验 → 停止追问、强制转人工。
 */
export function summarizeIdentityAskRounds(messages: unknown[]): {
  askCount: number;
  userRepliedAfterLatestAsk: boolean;
} {
  let askCount = 0;
  let userRepliedAfterLatestAsk = false;
  for (const message of messages) {
    const parsed = readMessageText(message);
    if (!parsed || !parsed.text) continue;
    if (parsed.role === 'assistant') {
      if (isIdentityAskMessage(parsed.text)) {
        askCount += 1;
        userRepliedAfterLatestAsk = false;
      }
      continue;
    }
    if (parsed.role === 'user' && askCount > 0) {
      userRepliedAfterLatestAsk = true;
    }
  }
  return { askCount, userRepliedAfterLatestAsk };
}

// —— 拒后改口核实（学生 → 被拒 → 改口社会人士）——————————————————————————
// assistant 的学生拒绝话术："这个岗位不要学生 / 暂不招学生 / 仅限社会人士" 等。
const STUDENT_REJECTION_NOTICE_RE =
  /(?:不要|不招|不收|不接受|暂不(?:要|招|收)|暂时不(?:要|招|收))[^\n。！？]{0,6}学生|学生[^\n。！？]{0,8}(?:不要|不招|不收|报不了|做不了|不行|暂不)|(?:只要|仅限|只招|只接受)[^\n。！？]{0,6}社会人士/u;

/** 判定一条 assistant 消息是否在告知候选人"该岗位不接受学生"。 */
export function detectStudentRejectionNotice(rawText: string): boolean {
  const text = stripMessageDecorations(rawText);
  if (!text) return false;
  return STUDENT_REJECTION_NOTICE_RE.test(text);
}

/**
 * 识别"学生自认 → 被拒 → 改口社会人士"序列并判断改口是否已核实。
 *
 * 产品裁定（2026-07-15）：被拒后的首次改口不能直接采信——Agent 必须核实一次
 * （告知如实填写不影响推荐其它岗位），候选人在核实问句后再次明确确认，改口才生效。
 * 只防"学生→社会"方向（造假动机方向）；反向改口自证学生无需核实。
 */
export function resolveIdentityFlipAfterRejection(messages: unknown[]): {
  flipPendingVerification: boolean;
} {
  let studentStated = false;
  let rejected = false;
  let flipped = false;
  let verifyAsked = false;
  let confirmed = false;
  for (const message of messages) {
    const parsed = readMessageText(message);
    if (!parsed || !parsed.text) continue;
    if (parsed.role === 'assistant') {
      if (studentStated && !rejected && detectStudentRejectionNotice(parsed.text)) {
        rejected = true;
      } else if (flipped && !confirmed && isIdentityAskMessage(parsed.text)) {
        verifyAsked = true;
      }
      continue;
    }
    if (parsed.role !== 'user') continue;
    const stated = matchIdentityStatement(parsed.text);
    if (stated === '学生') {
      // 候选人重新自认学生：改口链路重置（诚实方向，直接采信）。
      studentStated = true;
      rejected = false;
      flipped = false;
      verifyAsked = false;
      confirmed = false;
      continue;
    }
    if (stated === '社会人士' && rejected) {
      if (!flipped) {
        flipped = true;
      } else if (verifyAsked) {
        confirmed = true;
      }
      // 未经核实问句的重复自证不算确认——核实的价值在于 Agent 明示"如实填写不影响推荐"。
    }
  }
  return { flipPendingVerification: flipped && !confirmed };
}

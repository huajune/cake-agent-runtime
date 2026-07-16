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

export type IdentityEvidenceSource = 'direct' | 'form_answer' | 'choice_answer' | 'confirmation';

/**
 * 候选人身份的可追溯原话证据。
 *
 * identity 只表达识别结果；source 说明为什么这段文本可按身份答案解释；evidence
 * 保留清洗后的候选人原话，供 precheck / booking / 出站守卫记录与排障。没有足够
 * 明确的候选人原话时返回 null，年龄、画像和模型工具入参都不能伪装成本对象。
 */
export interface IdentityEvidence {
  identity: CandidateIdentity;
  source: IdentityEvidenceSource;
  evidence: string;
  /** 会话级扫描时对应 messages 数组的位置；单消息识别不填。 */
  messageIndex?: number;
}

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
  // 未填写的选项模板不能被其中的“社会人士”子串误判为答案。若模板后面另有回填值，
  // 去掉模板后只解释剩余部分（如“学生/社会人士 社会人士”）。
  const withoutChoiceTemplate = text
    .replace(/学生\s*(?:[\/／]|还是|或)\s*社会人士?/gu, ' ')
    .replace(/社会人士?\s*(?:[\/／]|还是|或)\s*学生/gu, ' ')
    .replace(/[（()）：:\s]/gu, ' ')
    .trim();
  if (withoutChoiceTemplate !== text && !withoutChoiceTemplate) return null;
  if (withoutChoiceTemplate !== text) return classifyIdentityAnswerText(withoutChoiceTemplate);
  // LLM 常把 is_student 布尔序列化成 "true"/"False"/"是"/"否"（按字段绝对语义解析）
  if (/^(false|否|no|不是|0)$/i.test(text)) return '社会人士';
  if (/^(true|是|yes|1)$/i.test(text)) return '学生';
  // 否定/社会侧优先：先排除"不是学生"再匹配"学生"
  if (
    /社会人士|社会人|^社会$|不是学生|非学生|不算学生|不在读书|已毕业|毕业了|上班族|^上班$|^工作$|已经工作|工作了|在上班/.test(
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
const SOCIAL_GRADUATION_CLAUSE_RE =
  /^(?:对)?(?:我)?(?:去年|今年)?(?:已经?|完全)?(?:本科|大专|专科|高中|硕士|研究生|博士)(?:已)?毕业(?:了|啦)?$/u;
// 表单行：括号说明放宽为任意文本——Agent 会把模板写成"身份（学生还是社会人士）："
// 等变体（2026-07-15 生产 19 个 chat），候选人照抄回填必须能被认。值交给宽松分类器。
const FORM_LINE_RE = /身份(?:[（(][^（）()]*[）)])?\s*[：:]\s*([^\n，。；！？、]{1,16})/u;
// 脱敏/摘要后的生产表单有时会丢失冒号，变成“18岁，学历高中，身份学生”。只认
// 紧跟身份字段的单值，并排除“身份学生还是社会人士”这类未作答选项。
const INLINE_IDENTITY_FIELD_RE =
  /身份\s*(?:是\s*)?(学生|社会人士|社会人|社会|非学生|不是学生)(?!\s*(?:还是|或|[\/／]))(?=$|[\s，。；！？、])/u;
const STUDENT_STATUS_FORM_RE =
  /(?:是否(?:是)?(?:学信网)?在籍学生|是否(?:是)?学生)\s*[：:]\s*(是|否|true|false|yes|no|1|0)(?=$|[\s，。；！？、])/iu;
// 候选人有时直接在 Agent 的二选一问题后填写简写答案，例如：
// “目前是学生还是社会人士？（这家只招社会人士哈）社会”。“社会”单独出现在
// 自由聊天里语义过宽，不能加入通用社会人士关键词；只在这个已知是身份答案的
// 二选一表单上下文中收窄识别。
const CHOICE_FORM_RE =
  /学生\s*还是\s*社会人士\s*[？?：:]\s*(?:[（(][^（）()]*[）)])?\s*(社会人士?|社会人|社会|学生)(?=$|[\s，。；！？、])/u;
const CLAUSE_SPLIT_RE = /[\s，。！？；、,.!?;\n\r~～]+/u;

/** 识别单条消息文本中的身份自认，并返回可追溯证据；无明确自认返回 null。 */
export function matchIdentityEvidence(rawText: string): IdentityEvidence | null {
  const text = stripMessageDecorations(rawText);
  if (!text) return null;
  let statementText = text;
  const formMatch = FORM_LINE_RE.exec(text);
  if (formMatch) {
    const fromForm = classifyIdentityAnswerText(formMatch[1] ?? '');
    if (fromForm) return { identity: fromForm, source: 'form_answer', evidence: text };
    // 从后续自由文本扫描中移除未填写的“学生/社会人士”选项，避免分句后把选项本身
    // 当成候选人自述；消息里的其它明确自述（如“学历：本科在读”）仍继续识别。
    statementText = text.replace(formMatch[0], ' ');
  }
  const inlineIdentityMatch = INLINE_IDENTITY_FIELD_RE.exec(statementText);
  if (inlineIdentityMatch) {
    const fromInlineField = classifyIdentityAnswerText(inlineIdentityMatch[1] ?? '');
    if (fromInlineField) {
      return { identity: fromInlineField, source: 'form_answer', evidence: text };
    }
  }
  const studentStatusFormMatch = STUDENT_STATUS_FORM_RE.exec(text);
  if (studentStatusFormMatch) {
    const fromForm = classifyIdentityAnswerText(studentStatusFormMatch[1] ?? '');
    if (fromForm) return { identity: fromForm, source: 'form_answer', evidence: text };
  }
  const choiceFormMatch = CHOICE_FORM_RE.exec(statementText);
  if (choiceFormMatch) {
    return {
      identity: choiceFormMatch[1] === '学生' ? '学生' : '社会人士',
      source: 'form_answer',
      evidence: text,
    };
  }
  if (
    /我(?:现在)?是学生|(?:本科|大专|高中|硕士|研究生|博士)在读|目前(?:大学)?本科|我还在读|我在上学|算是学生|学生[^。！？\n]{0,12}(?:实习|还没毕业)/u.test(
      statementText,
    )
  ) {
    return { identity: '学生', source: 'direct', evidence: text };
  }
  if (
    /我是社会人士|身份(?:是|：|:)社会人士|我不是学生|我是非学生|我[^。！？\n]{0,8}(?:已经?|完全)?(?:本科|大专|专科|高中|硕士|研究生|博士)?毕业(?:了|啦)?|我已经?工作了|完全毕业了/u.test(
      statementText,
    )
  ) {
    return { identity: '社会人士', source: 'direct', evidence: text };
  }
  for (const clause of statementText.split(CLAUSE_SPLIT_RE)) {
    if (!clause) continue;
    if (STUDENT_CLAUSE_RE.test(clause)) {
      return { identity: '学生', source: 'direct', evidence: text };
    }
    if (SOCIAL_CLAUSE_RE.test(clause)) {
      return { identity: '社会人士', source: 'direct', evidence: text };
    }
    // 学历字段里的“高中毕业”不是身份自认；只接受独立的毕业陈述，且出现等待升学
    // 等反向线索时保持 unknown。
    if (
      SOCIAL_GRADUATION_CLAUSE_RE.test(clause) &&
      !/(?:等|等待|准备|马上|即将)[^。！？\n]{0,12}(?:大学|录取|通知书|开学|入学)/u.test(
        statementText,
      )
    ) {
      return { identity: '社会人士', source: 'direct', evidence: text };
    }
  }
  return null;
}

/** 兼容旧调用方：只读取结构化证据中的身份值。 */
export function matchIdentityStatement(rawText: string): CandidateIdentity | null {
  return matchIdentityEvidence(rawText)?.identity ?? null;
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

/** 识别“学生还是社会人士/已经工作”这类二选一问句；其后的短答案才可宽松解释。 */
export function isIdentityChoiceQuestion(rawText: string): boolean {
  const text = stripMessageDecorations(rawText);
  if (!text) return false;
  return /学生[^。！？\n]{0,12}(?:还是|或)[^。！？\n]{0,12}(?:社会人士|社会人|已经?工作|上班)|(?:社会人士|社会人|已经?工作|上班)[^。！？\n]{0,12}(?:还是|或)[^。！？\n]{0,12}学生/u.test(
    text,
  );
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
export function findLatestExplicitIdentityEvidence(messages: unknown[]): IdentityEvidence | null {
  let latest: IdentityEvidence | null = null;
  let pendingConfirm: CandidateIdentity | null = null;
  let pendingChoice = false;
  for (const [messageIndex, message] of messages.entries()) {
    const parsed = readMessageText(message);
    if (!parsed || !parsed.text) continue;
    if (parsed.role === 'assistant') {
      pendingConfirm = detectIdentityConfirmQuestion(parsed.text);
      pendingChoice = pendingConfirm === null && isIdentityChoiceQuestion(parsed.text);
      continue;
    }
    if (parsed.role !== 'user') continue;
    if (pendingChoice) {
      const compact = parsed.text.replace(/[呢哈哦呀啊！。～!.~\s]+$/gu, '').trim();
      const isShortChoiceAnswer =
        /^(?:学生|社会人士?|社会人|社会|工作|上班|已毕业|毕业了|不是学生|非学生)$/u.test(compact);
      const choiceIdentity = isShortChoiceAnswer ? classifyIdentityAnswerText(compact) : null;
      if (choiceIdentity) {
        latest = {
          identity: choiceIdentity,
          source: 'choice_answer',
          evidence: parsed.text,
          messageIndex,
        };
        pendingChoice = false;
        continue;
      }
    }
    const stated = matchIdentityEvidence(parsed.text);
    if (stated) {
      latest = { ...stated, messageIndex };
      pendingConfirm = null;
      pendingChoice = false;
      continue;
    }
    if (pendingConfirm) {
      const compact = parsed.text.replace(/[！。～!.~\s]+$/u, '');
      if (BARE_AFFIRMATION_RE.test(compact)) {
        latest = {
          identity: pendingConfirm,
          source: 'confirmation',
          evidence: parsed.text,
          messageIndex,
        };
        pendingConfirm = null;
        pendingChoice = false;
      } else if (BARE_NEGATION_RE.test(compact)) {
        pendingConfirm = null;
        pendingChoice = false;
      }
      // 非应答消息（debounce 合并的寒暄等）不清除悬挂问句，等后续消息继续判定。
    }
  }
  return latest;
}

/** 兼容旧调用方：只读取会话级结构化证据中的身份值。 */
export function findLatestExplicitIdentity(messages: unknown[]): CandidateIdentity | null {
  return findLatestExplicitIdentityEvidence(messages)?.identity ?? null;
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

// 明确承认表单/措辞填错，与“被拒后为了报名改口”语义不同。
const IDENTITY_CORRECTION_NOTICE_RE =
  /(?:填顺手了|(?:填|写|选|说)错了|误填(?:了)?|手滑(?:填|写|选)?错了?|刚才(?:填|写|选|说)错了)/u;

/** 判定一条 assistant 消息是否在告知候选人"该岗位不接受学生"。 */
export function detectStudentRejectionNotice(rawText: string): boolean {
  const text = stripMessageDecorations(rawText);
  if (!text) return false;
  return STUDENT_REJECTION_NOTICE_RE.test(text);
}

/** 判定候选人是否明确说明先前身份信息属于误填或口误。 */
export function detectIdentityCorrectionNotice(rawText: string): boolean {
  const text = stripMessageDecorations(rawText);
  if (!text) return false;
  return IDENTITY_CORRECTION_NOTICE_RE.test(text);
}

/**
 * 识别"学生自认 → 被拒 → 改口社会人士"序列并判断改口是否已核实。
 *
 * 产品裁定（2026-07-15）：被拒后的策略性首次改口不能直接采信——Agent 必须核实一次
 * （告知如实填写不影响推荐其它岗位），候选人在核实问句后再次明确确认，改口才生效。
 * 候选人明确说明先前是误填/口误（可与身份陈述分开发送）时，属于纠错而非策略性改口，
 * 后续清晰身份陈述直接生效。
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
  let correctionDeclared = false;
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
    if (rejected && detectIdentityCorrectionNotice(parsed.text)) {
      correctionDeclared = true;
    }
    const stated = matchIdentityStatement(parsed.text);
    if (stated === '学生') {
      // 候选人重新自认学生：改口链路重置（诚实方向，直接采信）。
      studentStated = true;
      rejected = false;
      flipped = false;
      verifyAsked = false;
      confirmed = false;
      correctionDeclared = false;
      continue;
    }
    if (stated === '社会人士' && rejected) {
      if (correctionDeclared) {
        flipped = true;
        confirmed = true;
        continue;
      }
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

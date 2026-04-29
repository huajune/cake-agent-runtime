/**
 * 岗位补充标签分类器
 *
 * 岗位后台（supplier/entryUser 契约中的 `customerLabelDefinitions`）里配的标签
 * 有两种语义：
 *
 *  1. **收集型（collect）** —— 需要候选人自由填写，例如"学历"、"一周能上几天班"、
 *     "每天几到几点可以上班"、"能干几个月"。
 *
 *  2. **筛选型（screening）** —— labelName 自身带约束语义（括号黑名单或反问式），
 *     本质是岗位硬条件，例如"是否学生（不要学生）"、"专业（非新媒、食品）"、
 *     "周四六日都能上班吗"。这类应当先独立核对是否满足，不合格直接停止收资。
 *
 * badcase `batch_69e9bba2536c9654026522da_*`：岗位 527385 的筛选型 label 被原样
 * 塞进 `bookingChecklist.templateText` 当收集项问候选人，候选人答"食品类"/"不
 * 一定"（两条硬伤），Agent 没识别直接提交 duliday_interview_booking 成功。
 *
 * 本模块把分类收敛到一个正则驱动的纯函数，供 precheck 的 templateText 分流、
 * booking 的 supplementAnswers 硬校验共用。
 */

/** 括号黑名单：匹配"（不要/非/不接受/不含/不做/不招 ...）"风格的约束描述。 */
const BLACKLIST_PAREN_REGEX = /[（(](?:不要|非|不接受|不含|不做|不招)([^）)]+)[)）]/u;

/** 反问式：以"吗"结尾的 label，如"周四六日都能上班吗"。 */
const RHETORICAL_REGEX = /吗[?？]?$/u;

/** 二元判定：以"是否"开头的 label，如"是否学生"。 */
const BINARY_PREFIX_REGEX = /^是否/u;

/**
 * 反问式/二元 label 通用的候选人否定表达。
 *
 * 设计取舍：故意不把单字"不"收进列表，避免"不用" / "不错" / "不用担心" 类短语误伤；
 * 精确组合词足以覆盖运营见过的所有 fail 案例。
 */
const NEGATIVE_ANSWER_SIGNALS: readonly string[] = [
  '不能',
  '不行',
  '不一定',
  '不可以',
  '不方便',
  '做不了',
  '去不了',
  '没法',
  '没办法',
  '保证不了',
  '不保证',
  '保证不能',
];

/** 黑名单括号内部按逗号/顿号/斜线/空格拆词。 */
const BLACKLIST_SPLIT_REGEX = /[，,、/\s]+/u;

export type SupplementClassification =
  | { type: 'collect'; labelName: string }
  | {
      type: 'screening';
      labelName: string;
      /** 筛选模式，仅用于排障/日志 */
      mode: 'blacklist' | 'rhetorical' | 'binary';
      /** 候选人答案命中任一即视为不合格（String.includes，大小写敏感不重要） */
      failSignals: readonly string[];
    };

/**
 * 对单个 supplement label 做分类。
 *
 * 规则优先级：黑名单括号 > 反问式 / 二元前缀 > 默认收集型。
 */
export function classifySupplementLabel(labelName: string): SupplementClassification {
  const normalized = labelName.trim();

  const blacklistMatch = BLACKLIST_PAREN_REGEX.exec(normalized);
  if (blacklistMatch) {
    const raw = blacklistMatch[1] ?? '';
    const failSignals = raw
      .split(BLACKLIST_SPLIT_REGEX)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (failSignals.length > 0) {
      return {
        type: 'screening',
        labelName,
        mode: 'blacklist',
        failSignals,
      };
    }
  }

  if (RHETORICAL_REGEX.test(normalized)) {
    return {
      type: 'screening',
      labelName,
      mode: 'rhetorical',
      failSignals: NEGATIVE_ANSWER_SIGNALS,
    };
  }

  if (BINARY_PREFIX_REGEX.test(normalized)) {
    // 二元前缀但括号里又没给黑名单关键词 —— 保守按否定词匹配。
    return {
      type: 'screening',
      labelName,
      mode: 'binary',
      failSignals: NEGATIVE_ANSWER_SIGNALS,
    };
  }

  return { type: 'collect', labelName };
}

/**
 * 判断候选人对某个 screening label 的回答是否命中不合格信号。
 *
 * 不做 trim 以外的归一化 —— 候选人原始文本中混入的空格/标点足以被
 * `String.includes` 覆盖绝大多数实际场景。
 */
export function matchesScreeningFailure(
  classification: Extract<SupplementClassification, { type: 'screening' }>,
  answer: string,
): string | null {
  const normalized = answer.trim();
  if (!normalized) return null;
  for (const signal of classification.failSignals) {
    if (!normalized.includes(signal)) continue;
    if (isLikelyHealthCertificateTypeAnswerForProfession(classification.labelName, normalized)) {
      continue;
    }
    return signal;
  }
  return null;
}

function isLikelyHealthCertificateTypeAnswerForProfession(
  labelName: string,
  answer: string,
): boolean {
  if (!/专业/.test(labelName) || !/健康证/.test(answer)) return false;
  return !/(专业|学的是|学的|读的是|读的|(?:食品|新媒).{0,4}专业)/.test(answer);
}

/**
 * 遍历候选人对 supplement label 的回答，找出命中岗位硬筛选 failSignal 的第一条。
 *
 * 这是"候选人是否满足岗位硬筛选"这件事的**唯一判定算法**，其他调用方（booking 的
 * 兜底闸门、precheck 后续扩展的预判等）都应复用它，不得各自实现同类逻辑。
 *
 * 契约：
 * - **纯函数**：无副作用，不接触 IO；
 * - 只检查被 `classifySupplementLabel` 识别为 `screening` 的 label，
 *   收集型字段（如"学历"、"一周能上几天班"）的答案由海绵后台二审决定，不在此判定；
 * - 命中一条就立即返回，不做全量聚合（调用方通常只需一条理由即可拒单）。
 */
export interface ScreeningFailure {
  label: string;
  answer: string;
  matched: string;
}

export function findScreeningFailure(
  supplementAnswers: Record<string, string> | undefined,
): ScreeningFailure | null {
  if (!supplementAnswers) return null;
  for (const [label, rawAnswer] of Object.entries(supplementAnswers)) {
    const answer = typeof rawAnswer === 'string' ? rawAnswer : String(rawAnswer ?? '');
    if (!answer.trim()) continue;
    const classification = classifySupplementLabel(label);
    if (classification.type !== 'screening') continue;
    const matched = matchesScreeningFailure(classification, answer);
    if (matched) {
      return { label, answer, matched };
    }
  }
  return null;
}

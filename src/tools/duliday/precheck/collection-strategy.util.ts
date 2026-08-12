/**
 * 候选人对话信号检测（抗收资 / 坚持真名）+ 收资策略推荐。
 *
 * 从 duliday-interview-precheck.tool.ts 拆出（Phase 1.A 机械搬运，0 逻辑改动）：
 * - extractMessageText / getRecentUserMessages：从 raw messages 抽出最近 N 条用户文本
 * - detectRealNameInsistence：候选人坚持"这就是真名"（少数民族真名场景）
 * - detectCollectionResistance：候选人对填资料有抗拒/不耐烦（"太麻烦/不想填"）
 * - buildCollectionStrategy：根据 missingFields + 抗拒信号决定 full_template vs progressive
 */

import { normalizePolicyText } from '@tools/utils/job-policy-parser';
import { API_BOOKING_USER_REQUIRED_FIELDS } from '@tools/duliday/booking/job-booking.contract';
import { normalizeChecklistField, orderFields } from '@tools/duliday/precheck/checklist.util';
import { dedupeStrings } from '@tools/duliday/precheck/field-normalize.util';
import { extractMessageText } from '@resolution/signal/markers';

export { extractMessageText } from '@resolution/signal/markers';

const COLLECTION_RESISTANCE_PATTERNS = [
  { label: '这么多信息', pattern: /这么多(信息|资料|内容|东西|问题)/ },
  { label: '问/填这么多', pattern: /(问|填|提供|发|写).{0,4}这么多/ },
  { label: '太麻烦', pattern: /(太|好)?麻烦(了)?/ },
  { label: '不想填', pattern: /不想(填|提供|发|写)/ },
  { label: '不填了', pattern: /不(填|发|给)了/ },
  { label: '懒得填', pattern: /懒得(填|发|写)/ },
  { label: '烦死了', pattern: /烦死了|烦得很/ },
  { label: '滚犊子', pattern: /滚犊子|滚蛋/ },
] as const;

export function getRecentUserMessages(messages: unknown[], limit = 3): string[] {
  const texts = messages
    .map((message) => {
      if (!message || typeof message !== 'object') return null;
      const record = message as Record<string, unknown>;
      if (record.role !== 'user') return null;
      const text = normalizePolicyText(extractMessageText(record.content));
      return text || null;
    })
    .filter((text): text is string => Boolean(text));

  return texts.slice(-limit);
}

/**
 * 候选人坚持"姓名就是真实姓名"的信号。
 *
 * 历史 badcase slg3jqi9：候选人本名"布买日也木"（少数民族 5 字真名），被
 * isStrictRealChineseName 的 2-4 字汉字白名单一律拒；候选人回复"这个就是真实姓名"
 * 坚持后，Agent 仍按 nameFieldGuard 反复要求改名，最终候选人无奈给"小布"小名才报上。
 *
 * 出现此信号时，nameFieldGuard 应升级到"必须转人工"模式，由招募经理人工补录长姓名。
 */
const REAL_NAME_INSISTENCE_PATTERNS: readonly RegExp[] = [
  /这(?:就|确实|的确)?是(?:我的)?(?:真|本)(?:名|实姓名)/,
  /(?:这|我)的全名(?:就|确实|的确)?是/,
  /真名(?:就|确实|的确)?是/,
  /(?:我|本人)就(?:叫|是)/,
  /没起过(?:中文|汉)名/,
  /身份证上(?:就|确实|的确)?是/,
  /(?:少数民族|藏族|维吾尔|蒙古|回族|彝族|哈萨克)/,
];

export function detectRealNameInsistence(messages: unknown[]): boolean {
  const recent = getRecentUserMessages(messages, 6);
  for (const msg of recent) {
    for (const pattern of REAL_NAME_INSISTENCE_PATTERNS) {
      if (pattern.test(msg)) return true;
    }
  }
  return false;
}

export function detectCollectionResistance(messages: unknown[]): {
  detected: boolean;
  matchedSignals: string[];
  latestUserMessage: string | null;
} {
  const recentUserMessages = getRecentUserMessages(messages);
  const latestUserMessage = recentUserMessages[recentUserMessages.length - 1] ?? null;

  if (!latestUserMessage) {
    return {
      detected: false,
      matchedSignals: [],
      latestUserMessage: null,
    };
  }

  const matchedSignals = dedupeStrings(
    recentUserMessages.flatMap((message) =>
      COLLECTION_RESISTANCE_PATTERNS.filter(({ pattern }) => pattern.test(message)).map(
        ({ label }) => label,
      ),
    ),
  );

  return {
    detected: matchedSignals.length > 0,
    matchedSignals,
    latestUserMessage,
  };
}

const JOB_DETAIL_FOLLOWUP_PATTERNS: readonly RegExp[] = [
  /(?:工作内容|主要做什么|具体做什么|是做什么|干什么|干啥)/u,
  /(?:休息多久|休息多长|休息时间|一天几小时|上多久|工时|班次|几点上班|几点下班)/u,
  /(?:有饭|吃饭|员工餐|包吃|餐补|住宿|包住|福利)/u,
  /(?:工资|薪资|时薪|多少钱|结算|日结|周结|月结|发薪)/u,
  /(?:地址|位置|在哪里|在哪儿|多远|距离|通勤)/u,
  /(?:面试方式|怎么面试|面试流程)/u,
];

export interface PendingCollectionJobDetailFollowup {
  missingFields: string[];
  reminder: string;
  latestUserMessage: string;
}

/** collectedFields（本轮原话确定性解析）键 → 收资模板字段标签。 */
const COLLECTED_FIELD_KEY_TO_LABEL: Readonly<Record<string, string>> = {
  name: '姓名',
  phone: '联系电话',
  gender: '性别',
  age: '年龄',
  education: '学历',
  healthCert: '健康证情况',
  householdProvince: '户籍省份',
  height: '身高',
  weight: '体重',
};

/** sessionFacts.interview_info 键 → 收资模板字段标签。 */
const SESSION_INFO_KEY_TO_LABEL: Readonly<Record<string, string>> = {
  name: '姓名',
  phone: '联系电话',
  gender: '性别',
  age: '年龄',
  education: '学历',
  has_health_certificate: '健康证情况',
  household_register_province: '户籍省份',
  height: '身高',
  weight: '体重',
  is_student: '身份',
  experience: '过往公司+岗位+年限',
};

function unwrapValue(value: unknown): unknown {
  if (value && typeof value === 'object' && 'value' in value) {
    return (value as { value?: unknown }).value;
  }
  return value;
}

/**
 * 从本轮确定性解析结果 + 会话事实推导「已提供字段」标签集，供催填缺口扣减
 * （PR #1000 评审 P2-6）：缺口不能只从上次模板空行推导——模板发出后（含本轮
 * 触发消息）候选人已回填的字段再催一遍即重复收资。
 */
export function buildProvidedFieldLabels(params: {
  collectedFields?: Readonly<Record<string, unknown>> | null;
  sessionInterviewInfo?: Readonly<Record<string, unknown>> | null;
}): Set<string> {
  const labels = new Set<string>();
  for (const [key, field] of Object.entries(params.collectedFields ?? {})) {
    const label = COLLECTED_FIELD_KEY_TO_LABEL[key];
    if (label && field != null && unwrapValue(field) != null) labels.add(label);
  }
  for (const [key, label] of Object.entries(SESSION_INFO_KEY_TO_LABEL)) {
    const value = unwrapValue(params.sessionInterviewInfo?.[key]);
    if (value !== null && value !== undefined && String(value).trim() !== '') labels.add(label);
  }
  return labels;
}

/**
 * 候选人收到收资表后插问岗位细节：识别最近一张表里的空项，给 job-list 成功结果
 * 追加“答完只催缺口”的结构化指令。它只解析 assistant 已发出的字段行，不臆测
 * supplier 要求，也不把预填值当缺失；`providedFieldLabels` 里已提供的字段从缺口
 * 中扣减，全部补齐则不再催。
 */
export function detectPendingCollectionJobDetailFollowup(
  messages: unknown[],
  providedFieldLabels?: ReadonlySet<string>,
): PendingCollectionJobDetailFollowup | null {
  const parsed = messages
    .map((message) => {
      if (!message || typeof message !== 'object') return null;
      const record = message as Record<string, unknown>;
      const text = normalizePolicyText(extractMessageText(record.content));
      return text ? { role: record.role, text } : null;
    })
    .filter((message): message is { role: unknown; text: string } => Boolean(message));

  let latestUserIndex = -1;
  for (let index = parsed.length - 1; index >= 0; index -= 1) {
    if (parsed[index].role !== 'user') continue;
    latestUserIndex = index;
    break;
  }
  if (latestUserIndex < 0) return null;
  const latestUserMessage = parsed[latestUserIndex].text;
  if (!JOB_DETAIL_FOLLOWUP_PATTERNS.some((pattern) => pattern.test(latestUserMessage))) return null;

  const recentBeforeCurrent = parsed.slice(Math.max(0, latestUserIndex - 6), latestUserIndex);
  for (let index = recentBeforeCurrent.length - 1; index >= 0; index -= 1) {
    const message = recentBeforeCurrent[index];
    if (message.role !== 'assistant') continue;
    const templateMissingFields = extractMissingFieldsFromSentTemplate(message.text);
    if (templateMissingFields.length < 2) continue;
    // 模板发出后（含本轮触发消息）已提供的字段从缺口扣减；全补齐则无缺口可催。
    const missingFields = templateMissingFields.filter((field) => !providedFieldLabels?.has(field));
    if (missingFields.length === 0) return null;
    return {
      missingFields,
      reminder: formatMissingFieldReminder(missingFields),
      latestUserMessage,
    };
  }
  return null;
}

function extractMissingFieldsFromSentTemplate(text: string): string[] {
  const fields: string[] = [];
  for (const line of text.split(/\r?\n/u)) {
    const match = line.match(/^\s*(?:[-•]\s*)?([^：:\n]{1,48})\s*[：:]\s*(.*?)\s*$/u);
    if (!match) continue;
    const label = normalizeChecklistField(match[1]);
    const value = match[2].trim();
    if (!label || isCollectionTemplateHeader(label) || !isCollectionPlaceholder(value)) continue;
    fields.push(label);
  }
  return dedupeStrings(fields);
}

function isCollectionTemplateHeader(label: string): boolean {
  return /(?:面试要求|资料|清单|补充下列|帮你约)/u.test(label);
}

function isCollectionPlaceholder(value: string): boolean {
  if (!value) return true;
  const compact = value.replace(/\s+/gu, '');
  return /^(?:有[\/／]无|接受[\/／]不接受|学生[\/／]社会人士|男[\/／]女)$/u.test(compact);
}

function formatMissingFieldReminder(fields: readonly string[]): string {
  if (fields.length === 1) return `还差${fields[0]}一项哈`;
  if (fields.length === 2) return `还差${fields.join('、')}两项哈`;
  return `还差${fields.join('、')}这${fields.length}项哈`;
}

export function buildCollectionStrategy(params: {
  missingFields: string[];
  resistanceSignals: string[];
}): {
  candidateResistanceDetected: boolean;
  recommendedMode: 'full_template' | 'progressive';
  reason: string;
  starterFields: string[];
  remainingFields: string[];
} {
  const orderedMissingFields = orderFields(params.missingFields);
  const coreMissingFields = orderFields(
    orderedMissingFields.filter((field) =>
      (API_BOOKING_USER_REQUIRED_FIELDS as readonly string[]).includes(field),
    ),
  );
  const starterFields =
    coreMissingFields.length > 0
      ? coreMissingFields
      : orderedMissingFields.slice(0, Math.min(2, orderedMissingFields.length));
  const remainingFields = orderedMissingFields.filter((field) => !starterFields.includes(field));
  const candidateResistanceDetected = params.resistanceSignals.length > 0;

  return {
    candidateResistanceDetected,
    recommendedMode: candidateResistanceDetected ? 'progressive' : 'full_template',
    reason: candidateResistanceDetected
      ? `候选人当前对收资有抗拒或不耐烦信号（${params.resistanceSignals.join('、')}），先共情解释，再从 starterFields 开始逐步收集`
      : '候选人当前没有明显收资阻力，正常场景可直接参考 templateText 一次性收集当前岗位需要的信息',
    starterFields,
    remainingFields,
  };
}

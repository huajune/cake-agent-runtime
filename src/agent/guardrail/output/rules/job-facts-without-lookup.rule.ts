import type { AgentToolCall } from '@shared-types/agent-telemetry.types';
import { GUARDRAIL_ACTION } from '@shared-types/guardrail.contract';
import type { RuleContradiction } from '../output-rule.types';

/**
 * 无出处的量化岗位事实或正向经验门槛编造。
 *
 * 与 `settlement_no_evidence_assertion` 互补，两者合起来覆盖"无出处岗位事实"的两半：
 * - 那条管「**查过**岗但全部查无，仍断言结算/发薪」；
 * - 本条管「**根本没查**岗，却投递门店名、距离、时薪、班次、发薪日、年龄段」，
 *   以及「工具虽成功但没有经验字段，仍断言岗位不要求经验/接受新手」。
 *
 * 2026-07-30 生产实证（07-31 扫描日报置顶红标）：当日 10 个回合 / 8 个会话，
 * `tool_calls` 为 `[]` 或只含阶段跃迁/图片描述等非岗位工具，本轮完全没有调用
 * `duliday_job_list`，模型却投递了整套量化细节——"必胜客保利大都汇，日结当天发薪" +
 * 三个班次时段（`6a66fb44` 17:57）、"奥乐齐银都店离你大概 8.9 公里"（`6a6ae281` 20:04）、
 * "金光汇店 12:00-15:00／基础 24 元时／要求 40-50 岁"（`6a1e42ce` 19:04）等。
 * 语义层判了 8 条 block，但语义层是 shadow，拦不住投递。该形态确定性可判，不吃 LLM 预算。
 *
 * ⚠️ 假阳防线是本规则的全部难点：Agent **正常且高频**地在后续轮次复述上一轮已展示的
 * 岗位（候选人追问"那家几点上班"时不会重新查岗）。因此判定不是"本轮没查岗就拦"，
 * 而是**逐个事实做出处核验**：某个具体数值只有在「本轮所有工具结果」与「助手侧历史
 * 文本」里都找不到时，才算凭空捏造。任一处能对上就放行。
 */

/** 量化岗位事实的取值形态。捕获整段用于出处比对，不做语义解析。 */
const JOB_FACT_EXTRACTORS: ReadonlyArray<{ kind: string; pattern: RegExp }> = [
  { kind: '距离', pattern: /\d+(?:\.\d+)?\s*(?:公里|km|KM|千米)/gu },
  { kind: '薪资', pattern: /\d+(?:\.\d+)?\s*元\s*\/\s*(?:小时|小?时|天|月)/gu },
  {
    kind: '班次',
    pattern: /\d{1,2}\s*[:：]\s*\d{2}\s*[-—~～至]\s*(?:次日\s*)?\d{1,2}\s*[:：]\s*\d{2}/gu,
  },
  { kind: '发薪日', pattern: /\d{1,2}\s*号\s*(?:发薪|发工资|结算)/gu },
  { kind: '年龄段', pattern: /\d{2}\s*[-—~～至]\s*\d{2}\s*岁/gu },
];

/** 无岗位证据时同样不可凭通识补齐的定性经验门槛。 */
const OPEN_EXPERIENCE_PATTERN =
  /(?:不(?:需要|要求|强制(?:要求)?)[^。！？\n]{0,6}经验|无需[^。！？\n]{0,6}经验|对经验没(?:有)?要求|(?:经验不限|不限经验)|接受(?:新手|零经验|无经验)|(?:新手|零基础|没(?:有)?干过|没(?:有)?做过|无经验)(?:也)?(?:能|可以|可)(?:做|报名|应聘)?)/gu;

const OPEN_EXPERIENCE_UNCERTAINTY_PREFIX_PATTERN =
  /(?:(?:如果|若|要是|是否|不(?:能|好|得|要|该)?(?:确认|说|声称|承诺)|无法确认|不确定|没(?:有)?(?:查到|写|说明|标注|明确)|未(?:查到|明确|写|说明|标注)|不要|别|禁止|严禁|不得)[^，,；;。！？\n]{0,24}|不\s*)$/u;
const OPEN_EXPERIENCE_UNCERTAINTY_SUFFIX_PATTERN =
  /^[^，,；;。！？\n]{0,16}(?:吗|么|尚未明确|还没(?:有)?查到|无法确认|不确定)/u;

interface OpenExperienceAssertion {
  start: number;
  text: string;
}

function extractOpenExperienceAssertions(sentence: string): OpenExperienceAssertion[] {
  const assertions: OpenExperienceAssertion[] = [];
  for (const match of sentence.matchAll(OPEN_EXPERIENCE_PATTERN)) {
    const start = match.index ?? 0;
    const prefix = sentence.slice(Math.max(0, start - 32), start);
    const suffix = sentence.slice(start + match[0].length, start + match[0].length + 20);
    if (OPEN_EXPERIENCE_UNCERTAINTY_PREFIX_PATTERN.test(prefix)) continue;
    if (OPEN_EXPERIENCE_UNCERTAINTY_SUFFIX_PATTERN.test(suffix)) continue;
    assertions.push({ start, text: match[0] });
  }
  return assertions;
}

function assertsOpenExperience(sentence: string): boolean {
  return extractOpenExperienceAssertions(sentence).length > 0;
}

const STORE_SCOPE_PATTERN =
  /([\p{Script=Han}A-Za-z0-9·（）()_-]{1,24}店)[^，,；;。！？\n]{0,8}[，,]?\s*$/u;
const GENERIC_STORE_SCOPES = new Set(['这家店', '该店', '门店']);

function extractExperienceStoreScope(
  sentence: string,
  assertionStart: number,
  knownStoreNames: readonly string[],
): string | null {
  const prefix = sentence.slice(Math.max(0, assertionStart - 80), assertionStart);
  const knownScope = knownStoreNames
    .map((storeName) => {
      const index = prefix.lastIndexOf(storeName);
      return { storeName, index, end: index + storeName.length };
    })
    .filter(({ index }) => index >= 0)
    // 取离断言最近的门店；同一结束位置时优先完整长店名，避免短后缀抢占。
    .sort((a, b) => b.end - a.end || b.storeName.length - a.storeName.length)[0]?.storeName;
  if (knownScope) return knownScope;

  const match = prefix.match(STORE_SCOPE_PATTERN);
  const scope = match?.[1]?.trim();
  return scope && !GENERIC_STORE_SCOPES.has(scope) ? scope : null;
}

function splitEvidenceSegments(text: string): string[] {
  // `duliday_job_list` 的生产 markdown 把一个岗位的门店、经验与 jobId 分散在多行；
  // 按行切会丢掉三者的关联。先按 `## N.` 岗位标题分块，每块作为一个证据单元。
  if (/^##\s+\d+\.\s+/mu.test(text)) {
    return text
      .split(/(?=^##\s+\d+\.\s+)/mu)
      .map((segment) => segment.trim())
      .filter(Boolean);
  }

  return text
    .split(/[。！？!?\n；;]+/u)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function collectStructuredEvidenceSegments(value: unknown, seen = new WeakSet<object>()): string[] {
  if (typeof value === 'string') return splitEvidenceSegments(value);
  if (!value || typeof value !== 'object') return [];
  if (seen.has(value)) return [];
  seen.add(value);

  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      // rawData 的每个数组元素通常就是一个完整岗位。保留整项，避免把 basicInfo、
      // hiringRequirement 与 jobId 递归拆散；不可序列化时再退回递归采集。
      if (item && typeof item === 'object') {
        try {
          return [JSON.stringify(item)];
        } catch {
          return collectStructuredEvidenceSegments(item, seen);
        }
      }
      return collectStructuredEvidenceSegments(item, seen);
    });
  }

  const scalarRecord: Record<string, unknown> = {};
  const segments: string[] = [];
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (item && typeof item === 'object') {
      segments.push(...collectStructuredEvidenceSegments(item, seen));
      continue;
    }
    if (typeof item === 'string' && /[\n；;]/u.test(item)) {
      segments.push(...splitEvidenceSegments(item));
      continue;
    }
    scalarRecord[key] = item;
  }
  if (Object.keys(scalarRecord).length > 0) {
    try {
      segments.push(JSON.stringify(scalarRecord));
    } catch {
      // 标量字段不可序列化时只跳过这一层，子对象证据仍保留。
    }
  }
  return segments;
}

function segmentMatchesJobId(segment: string, jobId: number): boolean {
  const withoutMarkdownEmphasis = segment.replace(/[*_`]/gu, '');
  return new RegExp(`["']?jobId["']?\\s*[:：=]\\s*["']?${jobId}(?!\\d)`, 'u').test(
    withoutMarkdownEmphasis,
  );
}

function extractEvidenceStoreNames(segment: string): string[] {
  const names = new Set<string>();
  for (const match of segment.matchAll(/"storeName"\s*:\s*"([^"]+)"/gu)) {
    if (match[1]?.trim()) names.add(match[1].trim());
  }
  for (const match of segment.matchAll(/\*\*门店\*\*\s*[:：]\s*([^\n]+)/gu)) {
    const name = match[1]?.replace(/\s*[（(](?:ID|id)\s*[:：][^）)]*[）)]\s*$/u, '').trim();
    if (name) names.add(name);
  }
  return [...names];
}

interface OpenExperienceEvidence {
  allSegments: string[];
  focusedSegments: string[];
  knownStoreNames: string[];
  multiJobSupportWithoutFocus: boolean | null;
}

function extractEvidenceJobIds(segment: string): number[] {
  const normalized = segment.replace(/[*_`]/gu, '');
  return [...normalized.matchAll(/["']?jobId["']?\s*[:：=]\s*["']?(\d+)/gu)]
    .map((match) => Number(match[1]))
    .filter((jobId) => Number.isFinite(jobId));
}

function evaluateMultiJobOpenExperienceSupport(segments: readonly string[]): boolean | null {
  const jobIds = [...new Set(segments.flatMap(extractEvidenceJobIds))];
  if (jobIds.length > 1) {
    return jobIds.every((jobId) =>
      segments.some(
        (segment) => segmentMatchesJobId(segment, jobId) && assertsOpenExperience(segment),
      ),
    );
  }

  const storeNames = [...new Set(segments.flatMap(extractEvidenceStoreNames))];
  if (storeNames.length > 1) {
    return storeNames.every((storeName) =>
      segments.some((segment) => segment.includes(storeName) && assertsOpenExperience(segment)),
    );
  }
  return null;
}

function collectReturnedJobEvidenceSegments(result: unknown): string[] {
  if (typeof result === 'string') return splitEvidenceSegments(result);
  if (!result || typeof result !== 'object' || Array.isArray(result)) return [];

  const record = result as Record<string, unknown>;
  const segments: string[] = [];
  if (typeof record.markdown === 'string') {
    segments.push(...splitEvidenceSegments(record.markdown));
  }

  const rawData = record.rawData;
  if (Array.isArray(rawData)) {
    segments.push(...collectStructuredEvidenceSegments(rawData));
  } else if (rawData && typeof rawData === 'object') {
    const rows = (rawData as Record<string, unknown>).result;
    if (Array.isArray(rows)) {
      segments.push(...collectStructuredEvidenceSegments(rows));
    }
  }
  return segments;
}

function collectOpenExperienceEvidence(
  toolCalls: readonly AgentToolCall[],
  assistantHistoryEvidence: string,
  currentFocusJobId?: number,
): OpenExperienceEvidence {
  const allToolSegments: string[] = [];
  const focusedToolSegments: string[] = [];
  for (const call of toolCalls) {
    if (call.status === 'error') continue;
    // job_list 的 queryMeta/excludedExamples 是“被过滤掉的岗位”，不能作为已返回岗位证据；
    // 这里只采对模型可见的 markdown 岗位块或 rawData.result 行。
    const segments =
      call.toolName === 'duliday_job_list'
        ? collectReturnedJobEvidenceSegments(call.result)
        : collectStructuredEvidenceSegments(call.result);
    allToolSegments.push(...segments);
    if (!currentFocusJobId) {
      focusedToolSegments.push(...segments);
      continue;
    }

    const argJobId = Number(call.args?.jobId);
    const argJobIds = Array.isArray(call.args?.jobIdList)
      ? call.args.jobIdList.map((id) => Number(id))
      : [];
    const callIsFocused = argJobId === currentFocusJobId || argJobIds.includes(currentFocusJobId);
    const focusedSegments = segments.filter((segment) =>
      segmentMatchesJobId(segment, currentFocusJobId),
    );
    focusedToolSegments.push(
      ...(focusedSegments.length > 0 || !callIsFocused ? focusedSegments : segments),
    );
  }

  const historySegments = splitEvidenceSegments(assistantHistoryEvidence);
  const allSegments = [...allToolSegments, ...historySegments];
  const focusedStoreNames = [...new Set(focusedToolSegments.flatMap(extractEvidenceStoreNames))];
  const focusedHistorySegments = currentFocusJobId
    ? historySegments.filter(
        (segment) =>
          segmentMatchesJobId(segment, currentFocusJobId) ||
          focusedStoreNames.some((storeName) => segment.includes(storeName)),
      )
    : historySegments;
  return {
    allSegments,
    focusedSegments: [...focusedToolSegments, ...focusedHistorySegments],
    knownStoreNames: [...new Set(allSegments.flatMap(extractEvidenceStoreNames))],
    multiJobSupportWithoutFocus: evaluateMultiJobOpenExperienceSupport(allToolSegments),
  };
}

function hasGroundedOpenExperienceEvidence(
  evidenceSegments: readonly string[],
  storeScope: string | null,
): boolean {
  return evidenceSegments.some((segment) => {
    if (storeScope && !segment.includes(storeScope)) return false;
    return assertsOpenExperience(segment);
  });
}

/**
 * 归一化：剥掉空白与全半角差异后再比对出处。
 *
 * 工具 markdown 写 `24 元/小时`、回复写 `24元/时` 是同一事实，不能因为排版差异判成编造。
 * 因此比对的是"数字 + 关键字"的骨架，而不是原始子串。
 */
function normalizeFact(raw: string): string {
  return raw
    .replace(/\s+/gu, '')
    .replace(/[：]/gu, ':')
    .replace(/[—~～至]/gu, '-')
    .replace(/小时/gu, '时')
    .replace(/千米|KM|km/gu, '公里')
    .replace(/发工资|结算/gu, '发薪');
}

/** 本轮所有工具结果的全文（不限 duliday_job_list：precheck/booking/位置分享等同样是合法出处）。 */
function readToolEvidenceText(toolCalls: readonly AgentToolCall[]): string {
  const parts: string[] = [];
  for (const call of toolCalls) {
    if (!call?.result) continue;
    try {
      parts.push(typeof call.result === 'string' ? call.result : JSON.stringify(call.result));
    } catch {
      // 结果不可序列化时跳过：宁可放行，不因为取不到出处而误判编造。
      continue;
    }
  }
  return parts.join('\n');
}

/** 助手侧历史文本。候选人自己说的数字不构成出处——他可能在转述别处看到的岗位。 */
function readAssistantHistoryText(recentMessages: readonly unknown[]): string {
  const parts: string[] = [];
  for (const message of recentMessages) {
    if (!message || typeof message !== 'object') continue;
    const record = message as { role?: unknown; content?: unknown };
    if (record.role !== 'assistant' || typeof record.content !== 'string') continue;
    parts.push(record.content);
  }
  return parts.join('\n');
}

/**
 * 面试/报名语境：该句里的时间段是**面试时段**，不是岗位班次。
 *
 * 「已帮你约好周四的面试，13:30-16:30 之间到就行」形态上与班次完全一样，但出处是
 * booking/precheck 而非岗位数据，且约面回执类问题由 booking_receipt_mismatch 治理。
 * 不做这个区分会把整条约面链路全判成编造——这是本规则最大的假阳来源。
 */
const INTERVIEW_CONTEXT_PATTERN = /面试|约|预约|报名|到店|来店/u;

/** 按句切分，用于逐句判定语境。 */
function splitSentences(text: string): string[] {
  return text
    .split(/[。！？!?\n；;]+/u)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 本轮是否拿到过可用岗位数据（仅用于量化事实，与 settlement_no_evidence_assertion 同口径）。 */
function hasProductiveJobLookup(toolCalls: readonly AgentToolCall[]): boolean {
  return toolCalls.some((call) => {
    if (call?.toolName !== 'duliday_job_list') return false;
    if (call.status === 'error' || !call.result) return false;
    const result = call.result as Record<string, unknown>;
    return typeof result.markdown === 'string' || Boolean(result.rawData);
  });
}

/**
 * 检出无出处岗位事实。
 *
 * 触发条件（三者同时成立）：
 * - 量化事实：本轮没有 `duliday_job_list` 可用结果，且数值在工具/助手历史里无出处；
 * - 正向经验门槛：无论是否拿到其它岗位字段，都必须在成功工具结果或助手历史里找到
 *   明确的“不要求经验/接受新手”正向证据；疑问、否定、条件和错误结果均不算证据。
 *
 * 快环确定性动作：纯文本比对，无 LLM 参与。
 */
export function detectJobFactsWithoutLookup(
  replyText: string,
  toolCalls: readonly AgentToolCall[],
  recentMessages: readonly unknown[] = [],
  currentFocusJobId?: number,
): RuleContradiction | null {
  if (!replyText) return null;

  const assistantHistoryEvidence = readAssistantHistoryText(recentMessages);
  const rawEvidence = `${readToolEvidenceText(toolCalls)}\n${assistantHistoryEvidence}`;
  const openExperienceEvidence = collectOpenExperienceEvidence(
    toolCalls,
    assistantHistoryEvidence,
    currentFocusJobId,
  );
  const hasJobLookupEvidence = hasProductiveJobLookup(toolCalls);
  const evidence = normalizeFact(rawEvidence);

  for (const sentence of splitSentences(replyText)) {
    for (const assertion of extractOpenExperienceAssertions(sentence)) {
      const storeScope = extractExperienceStoreScope(
        sentence,
        assertion.start,
        openExperienceEvidence.knownStoreNames,
      );
      // 显式点名门店时应在全部成功岗位块里按店对齐；泛指“这家”时才跟随
      // currentFocusJobId，避免当前焦点 B 把用户明确追问的 A 店证据过滤掉。
      const evidenceSegments = storeScope
        ? openExperienceEvidence.allSegments
        : !currentFocusJobId && openExperienceEvidence.multiJobSupportWithoutFocus === false
          ? []
          : openExperienceEvidence.focusedSegments;
      if (!hasGroundedOpenExperienceEvidence(evidenceSegments, storeScope)) {
        return {
          ruleId: 'job_facts_without_any_lookup',
          label:
            `回复断言${storeScope ? `${storeScope}的` : '岗位'}“${assertion.text}”，但本轮成功工具结果与往轮助手消息里` +
            '没有同一岗位的明确正向经验门槛出处，属凭空生成的岗位事实',
          action: GUARDRAIL_ACTION.REVISE,
        };
      }
    }

    if (hasJobLookupEvidence) continue;

    const isInterviewContext = INTERVIEW_CONTEXT_PATTERN.test(sentence);
    for (const { kind, pattern } of JOB_FACT_EXTRACTORS) {
      // 面试语境里的时间段是面试时段而非班次，出处在 booking/precheck，不归本规则管。
      if (kind === '班次' && isInterviewContext) continue;
      for (const match of sentence.matchAll(pattern)) {
        const fact = normalizeFact(match[0]);
        if (!fact || evidence.includes(fact)) continue;
        return {
          ruleId: 'job_facts_without_any_lookup',
          label:
            `本轮没有任何一次岗位查询拿到数据，回复却给出${kind}“${match[0].trim()}”` +
            '——该数值在本轮工具结果与往轮助手消息里都没有出处，属凭空生成的岗位事实',
          action: GUARDRAIL_ACTION.REVISE,
        };
      }
    }
  }
  return null;
}

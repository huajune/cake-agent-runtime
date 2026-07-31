import type { AgentToolCall } from '@shared-types/agent-telemetry.types';
import { GUARDRAIL_ACTION } from '@shared-types/guardrail.contract';
import type { RuleContradiction } from '../output-rule.types';

/**
 * 零查岗轮的量化岗位事实编造。
 *
 * 与 `settlement_no_evidence_assertion` 互补，两者合起来覆盖"无出处岗位事实"的两半：
 * - 那条管「**查过**岗但全部查无，仍断言结算/发薪」；
 * - 本条管「**根本没查**岗，却投递门店名、距离、时薪、班次、发薪日、年龄段」。
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

/** 本轮是否拿到过可用岗位数据（与 settlement_no_evidence_assertion 同口径）。 */
function hasProductiveJobLookup(toolCalls: readonly AgentToolCall[]): boolean {
  return toolCalls.some((call) => {
    if (call?.toolName !== 'duliday_job_list') return false;
    if (call.status === 'error' || !call.result) return false;
    const result = call.result as Record<string, unknown>;
    return typeof result.markdown === 'string' || Boolean(result.rawData);
  });
}

/**
 * 检出零查岗轮的无出处量化岗位事实。
 *
 * 触发条件（三者同时成立）：
 * 1. 本轮没有任何一次 `duliday_job_list` 拿到可用岗位数据（含一次都没调用）；
 * 2. 回复里出现量化岗位事实；
 * 3. 该事实在本轮工具结果与助手历史里都查不到出处。
 *
 * 快环确定性动作：纯文本比对，无 LLM 参与。
 */
export function detectJobFactsWithoutLookup(
  replyText: string,
  toolCalls: readonly AgentToolCall[],
  recentMessages: readonly unknown[] = [],
): RuleContradiction | null {
  if (!replyText) return null;
  if (hasProductiveJobLookup(toolCalls)) return null;

  const evidence = normalizeFact(
    `${readToolEvidenceText(toolCalls)}\n${readAssistantHistoryText(recentMessages)}`,
  );

  for (const sentence of splitSentences(replyText)) {
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

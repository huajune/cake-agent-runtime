import { GUARDRAIL_ACTION } from '@shared-types/guardrail.contract';
import type { RuleContradiction } from '../output-rule.types';

/**
 * Agent 回复输出泄漏检测。
 *
 * 业务背景：badcase `vllg7hlu` 中，模型直接给候选人发送了 `阶段已切换到 job_consultation，
 * 等待候选人回复年龄信息。`，把内部程序记忆术语暴露给用户。Prompt 已写过
 * "严禁暴露阶段切换"，但模型偶尔违反，必须在出站 guardrail 做确定性兜底。
 *
 * 职责：
 * - 管阶段名、工具名、内部策略字段、JSON/代码块等“实现细节被发给候选人”的问题；
 * - 这些内容不依赖业务工具是否成功，只要出现在最终 reply 就应拦截；
 * - 命中后 block，因为用户看到内部状态会破坏产品可信度，也可能泄露策略。
 *
 * 不负责：
 * - 不管候选人是否问到了业务事实；
 * - 不管岗位/预约/位置的事实正确性，那些由其它领域规则对账。
 *
 * 维护边界：
 * - 新增阶段字段、工具名、内部 prompt 字段时，应同步补 STAGE_TERMS 或 TOOL_NAMES；
 * - 如果某个工具名未来变成候选人可见品牌词，需要先在产品口径里明确，再从这里移除。
 */

const STAGE_TERMS = [
  '阶段已切换',
  '阶段切换到',
  '阶段推进到',
  '当前阶段策略',
  '阶段成功标准',
  'effectiveStageStrategy',
  'nextStage',
  'currentStage',
  'fromStage',
  'disallowedActions',
  'successCriteria',
  'primaryGoal',
] as const;

const TOOL_NAMES = [
  'advance_stage',
  'duliday_job_list',
  'duliday_interview_precheck',
  'duliday_interview_booking',
  'invite_to_group',
  'request_handoff',
  'skip_reply',
  'raise_risk_alert',
  'geocode',
  'recall_history',
  'save_image_description',
  'send_store_location',
] as const;

const PATTERNS: RegExp[] = [
  // 模型把阶段术语 / 内部状态字段直接说出来
  new RegExp(STAGE_TERMS.map(escapeRegex).join('|')),
  // 阶段流转状态回声（例如“已切换到岗位咨询阶段，等待候选人反馈意向”）
  /已切换到[^。！？\n]{0,30}阶段[，,。；;\s]*(?:现在)?等待候选人(?:反馈|回应|回复|确认)[^。！？\n]{0,30}/,
  // 等待候选人补 X 信息（典型阶段切换回声）
  /等待候选人(?:反馈|回应|回复|提供|补充|确认)\S*(?:信息|意向|选择|结果)/,
  // 工具链结束后把“已经对候选人完成动作”的内部状态当成回复
  /(?:已发送岗位推荐|已给出岗位信息|岗位推荐已发送)[，,。；;\s]*(?:现在)?等待候选人(?:回应|回复|确认)/,
  // 内部评审/阶段达成话术不应发给候选人
  /✅\s*对话已完成/,
  /符合.{0,8}阶段要求/,
  /^[✅❌]\s*[^。！？\n]{0,50}(?:完成|符合|通过|失败|不符合|阶段|要求)/m,
  /【工具调用结果】/,
  // 工具调用回显
  new RegExp(`(?:调用|call|invoke)\\s*(?:${TOOL_NAMES.map(escapeRegex).join('|')})`, 'i'),
  // 工具名标识符出现在候选人可见文本的任何位置都属于泄漏（覆盖 `[duliday_job_list]`、
  // `["geocode", {...}]`、`{"name":"geocode",...}` 等一切携带已注册工具名的形态。
  // 上线首日 badcase：repair 以 toolMode:'none' 重写时模型把工具调用写成文本，
  // 3 条 JSON 原文穿透旧词库发给了候选人（06:14/06:40/06:41 三单）
  new RegExp(`\\b(?:${TOOL_NAMES.map(escapeRegex).join('|')})\\b`),
  // 工具调用 JSON 骨架（未注册工具名/MCP 动态工具也能兜住）
  /<\/?tool_call>/i,
  /["']name["']\s*:\s*["'][\w-]+["']\s*,\s*["']arguments["']\s*:/,
  /["']arguments["']\s*:\s*\{/,
  // 整条回复以 JSON 开头（`{"`、`[{`、`["`）——自然语言回复不存在这种开头
  /^\s*(?:\[\s*)?\{\s*["']/,
  /^\s*\[\s*["']/,
  // 工具结果 JSON 残片直接外抛（{"success":true,...}）
  /["']success["']\s*:\s*(?:true|false)/,
  // 代码块（Agent 不应该给候选人发 markdown code fence）
  /^```/m,
];

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 返回命中的 pattern，方便告警里展示具体泄漏形态。
 * 这里不返回 RuleContradiction，是为了让 hard-rules.service 统一决定 action 和告警格式。
 */
export function detectOutputLeak(content: string): RegExp | null {
  if (!content) return null;
  for (const pattern of PATTERNS) {
    if (pattern.test(content)) return pattern;
  }
  return null;
}

/**
 * 剥掉 markdown 代码围栏标记（```` ```lang ````），围栏内的正文原样保留。
 *
 * 业务背景：2026-07-21 生产 badcase——首版用 ```text 围栏包了一张逐项填写的报名表模板，
 * 仅因围栏命中本规则进了 LLM 重写，重写把整张模板压成一句话流水账。围栏是本词库里
 * 唯一"删掉标记即完整修复"的形态，runner 对 fence-only 命中走此确定性最小修复，
 * 不进 LLM 重写（修复代价为零）。
 *
 * 行为：行首 ``` 标记行整行删除；``` 后跟正文的行只删标记保留正文；压缩多余空行。
 */
export function stripMarkdownCodeFences(content: string): string {
  return content
    .split('\n')
    .map((line) => {
      if (!/^\s*```/.test(line)) return line;
      const rest = line.replace(/^\s*`{3,}[\w-]*\s*/, '');
      return rest === '' ? null : rest;
    })
    .filter((line): line is string => line !== null)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 人设露馅：Agent 人设是真人招募经理，说"转人工/人工客服"等词等于自曝机器人身份。
 *
 * 运营反馈（recvjXBkmV6idz"能不能不要说转人工，这样不是露馅了吗"、
 * recvnV3iYGZnBJ"别说我给你转人工，有点像人机"）。正确口径是"我帮你问下同事/
 * 让负责的同事联系你"。与上面的内部状态泄漏同族（实现细节外露），但先 observe
 * 收判例——话术类拦截要先确认误报率再升档。
 */
const HUMAN_SERVICE_PHRASE_PATTERN = /转人工|人工客服|人工坐席|转接人工|人工渠道/;

export function detectHumanServicePhraseLeak(content: string): RuleContradiction | null {
  if (!content) return null;
  if (!HUMAN_SERVICE_PHRASE_PATTERN.test(content)) return null;
  return {
    ruleId: 'human_service_phrase_leak',
    label:
      '回复出现"转人工/人工客服"等表述，与真人招募经理人设冲突（badcase recvjXBkmV6idz / recvnV3iYGZnBJ），应改为"帮你问下同事"类口径',
    action: GUARDRAIL_ACTION.OBSERVE,
  };
}

/**
 * 元叙述旁白：整条回复是描述 Agent 自身行为的括号旁白，说明模型有"本轮不该说话"
 * 的意图但没走 skip_reply 工具，把内心独白当成了正文。
 *
 * 业务背景：badcase chat 6a5740ff…（2026-07-15）：真人招募经理手动插话筛选候选人、
 * 候选人回应真人后，模型输出「（本轮为真人招募经理与候选人直接沟通，AI 保持静默，
 * 不插入回复）」被当正文投递，经理被迫撤回。与上面的内部状态泄漏同族（内部
 * 视角文本外发），但形态是自然语言旁白，词库式 PATTERNS 覆盖不到。
 *
 * 口径刻意收窄（兜底边界原则，30 天生产仅此一例形态）：
 * - 整条回复必须被全角/半角括号完整包裹——正常候选人话术不存在这种形态；
 * - 且含自我指涉元词（真人/AI/静默/不插入回复 等）。
 * 两个条件叠加，正文里合法使用括号（如"到店说（独立客介绍来的）"）不会命中。
 *
 * 命中处理：block，且 runner 对本规则直达静默不进 repair——本该沉默的轮次，
 * 重写产物仍是不该发的插话（见 agent-runner isOnlyMetaNarrationBlock）。
 */
const META_NARRATION_WRAPPED_PATTERN = /^[（(][^（()）]*[）)]$/;
const META_NARRATION_TERM_PATTERN =
  /真人|AI|人机|静默|沉默|不插入|不回复|无需回复|等待候选人|人工操作/;

export function detectMetaNarrationReply(content: string): RuleContradiction | null {
  const text = content?.trim() ?? '';
  if (!text) return null;
  if (!META_NARRATION_WRAPPED_PATTERN.test(text)) return null;
  if (!META_NARRATION_TERM_PATTERN.test(text)) return null;
  return {
    ruleId: 'meta_narration_reply',
    label:
      '整条回复是描述 Agent 自身行为的括号旁白（如"AI 保持静默，不插入回复"），属内心独白外发，必须拦截并整轮静默（badcase chat 6a5740ff）',
    action: GUARDRAIL_ACTION.BLOCK,
  };
}

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

/**
 * 工具调用 XML 标签形态——**泄漏检测与残文剥离共用的单一真相源**。
 *
 * 2026-08-06 生产 badcase（运营反馈 `8pu8f8we`，chat `6a72a29d…` 08-05 10:42）：
 * 整条回复只有一个闭合标签 `</function_calls>`，被原样投递给候选人，候选人回了
 * 一个「？」，Agent 三分钟后才以"抱歉刚才在帮你查～"补救。
 *
 * 根因是同族判据单边漂移：2026-08-04 审计把**残文剥离**的交替组从 `function_call/s`
 * 扩到了 `function(?:_calls?)?` 与 `thinking`，却漏改**泄漏检测**侧——那里一直是窄的
 * `<\/?tool_call>`。`isToolCallArtifactOnly` 以 `detectOutputLeak` 为前置闸，检测不
 * 命中就直接短路返回 false，于是这条残文既没被拦、也没走整轮静默。
 * 既往同族残文之所以侥幸被捕，是因为正文里另带了已注册工具名（`skip_reply` 等）
 * 命中了工具名词条，并非 XML 标签判据生效。
 *
 * 两处共用同一份来源，杜绝再次单边扩展。
 */
const TOOL_CALL_XML_TAG_SOURCE =
  '<\\/?(?:tool_call|tool_use|invoke|parameter|function(?:_calls?)?|thinking)\\b[^>]*>';

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
  new RegExp(TOOL_CALL_XML_TAG_SOURCE, 'i'),
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

// —— 残文与跨域形态识别（2026-07-30 守卫审计 P0-2 / P0-3）————————————————

/**
 * 工具调用骨架：XML 标签、`toolName(args)` 调用式、字面量与括号。
 *
 * 2026-08-04 审计修正：
 * - XML 交替组补 `function(?:_calls?)?` 与 `thinking`——生产实测漏杀
 *   `<function invite_to_group>`（rewrite 编出"已经拉你进群了"并投递）与
 *   `</thinking>\n<function=skip_reply>`（旧组只匹配 function_call/s）；
 * - 补 `<parameter…>值` 剥除——XML 形态的参数值不带引号（`<parameter=city>上海`），
 *   字符串字面量模式剥不掉，残渣带汉字致整条漏判为"非残文"流进 rewrite。
 *   值吃到下一个 `<` 为止，闭合标签缺失（截断输出）也能剥净。
 */
const TOOL_CALL_SKELETON_PATTERNS: readonly RegExp[] = [
  /<parameter\b[^>]*>[^<]*/gi,
  new RegExp(TOOL_CALL_XML_TAG_SOURCE, 'gi'),
  new RegExp(`\\b(?:${TOOL_NAMES.map(escapeRegex).join('|')})\\s*\\([^()]*\\)`, 'g'),
  /(["'])(?:\\.|(?!\1)[^\\])*\1/g,
  new RegExp(`\\b(?:${TOOL_NAMES.map(escapeRegex).join('|')})\\b`, 'g'),
  /\b(?:true|false|null|name|arguments|parameters?)\b/gi,
  /[\d\s{}[\]<>()=,:;.、，。：；"'`|/\\-]+/g,
];

/**
 * JSON 信封：模型把本想发的正文包进了 JSON 信封再当回复吐出（2026-08-04 生产实测两形态：
 * `{"censorStatus":"ok","_replyInstruction":"不客气～…"}`、`{"agent_response":"好的，我帮你…"}`）。
 *
 * 这种形态曾被 isToolCallArtifactOnly 误判成纯残文整轮静默——字符串字面量剥离把
 * 信封里的完整好回复连壳一起剥掉了。正解与剥围栏同型：确定性拆封、逐字放出正文。
 *
 * 防反例（同窗口生产实测 `{"type":"tool_use","name":"request_handoff","input":{"reason":"候选人追问…"}}`）：
 * tool_use 信封的 reason 同样是长中文，但那是内部升级理由不是候选人话术——含
 * type/name/input/arguments 等调用结构键的对象一律不拆，维持静默。
 */
const ENVELOPE_TOOL_STRUCTURE_KEYS = new Set([
  'type',
  'name',
  'tool',
  'toolname',
  'tool_name',
  'function',
  'input',
  'arguments',
  'parameters',
]);
const ENVELOPE_MIN_HAN_CHARS = 6;

function countHanChars(text: string): number {
  return text.match(/\p{Script=Han}/gu)?.length ?? 0;
}

export function tryUnwrapEnvelopeReply(content: string): string | null {
  const text = content?.trim() ?? '';
  if (!text.startsWith('{') || !text.endsWith('}')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null; // 解析不了的伪 JSON 不猜测，交回残文判定/常规 repair
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).some((key) => ENVELOPE_TOOL_STRUCTURE_KEYS.has(key.toLowerCase()))) {
    return null;
  }
  // 仅取顶层字符串值里"像候选人话术"的候选：中文量足够、自身无任何泄漏形态、
  // 非技术文档。恰好一条才拆——多条无法确定哪条是正文，宁可维持原收敛。
  const candidates = Object.values(record).filter(
    (value): value is string =>
      typeof value === 'string' &&
      countHanChars(value) >= ENVELOPE_MIN_HAN_CHARS &&
      !detectOutputLeak(value) &&
      !hasTechnicalDocumentationShape(value),
  );
  if (candidates.length !== 1) return null;
  return candidates[0].trim();
}

/**
 * 整条回复只是工具调用残文——模型没发起工具调用，而是把调用语法当正文吐了出来
 * （2026-07-28 15:05–15:11 生产降级：`<tool_call><invoke name="duliday_job_list">…`、
 * `{"name":"geocode",…}`、`geocode(address="海珠", city="广州")`、裸串 `duliday_job_list`）。
 *
 * 这种输入不能进 rewrite：泄漏反馈要求"其余内容逐字保留"，而残文剥完无一字可留，
 * 指令退化成自由创作——当时 4/4 例编出了薪资、门店岗位乃至字面占位的伪造报名链接
 * 并全部投递。正确结局与元叙述旁白同型：整轮静默。
 *
 * 判据：剥掉工具调用骨架与字面量后，不再剩下任何可读字符（汉字/字母）。
 * 可拆封的 JSON 信封（见 tryUnwrapEnvelopeReply）不算残文——里面有完整正文可放出，
 * 静默会把好回复一起吞掉（2026-08-04 审计静默误伤 ×2）。
 */
export function isToolCallArtifactOnly(content: string): boolean {
  const text = content?.trim() ?? '';
  if (!text) return false;
  if (!detectOutputLeak(text)) return false;
  if (tryUnwrapEnvelopeReply(text) !== null) return false;
  const residue = TOOL_CALL_SKELETON_PATTERNS.reduce(
    (acc, pattern) => acc.replace(pattern, ''),
    text,
  );
  return !/[\p{Script=Han}A-Za-z]/u.test(residue);
}

/**
 * 技术文档形态：markdown 表格/标题、JSON 键值对、长驼峰标识符、接口术语。
 *
 * 用于给"剥围栏即完整修复"的确定性快通道加前置闸——2026-07-28 生产实例：候选人问
 * 日结岗，模型回了一整篇后端接口设计答案（`TjybappHousingConfirm` 表金额透传、JSON
 * 示例、字段映射表）。围栏只是它最表层的问题，剥掉围栏后词库不再命中，快通道遂
 * 逐字放行，整篇跨域内容投递给了候选人。
 *
 * 要求至少两类信号同时出现：报名表模板（逐项"姓名："）不含其中任何一类，
 * 2026-07-21 锚定判例的最小修复路径不受影响。
 */
const TECHNICAL_DOC_PATTERNS: readonly RegExp[] = [
  /^\s*\|[^\n|]*\|[^\n|]*\|/m,
  /^\s*#{1,6}\s+\S/m,
  /["'][\w-]+["']\s*:\s*(?:["'\d[{]|true|false|null)/,
  /\b[a-z]+[A-Z][a-zA-Z0-9]{2,}\b|\b[A-Z][a-z]+[A-Z][a-zA-Z0-9]{2,}\b/,
  /接口|字段|参数名|返回值|数据库|整型|字符串|透传|前端|后端|调用方|存储/,
];

export function hasTechnicalDocumentationShape(content: string): boolean {
  const text = content?.trim() ?? '';
  if (!text) return false;
  return TECHNICAL_DOC_PATTERNS.filter((pattern) => pattern.test(text)).length >= 2;
}

/**
 * 人设露馅：Agent 人设是真人招募经理，说"转人工/人工客服"等词等于自曝机器人身份。
 *
 * 运营反馈（recvjXBkmV6idz"能不能不要说转人工，这样不是露馅了吗"、
 * recvnV3iYGZnBJ"别说我给你转人工，有点像人机"）。正确口径是"我帮你问下同事/
 * 让负责的同事联系你"。与上面的内部状态泄漏同族（实现细节外露）。
 *
 * 2026-07-07 observe 入场收判例；2026-07-21 升 revise：两周 5 条命中全为真阳性
 * 人设露馅（守卫档案 7-14/7-16/7-17/7-20/7-21），封闭词表零误报，措辞替换即可
 * 修复，满足 catalog 准入条件（≥2 周判例、精确率 ≥90%、恢复路径可靠）。
 *
 * 2026-07-22 扩词（badcase chat 6a5dedb2ce406a6aeee1ea62"东升是真人招募经理哈"
 * 直发未拦）：补"人工登记/人工确认"等动作变体与"真人经理/专人联系"类第三方
 * 割裂表述。仍是封闭词表；"真人/人工"单字不入表，避免误伤正常语义。
 */
const HUMAN_SERVICE_PHRASE_PATTERN =
  /转人工|人工客服|人工坐席|转接人工|人工渠道|人工登记|人工确认|人工介入|人工处理|人工跟进|真人招募经理|真人经理|真人客服|专人联系|专人跟进|专人对接/;
// 刻意不入表："人工审核"（描述门店/品牌侧简历审核外部流程，属合法业务表述，
// precheck wait_notice 话术用"先进入审核"避免主动引导该词形）。

/**
 * 反馈按"本轮是否有真实人工升级动作"分叉（2026-08-04 审计 P1-5，trace …_1785743845189）：
 * 目录反馈的处方"改成'我帮你问下同事'"逐字就是 handoff_promise_without_handoff 的
 * 违规构成要件——repair 照做后被二审 P0 打死，任何"说了人工 + 本轮无升级动作"的
 * 轮次注定沉默。无升级动作时反馈必须要求删除露馅措辞**且不得替换成任何跟进承诺**。
 */
export function detectHumanServicePhraseLeak(
  content: string,
  hasCommittedEscalation = false,
): RuleContradiction | null {
  if (!content) return null;
  if (!HUMAN_SERVICE_PHRASE_PATTERN.test(content)) return null;
  return {
    ruleId: 'human_service_phrase_leak',
    label:
      '回复出现"转人工/人工客服/真人经理/专人联系"等表述，把自己与"人工/真人"割裂、与账号本人人设冲突（badcase recvjXBkmV6idz / recvnV3iYGZnBJ / chat 6a5dedb2ce406a6aeee1ea62），应改为"帮你问下同事"类口径',
    action: GUARDRAIL_ACTION.REVISE,
    feedbackToGenerator: hasCommittedEscalation
      ? '上一版回复出现"转人工/人工客服/真人经理/专人联系"类表述，与"候选人看到的这个账号就是你本人"的身份设定冲突，当前文本不可发送。' +
        '只把露馅措辞改成人设内口径（如"我帮你问下同事""让负责的同事联系你"），其余内容原样保留，不要改变承诺的事实和后续动作。'
      : '上一版回复出现"转人工/人工客服/真人经理/专人联系"类表述，与"候选人看到的这个账号就是你本人"的身份设定冲突，当前文本不可发送。' +
        '删除露馅措辞，且**不得**把它替换成"我帮你问下同事/让同事联系你"等任何跟进承诺——本轮没有真实的人工升级动作，替换成承诺会构成新的空头承诺违规。' +
        '只保留已确认的事实与候选人可自行进行的下一步；若删除后没有其他实质内容，就只输出一句不含承诺、不含新事实的自然收束。',
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

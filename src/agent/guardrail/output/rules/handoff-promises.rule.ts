import type { AgentToolCall } from '@agent/generator/generator.types';
import { GUARDRAIL_ACTION } from '@shared-types/guardrail.contract';
import { asRecord, type RuleContradiction } from '../output-rule.types';

/**
 * “同事/负责人后续处理”是可验证的外部动作承诺，不能只靠一句话成立。
 *
 * 这条规则刻意不拦“具体以门店/同事确认为准”一类边界声明；只有 Agent 明确声称自己
 * 已经或将要联系某个人继续确认、处理、回复时，才要求本轮存在成功的人工升级动作
 * （request_handoff 或 raise_risk_alert）。
 */
const HANDOFF_PROMISE_PATTERNS: RegExp[] = [
  /我(?:们)?(?:这边)?(?:已经|会|来|先|马上|尽快)?(?:帮你)?(?:让|请|找|问|联系|反馈给|转给)[^。！？\n]{0,16}(?:同事|负责人|店长|门店|招聘经理)[^。！？\n]{0,24}(?:确认|核实|处理|跟进|联系|回复|答复|发送|发(?:给|你|下|一份|过来|资料|清单|文件|链接|地址|定位|截图|消息)|提供)/,
  /我(?:们)?(?:这边)?(?:已经|会|来|先|马上|尽快)?帮你(?:转给|转达给|反馈给|联系)[^。！？\n]{0,16}(?:同事|负责人|店长|门店|招聘经理)/,
  /(?:稍后|晚点|随后|之后)[^。！？\n]{0,16}(?:同事|负责人|店长|门店|招聘经理)[^。！？\n]{0,24}(?:联系|回复|答复|跟进|处理|发送|发(?:给|你|下|一份|过来|资料|清单|文件|链接|地址|定位|截图|消息)|提供)/,
  /(?:同事|负责人|店长|门店|招聘经理)[^。！？\n]{0,12}(?:稍后|晚点|随后|之后)[^。！？\n]{0,24}(?:联系|回复|答复|跟进|处理|发送|发(?:给|你|下|一份|过来|资料|清单|文件|链接|地址|定位|截图|消息)|提供)/,
  // "转人工"式承诺（badcase chat 6a5f4549："我帮你转人工核实下具体原因"当轮没落
  // handoff，下一轮才补）。措辞本身另由 human_service_phrase_leak(revise) 治理人设
  // 露馅；本词形管的是承诺与动作对账，两规则叠加时按更重的 replan 收敛。
  /(?:帮|给)你转(?:接)?人工|转(?:接)?人工[^。！？\n]{0,16}(?:核实|确认|处理|跟进|登记|申请)/,
];

const NEGATED_HANDOFF_ACTION_PATTERN =
  /(?:不会|不要|别|无需|不用|不必|不需要|不再|未|没有|没)[^，,；;。！？\n]{0,16}(?:确认|核实|处理|跟进|联系|回复|答复|发送|发(?:给|你|下|一份|过来|资料|清单|文件|链接|地址|定位|截图|消息)|提供)/u;

const DELEGATED_HUMAN_CONTEXT_PATTERN =
  /我(?:们)?(?:这边)?(?:已经|会|来|先|马上|尽快)?(?:帮你)?(?:让|请|找|问|联系|反馈给|转给)[^。！？\n]{0,16}(?:同事|负责人|店长|门店|招聘经理)/u;
const TIMED_HUMAN_CONTEXT_PATTERN =
  /(?:(?:稍后|晚点|随后|之后)[^。！？\n]{0,16}(?:同事|负责人|店长|门店|招聘经理)|(?:同事|负责人|店长|门店|招聘经理)[^。！？\n]{0,12}(?:稍后|晚点|随后|之后))/u;
const IMPLICIT_CLAUSE_LEAD_PATTERN = /^(?:但|不过|只是|而是)\s*/u;
const IMPLICIT_ACTION_CONNECTOR_PATTERN =
  /^(?:(?:直接|改成|改为|再|然后|随后|稍后|晚点|之后|会|马上|尽快|继续|转而)\s*)+/u;
const IMPLICIT_ACTION_PREFIX_PATTERN =
  /^(?:帮你|给你)?\s*(?:确认(?!结果|状态)|核实(?!结果)|处理(?!结果|方式)|跟进(?!记录|结果)|联系(?!方式|记录)|回复(?!记录|内容)|答复(?!记录|内容)|发送(?!记录|状态)|发(?:给|你|下|一份|过来|资料|清单|文件|链接|地址|定位|截图|消息)|提供(?!的(?:信息|内容)|信息))/u;
const IMPLICIT_FRONTED_SEND_PATTERN =
  /^(?:把|将)[^，,；;。！？\n]{0,12}(?:发送(?:给你)?|发(?:给你|你|下|过来)|提供给你)/u;
const IMPLICIT_STRONG_BARE_ACTION_PATTERN =
  /^(?:联系你|回复你|答复你|跟进你|发送给你|发(?:给你|你|一份|资料|清单|文件|链接|地址|定位|截图|消息)|提供给你)/u;

function isImplicitPositiveHandoffClause(clause: string): boolean {
  let body = clause.replace(IMPLICIT_CLAUSE_LEAD_PATTERN, '').trim();
  const connector = body.match(IMPLICIT_ACTION_CONNECTOR_PATTERN);
  if (connector) body = body.slice(connector[0].length).trim();

  if (IMPLICIT_FRONTED_SEND_PATTERN.test(body)) return true;
  if (connector) return IMPLICIT_ACTION_PREFIX_PATTERN.test(body);
  // 无连接词时只认带明确宾语/收件人的强动作，避免把“回复已收到”“联系已中断”
  // 这类名词或状态描述继承为同事的后续承诺。
  return IMPLICIT_STRONG_BARE_ACTION_PATTERN.test(body);
}

function containsPositiveImplicitHandoffAction(sentence: string): boolean {
  const clauses = sentence
    .split(/[，,；;]+/u)
    .map((clause) => clause.trim())
    .filter(Boolean);
  for (let index = 1; index < clauses.length; index += 1) {
    const priorContext = clauses.slice(0, index).join('，');
    if (
      !DELEGATED_HUMAN_CONTEXT_PATTERN.test(priorContext) &&
      !TIMED_HUMAN_CONTEXT_PATTERN.test(priorContext)
    ) {
      continue;
    }
    // 只让“直接/改成/再/会…”等动作型子句继承前文人工主体；“我自己回复”、
    // “现有资料提供的信息”等新主语或名词短语不会被当成人工后续承诺。
    if (isImplicitPositiveHandoffClause(clauses[index])) return true;
  }
  return false;
}

function containsPositiveHandoffPromise(content: string): boolean {
  const sentences = content
    .split(/[。！？!?\n]+/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

  const containsPromise = (text: string): boolean =>
    HANDOFF_PROMISE_PATTERNS.some((pattern) => {
      const matcher = new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`);
      for (const match of text.matchAll(matcher)) {
        if (!NEGATED_HANDOFF_ACTION_PATTERN.test(match[0])) return true;
      }
      return false;
    });

  return sentences.some((sentence) => {
    // 保留整句检查，兼容“我让同事确认下，有消息告诉你”这类跨逗号主谓；同时逐个
    // 逗号/分号子句再查一次，防止前半句的否定动作被贪婪匹配吞掉后半句的正向承诺。
    const candidates = [sentence, ...sentence.split(/[，,；;]+/u)];
    return (
      candidates.some((candidate) => containsPromise(candidate.trim())) ||
      containsPositiveImplicitHandoffAction(sentence)
    );
  });
}

/**
 * 本轮已提交的真实人工升级动作：request_handoff（dispatched=true）、
 * raise_risk_alert（accepted=true），或 duliday_interview_booking 失败自动暂停
 * （hostingPaused=true）。三者的副作用同样收敛为「暂停托管 + 飞书告警 +
 * 下一轮人工接手」，都能兑现"让同事/负责人跟进"的承诺；差别只在
 * raise_risk_alert 本轮仍要输出安抚话术——恰恰是这条路径会走到出站守卫
 * （badcase batch_6a66f559…：面试官缺席，Agent 正确升级 raise_risk_alert 并
 * 承诺"让同事确认"，却被判 P0 空头承诺，无工具 rewrite 把当天 15:00 的真实
 * 约面复述成"明天…不用一直等"，劝退了正在等面的候选人）。
 *
 * booking 分支（2026-08-04 守卫审计 …740343589/…748484273）：预约失败时工具
 * 自己 pauseUserHostingAsync 暂停托管并告警真人接管，且其 replyInstruction 明确
 * 指示模型说"我让同事确认一下，稍等"——规则若不认这第三种升级副作用，就是把
 * 工具亲自教的如实话术判成 P0 空头承诺，逼 rewrite 编出"那就给你约明天…"类
 * 完成暗示（假阳 × 有害重写，与 8ac0c1e4 修的 raise_risk_alert 假阳同构）。
 * 对账走工具结果里的显式 `hostingPaused` 打标，不用 errorType 推断——
 * BOOKING_REJECTED 也被不暂停的 precheck 早退分支复用，推断会把早退误判为已升级。
 */
export function hasCommittedHumanEscalation(toolCalls: AgentToolCall[]): boolean {
  return toolCalls.some((call) => {
    const result = asRecord(call.result);
    if (call.toolName === 'request_handoff') return result?.dispatched === true;
    if (call.toolName === 'raise_risk_alert') return result?.accepted === true;
    if (call.toolName === 'duliday_interview_booking') return result?.hostingPaused === true;
    return false;
  });
}

/**
 * 整条回复剥掉承诺句后是否已无实质内容（2026-08-04 审计 P0-1）。
 *
 * "删除跟进承诺、其余逐字保留"的修复指令在首版整条只有那句承诺时保留的是空集
 * ——rewrite 被逼成自由创作，生产 4 例全部编出无出处事实（"衣服方面店里没有特殊
 * 要求""已经拉你进上海的餐饮群了""那就给你约明天下午1点半"），其中 2 例投递。
 * 该形态由 runner 直接收敛为静默（handoff_promise_only_reply_silenced），不进 rewrite：
 * 没有事实可依时，沉默好于编造（与 tool_call_artifact_silenced 同一裁定）。
 *
 * 句切分只用句末标点/换行、刻意不切逗号："衣服要求我让同事确认下，有消息告诉你"
 * 的后半是同一承诺的尾巴，跟着整句一起剥。剥后残文少于 4 个汉字（"好的"类寒暄）
 * 视为无实质内容。
 */
export function isHandoffPromiseOnlyReply(content: string): boolean {
  const text = content?.trim() ?? '';
  if (!text) return false;
  if (!containsPositiveHandoffPromise(text)) return false;
  const residue = text
    .split(/[。！？!?\n]+/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .filter((sentence) => !containsPositiveHandoffPromise(sentence))
    .join('\n');
  return (residue.match(/\p{Script=Han}/gu)?.length ?? 0) < 4;
}

export function detectHandoffPromiseWithoutHandoff(
  content: string,
  toolCalls: AgentToolCall[],
): RuleContradiction | null {
  if (!content || !containsPositiveHandoffPromise(content)) return null;
  if (hasCommittedHumanEscalation(toolCalls)) return null;

  return {
    ruleId: 'handoff_promise_without_handoff',
    label:
      '回复承诺已让同事/负责人后续确认、联系或发送资料，但本轮没有成功的人工升级动作（request_handoff / raise_risk_alert / 预约失败自动暂停），属于无真实动作支撑的跟进承诺',
    // 2026-07-27 发牌收尾：replan → revise（评估文档 §2.2/§2.4）。replan 作为修复
    // 机制已整体退役；本规则检测是过程判据（承诺词形+dispatched 对账）、rewrite 下
    // 修法唯一（删除完成时态承诺、只陈述已确认事实），符合白名单准入三条件，且 P0
    // 收敛保证 rewrite 失败即 block——假承诺不会出门。"真正补执行 request_handoff"
    // 的保文补参式修复是条件项（评估文档 §2.4），届时走两步拆解不回 replan。
    action: GUARDRAIL_ACTION.REVISE,
  };
}

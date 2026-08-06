import type { AgentToolCall } from '@agent/generator/generator.types';
import { GUARDRAIL_ACTION } from '@shared-types/guardrail.contract';
import { isDanglingCheckReply } from '@agent/runner/dangling-reply';

/**
 * 首版投递物的悬空承接句观测。
 *
 * 背景：`isDanglingCheckReply` 只作用于 repair 产物（agent-runner 的 invokeReviewed
 * 里对 revisedText 判定，命中收敛为 block），**首版直投不在其覆盖内**——而首版才是绝大
 * 多数投递物。2026-07-29 日报 L1 回扫实证两条真悬空（chat 6a69ba9f 16:36、6a69be5c），
 * 都是"我先帮你查下 X，稍等哈"独立成句发出后再无下文，候选人一直空等。
 *
 * 为什么是 OBSERVE 而不是 REVISE/BLOCK：
 * - 首版命中的动作难定。走 repair（rewrite 模式工具已被物理移除）只能改写措辞，
 *   改不出候选人要的结果，反而容易把"我帮你查下"改成"暂时没有岗位"——那是编造。
 * - 收敛为 block 则候选人从"收到空头承诺"变成"什么都没收到"，未必更好。
 * - 真正的根治在生成侧（不得以裸承诺结束回合），已同步补进 candidate-consultation
 *   的全局原则。本规则先落档累计精确率与规模，够实证再议是否升档。
 *   这与"快环只做确定性动作、聪明的判断进 shadow 观测 + 离线环"的既定裁定一致。
 *
 * 判据完全复用 runner 的纯谓词（短文本 + 将来时"我帮你查"承诺 + 无任何结果性内容
 * 标记），刻意保守、宁可漏判也不误杀。这里跨目录 import 的是零依赖纯函数，不引入
 * 运行时耦合；不搬文件是为了避开主线上该文件的并发改动。
 */
export function detectDanglingReplyPromise(text: string, toolCalls: AgentToolCall[] = []) {
  if (!isDanglingCheckReply(text)) return null;

  const jobListCalls = toolCalls.filter((call) => call.toolName === 'duliday_job_list');
  const context =
    jobListCalls.length === 0
      ? '本轮未调用 duliday_job_list'
      : `本轮调用 duliday_job_list ${jobListCalls.length} 次但结果未落入回复`;

  return {
    ruleId: 'dangling_reply_promise',
    label: `首版回复只给出将来时查询承诺、没有任何结果性内容（${context}），候选人会一直空等`,
    action: GUARDRAIL_ACTION.OBSERVE,
  };
}

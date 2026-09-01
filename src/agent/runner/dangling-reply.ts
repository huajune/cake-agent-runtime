/**
 * 悬空查岗承接句检测：识别"只承接、不给结果"的最终回复。
 *
 * 出站守卫 repair 是本轮最后一次生成——修复由无工具的 ReplyRepairAgent 完成，产出即终版。
 * 此时任何"我帮你查下 X"式的将来时承诺都不可能兑现，投递出去就是空头承诺：候选人只收到
 * 一句"我帮你查下"，之后永远没有下文。
 *
 * 判定刻意保守（宁可漏判也不误杀）：短文本 + 含将来时"查/看/核实"承诺 + 不含任何
 * 结果性/推进性内容标记（否定结论、数字事实、反问、转人工话术等）才算悬空。
 */

/**
 * 将来时"我来查/看"式承诺。三个分支都要求第一人称/为你服务语境——
 * 裸"查一下/看一下"会把「你先看一下上面的岗位介绍」这类祈使句误判成承诺。
 */
const PROMISE_PATTERN =
  /(?:帮|给)你(?:查|看|核实|核对|确认|问)|(?:我|这边)(?:先|这就|马上|现在|去)(?:帮你|给你)?(?:查|看|核实|核对|确认|问)|(?:我|这边)(?:来|去)?(?:帮你|给你)?(?:查|看|核实|核对|确认)一?下/;

/**
 * 结果性/推进性内容标记：出现任一说明回复里带了实质结论或把对话推进给了候选人
 * （否定结论、在招状态、薪资/距离数字、反问收集信息、转人工衔接），不算悬空。
 * 完成态（了/到/啦/过/已经）说明"查"已经发生并有下文，是结果陈述不是空头承诺。
 *
 * `没` 必须后接结论性成分才算落地，不能把“有没有”里的疑问语气词当作否定结论。
 */
const GROUNDED_PATTERN =
  /(?<!有)没(?:找到|查到|有岗|在招|了|得|人)|暂|无|已|了|到|啦|过|在招|元|块|公里|千米|km|KM|群|同事|人工|吗|？|\?|哪|多少|几点|什么时候|方便/;

/** 归一化后超过该长度的回复默认视为带实质内容，不参与悬空判定。 */
const MAX_DANGLING_LENGTH = 30;

/**
 * 承诺 + 等待指令共现（"我帮你查下 X，稍等哈"）：这个组合几乎不可能是实质回复，
 * 长度豁免对它不成立——报个地名加几个岗位类型就轻松超过 30 字
 * （实测形态归一化后 40 字，会被长度闸直接放行）。
 */
const WAIT_INSTRUCTION_PATTERN =
  /稍等|等我|马上(?:回|告诉|发)|一会儿?(?:告诉|回|发)你|等下(?:告诉|回|发)/;

export function isDanglingCheckReply(text: string): boolean {
  const normalized = text.replace(/\s+/g, '');
  if (!normalized) return false;
  if (!PROMISE_PATTERN.test(normalized)) return false;
  const lengthExempt =
    normalized.length > MAX_DANGLING_LENGTH && !WAIT_INSTRUCTION_PATTERN.test(normalized);
  if (lengthExempt) return false;
  return !GROUNDED_PATTERN.test(normalized);
}

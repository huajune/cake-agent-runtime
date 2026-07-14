import { type GeneratorInvokeParams } from './generator.types';

/**
 * HC-1 revise/repair 与 reengagement 主动回合的 prompt 指令构建（纯函数）。
 *
 * 由 PreparationService 在组装 finalPrompt / messages 时调用；普通回合
 * （无 revise 反馈、无主动 directive）一律返回空串，不产生任何影响。
 */

/**
 * HC-1：把 revise 回路的违规意见 / 已提交副作用摘要拼到 system prompt 末尾。
 *
 * - committedSideEffects：告知模型副作用已生效，既不声称未发生也不重复执行；
 * - reviseFeedback：把出站守卫的违规意见喂回，让模型只修正这些问题。
 *
 * 二者均为可选；都缺省时返回空串，不影响普通回合。
 */
export function buildReviseNotice(params: GeneratorInvokeParams): string {
  const parts: string[] = [];

  const committed = params.committedSideEffects?.trim();
  if (committed) {
    parts.push(
      `本轮的副作用动作已经执行并生效（${committed}），既成事实，不可撤销也不可重复执行。` +
        `请基于这一事实重写本轮回复：修正措辞与合规问题，` +
        `严禁声称未发生、严禁重复执行已经生效的操作。`,
    );
  }

  const repair = params.guardrailRepair;
  if (repair) {
    const feedback = repair.feedbackToGenerator?.trim();
    const noToolRepairConstraint =
      params.toolMode === 'none'
        ? '\n- 本次修复不能调用任何工具。不要输出任何工具名、函数调用、JSON、方括号指令或 XML 标签；只输出发给候选人的纯中文文本。如果你认为需要重新查询才能回答，不要尝试查询，改为向候选人自然确认信息或告知稍后跟进。'
        : '';
    parts.push(
      `本次是 Guardrail Repair Writer 模式。上一版候选人可见回复已被丢弃，原文如下：\n` +
        `"""${repair.originalReply.slice(0, 1200)}"""\n` +
        `请只输出一版新的候选人可见回复，严格满足：\n` +
        `- 只修复命中规则的问题，不扩写、不新增未接地事实、不改变已提交副作用事实。\n` +
        `- 不提“规则/守卫/拦截/系统/工具/模型”。\n` +
        `- 不输出分析过程，不输出 JSON，不输出多方案。\n` +
        `- 命中规则：${repair.ruleIds.length > 0 ? repair.ruleIds.join('、') : '未提供'}。` +
        noToolRepairConstraint +
        (feedback ? `\n- 聚合修复要求：${feedback}` : ''),
    );
  }

  if (params.reviseFeedback?.length) {
    const lines = params.reviseFeedback.map(
      (v) =>
        `- [${v.type}] ${v.feedbackPolicy === 'redacted' ? '证据已脱敏' : `问题：${v.evidence}`}；修复要求：${v.suggestion}`,
    );
    const hasReplan = params.reviseFeedback.some((v) => v.repairMode === 'replan');
    const replanToolConstraint = buildReplanToolConstraint(params.allowedToolNames);
    const noToolRepairConstraint =
      params.toolMode === 'none'
        ? '本次修复不能调用任何工具。不要输出任何工具名、函数调用、JSON、方括号指令或 XML 标签——只输出发给候选人的纯中文文本。如果你认为需要重新查询才能回答，不要尝试查询，改为向候选人自然确认信息或告知稍后跟进。'
        : '';
    parts.push(
      `上一版回复不可发送，存在以下需修正的问题。请只针对这些问题生成一版新的候选人可见回复，` +
        `不要解释或提到出站守卫/规则/拦截，不要复述高敏感条件，不要新增未接地承诺。` +
        (hasReplan ? replanToolConstraint : `本次只做文案修复，严禁调用工具。`) +
        noToolRepairConstraint +
        `\n${lines.join('\n')}`,
    );
  }

  if (parts.length === 0) return '';
  return `\n\n# 回复重写要求（HC-1）\n${parts.join('\n\n')}`;
}

/**
 * HC-1 重写指令的对话末尾版：拼成一条追加在 messages 末尾的 user 消息。
 *
 * 动机：system HC-1 位于 ~16K token 大 prompt 的最尾部，而对话仍以候选人的
 * 原问题收尾，弱模型（qwen 等 fallback 链路）会无视 system 指令、把 repair
 * 回合当新对话重新执行任务。对话末尾的显式指令是模型注意力最强的位置，
 * 与 system HC-1 双保险。内容自包含（含被丢弃原文与违规清单），不依赖模型
 * 回头翻 system。
 */
export function buildReviseUserDirective(params: GeneratorInvokeParams): string | null {
  const repair = params.guardrailRepair;
  const violations = params.reviseFeedback ?? [];
  if (!repair && violations.length === 0) return null;

  const hasReplan = violations.some((v) => v.repairMode === 'replan');
  const replanToolConstraint = buildReplanToolConstraint(params.allowedToolNames);
  const lines: string[] = [
    '【系统重写指令｜本条不是候选人消息，候选人看不到本条，也不要回应本条】',
    '你上一版发给候选人的回复未通过发送前审查，已被丢弃。本轮任务不是回答候选人的新消息，' +
      '而是重写上一版回复。' +
      (hasReplan
        ? replanToolConstraint
        : '严禁调用任何工具，严禁重新规划查岗/拉群/约面等任务——本轮工具动作已全部执行完毕，只做文案修复。' +
          '本轮没有工具可用，严禁把工具调用写成文本输出（如 {"name": "geocode", ...}、tool_call:xxx(...) 等形态，' +
          '这类文本会被当成事故直接拦截）；某个事实没有本轮工具结果支持时，删掉该事实或改为不确定表述。'),
  ];
  if (repair) {
    lines.push(`被丢弃的上一版回复原文：\n"""${repair.originalReply.slice(0, 1200)}"""`);
  }
  if (violations.length > 0) {
    lines.push(
      `需修正的问题：\n${violations.map((v) => `- [${v.type}] ${v.suggestion}`).join('\n')}`,
    );
  }
  lines.push(
    '现在直接输出修正后的候选人可见回复正文：保留上一版中符合事实、未违规的内容，只删除或改写违规部分；' +
      '不输出分析过程、前言、JSON 或多个方案；不提"规则/守卫/拦截/系统/工具/模型"。' +
      (hasReplan
        ? ''
        : '严禁输出"我帮你查下/我先看看"这类只承接不给结果的话——本轮不会再有任何查询，回复必须直接给出结论或下一步。'),
  );
  return lines.join('\n\n');
}

/** Guardrail replan 的提示必须与物理工具白名单完全一致，不能再声称笼统的“只读”。 */
function buildReplanToolConstraint(allowedToolNames?: string[]): string {
  if (allowedToolNames === undefined) {
    // 兼容非 guardrail 的历史调用；guardrail runner 必须始终显式传入白名单。
    return '本次只允许调用当前物理暴露的工具重新核实事实；严禁尝试任何未提供的工具。';
  }
  if (allowedToolNames.length === 0) {
    return '本次没有可用工具；只能基于已有事实修正回复，不能承诺稍后查询。';
  }
  return `本次只允许调用以下工具重新核实或补全必要事实：${allowedToolNames.join('、')}；严禁尝试任何其它工具。`;
}

/**
 * reengagement 主动回合 directive 注入。
 *
 * 告诉模型本回合是系统发起的主动跟进、目标是什么；话术由模型按记忆/上下文实时生成。
 * 强调主动回合的边界：只提醒/答疑，不替候选人报名/拉群（副作用工具已由 toolMode:'readonly'
 * 物理移除，这里再用 prompt 重申，双保险）。被动回合不传，返回空串。
 */
export function buildProactiveDirective(params: GeneratorInvokeParams): string {
  const directive = params.proactiveDirective?.trim();
  if (!directive) return '';
  return (
    `\n\n# 主动跟进回合（reengagement）\n` +
    `本回合不是候选人发来的消息，而是系统按既定场景发起的主动跟进。跟进目标：${directive}\n` +
    `要求：① 自然、简短、不骚扰，像真人招募经理顺手关心一句；② 只做提醒/答疑，` +
    `严禁替候选人报名/拉群/改约（这些动作只能由候选人本人在后续对话里推进）；` +
    `③ 若记忆显示候选人已报名/已转人工/已明确拒绝，则不要发起跟进。`
  );
}

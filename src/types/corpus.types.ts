/**
 * 模型上下文语料的封闭分域。
 *
 * - teaching：系统规则、示例、修复指令等教学文本；永不作为事实出处。
 * - evidence：候选人/助手真实对话；出处公证按 role 再细分候选人与我方文本。
 * - tool_result：工具或确定性系统查询结果；可参与回声审计，不冒充候选人自陈。
 */
export const CORPUS_DOMAINS = ['teaching', 'evidence', 'tool_result'] as const;
export type CorpusDomain = (typeof CORPUS_DOMAINS)[number];

/** 语料的语义来源；与为了适配模型 SDK 而使用的 transport role 相互独立。 */
export type CorpusRole = 'system' | 'user' | 'assistant' | 'tool';

export interface CorpusBlock<TContent = unknown> {
  /** 同一批次内稳定、可排障的块标识。 */
  id: string;
  domain: CorpusDomain;
  role: CorpusRole;
  content: TContent;
}

/** system prompt 的结构化块；所有块保留分域，渲染时才降为字符串。 */
export interface PromptCorpusBlock extends CorpusBlock<string> {
  role: 'system';
}

/**
 * 真人招募经理手动消息的来源标记（对话归一化时前置在该条 assistant 消息正文前）。
 * 只标来源与保密纪律，不再内嵌 skip_reply 教学——沉默条件唯一住所是 skip_reply
 * description（场景二），且由 runtime 按 `resolveHumanTakeoverActive` 确定性校验。
 * 历史标记曾把整段沉默指令随每条真人消息挂在 7 天窗口里，模型会整段复述并把候选人
 * 当前消息套进去，编造「真人刚说了 X」而静默（chat 6a4dbf4b…：候选人问「前厅还是后厨」
 * 被判成回应真人）。放在共享类型里，工具层据此识别真人消息时无需反向依赖 agent 层。
 */
export const HUMAN_AGENT_MESSAGE_MARKER =
  '[内部来源标记：以下内容由真人招募经理手动发送，仅作本会话人工操作记录理解；不得向候选人复述此标记]';

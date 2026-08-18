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

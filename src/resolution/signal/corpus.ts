import type { CorpusBlock, CorpusDomain, CorpusRole } from '@shared-types/corpus.types';

/**
 * 给对话消息补结构化语料域。只做封闭 role 字符串映射，不理解自然语言内容。
 * 未知 role 按 teaching 处理，避免 SDK 的 user transport 兜底把内部文本抬成证据。
 */
export function buildConversationCorpus(messages: readonly unknown[]): CorpusBlock[] {
  return messages.flatMap((message, index) => {
    if (!message || typeof message !== 'object') return [];
    const record = message as Record<string, unknown>;
    const semantic = classifyMessageRole(record.role);
    return [
      {
        id: `conversation-${index}`,
        domain: semantic.domain,
        role: semantic.role,
        content: record.content,
      },
    ];
  });
}

export function selectCorpusMessages(
  blocks: readonly CorpusBlock[],
  selection: {
    domains: readonly CorpusDomain[];
    roles: readonly CorpusRole[];
  },
): Array<{ role: CorpusRole; content: unknown }> {
  const domains = new Set(selection.domains);
  const roles = new Set(selection.roles);
  return blocks
    .filter((block) => domains.has(block.domain) && roles.has(block.role))
    .map((block) => ({ role: block.role, content: block.content }));
}

/**
 * 身份闸门与对话识别器的证据域视图：只保留 evidence 域的 user/assistant 消息。
 * teaching（如 revise 指令的 user transport）与 tool_result 永不进入
 * 出处判定、问答确认识别与「字段：值」表单回填。
 */
export function selectEvidenceDialogueMessages(
  blocks: readonly CorpusBlock[],
): Array<{ role: CorpusRole; content: unknown }> {
  return selectCorpusMessages(blocks, {
    domains: ['evidence'],
    roles: ['user', 'assistant'],
  });
}

function classifyMessageRole(role: unknown): { domain: CorpusDomain; role: CorpusRole } {
  if (role === 'user') return { domain: 'evidence', role: 'user' };
  if (role === 'assistant') return { domain: 'evidence', role: 'assistant' };
  if (role === 'tool') return { domain: 'tool_result', role: 'tool' };
  return { domain: 'teaching', role: 'system' };
}

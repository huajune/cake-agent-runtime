/** 只读取执行时保存的工具定义；旧记录不使用当前工具目录补齐历史现场。 */
export function renderToolDefinitionPrompt(request: Record<string, unknown>): string | undefined {
  const toolNames = Array.isArray(request.toolNames)
    ? request.toolNames.filter((name): name is string => typeof name === 'string')
    : [];
  const definitions = Array.isArray(request.toolDefinitions)
    ? request.toolDefinitions.filter(
        (item): item is Record<string, unknown> =>
          item !== null && typeof item === 'object' && !Array.isArray(item),
      )
    : [];

  if (definitions.length === 0) {
    if (toolNames.length === 0) return undefined;
    return (
      `━━━━━━━━━━ Tools（${toolNames.length} 个） ━━━━━━━━━━\n\n` +
      `工具名称：${toolNames.join('、')}\n\n` +
      '此记录未保存执行时工具定义，无法还原 description 和输入 JSON schema。'
    );
  }

  const rendered = definitions.map((definition, index) => {
    const name = typeof definition.name === 'string' ? definition.name : 'unknown';
    const sections = [`#${index + 1} ${name}`];
    if (typeof definition.description === 'string') {
      sections.push(`Description\n${definition.description}`);
    }
    if (definition.inputSchema !== undefined) {
      sections.push(`Input JSON schema\n${JSON.stringify(definition.inputSchema, null, 2)}`);
    } else if (definition.type === 'provider') {
      sections.push('由 provider 提供定义，无本地输入 schema。');
    } else {
      sections.push('输入 JSON schema 未保存。');
    }
    if (Array.isArray(definition.unavailableFields) && definition.unavailableFields.length > 0) {
      const fields = definition.unavailableFields.filter((field) => typeof field === 'string');
      sections.push(`快照未能解析：${fields.join('、')}`);
    }
    return sections.join('\n\n');
  });
  return `━━━━━━━━━━ Tools（${definitions.length} 个，执行时定义） ━━━━━━━━━━\n\n${rendered.join('\n\n')}`;
}

import { renderToolDefinitionPrompt } from '../../web/src/view/message-processing/list/components/MessageProcessingDetailDrawer/tool-definition-prompt';

describe('renderToolDefinitionPrompt', () => {
  it('renders stored descriptions and nested input schema without escaping the description', () => {
    const result = renderToolDefinitionPrompt({
      toolDefinitions: [
        {
          name: 'geocode',
          type: 'function',
          description: '执行时第一行\n执行时第二行',
          inputSchema: { properties: { address: { type: 'string', description: '地址说明' } } },
        },
      ],
    });
    expect(result).toContain('执行时定义');
    expect(result).toContain('执行时第一行\n执行时第二行');
    expect(result).toContain('"description": "地址说明"');
  });

  it('explicitly distinguishes a legacy names-only record from complete definitions', () => {
    const result = renderToolDefinitionPrompt({ toolNames: ['geocode', 'duliday_job_list'] });
    expect(result).toContain('geocode、duliday_job_list');
    expect(result).toContain('未保存执行时工具定义');
    expect(renderToolDefinitionPrompt({})).toBeUndefined();
  });

  it('handles partial and malformed snapshots without fabricating missing fields', () => {
    const result = renderToolDefinitionPrompt({
      toolDefinitions: [null, 'invalid', { name: 'geocode', unavailableFields: ['inputSchema'] }],
    });
    expect(result).toContain('Tools（1 个');
    expect(result).toContain('输入 JSON schema 未保存');
    expect(result).toContain('快照未能解析：inputSchema');
  });
});

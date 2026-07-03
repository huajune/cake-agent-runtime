import { ToolRegistryService } from '@tools/tool-registry.service';
import type { ToolBuildContext } from '@shared-types/tool.types';

function buildRegistry() {
  return new ToolRegistryService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {
      get: jest.fn((_key: string, defaultValue?: string) => defaultValue),
    } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
}

function baseContext(overrides: Partial<ToolBuildContext> = {}): ToolBuildContext {
  return {
    userId: 'user-1',
    corpId: 'corp-1',
    sessionId: 'chat-1',
    messages: [],
    ...overrides,
  } as ToolBuildContext;
}

describe('ToolRegistryService', () => {
  it('injects read_resume_attachment when resume URL is present in high-confidence facts', () => {
    const registry = buildRegistry();

    const tools = registry.buildForScenario(
      'candidate-consultation',
      baseContext({
        highConfidenceFacts: {
          interview_info: {
            upload_resume: {
              value: ' https://cdn.example.com/resume.pdf ',
              confidence: 'high',
              evidence: '候选人发送了简历附件',
            },
          },
        } as never,
      }),
    );

    expect(tools.read_resume_attachment).toBeDefined();
    expect(
      String((tools.read_resume_attachment as { description?: string }).description),
    ).toContain('https://cdn.example.com/resume.pdf');
  });

  it('deduplicates resume URLs across high-confidence and session facts', () => {
    const registry = buildRegistry();

    const tools = registry.buildForScenario(
      'candidate-consultation',
      baseContext({
        highConfidenceFacts: {
          interview_info: {
            upload_resume: {
              value: 'https://cdn.example.com/resume.pdf',
              confidence: 'high',
              evidence: '候选人发送了简历附件',
            },
          },
        } as never,
        sessionFacts: {
          interview_info: {
            upload_resume: ' https://cdn.example.com/resume.pdf ',
          },
        } as never,
      }),
    );

    const description = String(
      (tools.read_resume_attachment as { description?: string }).description,
    );
    expect(description.match(/https:\/\/cdn\.example\.com\/resume\.pdf/g)).toHaveLength(1);
  });

  it('does not inject read_resume_attachment without a resume URL', () => {
    const registry = buildRegistry();

    const tools = registry.buildForScenario('candidate-consultation', baseContext());

    expect(tools.read_resume_attachment).toBeUndefined();
  });
});

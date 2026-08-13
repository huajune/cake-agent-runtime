import { ToolRegistryService } from '@tools/tool-registry.service';
import type { ToolBuildContext } from '@shared-types/tool.types';
import { createToolContext, type ToolContextOverrides } from '../helpers/tool-context.fixture';
import { testRuleFact, testRuleFacts } from '../helpers/rule-fact-claims.fixture';

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
    // candidateSnapshotService / agentTracer（证据化裁决依赖）
    { save: jest.fn(), load: jest.fn() } as never,
    { emit: jest.fn() } as never,
  );
}

function baseContext(overrides: ToolContextOverrides = {}): ToolBuildContext {
  return createToolContext({
    session: { userId: 'user-1', corpId: 'corp-1', sessionId: 'chat-1', ...overrides.session },
    archive: overrides.archive,
    turnInput: overrides.turnInput,
    ledger: overrides.ledger,
    runtime: overrides.runtime,
  });
}

describe('ToolRegistryService', () => {
  it('injects read_resume_attachment when resume URL is present in rule claims', () => {
    const registry = buildRegistry();

    const tools = registry.buildForScenario(
      'candidate-consultation',
      baseContext({
        ledger: {
          facts: {
            ruleFacts: testRuleFacts(
              testRuleFact(
                'interview_info.upload_resume',
                ' https://cdn.example.com/resume.pdf ',
                '候选人发送了简历附件',
              ),
            ),
          },
        },
      }),
    );

    expect(tools.read_resume_attachment).toBeDefined();
    expect(
      String((tools.read_resume_attachment as { description?: string }).description),
    ).toContain('https://cdn.example.com/resume.pdf');
  });

  it('deduplicates resume URLs across rule claims and session facts', () => {
    const registry = buildRegistry();

    const tools = registry.buildForScenario(
      'candidate-consultation',
      baseContext({
        ledger: {
          facts: {
            ruleFacts: testRuleFacts(
              testRuleFact(
                'interview_info.upload_resume',
                'https://cdn.example.com/resume.pdf',
                '候选人发送了简历附件',
              ),
            ),
          },
        },
        archive: {
          sessionFacts: {
            interview_info: {
              upload_resume: ' https://cdn.example.com/resume.pdf ',
            },
          } as never,
        },
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

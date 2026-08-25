import { ToolRegistryService } from '@tools/tool-registry.service';
import type { ToolBuildContext } from '@shared-types/tool.types';
import { createToolContext, type ToolContextOverrides } from '../helpers/tool-context.fixture';
import { testTurnHint, testTurnHints } from '../helpers/turn-hints.fixture';
import type { ResumeAttachment } from '@tools/read-resume-attachment.tool';

function buildRegistry(
  options: {
    chatSessionService?: {
      updateMessageContent?: jest.Mock;
      getChatSessionMessages?: jest.Mock;
    };
    llm?: object;
  } = {},
) {
  return new ToolRegistryService(
    {} as never,
    {} as never,
    {} as never,
    { invite: jest.fn(), preflightExistingMembership: jest.fn() } as never,
    {} as never,
    {} as never,
    (options.chatSessionService ?? {}) as never,
    (options.llm ?? {}) as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    // agentTracer（证据化裁决依赖）
    { emit: jest.fn() } as never,
    // collectionFormService（收资表单接管，蓝图 §5）
    {} as never,
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
  it('injects read_resume_attachment when resume URL is present in turn hints', () => {
    const registry = buildRegistry();

    const tools = registry.buildForScenario(
      'candidate-consultation',
      baseContext({
        ledger: {
          facts: {
            turnHints: testTurnHints(
              testTurnHint(
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

  it('deduplicates resume URLs across turn hints and session facts', () => {
    const registry = buildRegistry();

    const tools = registry.buildForScenario(
      'candidate-consultation',
      baseContext({
        ledger: {
          facts: {
            turnHints: testTurnHints(
              testTurnHint(
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

  it('binds same-turn file/image URLs to their real messageId and never synthesizes one', () => {
    const registry = buildRegistry();
    const resolve = (
      registry as unknown as {
        resolveResumeAttachments(context: ToolBuildContext): ResumeAttachment[];
      }
    ).resolveResumeAttachments.bind(registry);

    const fileUrl = 'https://cdn.example.com/fake-resume.docx';
    const fileContext = baseContext({
      session: { turnId: 'file-message-1' },
      turnInput: {
        currentUserMessage: `[文件消息] 文件名：兮兮简历.docx；文件地址：${fileUrl}\n简历附件：${fileUrl}`,
      },
      ledger: {
        facts: {
          turnHints: testTurnHints(
            testTurnHint('interview_info.upload_resume', fileUrl, '候选人发送了简历附件'),
          ),
        },
      },
    });
    expect(resolve(fileContext)).toEqual([
      { fileUrl, fileName: '兮兮简历.docx', messageId: 'file-message-1' },
    ]);

    const imageUrl = 'https://cdn.example.com/fake-resume.png';
    const imageContext = baseContext({
      turnInput: { imageUrls: [imageUrl], imageMessageIds: ['image-message-1'] },
      archive: {
        sessionFacts: { interview_info: { upload_resume: imageUrl } } as never,
      },
    });
    expect(resolve(imageContext)).toEqual([
      { fileUrl: imageUrl, fileName: undefined, messageId: 'image-message-1' },
    ]);

    const historical = baseContext({
      archive: { sessionFacts: { interview_info: { upload_resume: fileUrl } } as never },
    });
    expect(resolve(historical)).toEqual([{ fileUrl, fileName: undefined, messageId: undefined }]);
  });

  it('resolves resume images to artworkUrl and never falls back to imageUrl', async () => {
    const staleUrl = 'https://cdn.example.com/thumbnail-expired.jpg';
    const artworkUrl = 'https://cdn.example.com/artwork-original.jpg';
    const getChatSessionMessages = jest.fn().mockResolvedValue({
      chatId: 'chat-1',
      messages: [
        {
          messageId: 'image-message-1',
          role: 'user',
          content: `[图片消息] 简历\n简历附件：${staleUrl}`,
          messageType: 'IMAGE',
          payload: { imageUrl: staleUrl, artworkUrl },
        },
      ],
    });
    const registry = buildRegistry({ chatSessionService: { getChatSessionMessages } });
    const resolve = (
      registry as unknown as {
        resolveResumeReadTarget(
          chatId: string,
          attachment: ResumeAttachment,
        ): Promise<{ fileUrl: string | null; messageId?: string; imageOriginal: boolean }>;
      }
    ).resolveResumeReadTarget.bind(registry);

    await expect(resolve('chat-1', { fileUrl: staleUrl })).resolves.toEqual({
      fileUrl: artworkUrl,
      messageId: 'image-message-1',
      imageOriginal: true,
    });

    getChatSessionMessages.mockResolvedValueOnce({
      chatId: 'chat-1',
      messages: [
        {
          messageId: 'image-message-2',
          role: 'user',
          content: `简历附件：${staleUrl}`,
          messageType: 'IMAGE',
          payload: { imageUrl: staleUrl },
        },
      ],
    });
    await expect(resolve('chat-1', { fileUrl: staleUrl })).resolves.toEqual({
      fileUrl: null,
      messageId: 'image-message-2',
      imageOriginal: false,
    });
  });

  it('reuses the chat message writeback path with bounded retry', async () => {
    jest.useFakeTimers();
    const updateMessageContent = jest
      .fn()
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error('not inserted yet'))
      .mockResolvedValueOnce(true);
    const registry = buildRegistry({ chatSessionService: { updateMessageContent } });
    const writeBack = (
      registry as unknown as {
        writeBackResumeMessage(messageId: string, content: string, sheet: object): Promise<boolean>;
      }
    ).writeBackResumeMessage.bind(registry);
    const sheet = { kind: 'resume', fields: [], rawDescription: '姓名：兮兮', degraded: false };

    const result = writeBack('message-1', '[文件消息] 简历解析摘要：姓名：兮兮', sheet);
    await jest.runAllTimersAsync();

    await expect(result).resolves.toBe(true);
    expect(updateMessageContent).toHaveBeenCalledTimes(3);
    expect(updateMessageContent).toHaveBeenLastCalledWith(
      'message-1',
      '[文件消息] 简历解析摘要：姓名：兮兮',
      sheet,
    );
    jest.useRealTimers();
  });
});

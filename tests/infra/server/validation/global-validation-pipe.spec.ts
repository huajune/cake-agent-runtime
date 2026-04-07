import { ArgumentMetadata } from '@nestjs/common';
import { createGlobalValidationPipe } from '@infra/server/validation/global-validation-pipe';
import { DebugChatDto } from '@agent/dto/debug-chat.dto';
import { VercelAIChatRequestDto } from '@biz/test-suite/dto/test-chat.dto';

describe('createGlobalValidationPipe', () => {
  const pipe = createGlobalValidationPipe();
  const debugMetadata: ArgumentMetadata = {
    type: 'body',
    metatype: DebugChatDto,
    data: '',
  };

  it('should transform primitive values using implicit conversion', async () => {
    const result = await pipe.transform(
      {
        messages: [
          {
            id: 'user-msg-1',
            role: 'user',
            parts: [{ type: 'text', text: '你好' }],
          },
        ],
        saveExecution: 'true',
      },
      {
        type: 'body',
        metatype: VercelAIChatRequestDto,
        data: '',
      },
    );

    expect(result).toBeInstanceOf(VercelAIChatRequestDto);
    expect(result.saveExecution).toBe(true);
  });

  it('should reject undeclared fields', async () => {
    await expect(
      pipe.transform(
        {
          message: 'hello',
          extraField: 'should-fail',
        },
        debugMetadata,
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        message: expect.arrayContaining(['property extraField should not exist']),
      }),
    });
  });

  it('should allow known AI SDK transport metadata for ai-stream requests', async () => {
    const result = await pipe.transform(
      {
        id: 'chat-1',
        trigger: 'submit-message',
        messageId: 'msg-1',
        messages: [
          {
            id: 'user-msg-1',
            role: 'user',
            parts: [{ type: 'text', text: '你好' }],
          },
        ],
        userId: 'user-1',
      },
      {
        type: 'body',
        metatype: VercelAIChatRequestDto,
        data: '',
      },
    );

    expect(result).toBeInstanceOf(VercelAIChatRequestDto);
    expect(result.id).toBe('chat-1');
    expect(result.trigger).toBe('submit-message');
    expect(result.messageId).toBe('msg-1');
  });
});

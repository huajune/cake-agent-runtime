import { ArgumentMetadata } from '@nestjs/common';
import { createGlobalValidationPipe } from '@infra/server/validation/global-validation-pipe';
import { DebugChatDto } from '@agent/dto/debug-chat.dto';

describe('createGlobalValidationPipe', () => {
  const pipe = createGlobalValidationPipe();
  const metadata: ArgumentMetadata = {
    type: 'body',
    metatype: DebugChatDto,
    data: '',
  };

  it('should transform primitive values using implicit conversion', async () => {
    const result = await pipe.transform(
      {
        message: 'hello',
        notifyBooking: 'true',
      },
      metadata,
    );

    expect(result).toBeInstanceOf(DebugChatDto);
    expect(result.notifyBooking).toBe(true);
  });

  it('should reject undeclared fields', async () => {
    await expect(
      pipe.transform(
        {
          message: 'hello',
          extraField: 'should-fail',
        },
        metadata,
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        message: expect.arrayContaining(['property extraField should not exist']),
      }),
    });
  });
});

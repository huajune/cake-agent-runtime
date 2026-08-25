import { BadRequestException, Injectable } from '@nestjs/common';
import { MemoryService } from '@memory/memory.service';
import { ResetChatSessionRequestDto } from '../dto/test-chat.dto';

@Injectable()
export class TestSuiteSessionService {
  constructor(private readonly memoryService: MemoryService) {}

  async resetChatSession(request: ResetChatSessionRequestDto) {
    const userId = request.userId?.trim();
    if (!userId) {
      throw new BadRequestException('userId 不能为空');
    }

    const corpId = request.corpId?.trim() || 'test';
    const botUserId = request.botUserId?.trim();
    if (!botUserId) {
      throw new BadRequestException('botUserId 不能为空');
    }
    const cleared = await this.memoryService.clearLongTermMemory(corpId, userId, botUserId);

    return {
      success: true,
      data: {
        userId,
        corpId,
        cleared,
      },
    };
  }
}

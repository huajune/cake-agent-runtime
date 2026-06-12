import { Body, Controller, Delete, Get, HttpCode, Post } from '@nestjs/common';
import { CandidateBlacklistService } from './services/candidate-blacklist.service';
import {
  AddCandidateBlacklistDto,
  RemoveCandidateBlacklistDto,
} from './dto/candidate-blacklist.dto';

/**
 * 候选人黑名单 Controller
 *
 * 独立业务资源（candidate_blacklist 表），命中后通过 user_hosting_status
 * 施加永久暂停托管，与 system_config 的小组黑名单无关。
 */
@Controller('candidate-blacklist')
export class CandidateBlacklistController {
  constructor(private readonly candidateBlacklistService: CandidateBlacklistService) {}

  @Get()
  async getCandidateBlacklist() {
    return { candidates: await this.candidateBlacklistService.getCandidateBlacklist() };
  }

  @Post()
  @HttpCode(200)
  async addCandidateToBlacklist(@Body() body: AddCandidateBlacklistDto) {
    await this.candidateBlacklistService.addCandidateToBlacklist({
      targetId: body.targetId,
      reason: body.reason,
      operator: body.operator,
      chatId: body.chatId,
      imContactId: body.imContactId,
      contactName: body.contactName,
    });
    return {
      message: `候选人 ${body.targetId} 已拉黑，托管账号再次收到其消息时将告警并取消托管`,
    };
  }

  @Delete()
  async removeCandidateFromBlacklist(@Body() body: RemoveCandidateBlacklistDto) {
    const removed = await this.candidateBlacklistService.removeCandidateFromBlacklist(
      body.targetId,
    );
    return {
      message: removed
        ? `候选人 ${body.targetId} 已从黑名单移除（命中时产生的永久暂停需在暂停托管列表中手动恢复）`
        : `候选人 ${body.targetId} 不在黑名单中`,
    };
  }
}

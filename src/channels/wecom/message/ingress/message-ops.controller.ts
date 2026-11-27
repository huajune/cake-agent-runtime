import { Body, Controller, Get, Post } from '@nestjs/common';
import { AllowMachineAccess } from '@infra/server/guards/api-token.guard';
import { IsInt, Max, Min } from 'class-validator';
import { MESSAGE_WORKER_CONCURRENCY } from '@biz/hosting-config/types/hosting-config.types';
import { MessageProcessor } from '../runtime/message.processor';

class SetWorkerConcurrencyDto {
  @IsInt()
  @Min(MESSAGE_WORKER_CONCURRENCY.min)
  @Max(MESSAGE_WORKER_CONCURRENCY.max)
  concurrency: number;
}

@Controller('message')
export class MessageOpsController {
  constructor(private readonly messageProcessor: MessageProcessor) {}

  @AllowMachineAccess()
  @Get('worker-status')
  getWorkerStatus() {
    return this.messageProcessor.getWorkerStatus();
  }

  @Get('queue-status')
  getQueueStatus() {
    return this.messageProcessor.getQueueStatus();
  }

  @AllowMachineAccess()
  @Post('worker-concurrency')
  async setWorkerConcurrency(@Body() body: SetWorkerConcurrencyDto) {
    return this.messageProcessor.setConcurrency(body.concurrency);
  }
}

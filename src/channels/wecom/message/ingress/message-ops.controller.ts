import { Body, Controller, Get, Post } from '@nestjs/common';
import { IsInt, Min } from 'class-validator';
import { MessageProcessor } from '../runtime/message.processor';

class SetWorkerConcurrencyDto {
  @IsInt()
  @Min(1)
  concurrency: number;
}

@Controller('message')
export class MessageOpsController {
  constructor(private readonly messageProcessor: MessageProcessor) {}

  @Get('worker-status')
  getWorkerStatus() {
    return this.messageProcessor.getWorkerStatus();
  }

  @Get('queue-status')
  getQueueStatus() {
    return this.messageProcessor.getQueueStatus();
  }

  @Post('worker-concurrency')
  async setWorkerConcurrency(@Body() body: SetWorkerConcurrencyDto) {
    return this.messageProcessor.setConcurrency(body.concurrency);
  }
}

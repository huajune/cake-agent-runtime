import { Injectable, Logger } from '@nestjs/common';
import {
  TYPING_MAX_DELAY_MS,
  TYPING_MIN_DELAY_MS,
  TYPING_RANDOM_VARIATION,
} from '@infra/config/constants/message.constants';
import { MessageRuntimeConfigService } from '../runtime/message-runtime-config.service';
import { MessageSplitter } from '../utils/message-splitter.util';

@Injectable()
export class TypingPolicyService {
  private readonly logger = new Logger(TypingPolicyService.name);
  private readonly minDelay = TYPING_MIN_DELAY_MS;
  private readonly maxDelay = TYPING_MAX_DELAY_MS;
  private readonly randomVariation = TYPING_RANDOM_VARIATION;

  constructor(private readonly runtimeConfig: MessageRuntimeConfigService) {}

  shouldSplit(content: string): boolean {
    return this.runtimeConfig.isMessageSplitSendEnabled() && MessageSplitter.needsSplit(content);
  }

  calculateDelay(text: string, isFirstSegment: boolean = false): number {
    const typingConfig = this.runtimeConfig.getTypingConfig();
    const baseDelay = (text.length / typingConfig.typingSpeedCharsPerSec) * 1000;
    const variation = 1 + (Math.random() * 2 - 1) * this.randomVariation;
    let delay = isFirstSegment ? 0 : baseDelay * variation;

    if (!isFirstSegment && delay > 0) {
      delay = Math.max(this.minDelay, Math.min(this.maxDelay, delay));
      delay = Math.max(typingConfig.paragraphGapMs, delay);
    }

    this.logger.debug(
      `计算延迟: 文本长度=${text.length}, 基础延迟=${Math.round(baseDelay)}ms, 段落间隔=${typingConfig.paragraphGapMs}ms, 实际延迟=${Math.round(delay)}ms`,
    );
    return Math.round(delay);
  }

  getSnapshot(): {
    splitSend: boolean;
    typingSpeedCharsPerSec: number;
    paragraphGapMs: number;
  } {
    const typingConfig = this.runtimeConfig.getTypingConfig();
    return {
      splitSend: this.runtimeConfig.isMessageSplitSendEnabled(),
      typingSpeedCharsPerSec: typingConfig.typingSpeedCharsPerSec,
      paragraphGapMs: typingConfig.paragraphGapMs,
    };
  }
}

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SystemConfigService } from '@biz/hosting-config/services/system-config.service';
import { AgentReplyConfig } from '@biz/hosting-config/types/hosting-config.types';

export interface MessageTypingConfig {
  typingSpeedCharsPerSec: number;
  paragraphGapMs: number;
}

@Injectable()
export class MessageRuntimeConfigService implements OnModuleInit {
  private readonly logger = new Logger(MessageRuntimeConfigService.name);
  private readonly SNAPSHOT_SYNC_INTERVAL_MS = 1_000;

  private aiReplyEnabled: boolean;
  private messageMergeEnabled: boolean;
  private messageSplitSendEnabled: boolean;
  private mergeDelayMs: number;
  private typingConfig: MessageTypingConfig;
  private overrideModelId?: string;
  private lastSyncedAt = 0;
  private syncPromise?: Promise<void>;

  constructor(
    private readonly configService: ConfigService,
    private readonly systemConfigService: SystemConfigService,
  ) {
    this.aiReplyEnabled = this.readBooleanEnv('ENABLE_AI_REPLY', true);
    this.messageMergeEnabled = this.readBooleanEnv('ENABLE_MESSAGE_MERGE', true);
    this.messageSplitSendEnabled = this.readBooleanEnv('ENABLE_MESSAGE_SPLIT_SEND', true);
    this.mergeDelayMs = 2000;
    this.typingConfig = {
      typingSpeedCharsPerSec: 8,
      paragraphGapMs: 2000,
    };

    this.systemConfigService.onAiReplyChange((enabled) => {
      this.aiReplyEnabled = enabled;
      this.logger.log(`AI 自动回复开关已更新: ${enabled ? '启用' : '禁用'}`);
    });
    this.systemConfigService.onMessageMergeChange((enabled) => {
      this.messageMergeEnabled = enabled;
      this.logger.log(`消息聚合开关已更新: ${enabled ? '启用' : '禁用'}`);
    });
    this.systemConfigService.onAgentReplyConfigChange((config) => {
      this.applyAgentReplyConfig(config);
    });
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.syncSnapshot(true);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.warn(`加载消息运行时配置失败，继续使用环境变量默认值: ${errorMessage}`);
    }

    this.logger.log(
      `消息运行时配置已就绪: aiReply=${this.aiReplyEnabled}, merge=${this.messageMergeEnabled}, splitSend=${this.messageSplitSendEnabled}, mergeDelayMs=${this.mergeDelayMs}, typing=${this.typingConfig.typingSpeedCharsPerSec}cps`,
    );
  }

  isAiReplyEnabled(): boolean {
    return this.aiReplyEnabled;
  }

  isMessageMergeEnabled(): boolean {
    return this.messageMergeEnabled;
  }

  isMessageSplitSendEnabled(): boolean {
    return this.messageSplitSendEnabled;
  }

  getMergeDelayMs(): number {
    return this.mergeDelayMs;
  }

  getTypingConfig(): MessageTypingConfig {
    return { ...this.typingConfig };
  }

  async syncSnapshot(force: boolean = false): Promise<void> {
    const now = Date.now();
    if (!force && now - this.lastSyncedAt < this.SNAPSHOT_SYNC_INTERVAL_MS) {
      return;
    }

    if (this.syncPromise) {
      return this.syncPromise;
    }

    this.syncPromise = (async () => {
      const [aiReplyEnabled, messageMergeEnabled, agentReplyConfig] = await Promise.all([
        this.systemConfigService.getAiReplyEnabled(),
        this.systemConfigService.getMessageMergeEnabled(),
        this.systemConfigService.getAgentReplyConfig(),
      ]);

      this.aiReplyEnabled = aiReplyEnabled;
      this.messageMergeEnabled = messageMergeEnabled;
      this.applyAgentReplyConfig(agentReplyConfig);
      this.lastSyncedAt = Date.now();
    })().finally(() => {
      this.syncPromise = undefined;
    });

    return this.syncPromise;
  }

  async resolveWecomChatModelSelection(): Promise<{
    overrideModelId?: string;
    effectiveModelId: string;
  }> {
    await this.syncSnapshot(true);
    const overrideModelId = this.overrideModelId?.trim() || undefined;
    const effectiveModelId =
      overrideModelId ?? this.configService.get<string>('AGENT_CHAT_MODEL') ?? '';

    return {
      overrideModelId,
      effectiveModelId,
    };
  }

  private applyAgentReplyConfig(config: AgentReplyConfig): void {
    this.overrideModelId = config.wecomCallbackModelId?.trim() || undefined;
    const nextMergeDelayMs = config.initialMergeWindowMs || 2000;
    const nextTypingSpeed =
      config.typingSpeedCharsPerSec ||
      (config.typingDelayPerCharMs ? Math.round(1000 / config.typingDelayPerCharMs) : 8);
    const nextParagraphGapMs =
      typeof config.paragraphGapMs === 'number' && config.paragraphGapMs >= 0
        ? config.paragraphGapMs
        : 2000;

    this.mergeDelayMs = nextMergeDelayMs;
    this.typingConfig = {
      typingSpeedCharsPerSec: nextTypingSpeed,
      paragraphGapMs: nextParagraphGapMs,
    };
  }

  private readBooleanEnv(key: string, defaultValue: boolean): boolean {
    return this.configService.get<string>(key, defaultValue ? 'true' : 'false') === 'true';
  }
}

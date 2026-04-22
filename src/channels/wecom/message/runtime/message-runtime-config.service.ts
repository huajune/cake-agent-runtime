import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SystemConfigService } from '@biz/hosting-config/services/system-config.service';
import {
  AgentReplyConfig,
  AgentThinkingMode,
} from '@biz/hosting-config/types/hosting-config.types';
import type { AgentThinkingConfig } from '@agent/agent-run.types';

export interface MessageTypingConfig {
  typingSpeedCharsPerSec: number;
  paragraphGapMs: number;
}

interface WecomChatSelection {
  overrideModelId?: string;
  thinkingMode: AgentThinkingMode;
  thinking: AgentThinkingConfig;
}

@Injectable()
export class MessageRuntimeConfigService implements OnModuleInit {
  private readonly logger = new Logger(MessageRuntimeConfigService.name);
  // 运营配置（AI 开关/聚合开关/模型选择）由 Dashboard 手动切换，
  // 30s 的传播延迟完全可接受；1s 过期会导致每条消息在生产者 + 消费者
  // 两端各触发一次 Supabase 3 并发查询，约 0.5-2s 阻塞关键路径。
  private readonly SNAPSHOT_SYNC_INTERVAL_MS = 30_000;
  private readonly DEFAULT_WECOM_DEEP_THINKING_BUDGET_TOKENS = 4000;

  private aiReplyEnabled: boolean;
  private messageMergeEnabled: boolean;
  private messageSplitSendEnabled: boolean;
  private mergeDelayMs: number;
  private typingConfig: MessageTypingConfig;
  private overrideModelId?: string;
  private wecomThinkingMode: AgentThinkingMode;
  private readonly wecomDeepThinkingBudgetTokens: number;
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
    this.wecomThinkingMode = 'fast';
    this.wecomDeepThinkingBudgetTokens = this.resolveWecomDeepThinkingBudgetTokens();

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

  async resolveWecomChatModelSelection(): Promise<WecomChatSelection> {
    await this.syncSnapshot(true);
    const overrideModelId = this.overrideModelId?.trim() || undefined;
    const thinkingMode = this.wecomThinkingMode;

    return {
      overrideModelId,
      thinkingMode,
      thinking:
        thinkingMode === 'deep'
          ? {
              type: 'enabled',
              budgetTokens: this.wecomDeepThinkingBudgetTokens,
            }
          : {
              type: 'disabled',
              budgetTokens: 0,
            },
    };
  }

  private applyAgentReplyConfig(config: AgentReplyConfig): void {
    this.overrideModelId = config.wecomCallbackModelId?.trim() || undefined;
    this.wecomThinkingMode = config.wecomCallbackThinkingMode === 'deep' ? 'deep' : 'fast';
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

  private resolveWecomDeepThinkingBudgetTokens(): number {
    const configuredValue = Number(this.configService.get('AGENT_THINKING_BUDGET_TOKENS', '0'));

    if (Number.isFinite(configuredValue) && configuredValue > 0) {
      return configuredValue;
    }

    return this.DEFAULT_WECOM_DEEP_THINKING_BUDGET_TOKENS;
  }
}

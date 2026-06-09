import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance, isAxiosError } from 'axios';
import * as crypto from 'crypto';
import { FEISHU_WEBHOOK_CHANNELS, type FeishuWebhookChannel } from '../constants/constants';
import { FeishuApiResponse } from '../interfaces/interface';

/**
 * 飞书发送错误，携带是否可重试的判定。
 * - 网络错误 / 超时 / HTTP 5xx / HTTP 429 / 飞书限流 code → 可重试（瞬时故障）
 * - HTTP 4xx（非 429）/ 其它飞书业务 code（卡片非法等）→ 不可重试（重发也不会成功）
 */
class FeishuSendError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'FeishuSendError';
  }
}

/** 飞书自定义机器人限流相关 code，遇到应退避重试。文档：9499=too many request。 */
const RETRYABLE_FEISHU_CODES = new Set<number>([9499, 11232]);

/**
 * 飞书 Webhook 基础服务
 * 提供统一的签名生成和消息发送能力
 */
@Injectable()
export class FeishuWebhookService {
  private readonly logger = new Logger(FeishuWebhookService.name);
  private readonly httpClient: AxiosInstance;
  private readonly fallbackWarnedChannels = new Set<FeishuWebhookChannel>();

  // 发送重试配置：对运营关键通知（报名成功/失败、转人工等）瞬时失败做退避重试，
  // 避免一次网络抖动/限流就静默丢单。总尝试 3 次，退避 500ms → 1000ms。
  private readonly MAX_SEND_ATTEMPTS = 3;
  private readonly RETRY_BASE_DELAY_MS = 500;

  constructor(private readonly configService: ConfigService) {
    this.httpClient = axios.create({
      timeout: 10000,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /**
   * 发送消息到飞书 Webhook（带退避重试 + 最终失败告警）
   * @param channel 飞书通知群通道
   * @param content 消息内容（飞书卡片 JSON）
   * @returns 是否发送成功
   */
  async sendMessage(
    channel: FeishuWebhookChannel,
    content: Record<string, unknown>,
  ): Promise<boolean> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.MAX_SEND_ATTEMPTS; attempt++) {
      try {
        await this.sendMessageOrThrow(channel, content);
        return true;
      } catch (error) {
        lastError = error;
        const retryable = error instanceof FeishuSendError ? error.retryable : false;
        const message = error instanceof Error ? error.message : String(error);
        const canRetry = retryable && attempt < this.MAX_SEND_ATTEMPTS;

        if (canRetry) {
          const delayMs = this.RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
          this.logger.warn(
            `飞书消息发送失败 [${channel}]（第 ${attempt}/${this.MAX_SEND_ATTEMPTS} 次，${delayMs}ms 后重试）: ${message}`,
          );
          await this.sleep(delayMs);
          continue;
        }

        // 不可重试，或已到最大次数：终态失败
        break;
      }
    }

    const message = lastError instanceof Error ? lastError.message : String(lastError);
    const stack = lastError instanceof Error ? lastError.stack : undefined;
    this.logger.error(
      `飞书消息发送最终失败 [${channel}]（已尝试 ${this.MAX_SEND_ATTEMPTS} 次）: ${message}`,
      stack,
    );
    await this.notifySendFailure(channel, message);
    return false;
  }

  async sendMessageOrThrow(
    channel: FeishuWebhookChannel,
    content: Record<string, unknown>,
  ): Promise<void> {
    const config = this.getWebhookConfig(channel);

    if (!config.url) {
      // 配置缺失属永久错误，重试无意义
      throw new FeishuSendError(`未配置 ${channel} Webhook URL`, false);
    }

    let payload = content;
    if (config.secret) {
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const sign = this.generateSign(timestamp, config.secret);
      payload = { ...content, timestamp, sign };
    }

    try {
      const response = await this.httpClient.post<FeishuApiResponse>(config.url, payload);
      const code = response.data?.code;
      if (code !== 0) {
        throw new FeishuSendError(
          `飞书 API 返回错误: ${JSON.stringify(response.data)}`,
          RETRYABLE_FEISHU_CODES.has(code ?? -1),
        );
      }
      this.logger.log(`飞书消息发送成功 [${channel}]`);
    } catch (error) {
      if (error instanceof FeishuSendError) throw error;
      if (isAxiosError(error)) {
        const status = error.response?.status;
        const data = error.response?.data;
        const detail = data ? JSON.stringify(data) : error.message;
        // 无响应（网络/超时）、429 限流、5xx 服务端错误 → 可重试；其余 4xx → 不可重试
        const retryable = status === undefined || status === 429 || status >= 500;
        throw new FeishuSendError(
          `飞书 HTTP 请求失败 [status=${status ?? 'n/a'}]: ${detail}`,
          retryable,
        );
      }
      throw new FeishuSendError(error instanceof Error ? error.message : String(error), false);
    }
  }

  /**
   * 通知发送终态失败时，向告警群补发一条可见告警，把"静默丢单"变成可观测。
   * best-effort：单次发送、自身失败只记日志；告警群自身失败时不再递归告警。
   */
  private async notifySendFailure(
    failedChannel: FeishuWebhookChannel,
    reason: string,
  ): Promise<void> {
    if (failedChannel === 'ALERT') return; // 避免告警群自身失败时递归/雪崩

    try {
      const card = this.buildFailureAlertCard(failedChannel, reason);
      await this.sendMessageOrThrow('ALERT', card);
    } catch (error) {
      this.logger.error(
        `飞书发送失败告警补发也失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private buildFailureAlertCard(
    failedChannel: FeishuWebhookChannel,
    reason: string,
  ): Record<string, unknown> {
    const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const truncatedReason = reason.length > 500 ? `${reason.slice(0, 500)}…` : reason;
    const content = [
      `**失败通道**：${failedChannel}`,
      `**已重试次数**：${this.MAX_SEND_ATTEMPTS}`,
      `**最后错误**：${truncatedReason}`,
      `**时间**：${now}`,
      '> 该通道的一条通知未能送达，请人工核查对应业务（如报名/转人工）是否需要补处理。',
    ].join('\n');

    return {
      msg_type: 'interactive',
      card: {
        config: { wide_screen_mode: true },
        header: {
          title: { tag: 'plain_text', content: `🚨 飞书通知发送失败 · ${failedChannel}` },
          template: 'red',
        },
        elements: [{ tag: 'markdown', content }],
      },
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * 获取 Webhook 配置
   * 优先使用环境变量，否则使用硬编码默认值
   */
  private getWebhookConfig(channel: FeishuWebhookChannel): {
    url: string;
    secret: string;
  } {
    const defaultConfig = FEISHU_WEBHOOK_CHANNELS[channel];
    const envUrl = this.configService.get<string>(defaultConfig.ENV_URL_KEY);
    const envSecret = this.configService.get<string>(defaultConfig.ENV_SECRET_KEY);
    const missingKeys: string[] = [];

    if (envUrl === undefined && defaultConfig.URL) {
      missingKeys.push(defaultConfig.ENV_URL_KEY);
    }
    if (envSecret === undefined && defaultConfig.SECRET) {
      missingKeys.push(defaultConfig.ENV_SECRET_KEY);
    }

    if (missingKeys.length > 0 && !this.fallbackWarnedChannels.has(channel)) {
      this.logger.warn(
        `[${channel}] 未配置 ${missingKeys.join(' / ')}，回退到代码默认 Webhook 配置`,
      );
      this.fallbackWarnedChannels.add(channel);
    }

    return {
      url: envUrl ?? defaultConfig.URL,
      secret: envSecret ?? defaultConfig.SECRET,
    };
  }

  /**
   * 生成飞书签名
   * 算法：HmacSHA256(空字节数组, key=timestamp+"\n"+secret) -> Base64
   * 文档：https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot
   */
  private generateSign(timestamp: string, secret: string): string {
    const stringToSign = `${timestamp}\n${secret}`;
    const hmac = crypto.createHmac('sha256', stringToSign);
    hmac.update(Buffer.alloc(0)); // 对空字节数组签名
    return hmac.digest('base64');
  }
}

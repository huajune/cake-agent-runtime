import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import * as crypto from 'crypto';
import {
  FEISHU_WEBHOOK_CHANNELS,
  type FeishuWebhookChannel,
} from '../constants/constants';
import { FeishuApiResponse } from '../interfaces/interface';

/**
 * 飞书 Webhook 基础服务
 * 提供统一的签名生成和消息发送能力
 */
@Injectable()
export class FeishuWebhookService {
  private readonly logger = new Logger(FeishuWebhookService.name);
  private readonly httpClient: AxiosInstance;

  constructor(private readonly configService: ConfigService) {
    this.httpClient = axios.create({
      timeout: 10000,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /**
   * 发送消息到飞书 Webhook
   * @param channel 飞书通知群通道
   * @param content 消息内容（飞书卡片 JSON）
   * @returns 是否发送成功
   */
  async sendMessage(channel: FeishuWebhookChannel, content: Record<string, unknown>): Promise<boolean> {
    try {
      // 获取配置（优先使用环境变量，否则使用硬编码）
      const config = this.getWebhookConfig(channel);

      if (!config.url) {
        this.logger.warn(`未配置 ${channel} Webhook URL`);
        return false;
      }

      // 添加签名
      let payload = content;
      if (config.secret) {
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const sign = this.generateSign(timestamp, config.secret);
        payload = { ...content, timestamp, sign };
      }

      // 发送请求
      const response = await this.httpClient.post<FeishuApiResponse>(config.url, payload);

      if (response.data?.code !== 0) {
        throw new Error(`飞书 API 返回错误: ${JSON.stringify(response.data)}`);
      }

      this.logger.log(`飞书消息发送成功 [${channel}]`);
      return true;
    } catch (error) {
      this.logger.error(`飞书消息发送失败 [${channel}]: ${error.message}`, error.stack);
      return false;
    }
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

    return {
      url: this.configService.get<string>(defaultConfig.ENV_URL_KEY, defaultConfig.URL),
      secret: this.configService.get<string>(defaultConfig.ENV_SECRET_KEY, defaultConfig.SECRET),
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

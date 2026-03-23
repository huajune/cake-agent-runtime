import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import * as crypto from 'crypto';
import { FEISHU_WEBHOOKS } from '../constants/constants';
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
   * @param webhookType Webhook 类型 ('ALERT' | 'INTERVIEW_BOOKING')
   * @param content 消息内容（飞书卡片 JSON）
   * @returns 是否发送成功
   */
  async sendMessage(
    webhookType: keyof typeof FEISHU_WEBHOOKS,
    content: Record<string, unknown>,
  ): Promise<boolean> {
    try {
      // 获取配置（优先使用环境变量，否则使用硬编码）
      const config = this.getWebhookConfig(webhookType);

      if (!config.url) {
        this.logger.warn(`未配置 ${webhookType} Webhook URL`);
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

      this.logger.log(`飞书消息发送成功 [${webhookType}]`);
      return true;
    } catch (error) {
      this.logger.error(`飞书消息发送失败 [${webhookType}]: ${error.message}`, error.stack);
      return false;
    }
  }

  /**
   * 获取 Webhook 配置
   * 优先使用环境变量，否则使用硬编码默认值
   */
  private getWebhookConfig(webhookType: keyof typeof FEISHU_WEBHOOKS): {
    url: string;
    secret: string;
  } {
    const defaultConfig = FEISHU_WEBHOOKS[webhookType];

    // 根据类型选择对应的环境变量
    const envUrlKey =
      webhookType === 'ALERT' ? 'FEISHU_ALERT_WEBHOOK_URL' : 'INTERVIEW_BOOKING_WEBHOOK_URL';
    const envSecretKey =
      webhookType === 'ALERT' ? 'FEISHU_ALERT_SECRET' : 'INTERVIEW_BOOKING_WEBHOOK_SECRET';

    return {
      url: this.configService.get<string>(envUrlKey, defaultConfig.URL),
      secret: this.configService.get<string>(envSecretKey, defaultConfig.SECRET),
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

  /**
   * 构建飞书卡片消息
   * @param title 标题
   * @param content Markdown 内容
   * @param color 卡片颜色
   * @param atUsers 需要 @ 的用户列表
   */
  buildCard(
    title: string,
    content: string,
    color: 'blue' | 'green' | 'yellow' | 'red' = 'blue',
    atUsers?: Array<{ openId: string; name: string }>,
  ): Record<string, unknown> {
    const elements: Array<Record<string, unknown>> = [
      {
        tag: 'markdown',
        content,
      },
    ];

    // 如果有需要 @ 的用户，添加 @ 区域
    if (atUsers && atUsers.length > 0) {
      // 添加分隔线和 @ 区域
      elements.push({
        tag: 'hr',
      });
      elements.push({
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**请关注**: ${atUsers.map((u) => `<at id=${u.openId}></at>`).join(' ')}`,
        },
      });
    }

    return {
      msg_type: 'interactive',
      card: {
        config: { wide_screen_mode: true },
        header: {
          title: { tag: 'plain_text', content: title },
          template: color,
        },
        elements,
      },
    };
  }

  /**
   * 构建带 @ 所有人的卡片
   * 注意：需要机器人是群主或管理员才能 @ 所有人
   */
  buildCardWithAtAll(
    title: string,
    content: string,
    color: 'blue' | 'green' | 'yellow' | 'red' = 'blue',
  ): Record<string, unknown> {
    const elements: Array<Record<string, unknown>> = [
      {
        tag: 'markdown',
        content,
      },
      {
        tag: 'hr',
      },
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: '**请关注**: <at id=all></at>',
        },
      },
    ];

    return {
      msg_type: 'interactive',
      card: {
        config: { wide_screen_mode: true },
        header: {
          title: { tag: 'plain_text', content: title },
          template: color,
        },
        elements,
      },
    };
  }
}

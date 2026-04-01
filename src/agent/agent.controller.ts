import { Controller, Get, Post, Body, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { Public } from '@infra/server/response/decorators/api-response.decorator';
import { FeishuAlertService } from '@infra/feishu/services/alert.service';
import { AgentRunnerService } from './runner.service';
import { RegistryService } from '@providers/registry.service';
import { AgentHealthService } from './agent-health.service';
import { BookingDetectionService } from '@biz/message/services/booking-detection.service';

@Controller('agent')
export class AgentController {
  private readonly logger = new Logger(AgentController.name);

  constructor(
    private readonly runner: AgentRunnerService,
    private readonly feishuAlertService: FeishuAlertService,
    private readonly registry: RegistryService,
    private readonly healthService: AgentHealthService,
    private readonly bookingDetection: BookingDetectionService,
  ) {}

  /**
   * 健康检查（真实检测）
   * GET /agent/health
   *
   * healthy:   Redis + Supabase 均可用
   * degraded:  Supabase 不可用（历史/配置受影响，但消息处理仍可用）
   * unhealthy: Redis 不可用（消息队列完全瘫痪）
   */
  @Public()
  @Get('health')
  async healthCheck() {
    return this.healthService.check();
  }

  /**
   * 可用模型列表
   * GET /agent/models
   */
  @Get('models')
  listModels() {
    return {
      models: this.registry.listModels(),
      total: this.registry.listModels().length,
    };
  }

  /**
   * 调试接口：测试聊天并返回完整响应
   * POST /agent/debug-chat
   */
  @Post('debug-chat')
  async debugChat(
    @Body()
    body: {
      message: string;
      sessionId?: string;
      scenario?: string;
      userId?: string;
      notifyBooking?: boolean;
    },
  ) {
    this.logger.log(`【调试模式】测试聊天: ${body.message}`);
    const sessionId = body.sessionId || `debug-${Date.now()}`;
    const scenario = body.scenario || 'candidate-consultation';

    try {
      const result = await this.runner.invoke({
        messages: [{ role: 'user', content: body.message }],
        userId: body.userId || 'debug-user',
        corpId: 'debug',
        sessionId,
        scenario,
      });

      if (body.notifyBooking === true) {
        await this.bookingDetection.handleBookingSuccessAsync({
          chatId: sessionId,
          contactName: body.userId || 'debug-user',
          userId: body.userId || 'debug-user',
          managerId: 'debug-agent',
          managerName: 'Agent Debug',
          toolCalls: result.toolCalls,
        });
      }

      return {
        success: true,
        sessionId,
        scenario,
        reasoning: result.reasoning,
        text: result.text,
        usage: result.usage,
        steps: result.steps,
      };
    } catch (error) {
      this.logger.error('调试聊天失败:', error);

      this.feishuAlertService
        .sendAlert({
          errorType: 'agent',
          error,
          apiEndpoint: '/agent/debug-chat',
          scenario,
        })
        .catch((alertError: Error) => {
          this.logger.error(`飞书告警发送失败: ${alertError.message}`);
        });

      throw new HttpException(
        {
          success: false,
          message: 'Agent 调用失败',
          error: error instanceof Error ? error.message : String(error),
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}

import { Controller, Get, Post, Body, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { FeishuAlertService } from '@infra/feishu/services/alert.service';
import { SystemPromptService } from './system-prompt.service';
import { LoopService } from './loop.service';
import { RouterService } from '@providers/router.service';

@Controller('agent')
export class AgentController {
  private readonly logger = new Logger(AgentController.name);

  constructor(
    private readonly systemPrompt: SystemPromptService,
    private readonly feishuAlertService: FeishuAlertService,
    private readonly loop: LoopService,
    private readonly router: RouterService,
  ) {}

  /**
   * 健康检查
   * GET /agent/health
   */
  @Get('health')
  healthCheck() {
    return {
      status: 'healthy',
      providers: this.router.listRoles(),
      scenarios: this.systemPrompt.getLoadedScenarios(),
      message: 'Agent 服务正常',
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
    },
  ) {
    this.logger.log(`【调试模式】测试聊天: ${body.message}`);
    const sessionId = body.sessionId || `debug-${Date.now()}`;
    const scenario = body.scenario || 'candidate-consultation';

    try {
      const result = await this.loop.run({
        messages: [{ role: 'user', content: body.message }],
        userId: body.userId || 'debug-user',
        corpId: 'debug',
        scenario,
      });

      return {
        success: true,
        sessionId,
        scenario,
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

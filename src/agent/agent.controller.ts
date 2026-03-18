import { Controller, Get, Post, Body, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { FeishuAlertService } from '@infra/feishu/services/alert.service';
import { LoopService } from './loop.service';
import { ContextService } from './context/context.service';
import { RouterService } from '@providers/router.service';
import { RegistryService } from '@providers/registry.service';

@Controller('agent')
export class AgentController {
  private readonly logger = new Logger(AgentController.name);

  constructor(
    private readonly loop: LoopService,
    private readonly context: ContextService,
    private readonly feishuAlertService: FeishuAlertService,
    private readonly router: RouterService,
    private readonly registry: RegistryService,
  ) {}

  /**
   * 健康检查
   * GET /agent/health
   */
  @Get('health')
  healthCheck() {
    return {
      status: 'healthy',
      providers: this.registry.listProviders(),
      roles: this.router.listRoleDetails(),
      scenarios: this.context.getLoadedScenarios(),
      message: 'Agent 服务正常',
    };
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
    },
  ) {
    this.logger.log(`【调试模式】测试聊天: ${body.message}`);
    const sessionId = body.sessionId || `debug-${Date.now()}`;
    const scenario = body.scenario || 'candidate-consultation';

    try {
      const result = await this.loop.invoke({
        messages: [{ role: 'user', content: body.message }],
        userId: body.userId || 'debug-user',
        corpId: 'debug',
        sessionId,
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

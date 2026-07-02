import { Controller, Get, Post, Body, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { Public } from '@infra/server/response/decorators/api-response.decorator';
import { AlertNotifierService } from '@notification/services/alert-notifier.service';
import { CallerKind } from '@enums/agent.enum';
import { AgentRunnerService } from './runner/agent-runner.service';
import { RegistryService } from '@providers/registry.service';
import { AgentHealthService } from './agent-health.service';
import { DebugChatDto } from './dto/debug-chat.dto';

@Controller('agent')
export class AgentController {
  private readonly logger = new Logger(AgentController.name);

  constructor(
    private readonly runner: AgentRunnerService,
    private readonly alertService: AlertNotifierService,
    private readonly registry: RegistryService,
    private readonly healthService: AgentHealthService,
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
  async debugChat(@Body() body: DebugChatDto) {
    this.logger.log(`【调试模式】测试聊天: ${body.message}`);
    const sessionId = body.sessionId || `debug-${Date.now()}`;
    const scenario = body.scenario || 'candidate-consultation';

    try {
      // 走 invokeReviewed 而非裸 generator：调试页需要看到与生产一致的
      // guardrail runtime 过程（rule/llm 裁决 → 受控 repair → 最终 veto）。
      const result = await this.runner.invokeReviewed(
        {
          callerKind: CallerKind.DEBUG,
          messages: [{ role: 'user', content: body.message }],
          userId: body.userId || 'debug-user',
          corpId: 'debug',
          sessionId,
          scenario,
          strategySource: 'testing',
          contactName: body.contactName,
        },
        {
          userMessage: body.message,
          chatId: sessionId,
          userId: body.userId || 'debug-user',
          contactName: body.contactName,
        },
      );

      return {
        success: true,
        sessionId,
        scenario,
        reasoning: result.reasoning,
        text: result.text,
        usage: result.usage,
        steps: result.steps,
        // 调试专用：完整出站裁决（含 violations 证据/建议全文）+ 全程 trace。
        guardrail: {
          decision: result.outputDecision,
          revised: result.revised,
          trace: result.guardrailTrace,
        },
      };
    } catch (error) {
      this.logger.error('调试聊天失败:', error);

      this.alertService
        .sendAlert({
          code: 'agent.debug_chat_failed',
          summary: 'Agent 调试聊天失败',
          source: {
            subsystem: 'agent',
            component: 'AgentController',
            action: 'debugChat',
            trigger: 'http',
          },
          scope: {
            scenario,
          },
          diagnostics: {
            error,
          },
          dedupe: {
            key: `agent.debug_chat_failed:${scenario}`,
          },
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

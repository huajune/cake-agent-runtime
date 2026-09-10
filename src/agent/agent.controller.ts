import { toErrorMessage } from '@infra/utils/error.util';
import {
  Controller,
  Get,
  Post,
  Body,
  Logger,
  HttpException,
  HttpStatus,
  Optional,
} from '@nestjs/common';
import { Public } from '@infra/server/response/decorators/api-response.decorator';
import { AlertNotifierService } from '@notification/services/alert-notifier.service';
import { CallerKind } from '@enums/agent.enum';
import { AgentRunnerService } from './runner/agent-runner.service';
import { RegistryService } from '@providers/registry.service';
import { AgentHealthService } from './agent-health.service';
import { DebugChatDto } from './debug-chat.dto';
import { AgentTracerService } from '@observability/agent-tracer.service';
import { RequestContextService } from '@observability/context/request-context.service';

@Controller('agent')
export class AgentController {
  private readonly logger = new Logger(AgentController.name);

  constructor(
    private readonly runner: AgentRunnerService,
    private readonly alertService: AlertNotifierService,
    private readonly registry: RegistryService,
    private readonly healthService: AgentHealthService,
    @Optional()
    private readonly requestContext?: RequestContextService,
    @Optional()
    private readonly tracer?: AgentTracerService,
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
    const traceId = `${sessionId}:${Date.now()}`;
    const telemetryContext = {
      traceId,
      chatId: sessionId,
      userId: body.userId || 'debug-user',
      corpId: 'debug',
      scenario,
      callerKind: CallerKind.DEBUG,
    };

    // try/catch 放在请求上下文之内：agent_error 事件与其余事件一样由 tracer 补齐 trace 维度。
    const runDebugChat = async () => {
      const startedAt = Date.now();
      try {
        this.tracer?.emit({ type: 'agent_start' });
        // 走 invokeReviewed 而非裸 generator：调试页需要看到与生产一致的
        // guardrail runtime 过程（rule 裁决 → 受控 repair → 最终处置）。
        const result = await this.runner.invokeReviewed(
          {
            callerKind: CallerKind.DEBUG,
            messages: [{ role: 'user', content: body.message }],
            userId: telemetryContext.userId,
            corpId: telemetryContext.corpId,
            sessionId,
            scenario,
            strategySource: 'testing',
            contactName: body.contactName,
          },
          {
            userMessage: body.message,
            chatId: sessionId,
            userId: telemetryContext.userId,
            traceId,
            contactName: body.contactName,
          },
        );
        this.tracer?.emit({
          type: 'agent_end',
          steps: result.steps,
          totalTokens: result.usage.totalTokens,
          durationMs: Date.now() - startedAt,
        });

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
            resolution: result.resolution,
            revised: result.revised,
            trace: result.guardrailTrace,
          },
        };
      } catch (error) {
        this.tracer?.emit({ type: 'agent_error', error: toErrorMessage(error) });
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
            error: toErrorMessage(error),
          },
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }
    };

    return this.requestContext
      ? this.requestContext.run(telemetryContext, runDebugChat)
      : runDebugChat();
  }
}

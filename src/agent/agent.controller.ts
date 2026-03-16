import {
  Controller,
  Get,
  Post,
  Body,
  Logger,
  Param,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FeishuAlertService } from '@core/feishu';
import { ProfileLoaderService } from './services/profile-loader.service';
import { OrchestratorService } from './services/orchestrator.service';
import { RouterService } from '@providers/router.service';
import { ToolRegistryService } from '@tools/tool-registry.service';

@Controller('agent')
export class AgentController {
  private readonly logger = new Logger(AgentController.name);

  constructor(
    private readonly profileLoader: ProfileLoaderService,
    private readonly configService: ConfigService,
    private readonly feishuAlertService: FeishuAlertService,
    private readonly orchestrator: OrchestratorService,
    private readonly router: RouterService,
    private readonly toolRegistry: ToolRegistryService,
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
      message: 'Agent 服务正常',
    };
  }

  /**
   * 获取所有配置档案
   * GET /agent/profiles
   */
  @Get('profiles')
  getProfiles() {
    const profiles = this.profileLoader.getAllProfiles();
    return profiles.map((p) => ({
      name: p.name,
      description: p.description,
      model: p.model,
      allowedTools: p.allowedTools,
      hasContext: !!p.context,
      contextStrategy: p.contextStrategy,
      prune: p.prune,
    }));
  }

  /**
   * 获取特定配置档案（公开接口，已脱敏）
   * GET /agent/profiles/:scenario
   *
   * 安全说明：
   * - 此接口返回脱敏后的配置摘要，不包含敏感凭据
   * - context、toolContext、systemPrompt 等字段已移除
   * - 仅返回公开可见的元数据
   */
  @Get('profiles/:scenario')
  getProfile(@Param('scenario') scenario: string) {
    const profile = this.profileLoader.getProfile(scenario);
    if (!profile) {
      throw new HttpException(`未找到场景 ${scenario} 的配置`, HttpStatus.NOT_FOUND);
    }

    // 返回脱敏后的公开版本，移除敏感字段
    return {
      name: profile.name,
      description: profile.description,
      model: profile.model,
      allowedTools: profile.allowedTools || [],
      contextStrategy: profile.contextStrategy,
      prune: profile.prune,
      pruneOptions: profile.pruneOptions,
      // 敏感字段已移除：
      // - context（可能包含 API tokens）
      // - toolContext（可能包含业务敏感配置）
      // - systemPrompt（可能包含业务逻辑）
    };
  }

  /**
   * 调试接口：测试聊天并返回完整响应
   * POST /agent/debug-chat
   * Body: { "message": "你好", "sessionId"?: "...", "scenario"?: "...", "userId"?: "..." }
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
      const result = await this.orchestrator.run({
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

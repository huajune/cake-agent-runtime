import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatRequest, ChatResponse } from './agent-types';

/**
 * Agent logging utility
 * Handles request and response logging
 */
export class AgentLogger {
  constructor(
    private readonly logger: Logger,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Log chat request
   */
  logRequest(sessionId: string, request: ChatRequest): void {
    const toolsCount = request.allowedTools?.length || 0;
    this.logger.log(
      `[Request] conversation:${sessionId}, messages:${request.messages.length}, tools:${toolsCount}`,
    );
  }

  /**
   * Log chat response
   */
  logResponse(sessionId: string, response: ChatResponse): void {
    const messageCount = response.messages?.length || 0;
    const usedTools = response.tools?.used || [];
    const toolsStr = usedTools.length > 0 ? usedTools.join(', ') : 'none';

    // 记录响应概览
    this.logger.log(
      `[Response] conversation:${sessionId}, messages:${messageCount}, usedTools:${toolsStr}`,
    );
  }
}

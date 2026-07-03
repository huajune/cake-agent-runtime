import { Injectable, Logger } from '@nestjs/common';
import { createUIMessageStream, pipeUIMessageStreamToResponse, type UIMessageChunk } from 'ai';
import { Response } from 'express';
import { randomUUID } from 'node:crypto';
import { OutputGuardrailService } from '@agent/guardrail/output/output-guardrail.service';
import type { GuardrailTurnTrace } from '@shared-types/guardrail.contract';
import { TestChatRequestDto, VercelAIChatRequestDto } from '../dto/test-chat.dto';
import { SSEStreamHandler } from '../utils/sse-stream-handler';
import { AiStreamObservabilityService } from './ai-stream-observability.service';
import { TestExecutionService } from './test-execution.service';

@Injectable()
export class TestSuiteStreamingService {
  private readonly logger = new Logger(TestSuiteStreamingService.name);

  constructor(
    private readonly executionService: TestExecutionService,
    private readonly aiStreamObservability: AiStreamObservabilityService,
    private readonly outputGuard: OutputGuardrailService,
  ) {}

  async testChatStream(request: TestChatRequestDto, res: Response): Promise<void> {
    const handler = new SSEStreamHandler(res, '[Stream]');
    handler.setupHeaders();

    try {
      handler.sendStart();
      const stream = await this.executionService.executeTestStream(request);

      stream.on('data', (chunk: Buffer) => handler.processChunk(chunk));
      stream.on('end', () => {
        handler.sendDone();
        handler.end();
      });
      stream.on('error', (error: Error) => {
        this.logger.error(`[Stream] 流式处理错误: ${error.message}`);
        handler.sendError(error.message);
        handler.end();
      });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      handler.sendError(errorMessage);
      handler.end();
    }
  }

  async testChatAIStream(request: VercelAIChatRequestDto, res: Response): Promise<void> {
    const transportMessages = Array.isArray(request.messages) ? request.messages : [];
    const { testRequest, messageText } =
      this.executionService.convertVercelAIToTestRequest(request);
    const sessionId = testRequest.sessionId ?? `test-${randomUUID()}`;
    const normalizedRequest = {
      ...testRequest,
      sessionId,
    };
    const requestBody = {
      transportRequest: {
        scenario: request.scenario,
        sessionId: request.sessionId,
        userId: request.userId,
        botUserId: request.botUserId,
        botImId: request.botImId,
        thinking: request.thinking,
        saveExecution: request.saveExecution ?? false,
        messages: transportMessages,
        modelId: request.modelId,
      },
      normalizedRequest: {
        scenario: normalizedRequest.scenario,
        sessionId,
        userId: normalizedRequest.userId,
        botUserId: normalizedRequest.botUserId,
        botImId: normalizedRequest.botImId,
        thinking: normalizedRequest.thinking,
        saveExecution: normalizedRequest.saveExecution ?? false,
        skipHistoryTrim: normalizedRequest.skipHistoryTrim ?? false,
        message: normalizedRequest.message,
        history: normalizedRequest.history,
        imageUrls: normalizedRequest.imageUrls,
        modelId: normalizedRequest.modelId,
      },
    };
    const trace = this.aiStreamObservability.startTrace({
      chatId: sessionId,
      userId: normalizedRequest.userId,
      scenario: normalizedRequest.scenario,
      messageText,
      requestBody,
      source: 'testing',
    });

    this.logger.log(
      `[AI-Stream] 执行流式测试: ${messageText.substring(0, 50)}... (共 ${transportMessages.length} 条消息)`,
    );

    try {
      trace.markAiStart();
      const { streamResult, entryStage, agentRequest } =
        await this.executionService.executeTestStreamWithMeta(normalizedRequest);
      if (agentRequest) {
        trace.mergeRequestBody({ agentRequest });
      }
      trace.markStreamReady(entryStage);
      res.setHeader('X-Agent-Trace-Id', trace.messageId);

      const uiStream = createUIMessageStream({
        execute: async ({ writer }) => {
          try {
            if (entryStage) {
              writer.write({
                type: 'data-entryStage',
                data: entryStage,
              } as UIMessageChunk);
            }

            trace.markResponsePipeStart();

            const reader = streamResult.toUIMessageStream({ sendReasoning: true }).getReader();
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                trace.observeChunk(value);
                writer.write(value);
              }
            } finally {
              reader.releaseLock();
            }

            if (trace.hasStreamError()) {
              const streamError = trace.getStreamErrorMessage() || 'AI stream returned error chunk';
              writer.write({
                type: 'data-observability',
                data: trace.getClientPayload('failure', streamError),
              } as UIMessageChunk);
              trace.finalizeFailure(streamError);
              return;
            }

            const usage = await streamResult.usage;
            trace.recordUsage({
              inputTokens: usage.inputTokens ?? 0,
              outputTokens: usage.outputTokens ?? 0,
              totalTokens: usage.totalTokens,
            });
            writer.write({
              type: 'data-tokenUsage',
              data: {
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
                totalTokens: usage.totalTokens,
              },
            } as UIMessageChunk);

            const guardrailTrace = await this.buildAdvisoryGuardrail(trace, messageText);
            if (guardrailTrace) {
              writer.write({
                type: 'data-guardrail',
                data: guardrailTrace,
              } as UIMessageChunk);
            }

            writer.write({
              type: 'data-observability',
              data: trace.getClientPayload('success'),
            } as UIMessageChunk);

            trace.finalizeSuccess();
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            writer.write({
              type: 'data-observability',
              data: trace.getClientPayload('failure', errorMessage),
            } as UIMessageChunk);
            trace.finalizeFailure(error);
            throw error;
          }
        },
      });

      pipeUIMessageStreamToResponse({ response: res, stream: uiStream });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      trace.finalizeFailure(error);
      if (!res.headersSent) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.flushHeaders();
      }
      res.write(`data: ${JSON.stringify({ type: 'error', error: errorMessage })}\n\n`);
      res.end();
    }
  }

  private async buildAdvisoryGuardrail(
    trace: ReturnType<AiStreamObservabilityService['startTrace']>,
    userMessage: string,
  ): Promise<GuardrailTurnTrace | null> {
    try {
      const { reply, toolCalls } = trace.getReviewInput();
      if (!reply.trim()) return null;

      const decision = await this.outputGuard.check({
        reply,
        toolCalls: toolCalls ?? [],
        userMessage,
        silent: true,
      });

      return {
        steps: [
          {
            stage: 'first',
            decision: decision.decision,
            riskLevel: decision.riskLevel,
            ruleIds: decision.ruleIds,
            blockedRuleIds: decision.blockedRuleIds,
            violationTypes: decision.violations.map((v) => v.type),
            repairMode: decision.repairMode,
            reasonCode: decision.reasonCode,
          },
        ],
        repaired: false,
        finalDecision: decision.decision,
        reasonCode: decision.reasonCode,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`[AI-Stream] advisory 守卫审查失败（忽略）: ${message}`);
      return null;
    }
  }
}

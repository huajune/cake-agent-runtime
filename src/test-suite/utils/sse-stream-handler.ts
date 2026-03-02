import { Logger } from '@nestjs/common';
import { Response } from 'express';

/**
 * SSE 事件类型
 */
export type SSEEventType =
  | 'start'
  | 'text'
  | 'tool_call'
  | 'tool_result'
  | 'metrics'
  | 'done'
  | 'error';

/**
 * 工具调用信息
 */
export interface ToolCallInfo {
  toolCallId?: string;
  toolName: string;
  input?: unknown;
  output?: unknown;
}

/**
 * Token 使用统计
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/**
 * 流处理累积数据
 */
export interface StreamAccumulator {
  fullText: string;
  toolCalls: ToolCallInfo[];
  tokenUsage: TokenUsage;
}

/**
 * 花卷 API 流式数据格式
 */
interface HuajuanStreamData {
  type?: string;
  id?: string;
  delta?: string;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
}

/**
 * SSE 流处理工具类
 *
 * 职责：
 * - 解析花卷 API 的流式响应
 * - 发送 SSE 事件到客户端
 * - 累积流式数据用于最终统计
 * - 处理不同格式的流式事件
 */
export class SSEStreamHandler {
  private readonly logger = new Logger(SSEStreamHandler.name);
  private readonly accumulator: StreamAccumulator;
  private readonly startTime: number;

  constructor(
    private readonly res: Response,
    private readonly logPrefix = '[SSE]',
  ) {
    this.startTime = Date.now();
    this.accumulator = {
      fullText: '',
      toolCalls: [],
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    };
  }

  /**
   * 设置 SSE 响应头
   */
  setupHeaders(): void {
    this.res.setHeader('Content-Type', 'text/event-stream');
    this.res.setHeader('Cache-Control', 'no-cache');
    this.res.setHeader('Connection', 'keep-alive');
    this.res.setHeader('X-Accel-Buffering', 'no');
    this.res.flushHeaders();
  }

  /**
   * 设置 Vercel AI SDK 兼容的响应头
   */
  setupVercelAIHeaders(): void {
    this.setupHeaders();
    this.res.setHeader('x-vercel-ai-ui-message-stream', 'v1');
  }

  /**
   * 发送 SSE 事件
   */
  sendEvent(event: SSEEventType, data: unknown): void {
    this.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  /**
   * 发送开始事件
   */
  sendStart(): void {
    this.sendEvent('start', { timestamp: new Date().toISOString() });
  }

  /**
   * 发送完成事件
   */
  sendDone(): void {
    const durationMs = Date.now() - this.startTime;

    this.sendEvent('metrics', {
      durationMs,
      tokenUsage: this.accumulator.tokenUsage,
      toolCallsCount: this.accumulator.toolCalls.length,
    });

    this.sendEvent('done', {
      status: 'success',
      actualOutput: this.accumulator.fullText,
      toolCalls: this.accumulator.toolCalls,
      metrics: { durationMs, tokenUsage: this.accumulator.tokenUsage },
    });
  }

  /**
   * 发送错误事件
   */
  sendError(message: string): void {
    this.sendEvent('error', { message });
  }

  /**
   * 结束响应
   */
  end(): void {
    this.res.end();
  }

  /**
   * 获取累积数据
   */
  getAccumulator(): StreamAccumulator {
    return this.accumulator;
  }

  /**
   * 获取流处理时长
   */
  getDurationMs(): number {
    return Date.now() - this.startTime;
  }

  /**
   * 处理流式数据块
   *
   * 解析花卷 API 的 SSE 格式数据，支持多种事件类型：
   * - text-delta: 文本增量
   * - tool-call: 工具调用开始
   * - tool-result: 工具调用结果
   * - finish: 完成事件（包含 usage）
   */
  processChunk(chunk: Buffer): void {
    const text = chunk.toString();
    this.logger.debug(`${this.logPrefix} 收到数据块: ${text.substring(0, 200)}...`);

    const lines = text.split('\n').filter((line) => line.startsWith('data: '));

    for (const line of lines) {
      try {
        const jsonStr = line.slice(6);
        if (jsonStr === '[DONE]') {
          this.logger.debug(`${this.logPrefix} 收到 [DONE] 信号`);
          continue;
        }

        const data = JSON.parse(jsonStr) as HuajuanStreamData;
        this.logger.debug(`${this.logPrefix} 解析事件: ${JSON.stringify(data).substring(0, 300)}`);

        this.processStreamData(data);
      } catch {
        // 解析失败，可能是不完整的 JSON，忽略
      }
    }
  }

  /**
   * 处理解析后的流式数据
   */
  private processStreamData(data: HuajuanStreamData): void {
    // 文本增量
    if (data.type === 'text-delta') {
      const textContent = data.delta || '';
      this.accumulator.fullText += textContent;
      this.sendEvent('text', { text: textContent, fullText: this.accumulator.fullText });
      return;
    }

    // Anthropic 原生格式（备用）
    if (data.type === 'content_block_delta') {
      const deltaData = data as unknown as { delta?: { type?: string; text?: string } };
      if (deltaData.delta?.type === 'text_delta') {
        const textContent = deltaData.delta.text || '';
        this.accumulator.fullText += textContent;
        this.sendEvent('text', { text: textContent, fullText: this.accumulator.fullText });
      }
      return;
    }

    // 通用文本格式
    if (data.type === 'text' || data.text) {
      const textContent = data.text || '';
      this.accumulator.fullText += textContent;
      this.sendEvent('text', { text: textContent, fullText: this.accumulator.fullText });
      return;
    }

    // 花卷 API 工具调用格式
    if (data.type === 'tool-call') {
      const toolCall: ToolCallInfo = {
        toolCallId: data.toolCallId,
        toolName: data.toolName || '',
        input: data.args,
      };
      this.accumulator.toolCalls.push(toolCall);
      this.sendEvent('tool_call', toolCall);
      return;
    }

    // 其他工具调用格式（备用）
    if (data.type === 'tool_use' || data.toolName) {
      const toolCall: ToolCallInfo = {
        toolName: data.toolName || '',
        input: data.args,
      };
      this.accumulator.toolCalls.push(toolCall);
      this.sendEvent('tool_call', toolCall);
      return;
    }

    // 花卷 API 工具结果格式
    if (data.type === 'tool-result') {
      const toolCallId = data.toolCallId;
      const matchingTool = this.accumulator.toolCalls.find((t) => t.toolCallId === toolCallId);
      if (matchingTool) {
        matchingTool.output = data.result;
      }
      this.sendEvent('tool_result', {
        toolCallId,
        toolName: matchingTool?.toolName,
        output: data.result,
      });
      return;
    }

    // 其他工具结果格式（备用）
    if (data.type === 'tool_result') {
      const lastTool = this.accumulator.toolCalls[this.accumulator.toolCalls.length - 1];
      if (lastTool) {
        lastTool.output = data.result;
      }
      this.sendEvent('tool_result', {
        toolName: lastTool?.toolName,
        output: data.result,
      });
      return;
    }

    // 完成事件，包含 usage 统计
    if (data.type === 'finish' && data.usage) {
      this.accumulator.tokenUsage = this.parseUsage(data.usage);
      return;
    }

    // Anthropic 原生格式的使用统计（备用）
    if (data.type === 'message_delta' && data.usage) {
      this.accumulator.tokenUsage = this.parseUsage(data.usage);
      return;
    }

    // 通用 usage 格式
    if (data.usage) {
      this.accumulator.tokenUsage = this.parseUsage(data.usage);
    }
  }

  /**
   * 解析 usage 统计
   */
  private parseUsage(usage: HuajuanStreamData['usage']): TokenUsage {
    if (!usage) {
      return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    }

    const inputTokens = usage.inputTokens || usage.input_tokens || 0;
    const outputTokens = usage.outputTokens || usage.output_tokens || 0;
    const totalTokens = usage.totalTokens || usage.total_tokens || inputTokens + outputTokens;

    return { inputTokens, outputTokens, totalTokens };
  }
}

/**
 * Vercel AI SDK 流处理器
 *
 * 专门处理 Vercel AI SDK 兼容格式的流式响应
 * 透传原始数据，只追踪输出文本长度用于估算 token
 */
export class VercelAIStreamHandler {
  private readonly logger = new Logger(VercelAIStreamHandler.name);
  private outputTextLength = 0;

  constructor(
    private readonly res: Response,
    private readonly estimatedInputTokens: number,
    private readonly logPrefix = '[AI-Stream]',
  ) {}

  /**
   * 设置响应头
   */
  setupHeaders(): void {
    this.res.setHeader('Content-Type', 'text/event-stream');
    this.res.setHeader('Cache-Control', 'no-cache');
    this.res.setHeader('Connection', 'keep-alive');
    this.res.setHeader('X-Accel-Buffering', 'no');
    this.res.setHeader('x-vercel-ai-ui-message-stream', 'v1');
    this.res.flushHeaders();
  }

  /**
   * 处理数据块（透传并追踪输出长度）
   */
  processChunk(chunk: Buffer): void {
    const text = chunk.toString();

    // 解析 SSE 数据，追踪输出文本长度
    const lines = text.split('\n').filter((line) => line.trim());
    for (const line of lines) {
      try {
        if (line.startsWith('data: ')) {
          const jsonStr = line.slice(6);
          if (jsonStr && jsonStr !== '[DONE]') {
            const data = JSON.parse(jsonStr) as HuajuanStreamData;
            if (data.type === 'text-delta' && data.delta) {
              this.outputTextLength += data.delta.length;
            }
          }
        }
      } catch {
        // 解析失败，忽略
      }
    }

    // 透传原始数据
    this.res.write(chunk);
  }

  /**
   * 发送 token usage 并结束响应
   */
  sendUsageAndEnd(): void {
    const estimatedOutputTokens = Math.round(this.outputTextLength / 4);
    const tokenUsage = {
      inputTokens: this.estimatedInputTokens,
      outputTokens: estimatedOutputTokens,
      totalTokens: this.estimatedInputTokens + estimatedOutputTokens,
    };

    const usageData = `data: ${JSON.stringify({ type: 'data-tokenUsage', data: tokenUsage })}\n\n`;
    this.res.write(usageData);
    this.logger.log(
      `${this.logPrefix} 发送估算 token usage: input=${this.estimatedInputTokens}, output=${estimatedOutputTokens}`,
    );
    this.res.end();
  }

  /**
   * 发送错误并结束响应
   */
  sendError(message: string): void {
    this.res.write(`data: ${JSON.stringify({ type: 'error', error: message })}\n\n`);
    this.res.end();
  }

  /**
   * 结束响应
   */
  end(): void {
    this.res.end();
  }
}

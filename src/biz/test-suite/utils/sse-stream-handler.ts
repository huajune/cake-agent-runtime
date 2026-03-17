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
 * Agent API 流式数据格式
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
 * - 解析 Agent API 的流式响应
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
   * 解析 Agent API 的 SSE 格式数据，支持多种事件类型：
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

    // Agent API 工具调用格式
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

    // Agent API 工具结果格式
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
 * 透传原始数据，从 finish 事件提取真实 token usage
 *
 * Token Usage 获取策略（按优先级）：
 * 1. 从 data: finish 事件的 usage 字段提取（UI Message Stream）
 * 2. 从 e: 事件提取（Vercel AI Data Stream Protocol）
 * 3. 降级为估算值：input 用调用方传入的 estimatedInputTokens，
 *    output 根据累积的 text-delta / reasoning-delta 字符数估算
 */
export class VercelAIStreamHandler {
  private readonly logger = new Logger(VercelAIStreamHandler.name);
  private tokenUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  /** 累积输出字符数（text-delta + reasoning-delta），用于估算 output tokens */
  private outputCharCount = 0;

  constructor(
    private readonly res: Response,
    private readonly logPrefix = '[AI-Stream]',
    /** 调用方预估的 input tokens（由 AgentService.estimateInputTokens 计算） */
    private readonly estimatedInputTokens = 0,
  ) {}

  /**
   * 静态方法：立即 flush SSE 响应头
   * 在耗时 await 之前调用，让浏览器尽快脱离 pending 状态
   */
  static flushSSEHeaders(res: Response): void {
    if (res.headersSent) return;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('x-vercel-ai-ui-message-stream', 'v1');
    res.flushHeaders();
  }

  /**
   * 设置响应头（如已发送则跳过）
   */
  setupHeaders(): void {
    VercelAIStreamHandler.flushSSEHeaders(this.res);
  }

  /**
   * 处理数据块（透传并从流事件提取 token usage）
   *
   * 同时兼容两种流协议：
   * - UI Message Stream: `data: {"type":"finish","usage":{...}}`
   * - Data Stream Protocol: `e:{"finishReason":"stop","usage":{...}}`
   */
  processChunk(chunk: Buffer): void {
    const text = chunk.toString();

    const lines = text.split('\n').filter((line) => line.trim());
    for (const line of lines) {
      try {
        // UI Message Stream 格式（data: 前缀）
        if (line.startsWith('data: ')) {
          const jsonStr = line.slice(6);
          if (jsonStr && jsonStr !== '[DONE]') {
            const data = JSON.parse(jsonStr) as HuajuanStreamData;
            // 从 finish 事件提取 usage
            if (data.type === 'finish' && data.usage) {
              this.tokenUsage = this.parseUsage(data.usage);
            }
            // 累积输出字符数用于估算
            if (data.type === 'text-delta' && data.delta) {
              this.outputCharCount += data.delta.length;
            }
            if (data.type === 'reasoning-delta' && data.delta) {
              this.outputCharCount += data.delta.length;
              this.logger.debug(
                `${this.logPrefix} 收到 reasoning-delta: ${data.delta.substring(0, 100)}`,
              );
            }
          }
        }
        // Vercel AI Data Stream Protocol（e: 前缀 = finish message）
        else if (line.startsWith('e:')) {
          const data = JSON.parse(line.slice(2));
          if (data.usage) {
            this.tokenUsage = {
              inputTokens: data.usage.promptTokens || data.usage.inputTokens || 0,
              outputTokens: data.usage.completionTokens || data.usage.outputTokens || 0,
              totalTokens: 0,
            };
            this.tokenUsage.totalTokens =
              this.tokenUsage.inputTokens + this.tokenUsage.outputTokens;
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
   * 优先使用 API 返回的真实 usage，否则降级为估算值
   */
  sendUsageAndEnd(): void {
    const finalUsage = this.resolveUsage();
    const isEstimated = this.tokenUsage.totalTokens === 0;

    this.logger.log(
      `${this.logPrefix} token usage: input=${finalUsage.inputTokens}, output=${finalUsage.outputTokens}, total=${finalUsage.totalTokens}${isEstimated ? ' (estimated)' : ''}`,
    );

    const usageData = `data: ${JSON.stringify({ type: 'data-tokenUsage', data: finalUsage })}\n\n`;
    this.res.write(usageData);
    this.res.end();
  }

  /**
   * 解析 usage 统计（兼容 camelCase 和 snake_case）
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

  /**
   * 确定最终 usage：真实值 > 估算值
   * 估算规则：中英文混合场景下，平均每字符约 0.5 token
   */
  private resolveUsage(): TokenUsage {
    if (this.tokenUsage.totalTokens > 0) {
      return this.tokenUsage;
    }
    const estimatedOutputTokens = Math.ceil(this.outputCharCount * 0.5);
    return {
      inputTokens: this.estimatedInputTokens,
      outputTokens: estimatedOutputTokens,
      totalTokens: this.estimatedInputTokens + estimatedOutputTokens,
    };
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

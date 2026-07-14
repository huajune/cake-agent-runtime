import { Logger } from '@nestjs/common';
import { ToolSet } from 'ai';
import { AgentTracerService } from '@observability/agent-tracer.service';
import { type GeneratorToolMode } from '../generator.types';
import {
  computeResultCount,
  computeToolCallStatus,
  SIDE_EFFECT_TOOLS,
} from '../tool-call-analysis';

/**
 * 工具集包装（PreparationService 的纯函数辅助层）：
 * 真实执行计时 + 按 toolMode 过滤可用工具。
 */
const logger = new Logger('ToolSetUtil');

/**
 * 给工具集的 execute 包一层真实计时（按 AI SDK 传入的 toolCallId 记录）。
 *
 * 没有这层时，观测里的工具耗时只能用"步骤墙钟"近似——它包含 LLM 思考与输出时间，
 * 曾导致 skip_reply 这类纯本地工具在流水里显示平均 7s+，无法区分模型慢还是外部 API 慢。
 */
export function wrapToolsWithTiming(
  tools: ToolSet,
  timings: Map<string, number>,
  tracer?: AgentTracerService,
): ToolSet {
  const wrapped: ToolSet = {};
  for (const [name, toolDef] of Object.entries(tools)) {
    const execute = (toolDef as { execute?: unknown }).execute;
    if (typeof execute !== 'function') {
      wrapped[name] = toolDef;
      continue;
    }
    wrapped[name] = {
      ...toolDef,
      execute: async (...args: unknown[]) => {
        const startedAt = Date.now();
        const options = args[1] as { toolCallId?: string } | undefined;
        try {
          const result = await (execute as (...callArgs: unknown[]) => unknown).apply(
            toolDef,
            args,
          );
          const durationMs = Date.now() - startedAt;
          recordToolTiming(name, timings, options, durationMs);
          const resultCount = computeResultCount(result);
          tracer?.emit({
            type: 'tool_call',
            toolName: name,
            durationMs,
            resultCount,
            status: computeToolCallStatus(result, resultCount, undefined, undefined, name),
            sideEffect: SIDE_EFFECT_TOOLS.has(name),
          });
          return result;
        } catch (error) {
          const durationMs = Date.now() - startedAt;
          recordToolTiming(name, timings, options, durationMs);
          tracer?.emit({
            type: 'tool_error',
            toolName: name,
            durationMs,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      },
    } as ToolSet[string];
  }
  return wrapped;
}

function recordToolTiming(
  name: string,
  timings: Map<string, number>,
  options: { toolCallId?: string } | undefined,
  durationMs: number,
): void {
  if (options?.toolCallId) {
    timings.set(options.toolCallId, durationMs);
    return;
  }

  // AI SDK execute(input, options) 签名变更会走到这里：计时静默失效，
  // durationMs 退回墙钟近似。打日志便于升级 SDK 后发现。
  logger.warn(`[tool-timing] 工具 ${name} 执行选项缺少 toolCallId，真实计时未记录`);
}

/** 按 toolMode 过滤工具集：none=全禁；readonly=剔除副作用工具；再叠加显式白名单。 */
export function resolveToolsForMode(
  tools: ToolSet,
  mode: GeneratorToolMode,
  allowedToolNames?: string[],
): ToolSet {
  if (mode === 'none') return {};

  const modeTools: ToolSet = {};
  for (const [name, toolDef] of Object.entries(tools)) {
    if (mode === 'scenario' || !SIDE_EFFECT_TOOLS.has(name)) modeTools[name] = toolDef;
  }

  if (allowedToolNames === undefined) return modeTools;
  const allowed = new Set(allowedToolNames);
  return Object.fromEntries(Object.entries(modeTools).filter(([name]) => allowed.has(name)));
}

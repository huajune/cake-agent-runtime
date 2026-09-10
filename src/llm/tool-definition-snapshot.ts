import { asSchema, type generateText, type ToolSet } from 'ai';

/** 仅保存模型可见定义；执行函数、工具 context 和 provider 凭据不进入请求档案。 */
export interface ToolDefinitionSnapshot {
  name: string;
  type: 'function' | 'dynamic' | 'provider';
  description?: string;
  inputSchema?: unknown;
  unavailableFields?: Array<'description' | 'inputSchema'>;
}

interface ToolDefinitionContext {
  toolsContext?: Readonly<Record<string, unknown>>;
  experimental_sandbox?: Parameters<typeof generateText>[0]['experimental_sandbox'];
}

/** 与 SDK prepareTools 同源解析 JSON schema，兼容 Zod、JSON schema 和异步 schema。 */
export async function snapshotToolDefinitions(
  tools: ToolSet,
  context: ToolDefinitionContext = {},
): Promise<ToolDefinitionSnapshot[]> {
  return Promise.all(
    Object.entries(tools).map(async ([name, tool]): Promise<ToolDefinitionSnapshot> => {
      const snapshot: ToolDefinitionSnapshot = { name, type: tool.type ?? 'function' };
      // Provider 工具由 provider 持有定义；不复制可能携带运行参数的 args。
      if (tool.type === 'provider') return snapshot;

      const unavailableFields: NonNullable<ToolDefinitionSnapshot['unavailableFields']> = [];
      try {
        const description =
          typeof tool.description === 'function'
            ? tool.description({
                context: context.toolsContext?.[name],
                experimental_sandbox: context.experimental_sandbox,
              })
            : tool.description;
        if (description !== undefined) snapshot.description = description;
      } catch {
        unavailableFields.push('description');
      }

      try {
        // jsonSchema 在 SDK v7 中可能为 Promise；先等待再序列化，不能把 Promise 存成 {}。
        const inputSchema = await asSchema(tool.inputSchema).jsonSchema;
        snapshot.inputSchema = JSON.parse(JSON.stringify(inputSchema)) as unknown;
      } catch {
        // 可观测性失败不得中断 LLM 执行，也不保存可能包含凭据的原始异常。
        unavailableFields.push('inputSchema');
      }
      if (unavailableFields.length > 0) snapshot.unavailableFields = unavailableFields;
      return snapshot;
    }),
  );
}

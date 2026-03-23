import { useMemo } from 'react';
import { formatDuration } from '@/utils/format';
import type { MessageRecord } from '@/api/types/chat.types';
import styles from './index.module.scss';

// 场景类型中文映射
const scenarioLabels: Record<string, string> = {
  consultation: '咨询',
  'candidate-consultation': '候选人咨询',
  booking: '预约',
  followup: '跟进',
  general: '通用',
};

// Part 类型定义（Agent API 返回的 messages.parts 结构）
interface MessagePart {
  type: string;
  text?: string;
  toolName?: string;
  state?: string;
  output?: Record<string, unknown>;
  input?: Record<string, unknown>;
}

interface AgentMessage {
  role: string;
  parts?: MessagePart[];
}

// 模型配置结构
interface ModelConfigDisplay {
  chatModel?: string;
  classifyModel?: string;
}

// ChatRequest 请求结构
interface ChatRequestDisplay {
  messages?: unknown[];
  model?: string;
  stream?: boolean;
  allowedTools?: string[];
  systemPrompt?: string;
  promptType?: string;
  context?: {
    configData?: unknown;
    replyPrompts?: unknown;
    preferredBrand?: string;
    brandPriorityStrategy?: string;
    modelConfig?: ModelConfigDisplay; // modelConfig 在 context 内部
    [key: string]: unknown;
  };
  toolContext?: Record<string, unknown>;
  prune?: boolean;
  pruneOptions?: {
    maxOutputTokens?: number;
    targetTokens?: number;
    preserveRecentMessages?: number;
  };
  contextStrategy?: string;
}

/**
 * 从 Agent 响应的 messages 中提取实际使用的工具
 */
function extractUsedToolsFromMessages(messages: AgentMessage[] | undefined): string[] {
  if (!messages || !Array.isArray(messages)) return [];

  const usedTools = new Set<string>();

  for (const message of messages) {
    if (!message.parts) continue;
    for (const part of message.parts) {
      if (part.type === 'dynamic-tool' && part.toolName && part.state === 'output-available') {
        usedTools.add(part.toolName);
      }
    }
  }

  return Array.from(usedTools);
}

/**
 * 获取对象的 keys 摘要（用于展示大对象）
 */
function getObjectSummary(obj: unknown): string {
  if (!obj || typeof obj !== 'object') return '无';
  const keys = Object.keys(obj);
  if (keys.length === 0) return '空对象';
  if (keys.length <= 3) return keys.join(', ');
  return `${keys.slice(0, 3).join(', ')}... (共 ${keys.length} 个字段)`;
}

/**
 * 计算对象的大致大小（字符数）
 */
function estimateSize(obj: unknown): string {
  try {
    const str = JSON.stringify(obj);
    if (str.length < 1000) return `${str.length} 字符`;
    if (str.length < 1000000) return `${(str.length / 1000).toFixed(1)}K`;
    return `${(str.length / 1000000).toFixed(1)}M`;
  } catch {
    return '未知';
  }
}

/**
 * 提取模型名称的简短形式（去掉 provider 前缀）
 */
function shortModelName(model: string): string {
  if (!model) return '-';
  // 如果包含 /，取最后一部分
  const parts = model.split('/');
  return parts.length > 1 ? parts[parts.length - 1] : model;
}

interface TechnicalStatsProps {
  message: MessageRecord;
}

export default function TechnicalStats({ message }: TechnicalStatsProps) {
  const invocation = message.agentInvocation;
  const request = invocation?.request as ChatRequestDisplay | undefined;
  const response = invocation?.response as {
    messages?: AgentMessage[];
    usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
    tools?: { used?: string[]; skipped?: string[] };
  } | undefined;

  const actualUsedTools = useMemo(() => {
    return extractUsedToolsFromMessages(response?.messages);
  }, [response?.messages]);

  // 提取 context 中的各个字段
  const contextInfo = useMemo(() => {
    const ctx = request?.context;
    if (!ctx) return null;
    return {
      hasConfigData: !!ctx.configData,
      configDataSummary: ctx.configData ? getObjectSummary(ctx.configData) : null,
      configDataSize: ctx.configData ? estimateSize(ctx.configData) : null,
      hasReplyPrompts: !!ctx.replyPrompts,
      replyPromptsKeys: ctx.replyPrompts ? Object.keys(ctx.replyPrompts) : [],
      preferredBrand: ctx.preferredBrand,
      brandPriorityStrategy: ctx.brandPriorityStrategy,
      otherKeys: Object.keys(ctx).filter(
        (k) => !['configData', 'replyPrompts', 'preferredBrand', 'brandPriorityStrategy'].includes(k)
      ),
    };
  }, [request?.context]);

  return (
    <>
      <h4 className={styles.sectionTitle}>技术指标</h4>

      {/* Latency & Token - Compact Row */}
      <div className={styles.statsGrid}>
        <div className={`${styles.statCard} ${styles.centered}`}>
          <div className={styles.statLabel}>总耗时</div>
          <div className={`${styles.statValue} ${styles.primary} ${styles.compact}`}>
            {formatDuration(message.totalDuration)}
          </div>
        </div>

        <div className={`${styles.statCard} ${styles.centered}`}>
          <div className={styles.statLabel}>Token</div>
          <div className={`${styles.statValue} ${styles.warning} ${styles.compact}`}>
            {message.tokenUsage?.toLocaleString() || '-'}
          </div>
        </div>
      </div>

      {/* Latency Breakdown */}
      {(message.queueDuration !== undefined ||
        message.aiDuration !== undefined ||
        message.sendDuration !== undefined) && (
        <div className={styles.statCard}>
          <div className={styles.statLabel}>耗时明细</div>
          <div className={styles.statBreakdown}>
            {message.queueDuration !== undefined && (
              <div className={styles.breakdownItem}>
                <span>排队</span>
                <span>{formatDuration(message.queueDuration)}</span>
              </div>
            )}
            {message.aiDuration !== undefined && (
              <div className={styles.breakdownItem}>
                <span>首条响应</span>
                <span>{formatDuration(message.aiDuration)}</span>
              </div>
            )}
            {message.sendDuration !== undefined && (
              <div className={styles.breakdownItem}>
                <span>发送</span>
                <span>{formatDuration(message.sendDuration)}</span>
              </div>
            )}
            {response?.usage && (
              <>
                <div className={`${styles.breakdownItem} ${styles.separator}`}>
                  <span>输入 Token</span>
                  <span>{response.usage.inputTokens?.toLocaleString() || '-'}</span>
                </div>
                <div className={styles.breakdownItem}>
                  <span>输出 Token</span>
                  <span>{response.usage.outputTokens?.toLocaleString() || '-'}</span>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Tools Card */}
      {(actualUsedTools.length > 0 || (response?.tools?.skipped && response.tools.skipped.length > 0)) && (
        <div className={styles.statCard}>
          <div className={styles.statLabel}>工具调用</div>
          <div className={styles.toolSection}>
            {actualUsedTools.length > 0 && (
              <div>
                <div className={`${styles.toolSectionHeader} ${styles.used}`}>
                  ✓ 已使用 ({actualUsedTools.length})
                </div>
                <div className={styles.toolTagsWrap}>
                  {actualUsedTools.map((tool, i) => (
                    <span key={i} className={styles.toolTag}>{tool}</span>
                  ))}
                </div>
              </div>
            )}
            {response?.tools?.skipped && response.tools.skipped.length > 0 && (
              <div className={styles.skippedSection}>
                <div className={`${styles.toolSectionHeader} ${styles.skipped}`}>
                  ○ 已跳过 ({response.tools.skipped.length})
                </div>
                <div className={styles.toolTagsWrap}>
                  {response.tools.skipped.map((tool: string, i: number) => (
                    <span key={i} className={`${styles.toolTag} ${styles.skipped}`}>{tool}</span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Request Params Card - 完整的 ChatRequest 字段 */}
      {request && (
        <div className={styles.statCard}>
          <div className={styles.statLabel}>请求参数 (ChatRequest)</div>
          <div className={styles.statBreakdown}>
            {/* 基本字段 */}
            <div className={styles.breakdownItem}>
              <span>消息数</span>
              <span>{request.messages?.length ?? 0} 条</span>
            </div>

            {request.model && (
              <div className={styles.breakdownItem}>
                <span>模型</span>
                <span className={styles.modelText} title={request.model}>
                  {request.model}
                </span>
              </div>
            )}

            <div className={styles.breakdownItem}>
              <span>流式</span>
              <span>{request.stream ? '是' : '否'}</span>
            </div>

            {/* modelConfig - 多模型配置（在 context 内部） */}
            {request.context?.modelConfig && (
              <>
                <div className={`${styles.breakdownItem} ${styles.separator}`}>
                  <span>modelConfig</span>
                  <span className={styles.paramYes}>✓ 多模型</span>
                </div>
                {request.context.modelConfig.chatModel && (
                  <div className={styles.breakdownItem}>
                    <span className={styles.indentL1}>├ chatModel</span>
                    <span className={styles.modelText} title={request.context.modelConfig.chatModel}>
                      {shortModelName(request.context.modelConfig.chatModel)}
                    </span>
                  </div>
                )}
                {request.context.modelConfig.classifyModel && (
                  <div className={styles.breakdownItem}>
                    <span className={styles.indentL1}>└ classifyModel</span>
                    <span className={styles.modelText} title={request.context.modelConfig.classifyModel}>
                      {shortModelName(request.context.modelConfig.classifyModel)}
                    </span>
                  </div>
                )}
              </>
            )}

            {/* allowedTools */}
            {request.allowedTools && request.allowedTools.length > 0 && (
              <div className={`${styles.breakdownItem} ${styles.column} ${styles.separator}`}>
                <span>allowedTools ({request.allowedTools.length})</span>
                <div className={styles.toolTagsWrap}>
                  {request.allowedTools.map((tool, i) => (
                    <span key={i} className={`${styles.toolTag} ${styles.small}`}>{tool}</span>
                  ))}
                </div>
              </div>
            )}

            {/* Prompt 相关 */}
            <div className={`${styles.breakdownItem} ${styles.separator}`}>
              <span>systemPrompt</span>
              <span className={request.systemPrompt ? styles.paramYes : styles.paramNo}>
                {request.systemPrompt ? `✓ ${request.systemPrompt.length} 字符` : '✗ 无'}
              </span>
            </div>

            {request.promptType && (
              <div className={styles.breakdownItem}>
                <span>promptType</span>
                <span className={styles.paramYes}>{request.promptType}</span>
              </div>
            )}

            {/* Context 详情 */}
            <div className={`${styles.breakdownItem} ${styles.separator}`}>
              <span>context</span>
              <span className={request.context ? styles.paramYes : styles.paramNo}>
                {request.context ? '✓ 已加载' : '✗ 无'}
              </span>
            </div>

            {contextInfo && (
              <>
                {/* configData 摘要 */}
                <div className={styles.breakdownItem}>
                  <span className={styles.indentL1}>├ configData</span>
                  <span className={contextInfo.hasConfigData ? styles.paramYes : styles.paramNo}>
                    {contextInfo.hasConfigData ? `✓ ${contextInfo.configDataSize}` : '✗ 无'}
                  </span>
                </div>

                {contextInfo.hasConfigData && (
                  <div className={styles.breakdownItem}>
                    <span className={styles.summaryText}>
                      {contextInfo.configDataSummary}
                    </span>
                  </div>
                )}

                {/* replyPrompts */}
                <div className={styles.breakdownItem}>
                  <span className={styles.indentL1}>├ replyPrompts</span>
                  <span className={contextInfo.hasReplyPrompts ? styles.paramYes : styles.paramNo}>
                    {contextInfo.hasReplyPrompts
                      ? `✓ ${contextInfo.replyPromptsKeys.length} 项`
                      : '✗ 无'}
                  </span>
                </div>

                {/* preferredBrand */}
                {contextInfo.preferredBrand && (
                  <div className={styles.breakdownItem}>
                    <span className={styles.indentL1}>├ preferredBrand</span>
                    <span className={styles.paramYes}>{contextInfo.preferredBrand}</span>
                  </div>
                )}

                {/* brandPriorityStrategy */}
                {contextInfo.brandPriorityStrategy && (
                  <div className={styles.breakdownItem}>
                    <span className={styles.indentL1}>└ brandPriorityStrategy</span>
                    <span className={styles.paramYes}>{contextInfo.brandPriorityStrategy}</span>
                  </div>
                )}
              </>
            )}

            {/* toolContext */}
            <div className={styles.breakdownItem}>
              <span>toolContext</span>
              <span className={request.toolContext ? styles.paramYes : styles.paramNo}>
                {request.toolContext
                  ? `✓ ${Object.keys(request.toolContext).length} 工具`
                  : '✗ 无'}
              </span>
            </div>

            {/* prune 配置 */}
            {request.prune !== undefined && (
              <div className={`${styles.breakdownItem} ${styles.separator}`}>
                <span>prune</span>
                <span className={request.prune ? styles.paramYes : styles.paramNo}>
                  {request.prune ? '✓ 启用' : '✗ 禁用'}
                </span>
              </div>
            )}

            {request.pruneOptions && (
              <>
                {request.pruneOptions.maxOutputTokens && (
                  <div className={styles.breakdownItem}>
                    <span className={styles.indentL1}>├ maxOutputTokens</span>
                    <span>{request.pruneOptions.maxOutputTokens}</span>
                  </div>
                )}
                {request.pruneOptions.targetTokens && (
                  <div className={styles.breakdownItem}>
                    <span className={styles.indentL1}>├ targetTokens</span>
                    <span>{request.pruneOptions.targetTokens}</span>
                  </div>
                )}
                {request.pruneOptions.preserveRecentMessages && (
                  <div className={styles.breakdownItem}>
                    <span className={styles.indentL1}>└ preserveRecentMessages</span>
                    <span>{request.pruneOptions.preserveRecentMessages}</span>
                  </div>
                )}
              </>
            )}

            {/* contextStrategy */}
            {request.contextStrategy && (
              <div className={styles.breakdownItem}>
                <span>contextStrategy</span>
                <span className={styles.paramYes}>{request.contextStrategy}</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* HTTP Info Card */}
      {invocation?.http && (
        <div className={styles.statCard}>
          <div className={styles.statLabel}>HTTP 响应</div>
          <div className={styles.statBreakdown}>
            <div className={styles.breakdownItem}>
              <span>状态码</span>
              <span className={invocation.http.status === 200 ? styles.paramYes : styles.paramNo}>
                {invocation.http.status} {invocation.http.statusText}
              </span>
            </div>
            {invocation.http.responseTime && (
              <div className={styles.breakdownItem}>
                <span>响应时间</span>
                <span>{formatDuration(invocation.http.responseTime)}</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Metadata Card */}
      <div className={styles.statCard}>
        <div className={styles.statLabel}>元数据</div>
        <div className={styles.statBreakdown}>
          <div className={styles.breakdownItem}>
            <span>场景</span>
            <span>{scenarioLabels[message.scenario || ''] || message.scenario || '未知'}</span>
          </div>
          <div className={styles.breakdownItem}>
            <span>会话 ID</span>
            <span className={styles.chatIdText} title={message.chatId}>
              {message.chatId.slice(0, 12)}...
            </span>
          </div>
        </div>
      </div>
    </>
  );
}

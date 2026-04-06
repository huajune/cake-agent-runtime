import { useState, memo } from 'react';
import { Wrench, ChevronRight } from 'lucide-react';
import type { ToolCall } from '../../types';
import styles from './index.module.scss';

interface ToolCallItemProps {
  tool: ToolCall;
  defaultExpanded?: boolean;
}

function safeStringify(value: unknown): string {
  try {
    const result = JSON.stringify(value, null, 2);
    return result ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * 工具调用组件
 */
export const ToolCallItem = memo(function ToolCallItem({
  tool,
  defaultExpanded = false,
}: ToolCallItemProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const toolName = tool.name || tool.tool || tool.toolName || '未知工具';

  // 兼容不同的字段命名: args/arguments/input, result/output
  const inputData = tool.args ?? tool.arguments ?? tool.input;
  const outputData = tool.result ?? tool.output;
  const hasContent = inputData !== undefined || outputData !== undefined;

  return (
    <div className={styles.toolCallItem}>
      <div
        className={`${styles.toolHeader} ${hasContent ? styles.clickable : ''}`}
        onClick={() => hasContent && setIsExpanded(!isExpanded)}
      >
        <div className={styles.toolName}>
          <Wrench size={11} />
          {toolName}
        </div>
        {hasContent && (
          <span className={styles.expandIcon}>
            <ChevronRight size={12} className={isExpanded ? styles.rotated : ''} />
          </span>
        )}
      </div>
      {isExpanded && (
        <div className={styles.toolBody}>
          {inputData !== undefined && (
            <div className={styles.toolSection}>
              <div className={styles.toolSectionLabel}>入参</div>
              <pre className={styles.toolDetail}>
                {typeof inputData === 'string' ? inputData : safeStringify(inputData)}
              </pre>
            </div>
          )}
          {outputData !== undefined && (
            <div className={styles.toolSection}>
              <div className={styles.toolSectionLabel}>出参</div>
              <pre className={styles.toolDetail}>
                {typeof outputData === 'string'
                  ? outputData.substring(0, 500)
                  : safeStringify(outputData).substring(0, 500)}
                {(typeof outputData === 'string' ? outputData : safeStringify(outputData)).length >
                  500 && '...'}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
});

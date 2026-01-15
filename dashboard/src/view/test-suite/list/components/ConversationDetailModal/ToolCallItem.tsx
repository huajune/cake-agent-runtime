import { useState, memo } from 'react';
import { Wrench, ChevronRight } from 'lucide-react';
import type { ToolCall } from '../../types';
import styles from './index.module.scss';

interface ToolCallItemProps {
  tool: ToolCall;
  defaultExpanded?: boolean;
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
  const hasContent = tool.arguments !== undefined || tool.result !== undefined;

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
          {tool.arguments !== undefined && (
            <div className={styles.toolSection}>
              <div className={styles.toolSectionLabel}>参数</div>
              <pre className={styles.toolDetail}>
                {typeof tool.arguments === 'string'
                  ? tool.arguments
                  : JSON.stringify(tool.arguments, null, 2)}
              </pre>
            </div>
          )}
          {tool.result !== undefined && (
            <div className={styles.toolSection}>
              <div className={styles.toolSectionLabel}>结果</div>
              <pre className={styles.toolDetail}>
                {typeof tool.result === 'string'
                  ? tool.result.substring(0, 500)
                  : JSON.stringify(tool.result, null, 2).substring(0, 500)}
                {(typeof tool.result === 'string'
                  ? tool.result
                  : JSON.stringify(tool.result)
                ).length > 500 && '...'}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
});

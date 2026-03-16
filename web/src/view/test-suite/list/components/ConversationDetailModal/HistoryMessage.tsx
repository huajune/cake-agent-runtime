import { memo } from 'react';
import { User, Bot } from 'lucide-react';
import type { ConversationTurnExecution } from '../../types';
import styles from './index.module.scss';

interface HistoryMessageProps {
  turn: ConversationTurnExecution;
  onClick: () => void;
}

/**
 * 历史记录消息组件（展示 Agent 测试历史）
 *
 * 注意：这里显示的是 Agent 的实际回复（actualOutput），不是真人招募经理的回复。
 * 因为回归验证的每一轮测试都是独立调用 Agent，历史上下文显示的是之前各轮 Agent 的回复。
 */
export const HistoryMessage = memo(function HistoryMessage({ turn, onClick }: HistoryMessageProps) {
  const reply = turn.actualOutput || turn.expectedOutput || '--';
  return (
    <div className={styles.historyMessage} onClick={onClick}>
      <div className={styles.historyUser}>
        <User size={12} />
        <span>{turn.inputMessage}</span>
      </div>
      <div className={styles.historyAssistant}>
        <Bot size={12} />
        <span>{reply}</span>
      </div>
    </div>
  );
});

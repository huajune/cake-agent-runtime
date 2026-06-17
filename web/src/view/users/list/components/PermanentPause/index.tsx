import { useState } from 'react';
import { Ban, ShieldCheck } from 'lucide-react';
import { formatDateTime } from '@/utils/format';
import type { UserData } from '../../types';
import styles from './index.module.scss';

interface PermanentPauseProps {
  users: UserData[];
  isLoading: boolean;
  /** 永久禁止提交中（usePauseUserHosting.isPending） */
  isAdding: boolean;
  /** 正在恢复托管的会话 ID（useToggleUserHosting 的乐观态） */
  pendingChatId?: string;
  onAdd: (params: { userId: string; reason: string; operator?: string }) => void;
  onResume: (chatId: string) => void;
  /** 把托管账号 wxid 解析为配置的展示名（未配置别名时返回原始值） */
  resolveBotLabel?: (ids: Pick<UserData, 'botUserId' | 'imBotId'>) => string;
}

/** 永久禁止来源（user_hosting_status.pause_source）展示文案 */
const SOURCE_LABELS: Record<string, string> = {
  manual: '手动',
  candidate_blacklist: '黑名单命中',
  interview_booking: '面试预约',
  intervention: '人工介入',
  human_intervention: '人工介入',
};

export default function PermanentPause({
  users,
  isLoading,
  isAdding,
  pendingChatId,
  onAdd,
  onResume,
  resolveBotLabel,
}: PermanentPauseProps) {
  const [targetId, setTargetId] = useState('');
  const [reason, setReason] = useState('');
  const [operator, setOperator] = useState('');

  const canSubmit = targetId.trim().length > 0 && reason.trim().length > 0 && !isAdding;

  const handleSubmit = () => {
    if (!canSubmit) return;
    onAdd({
      userId: targetId.trim(),
      reason: reason.trim(),
      operator: operator.trim() || undefined,
    });
    setTargetId('');
    setReason('');
    setOperator('');
  };

  const handleResume = (user: UserData) => {
    const confirmed = window.confirm(
      `确定恢复 ${user.odName || user.groupName || user.chatId} 的托管？\n恢复后该会话将重新由 AI 接管。`,
    );
    if (confirmed) {
      onResume(user.chatId);
    }
  };

  return (
    <div className={styles.panel}>
      <div className={styles.addForm}>
        <input
          value={targetId}
          onChange={(e) => setTargetId(e.target.value)}
          placeholder="微信 / 会话ID（chatId / imContactId / externalUserId）"
          aria-label="永久禁止托管对象"
        />
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="理由（必填，如：店长微信 / 客户微信）"
          aria-label="永久禁止托管理由"
        />
        <input
          value={operator}
          onChange={(e) => setOperator(e.target.value)}
          placeholder="操作人（选填）"
          aria-label="操作人"
        />
        <button
          type="button"
          className={styles.addButton}
          disabled={!canSubmit}
          onClick={handleSubmit}
        >
          <Ban size={15} aria-hidden="true" />
          {isAdding ? '处理中…' : '永久禁止'}
        </button>
      </div>

      <div className={styles.tableWrapper}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>对象</th>
              <th>托管账号</th>
              <th>理由</th>
              <th>操作人</th>
              <th>禁止时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={6} className={styles.loadingCell}>
                  <div className={styles.emptyState}>
                    <p>加载中...</p>
                  </div>
                </td>
              </tr>
            ) : users.length === 0 ? (
              <tr>
                <td colSpan={6} className={styles.loadingCell}>
                  <div className={styles.emptyState}>
                    <div className={styles.emptyIconHalo}>
                      <ShieldCheck className={styles.emptyIcon} aria-hidden="true" />
                    </div>
                    <p>暂无永久禁止托管的会话</p>
                    <span className={styles.emptyHint}>店长 / 客户微信等可在上方手动添加</span>
                  </div>
                </td>
              </tr>
            ) : (
              users.map((user) => {
                const botLabel = resolveBotLabel?.(user) || user.botUserId || user.imBotId || '-';
                const sourceLabel = user.pauseSource
                  ? SOURCE_LABELS[user.pauseSource] || user.pauseSource
                  : null;
                return (
                  <tr key={user.chatId}>
                    <td>
                      <div className={styles.targetName}>
                        {user.odName || user.groupName || user.chatId}
                        {sourceLabel && <span className={styles.sourceTag}>{sourceLabel}</span>}
                      </div>
                      <div className={styles.targetId} title={user.chatId}>
                        {user.chatId}
                      </div>
                    </td>
                    <td className={styles.botCell} title={botLabel}>
                      {botLabel}
                    </td>
                    <td className={styles.reasonCell} title={user.pauseReason}>
                      {user.pauseReason || '-'}
                    </td>
                    <td>{user.pauseOperator || '-'}</td>
                    <td className={styles.timeCell}>{formatDateTime(user.firstActiveAt)}</td>
                    <td>
                      <button
                        type="button"
                        className={styles.removeButton}
                        disabled={pendingChatId === user.chatId}
                        onClick={() => handleResume(user)}
                      >
                        {pendingChatId === user.chatId ? '恢复中…' : '恢复托管'}
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

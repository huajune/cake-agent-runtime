import { useMemo, useState } from 'react';
import { ArrowUpDown, Bot, Info, Search, X } from 'lucide-react';
import { useTodayUsers, useToggleUserHosting, usePausedUsers } from '@/hooks/user/useUsers';

// 类型导入
import type { TabType, UserData } from './types';

// 工具函数导入
import { transformPausedUsers } from './utils/transformers';

// 组件导入
import UserTable from './components/UserTable';
import UserTrendChart from './components/UserTrendChart';
import UserTabNav from './components/UserTabNav';

// 样式导入
import styles from './styles/index.module.scss';

const ALL_BOTS = '__all_bots__';

type SortMode = 'firstActiveDesc' | 'lastActiveDesc' | 'messageDesc';

function getBotLabel(user: Pick<UserData, 'botUserId' | 'imBotId'>) {
  return user.botUserId || user.imBotId || '';
}

function normalizeText(value?: string) {
  return (value || '').trim().toLowerCase();
}

function compareText(a?: string, b?: string) {
  return (a || '').localeCompare(b || '', 'zh-Hans-CN', { numeric: true, sensitivity: 'base' });
}

export default function Users() {
  const [activeTab, setActiveTab] = useState<TabType>('today');
  const [searchKeyword, setSearchKeyword] = useState('');
  const [sortMode, setSortMode] = useState<SortMode>('firstActiveDesc');
  const [botFilter, setBotFilter] = useState(ALL_BOTS);
  const { data: todayUsers = [], isLoading: isTodayLoading } = useTodayUsers();
  const { data: pausedUsers = [], isLoading: isPausedLoading } = usePausedUsers();
  const toggleHosting = useToggleUserHosting();

  const handleToggleHosting = (chatId: string, enabled: boolean) => {
    toggleHosting.mutate({ chatId, enabled });
  };

  const pausedUsersData = transformPausedUsers(pausedUsers);

  const sourceUsers = activeTab === 'today' ? todayUsers : pausedUsersData;
  const isLoading = activeTab === 'today' ? isTodayLoading : isPausedLoading;
  const pendingChatId = toggleHosting.isPending ? toggleHosting.variables?.chatId : undefined;

  const botOptions = useMemo(() => {
    const counts = new Map<string, number>();

    for (const user of sourceUsers) {
      const botLabel = getBotLabel(user);
      if (!botLabel) continue;
      counts.set(botLabel, (counts.get(botLabel) || 0) + 1);
    }

    return Array.from(counts.entries())
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => compareText(a.label, b.label));
  }, [sourceUsers]);

  const activeBotFilter = botOptions.some((option) => option.label === botFilter)
    ? botFilter
    : ALL_BOTS;

  const displayUsers = useMemo(() => {
    const keyword = normalizeText(searchKeyword);

    return sourceUsers
      .filter((user) => {
        const botLabel = getBotLabel(user);
        if (activeBotFilter !== ALL_BOTS && botLabel !== activeBotFilter) {
          return false;
        }

        if (!keyword) {
          return true;
        }

        return [user.odName, user.groupName, user.chatId].some((value) =>
          normalizeText(value).includes(keyword),
        );
      })
      .sort((a, b) => {
        if (sortMode === 'lastActiveDesc') {
          return b.lastActiveAt - a.lastActiveAt || compareText(a.chatId, b.chatId);
        }

        if (sortMode === 'messageDesc') {
          return b.messageCount - a.messageCount || compareText(a.chatId, b.chatId);
        }

        return b.firstActiveAt - a.firstActiveAt || compareText(a.chatId, b.chatId);
      });
  }, [activeBotFilter, searchKeyword, sortMode, sourceUsers]);

  const emptyMessage =
    searchKeyword || activeBotFilter !== ALL_BOTS ? '没有匹配的数据' : '暂无数据';

  return (
    <div className={styles.page}>
      {/* 近1月托管用户趋势图 */}
      <UserTrendChart />

      {/* Tab 切换 + 用户列表 */}
      <section className={styles.section}>
        <UserTabNav
          activeTab={activeTab}
          todayCount={todayUsers.length}
          pausedCount={pausedUsers.length}
          onTabChange={setActiveTab}
        />

        {activeTab === 'paused' && (
          <div className={styles.tabHint}>
            <Info className={styles.tabHintIcon} aria-hidden="true" />
            <span>
              禁止托管后，系统将在 3 天后自动恢复托管；如需提前恢复，请手动切换上方"托管状态"开关。
            </span>
          </div>
        )}

        <div className={styles.toolbar}>
          <label className={styles.searchControl}>
            <Search aria-hidden="true" size={15} />
            <input
              value={searchKeyword}
              onChange={(event) => setSearchKeyword(event.target.value)}
              placeholder="搜索用户 / 会话ID"
              aria-label="搜索用户或会话 ID"
            />
            {searchKeyword && (
              <button
                type="button"
                className={styles.clearSearch}
                onClick={() => setSearchKeyword('')}
                aria-label="清空搜索"
              >
                <X size={14} aria-hidden="true" />
              </button>
            )}
          </label>

          <label className={styles.selectControl}>
            <ArrowUpDown aria-hidden="true" size={15} />
            <select
              value={sortMode}
              onChange={(event) => setSortMode(event.target.value as SortMode)}
              aria-label="排序方式"
            >
              <option value="firstActiveDesc">首次活跃时间新到旧</option>
              <option value="lastActiveDesc">最后活跃时间新到旧</option>
              <option value="messageDesc">消息数多到少</option>
            </select>
          </label>

          <label className={styles.selectControl}>
            <Bot aria-hidden="true" size={15} />
            <select
              value={activeBotFilter}
              onChange={(event) => setBotFilter(event.target.value)}
              aria-label="托管 bot 过滤"
              disabled={botOptions.length === 0}
            >
              <option value={ALL_BOTS}>
                {botOptions.length === 0 ? '暂无 bot 数据' : '全部 bot'}
              </option>
              {botOptions.map((option) => (
                <option key={option.label} value={option.label}>
                  {option.label} ({option.count})
                </option>
              ))}
            </select>
          </label>
        </div>

        {/* 用户表格 */}
        <UserTable
          users={displayUsers}
          isLoading={isLoading}
          onToggleHosting={handleToggleHosting}
          isPausedTab={activeTab === 'paused'}
          pendingChatId={pendingChatId}
          emptyMessage={emptyMessage}
        />
      </section>
    </div>
  );
}

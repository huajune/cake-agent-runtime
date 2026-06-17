import { useMemo, useState } from 'react';
import { ArrowUpDown, Bot, Info, Search, X } from 'lucide-react';
import { useConfiguredBots } from '@/hooks/bot/useBots';
import {
  useTodayUsers,
  useToggleUserHosting,
  usePausedUsers,
  usePauseUserHosting,
} from '@/hooks/user/useUsers';
import {
  useCandidateBlacklist,
  useAddCandidateToBlacklist,
  useRemoveCandidateFromBlacklist,
} from '@/hooks/user/useCandidateBlacklist';
import type { BotAccount } from '@/api/types/bot.types';

// 类型导入
import type { TabType, UserData } from './types';

// 工具函数导入
import { transformPausedUsers } from './utils/transformers';

// 组件导入
import UserTable from './components/UserTable';
import UserTrendChart from './components/UserTrendChart';
import UserTabNav from './components/UserTabNav';
import CandidateBlacklist from './components/CandidateBlacklist';
import PermanentPause from './components/PermanentPause';
import { USER_RANGE_OPTIONS } from './constants';

// 样式导入
import styles from './styles/index.module.scss';

const ALL_BOTS = '__all_bots__';

type SortMode = 'firstActiveDesc' | 'lastActiveDesc' | 'messageDesc';

interface BotOption {
  value: string;
  label: string;
  aliases: string[];
  count: number;
}

function getUserBotLabel(user: Pick<UserData, 'botUserId' | 'imBotId'>) {
  return user.botUserId || user.imBotId || '';
}

function normalizeText(value?: string) {
  return (value || '').trim().toLowerCase();
}

function compareText(a?: string, b?: string) {
  return (a || '').localeCompare(b || '', 'zh-Hans-CN', { numeric: true, sensitivity: 'base' });
}

function uniqueValues(values: Array<string | undefined>) {
  return Array.from(
    new Set(
      values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)),
    ),
  );
}

function getBotAliases(bot: BotAccount) {
  return uniqueValues([bot.nickName, bot.name, bot.weixin, bot.wecomUserId, bot.wxid, bot.id]).map(
    normalizeText,
  );
}

function getBotOptionValue(bot: BotAccount, index: number) {
  return bot.wxid || bot.id || bot.wecomUserId || bot.weixin || bot.nickName || `bot-${index}`;
}

function getBotDisplayName(bot: BotAccount) {
  const name = bot.nickName || bot.name;
  const userId = bot.wecomUserId || bot.weixin;
  const primary = name || userId || bot.wxid || bot.id || '未命名账号';
  if (name && userId && normalizeText(name) !== normalizeText(userId)) {
    return `${name} / ${userId}`;
  }
  return primary;
}

function getUserBotAliases(user: Pick<UserData, 'botUserId' | 'imBotId'>) {
  return uniqueValues([user.botUserId, user.imBotId]).map(normalizeText);
}

function matchesBotOption(
  user: Pick<UserData, 'botUserId' | 'imBotId'>,
  option: Pick<BotOption, 'aliases'>,
) {
  const userAliases = getUserBotAliases(user);
  return userAliases.some((alias) => option.aliases.includes(alias));
}

function filterUsersByControls(
  users: UserData[],
  keyword: string,
  botOption?: Pick<BotOption, 'aliases'>,
) {
  return users.filter((user) => {
    if (botOption && !matchesBotOption(user, botOption)) {
      return false;
    }

    if (!keyword) {
      return true;
    }

    return [user.odName, user.groupName, user.chatId].some((value) =>
      normalizeText(value).includes(keyword),
    );
  });
}

export default function Users() {
  const [activeTab, setActiveTab] = useState<TabType>('today');
  const [searchKeyword, setSearchKeyword] = useState('');
  const [sortMode, setSortMode] = useState<SortMode>('firstActiveDesc');
  const [botFilter, setBotFilter] = useState(ALL_BOTS);
  const [selectedDays, setSelectedDays] = useState<number>(USER_RANGE_OPTIONS[0].days);
  const { data: todayUsers = [], isLoading: isTodayLoading } = useTodayUsers();
  const { data: pausedUsers = [], isLoading: isPausedLoading } = usePausedUsers();
  const { data: configuredBots = [], isLoading: isBotsLoading } = useConfiguredBots();
  const toggleHosting = useToggleUserHosting();
  const pauseHosting = usePauseUserHosting();
  const { data: candidateBlacklist, isLoading: isLoadingCandidates } = useCandidateBlacklist();
  const addCandidate = useAddCandidateToBlacklist();
  const removeCandidate = useRemoveCandidateFromBlacklist();

  const handleToggleHosting = (chatId: string, enabled: boolean) => {
    toggleHosting.mutate({ chatId, enabled });
  };

  const handlePermanentPause = (params: {
    userId: string;
    reason: string;
    operator?: string;
  }) => {
    pauseHosting.mutate({ ...params, permanent: true });
  };

  const pausedUsersData = useMemo(() => transformPausedUsers(pausedUsers), [pausedUsers]);
  const temporaryPausedUsersData = useMemo(
    () => pausedUsersData.filter((user) => user.isPermanent !== true),
    [pausedUsersData],
  );
  const permanentPausedUsersData = useMemo(
    () => pausedUsersData.filter((user) => user.isPermanent === true),
    [pausedUsersData],
  );

  const sourceUsers =
    activeTab === 'today'
      ? todayUsers
      : activeTab === 'permanent'
        ? permanentPausedUsersData
        : temporaryPausedUsersData;
  const isLoading = activeTab === 'today' ? isTodayLoading : isPausedLoading;
  const pendingChatId = toggleHosting.isPending ? toggleHosting.variables?.chatId : undefined;

  const botOptions = useMemo(() => {
    const optionsByValue = new Map<string, Omit<BotOption, 'count'>>();

    configuredBots.forEach((bot, index) => {
      const aliases = getBotAliases(bot);
      if (aliases.length === 0) return;

      const value = getBotOptionValue(bot, index);
      const existing = optionsByValue.get(value);
      optionsByValue.set(value, {
        value,
        label: existing?.label || getBotDisplayName(bot),
        aliases: uniqueValues([...(existing?.aliases || []), ...aliases]),
      });
    });

    const options = Array.from(optionsByValue.values());
    const counts = new Map<string, number>();

    for (const user of sourceUsers) {
      const matchedOption = options.find((option) => matchesBotOption(user, option));
      if (!matchedOption) continue;
      counts.set(matchedOption.value, (counts.get(matchedOption.value) || 0) + 1);
    }

    return options
      .map((option) => ({ ...option, count: counts.get(option.value) || 0 }))
      .sort((a, b) => compareText(a.label, b.label));
  }, [configuredBots, sourceUsers]);

  const activeBotOption = botOptions.find((option) => option.value === botFilter);
  const activeBotFilter = activeBotOption ? botFilter : ALL_BOTS;
  const normalizedKeyword = normalizeText(searchKeyword);

  const resolveBotLabel = (user: Pick<UserData, 'botUserId' | 'imBotId'>) => {
    const matchedOption = botOptions.find((option) => matchesBotOption(user, option));
    return matchedOption?.label || getUserBotLabel(user) || '-';
  };

  /** 黑名单列表用：仅按配置别名解析，未命中返回 undefined 让组件回退到拉黑快照 */
  const resolveBotName = (ids: Pick<UserData, 'botUserId' | 'imBotId'>) =>
    botOptions.find((option) => matchesBotOption(ids, option))?.label;

  const filteredTodayUsers = useMemo(
    () => filterUsersByControls(todayUsers, normalizedKeyword, activeBotOption),
    [activeBotOption, normalizedKeyword, todayUsers],
  );

  const filteredPausedUsers = useMemo(
    () => filterUsersByControls(temporaryPausedUsersData, normalizedKeyword, activeBotOption),
    [activeBotOption, normalizedKeyword, temporaryPausedUsersData],
  );

  const filteredPermanentUsers = useMemo(
    () => filterUsersByControls(permanentPausedUsersData, normalizedKeyword, activeBotOption),
    [activeBotOption, normalizedKeyword, permanentPausedUsersData],
  );

  const filteredSourceUsers =
    activeTab === 'today'
      ? filteredTodayUsers
      : activeTab === 'permanent'
        ? filteredPermanentUsers
        : filteredPausedUsers;

  const displayUsers = useMemo(() => {
    return [...filteredSourceUsers].sort((a, b) => {
      if (sortMode === 'lastActiveDesc') {
        return b.lastActiveAt - a.lastActiveAt || compareText(a.chatId, b.chatId);
      }

      if (sortMode === 'messageDesc') {
        return b.messageCount - a.messageCount || compareText(a.chatId, b.chatId);
      }

      return b.firstActiveAt - a.firstActiveAt || compareText(a.chatId, b.chatId);
    });
  }, [filteredSourceUsers, sortMode]);

  const emptyMessage = searchKeyword || activeBotOption ? '没有匹配的数据' : '暂无数据';

  return (
    <div className={styles.page}>
      {/* 托管用户趋势图 */}
      <UserTrendChart selectedDays={selectedDays} onSelectedDaysChange={setSelectedDays} />

      {/* Tab 切换 + 用户列表 */}
      <section className={styles.section}>
        <UserTabNav
          activeTab={activeTab}
          todayCount={filteredTodayUsers.length}
          pausedCount={filteredPausedUsers.length}
          permanentCount={filteredPermanentUsers.length}
          blacklistCount={candidateBlacklist?.candidates?.length || 0}
          onTabChange={setActiveTab}
        />

        {activeTab === 'paused' && (
          <>
            <div className={styles.tabHint}>
              <Info className={styles.tabHintIcon} aria-hidden="true" />
              <span>
                临时禁止托管后，系统将在 3
                天后自动恢复托管；如需提前恢复，请手动切换"托管状态"开关。
              </span>
            </div>
          </>
        )}

        {activeTab === 'permanent' && (
          <div className={styles.tabHint}>
            <Info className={styles.tabHintIcon} aria-hidden="true" />
            <span>
              永久禁止托管不会自动恢复，适用于店长微信、客户微信等不应由 AI
              托管的联系人；如需恢复，请点击对应行的"恢复托管"。
            </span>
          </div>
        )}

        {activeTab === 'blacklist' && (
          <div className={styles.tabHint}>
            <Info className={styles.tabHintIcon} aria-hidden="true" />
            <span>
              拉黑后，任一托管账号再次收到该候选人消息时会发送飞书告警（附拉黑理由），并永久取消该会话的托管；移除黑名单不会自动恢复已暂停的会话。
            </span>
          </div>
        )}

        {activeTab === 'blacklist' ? (
          /* 候选人黑名单（命中后永久暂停托管，与暂停列表的"黑名单"来源对应） */
          <CandidateBlacklist
            candidates={candidateBlacklist?.candidates || []}
            isLoading={isLoadingCandidates}
            isPending={addCandidate.isPending || removeCandidate.isPending}
            onAdd={(params) => addCandidate.mutate(params)}
            onRemove={(targetId) => removeCandidate.mutate({ targetId })}
            resolveBotName={resolveBotName}
          />
        ) : activeTab === 'permanent' ? (
          /* 永久禁止托管（与黑名单同款面板：添加表单 + 列表 + 逐行恢复） */
          <PermanentPause
            users={displayUsers}
            isLoading={isLoading}
            isAdding={pauseHosting.isPending}
            pendingChatId={pendingChatId}
            onAdd={handlePermanentPause}
            onResume={(chatId) => handleToggleHosting(chatId, true)}
            resolveBotLabel={resolveBotLabel}
          />
        ) : (
          <>
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
                  disabled={isBotsLoading || botOptions.length === 0}
                >
                  <option value={ALL_BOTS}>
                    {isBotsLoading
                      ? '正在加载托管账号'
                      : botOptions.length === 0
                        ? '暂无托管账号'
                        : '全部托管账号'}
                  </option>
                  {botOptions.map((option) => (
                    <option key={option.value} value={option.value}>
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
              resolveBotLabel={resolveBotLabel}
            />
          </>
        )}
      </section>
    </div>
  );
}

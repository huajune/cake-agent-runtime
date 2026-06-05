import { useId, type ChangeEvent } from 'react';
import { ChevronDown } from 'lucide-react';
import { useGroupList } from '@/hooks/config/useWorker';

export interface AnalyticsRangeOption<T extends string> {
  key: T;
  label: string;
}

interface AnalyticsControlFiltersProps<T extends string> {
  range: T;
  rangeOptions: Array<AnalyticsRangeOption<T>>;
  onRangeChange: (range: T) => void;
  groups: string[];
  onGroupsChange: (groups: string[]) => void;
  groupSelectionMode?: 'multiple' | 'single';
}

export default function AnalyticsControlFilters<T extends string>({
  range,
  rangeOptions,
  onRangeChange,
  groups,
  onGroupsChange,
  groupSelectionMode = 'multiple',
}: AnalyticsControlFiltersProps<T>) {
  const groupInputName = useId();
  // 小组选项动态读托管平台（/group/list），与「小组托管状态」页同源，新增/改名自动生效。
  const { data: groupList } = useGroupList();
  const groupOptions = (groupList ?? []).map((group) => group.name).filter(Boolean);
  const isSingleGroupMode = groupSelectionMode === 'single';
  const selectedGroup = groups[0];
  const groupSummary = isSingleGroupMode
    ? selectedGroup || '全部小组'
    : groups.length > 0
      ? `${groups.length} 个已选`
      : '全部小组';

  const toggleGroup = (group: string) => {
    onGroupsChange(
      groups.includes(group) ? groups.filter((item) => item !== group) : [...groups, group],
    );
  };

  const closeDropdown = (input: HTMLInputElement) => {
    if (!isSingleGroupMode) return;
    const dropdown = input.closest('details') as HTMLDetailsElement | null;
    if (dropdown) dropdown.open = false;
  };

  const handleAllGroupsChange = (event: ChangeEvent<HTMLInputElement>) => {
    onGroupsChange([]);
    closeDropdown(event.currentTarget);
  };

  const handleGroupChange = (group: string, event: ChangeEvent<HTMLInputElement>) => {
    if (isSingleGroupMode) {
      onGroupsChange([group]);
      closeDropdown(event.currentTarget);
      return;
    }
    toggleGroup(group);
  };

  return (
    <>
      <div className="filters">
        {rangeOptions.map((option) => (
          <button
            key={option.key}
            type="button"
            className={range === option.key ? 'active' : ''}
            onClick={() => onRangeChange(option.key)}
          >
            {option.label}
          </button>
        ))}
      </div>

      <details className="control-group-dropdown">
        <summary>
          <span>小组</span>
          <strong>{groupSummary}</strong>
          <ChevronDown size={14} />
        </summary>
        <div>
          <label>
            <input
              type={isSingleGroupMode ? 'radio' : 'checkbox'}
              name={groupInputName}
              checked={groups.length === 0}
              onChange={handleAllGroupsChange}
            />
            <span>全部小组</span>
          </label>
          {groupOptions.map((item) => (
            <label key={item}>
              <input
                type={isSingleGroupMode ? 'radio' : 'checkbox'}
                name={groupInputName}
                checked={isSingleGroupMode ? selectedGroup === item : groups.includes(item)}
                onChange={(event) => handleGroupChange(item, event)}
              />
              <span>{item}</span>
            </label>
          ))}
        </div>
      </details>
    </>
  );
}

import { ArrowDown, ArrowUp, X } from 'lucide-react';
import type { ModelOption } from '@/api/services/agent.service';
import { ModelSelector } from '@/components/ModelSelector';
import styles from './index.module.scss';

interface FallbackChainSelectorProps {
  label: string;
  value: readonly string[];
  options: readonly ModelOption[];
  onChange: (value: string[]) => void;
  disabled?: boolean;
}

/** 有序选择备用模型；空数组保留后端继承默认配置的语义。 */
export function FallbackChainSelector({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: FallbackChainSelectorProps) {
  const remainingOptions = options.filter((option) => !value.includes(option.id));
  const moveModel = (index: number, direction: number) => {
    const target = index + direction;
    if (target < 0 || target >= value.length) return;
    const next = [...value];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };

  return (
    <div className={styles.selector} role="group" aria-label={label}>
      <ol className={styles.chain}>
        {value.map((modelId, index) => (
          <li key={`${index}-${modelId}`} className={styles.row}>
            <span className={styles.position}>{index + 1}</span>
            <div className={styles.model}>
              <ModelSelector
                ariaLabel={`${label}第 ${index + 1} 个模型`}
                value={modelId}
                options={options.filter(
                  (option) => option.id === modelId || !value.includes(option.id),
                )}
                onChange={(next) =>
                  onChange(value.map((id, position) => (position === index ? next : id)))
                }
                disabled={disabled}
                showDefaultOption={false}
                showModelId={false}
                triggerDisplay="id"
              />
            </div>
            <div className={styles.actions}>
              <button
                type="button"
                className={styles.action}
                title="上移"
                aria-label={`上移${label}第 ${index + 1} 个模型`}
                disabled={disabled || index === 0}
                onClick={() => moveModel(index, -1)}
              >
                <ArrowUp size={14} />
              </button>
              <button
                type="button"
                className={styles.action}
                title="下移"
                aria-label={`下移${label}第 ${index + 1} 个模型`}
                disabled={disabled || index === value.length - 1}
                onClick={() => moveModel(index, 1)}
              >
                <ArrowDown size={14} />
              </button>
              <button
                type="button"
                className={styles.action}
                title="移除"
                aria-label={`移除${label}第 ${index + 1} 个模型`}
                disabled={disabled}
                onClick={() => onChange(value.filter((_, position) => position !== index))}
              >
                <X size={14} />
              </button>
            </div>
          </li>
        ))}
      </ol>
      {(remainingOptions.length > 0 || value.length === 0) && (
        <ModelSelector
          ariaLabel={`${label}添加模型`}
          value=""
          options={remainingOptions}
          onChange={(modelId) => onChange([...value, modelId])}
          disabled={disabled}
          placeholder={
            disabled
              ? '加载模型列表中…'
              : value.length
                ? '添加备用模型'
                : '使用默认配置 · 选择模型覆盖'
          }
          emptyPlaceholder={disabled ? '加载模型列表中…' : '暂无可选模型'}
          showDefaultOption={false}
          showModelId={false}
          triggerDisplay="id"
        />
      )}
      {value.length > 0 && (
        <button
          type="button"
          className={styles.reset}
          disabled={disabled}
          onClick={() => onChange([])}
        >
          清空，恢复默认配置
        </button>
      )}
    </div>
  );
}

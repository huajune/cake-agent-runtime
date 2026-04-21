import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Brain,
  Check,
  ChevronDown,
  Image as ImageIcon,
  ScrollText,
  Sparkles,
  Wrench,
} from 'lucide-react';
import type { ModelOption, ModelCapability } from '@/api/services/agent.service';
import styles from './index.module.scss';

export interface ModelSelectorProps {
  value: string;
  options: readonly ModelOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  emptyPlaceholder?: string;
  defaultOptionLabel?: string;
  defaultOptionDesc?: string;
}

interface CapabilityMeta {
  label: string;
  Icon: typeof Sparkles;
}

const CAPABILITY_META: Record<ModelCapability, CapabilityMeta> = {
  thinking: { label: '深度思考', Icon: Brain },
  'tool-use': { label: '工具调用', Icon: Wrench },
  multimodal: { label: '多模态', Icon: ImageIcon },
  'long-context': { label: '长上下文', Icon: ScrollText },
};

function CapabilityTag({ capability }: { capability: ModelCapability }) {
  const meta = CAPABILITY_META[capability];
  if (!meta) return null;
  const { label, Icon } = meta;
  return (
    <span className={`${styles.capTag} ${styles[`cap-${capability}`]}`}>
      <Icon size={11} />
      {label}
    </span>
  );
}

export function ModelSelector({
  value,
  options,
  onChange,
  disabled = false,
  placeholder = '默认（角色路由）',
  emptyPlaceholder = '暂无可用模型',
  defaultOptionLabel = '默认（角色路由）',
  defaultOptionDesc = '留空使用后端 AGENT_CHAT_MODEL 角色路由',
}: ModelSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [dropdownStyle, setDropdownStyle] = useState<{
    top: number;
    left: number;
    width: number;
  } | null>(null);

  const selected = useMemo(() => options.find((o) => o.id === value), [options, value]);

  useLayoutEffect(() => {
    if (!isOpen) {
      setDropdownStyle(null);
      return;
    }
    const updatePosition = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      setDropdownStyle({
        top: rect.bottom + 6,
        left: rect.left,
        width: rect.width,
      });
    };
    updatePosition();
    window.addEventListener('scroll', updatePosition, true);
    window.addEventListener('resize', updatePosition);
    return () => {
      window.removeEventListener('scroll', updatePosition, true);
      window.removeEventListener('resize', updatePosition);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (containerRef.current?.contains(target)) return;
      if (dropdownRef.current?.contains(target)) return;
      setIsOpen(false);
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKey);
    };
  }, [isOpen]);

  const handleSelect = (nextValue: string) => {
    onChange(nextValue);
    setIsOpen(false);
  };

  const isDisabled = disabled || options.length === 0;
  const triggerLabel = selected
    ? selected.name || selected.id
    : value
      ? value
      : options.length === 0
        ? emptyPlaceholder
        : placeholder;
  const triggerSub = selected?.id && selected.id !== triggerLabel ? selected.id : '';

  return (
    <div className={styles.modelSelector} ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`${styles.trigger} ${isOpen ? styles.open : ''}`}
        onClick={() => !isDisabled && setIsOpen((prev) => !prev)}
        disabled={isDisabled}
      >
        <span className={styles.triggerContent}>
          <span className={`${styles.triggerTitle} ${!selected && !value ? styles.placeholder : ''}`}>
            {triggerLabel}
          </span>
          {triggerSub && <span className={styles.triggerSub}>{triggerSub}</span>}
        </span>
        <ChevronDown
          size={16}
          className={`${styles.chevron} ${isOpen ? styles.chevronOpen : ''}`}
        />
      </button>

      {isOpen && dropdownStyle &&
        createPortal(
          <div
            ref={dropdownRef}
            className={styles.dropdown}
            role="listbox"
            style={{
              position: 'fixed',
              top: dropdownStyle.top,
              left: dropdownStyle.left,
              width: dropdownStyle.width,
            }}
          >
            <button
              type="button"
              className={`${styles.optionItem} ${styles.optionDefault} ${value === '' ? styles.optionSelected : ''}`}
              onClick={() => handleSelect('')}
              role="option"
              aria-selected={value === ''}
            >
              <div className={styles.optionMain}>
                <div className={styles.optionTitleRow}>
                  <Sparkles size={14} className={styles.optionIcon} />
                  <span className={styles.optionTitle}>{defaultOptionLabel}</span>
                  {value === '' && <Check size={14} className={styles.optionCheck} />}
                </div>
                <p className={styles.optionDesc}>{defaultOptionDesc}</p>
              </div>
            </button>

            {options.map((option) => {
              const isSelected = option.id === value;
              return (
                <button
                  key={option.id}
                  type="button"
                  className={`${styles.optionItem} ${isSelected ? styles.optionSelected : ''}`}
                  onClick={() => handleSelect(option.id)}
                  role="option"
                  aria-selected={isSelected}
                >
                  <div className={styles.optionMain}>
                    <div className={styles.optionTitleRow}>
                      <span className={styles.optionTitle}>{option.name || option.id}</span>
                      <span className={styles.optionId}>{option.id}</span>
                      {isSelected && <Check size={14} className={styles.optionCheck} />}
                    </div>
                    {option.description && (
                      <p className={styles.optionDesc}>{option.description}</p>
                    )}
                    {option.capabilities.length > 0 && (
                      <div className={styles.optionCaps}>
                        {option.capabilities.map((cap) => (
                          <CapabilityTag key={cap} capability={cap} />
                        ))}
                      </div>
                    )}
                  </div>
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </div>
  );
}

export default ModelSelector;

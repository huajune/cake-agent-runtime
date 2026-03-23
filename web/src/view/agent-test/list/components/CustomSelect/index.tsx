import { useState, useRef, useEffect } from 'react';
import { ChevronDown, Check } from 'lucide-react';
import styles from './index.module.scss';

export interface SelectOption {
  value: string;
  label: string;
}

export interface CustomSelectProps {
  value: string;
  options: readonly SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
}

/**
 * 自定义下拉选择组件 - 完全可控样式
 */
export function CustomSelect({ value, options, onChange, placeholder = '请选择...' }: CustomSelectProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // 点击外部关闭
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isOpen]);

  // 过滤掉空值选项（placeholder 不应该出现在下拉列表中）
  const displayOptions = options.filter((opt) => opt.value !== '');
  const selectedOption = displayOptions.find((opt) => opt.value === value);

  const handleSelect = (optValue: string) => {
    onChange(optValue);
    setIsOpen(false);
  };

  return (
    <div className={styles.customSelect} ref={containerRef}>
      <button
        type="button"
        className={`${styles.selectTrigger} ${isOpen ? styles.open : ''}`}
        onClick={() => setIsOpen(!isOpen)}
      >
        <span className={selectedOption ? styles.selectedText : styles.placeholderText}>
          {selectedOption?.label || placeholder}
        </span>
        <ChevronDown size={16} className={`${styles.selectArrow} ${isOpen ? styles.rotated : ''}`} />
      </button>

      {isOpen && (
        <div className={styles.selectDropdown}>
          {displayOptions.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={`${styles.selectOption} ${opt.value === value ? styles.selected : ''}`}
              onClick={() => handleSelect(opt.value)}
            >
              <span>{opt.label}</span>
              {opt.value === value && <Check size={14} className={styles.checkIcon} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

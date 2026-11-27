import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Check, ChevronDown, type LucideIcon } from 'lucide-react';
import styles from './index.module.scss';

interface Props {
  label: string;
  icon: LucideIcon;
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
}

export default function FilterSelect({
  label,
  icon: Icon,
  value,
  options,
  onChange,
  disabled,
  className,
}: Props) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const selected = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const [active, setActive] = useState<number | null>(null);
  const open = !disabled && active !== null && options.length > 0;
  const current = Math.min(active ?? selected, options.length - 1);
  const search = useRef({ text: '', at: 0 });

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setActive(null);
    };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, [open]);
  useEffect(() => {
    if (open) document.getElementById(`${id}-${current}`)?.scrollIntoView({ block: 'nearest' });
  }, [id, current, open]);

  function choose(index: number) {
    onChange(options[index].value);
    setActive(null);
  }

  function handleKey(event: KeyboardEvent<HTMLButtonElement>) {
    if (!options.length || event.altKey || event.metaKey || event.ctrlKey) return;
    switch (event.key) {
      case 'ArrowDown':
        setActive(open ? Math.min(current + 1, options.length - 1) : selected);
        break;
      case 'ArrowUp':
        setActive(open ? Math.max(current - 1, 0) : selected);
        break;
      case 'Home':
        setActive(0);
        break;
      case 'End':
        setActive(options.length - 1);
        break;
      case 'Enter':
      case ' ':
        if (open) choose(current);
        else setActive(selected);
        break;
      case 'Escape':
        if (!open) return;
        setActive(null);
        event.stopPropagation();
        break;
      default: {
        if (event.key.length !== 1) return;
        const now = Date.now();
        const text =
          (now - search.current.at < 600 ? search.current.text : '') + event.key.toLowerCase();
        search.current = { text, at: now };
        const index = options.findIndex((option) => option.label.toLowerCase().startsWith(text));
        if (index !== -1) setActive(index);
      }
    }
    event.preventDefault();
  }

  return (
    <div className={`${styles.root} ${className ?? ''}`} ref={root}>
      <button
        type="button"
        role="combobox"
        aria-label={label}
        aria-controls={id}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-activedescendant={open ? `${id}-${current}` : undefined}
        className={styles.trigger}
        disabled={disabled}
        onClick={() => setActive(open ? null : selected)}
        onBlur={() => setActive(null)}
        onKeyDown={handleKey}
      >
        <Icon size={14} aria-hidden="true" />
        <span>{options[selected]?.label}</span>
        <ChevronDown size={14} className={styles.chevron} aria-hidden="true" />
      </button>
      <ul id={id} role="listbox" aria-label={label} className={styles.menu} hidden={!open}>
        {open &&
          options.map((option, index) => (
            <li
              key={option.value}
              id={`${id}-${index}`}
              role="option"
              aria-selected={option.value === value}
              data-active={current === index}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(index)}
            >
              <span>{option.label}</span>
              {option.value === value && <Check size={14} aria-hidden="true" />}
            </li>
          ))}
      </ul>
    </div>
  );
}

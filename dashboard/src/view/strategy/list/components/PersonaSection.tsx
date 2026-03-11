import { useState, useEffect, useRef, useCallback } from 'react';
import TextareaAutosize from 'react-textarea-autosize';
import { useUpdatePersona } from '@/hooks/strategy/useStrategyConfig';
import type { StrategyConfigRecord, PersonaTextDimension } from '@/api/types/strategy.types';
import styles from '../styles/index.module.scss';

interface Props {
  config: StrategyConfigRecord;
}

export default function PersonaSection({ config }: Props) {
  const allDims = config.persona.textDimensions;
  const [dimensions, setDimensions] = useState<PersonaTextDimension[]>(allDims);
  const [activeKey, setActiveKey] = useState<string>(allDims[0]?.key ?? '');
  const updateMutation = useUpdatePersona();
  const dimensionsRef = useRef(dimensions);
  const savedRef = useRef(allDims);
  const itemRefs = useRef<Record<string, HTMLDivElement | null>>({});

  useEffect(() => {
    setDimensions(allDims);
    dimensionsRef.current = allDims;
    savedRef.current = allDims;
  }, [allDims]);

  const handleChange = (key: string, value: string) => {
    const next = dimensions.map((d) => (d.key === key ? { ...d, value } : d));
    setDimensions(next);
    dimensionsRef.current = next;
  };

  const isDirty = () => {
    const current = dimensionsRef.current;
    const saved = savedRef.current;
    if (current.length !== saved.length) return true;
    return current.some((d, i) => d.value !== saved[i].value);
  };

  const handleBlur = () => {
    if (!isDirty()) return;
    updateMutation.mutate({ textDimensions: dimensionsRef.current });
  };

  const scrollTo = useCallback((key: string) => {
    setActiveKey(key);
    itemRefs.current[key]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  return (
    <div className={styles.panel}>
      <div className={styles.personaHeader}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>人格设定</h2>
          <p className={styles.sectionDesc}>
            定义 AI 招聘经理的人格特质和沟通方式，每个栏目的内容将注入到系统提示词中
          </p>
        </div>
        <nav className={styles.dimensionNav}>
          {dimensions.map((dim) => (
            <button
              key={dim.key}
              className={`${styles.dimensionNavItem} ${activeKey === dim.key ? styles.dimensionNavActive : ''}`}
              onClick={() => scrollTo(dim.key)}
            >
              {dim.label}
            </button>
          ))}
        </nav>
      </div>

      <div className={styles.dimensionGroup}>
        {dimensions.map((dim) => (
          <div
            key={dim.key}
            className={styles.dimensionItem}
            ref={(el) => { itemRefs.current[dim.key] = el; }}
          >
            <label className={styles.dimensionLabel}>
              {dim.label}
            </label>
            <TextareaAutosize
              className={styles.textArea}
              value={dim.value}
              placeholder={dim.placeholder}
              onChange={(e) => handleChange(dim.key, e.target.value)}
              onBlur={handleBlur}
              onFocus={() => setActiveKey(dim.key)}
              minRows={3}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

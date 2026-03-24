import { useState, useEffect, useRef, useCallback } from 'react';
import TextareaAutosize from 'react-textarea-autosize';
import { useUpdatePersona, useUpdateRoleSetting } from '@/hooks/strategy/useStrategyConfig';
import type { StrategyConfigRecord, PersonaTextDimension } from '@/api/types/strategy.types';
import styles from '../styles/index.module.scss';

interface Props {
  config: StrategyConfigRecord;
}

const ROLE_KEY = '_roleSetting';

export default function PersonaSection({ config }: Props) {
  const allDims = config.persona.textDimensions;
  const [dimensions, setDimensions] = useState<PersonaTextDimension[]>(allDims);
  const [activeKey, setActiveKey] = useState<string>(ROLE_KEY);
  const updatePersonaMutation = useUpdatePersona();
  const updateRoleSettingMutation = useUpdateRoleSetting();
  const dimensionsRef = useRef(dimensions);
  const savedRef = useRef(allDims);
  const itemRefs = useRef<Record<string, HTMLDivElement | null>>({});

  // Role setting state
  const initialRoleContent = config.role_setting?.content ?? '';
  const [roleContent, setRoleContent] = useState(initialRoleContent);
  const savedRoleRef = useRef(initialRoleContent);

  useEffect(() => {
    setDimensions(allDims);
    dimensionsRef.current = allDims;
    savedRef.current = allDims;
  }, [allDims]);

  useEffect(() => {
    const next = config.role_setting?.content ?? '';
    setRoleContent(next);
    savedRoleRef.current = next;
  }, [config.role_setting]);

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

  const handlePersonaBlur = () => {
    if (!isDirty()) return;
    updatePersonaMutation.mutate({ textDimensions: dimensionsRef.current });
  };

  const handleRoleBlur = () => {
    if (roleContent === savedRoleRef.current) return;
    updateRoleSettingMutation.mutate({ content: roleContent });
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
            定义 AI 招聘经理的角色身份、人格特质和沟通方式，每个栏目的内容将注入到系统提示词中
          </p>
        </div>
        <nav className={styles.dimensionNav}>
          <button
            className={`${styles.dimensionNavItem} ${activeKey === ROLE_KEY ? styles.dimensionNavActive : ''}`}
            onClick={() => scrollTo(ROLE_KEY)}
          >
            角色设定
          </button>
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
        <div
          className={styles.dimensionItem}
          ref={(el) => { itemRefs.current[ROLE_KEY] = el; }}
        >
          <label className={styles.dimensionLabel}>角色设定</label>
          <TextareaAutosize
            className={styles.textArea}
            value={roleContent}
            placeholder="描述 Agent 的角色身份、沟通场景和核心使命。例如：你是「独立客」招聘经理，在企业微信与蓝领候选人一对一沟通……"
            onChange={(e) => setRoleContent(e.target.value)}
            onBlur={handleRoleBlur}
            onFocus={() => setActiveKey(ROLE_KEY)}
            minRows={4}
          />
        </div>

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
              onBlur={handlePersonaBlur}
              onFocus={() => setActiveKey(dim.key)}
              minRows={3}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

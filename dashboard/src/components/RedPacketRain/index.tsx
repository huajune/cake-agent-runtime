import { useEffect, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import styles from './index.module.scss';

interface RedPacket {
  id: number;
  left: number;
  delay: number;
  duration: number;
  size: number;
  rotation: number;
  type: 'packet' | 'coin' | 'sparkle';
}

interface RedPacketRainProps {
  active: boolean;
  duration?: number; // 持续时间，默认 3000ms
  density?: number; // 红包密度，默认 25
  onComplete?: () => void;
}

/**
 * 红包雨组件 - 新春特效
 */
export default function RedPacketRain({
  active,
  duration = 3000,
  density = 25,
  onComplete,
}: RedPacketRainProps) {
  const [packets, setPackets] = useState<RedPacket[]>([]);
  const [isVisible, setIsVisible] = useState(false);

  const generatePackets = useCallback(() => {
    const newPackets: RedPacket[] = [];
    for (let i = 0; i < density; i++) {
      const types: RedPacket['type'][] = ['packet', 'packet', 'packet', 'coin', 'sparkle'];
      newPackets.push({
        id: i,
        left: Math.random() * 100,
        delay: Math.random() * 500, // 缩短延迟，让红包快速出现
        duration: 1200 + Math.random() * 800, // 缩短下落时间，快速划过
        size: 0.6 + Math.random() * 0.6,
        rotation: -30 + Math.random() * 60,
        type: types[Math.floor(Math.random() * types.length)],
      });
    }
    return newPackets;
  }, [density]);

  useEffect(() => {
    if (active) {
      setPackets(generatePackets());
      setIsVisible(true);

      const timer = setTimeout(() => {
        setIsVisible(false);
        setPackets([]);
        onComplete?.();
      }, duration); // 与 duration 同步移除容器

      return () => clearTimeout(timer);
    }
  }, [active, duration, generatePackets, onComplete]);

  if (!isVisible || packets.length === 0) return null;

  const content = (
    <div className={styles.rainContainer}>
      {packets.map((packet) => (
        <div
          key={packet.id}
          className={`${styles.packet} ${styles[packet.type]}`}
          style={{
            left: `${packet.left}%`,
            animationDelay: `${packet.delay}ms`,
            animationDuration: `${packet.duration}ms`,
            transform: `scale(${packet.size}) rotate(${packet.rotation}deg)`,
          }}
        >
          {packet.type === 'packet' && <RedPacketSVG />}
          {packet.type === 'coin' && <CoinSVG />}
          {packet.type === 'sparkle' && <SparkleSVG />}
        </div>
      ))}
      {/* 中心祝福语 */}
      <div className={styles.blessing}>
        <span className={styles.blessingText}>恭喜发财</span>
        <span className={styles.blessingSubtext}>反馈提交成功!</span>
      </div>
    </div>
  );

  return createPortal(content, document.body);
}

// 红包 SVG
function RedPacketSVG() {
  return (
    <svg width="48" height="56" viewBox="0 0 60 70" fill="none">
      <defs>
        <linearGradient id="rpRed" x1="30" y1="0" x2="30" y2="70" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#EF4444" />
          <stop offset="0.5" stopColor="#DC2626" />
          <stop offset="1" stopColor="#991B1B" />
        </linearGradient>
        <linearGradient id="rpGold" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#FCD34D" />
          <stop offset="0.5" stopColor="#FBBF24" />
          <stop offset="1" stopColor="#D97706" />
        </linearGradient>
      </defs>
      {/* 红包主体 */}
      <rect x="8" y="8" width="44" height="54" rx="4" fill="url(#rpRed)" />
      {/* 金色封口 */}
      <path d="M8 20 Q30 28 52 20 L52 8 Q30 16 8 8 Z" fill="url(#rpGold)" />
      {/* 金色圆扣 */}
      <circle cx="30" cy="24" r="8" fill="url(#rpGold)" stroke="#B45309" strokeWidth="1" />
      {/* 福字 */}
      <text x="30" y="50" fontSize="20" fill="#FCD34D" textAnchor="middle" fontWeight="bold">福</text>
    </svg>
  );
}

// 金币 SVG
function CoinSVG() {
  return (
    <svg width="32" height="32" viewBox="0 0 40 40" fill="none">
      <defs>
        <linearGradient id="coinGold" x1="0" y1="0" x2="40" y2="40" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#FEF3C7" />
          <stop offset="0.3" stopColor="#FCD34D" />
          <stop offset="0.6" stopColor="#FBBF24" />
          <stop offset="1" stopColor="#D97706" />
        </linearGradient>
      </defs>
      <circle cx="20" cy="20" r="18" fill="url(#coinGold)" stroke="#B45309" strokeWidth="2" />
      <rect x="14" y="14" width="12" height="12" fill="#D97706" rx="2" />
    </svg>
  );
}

// 闪光 SVG
function SparkleSVG() {
  return (
    <svg width="24" height="24" viewBox="0 0 32 32" fill="none">
      <path
        d="M16 2 L18 12 L28 14 L18 16 L16 26 L14 16 L4 14 L14 12 Z"
        fill="#FCD34D"
        stroke="#D97706"
        strokeWidth="1"
      />
    </svg>
  );
}

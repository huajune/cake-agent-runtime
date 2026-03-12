import { useState, useEffect, useCallback } from 'react';
import { Outlet } from 'react-router-dom';
import Sidebar from '@/components/Sidebar';
import FestivalPendant from '@/components/FestivalPendant';

export default function Layout() {
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);

  const toggleSidebar = useCallback(() => {
    setIsSidebarCollapsed((prev) => !prev);
  }, []);

  // 监听 Cmd+S (Mac) / Ctrl+S (Windows) 快捷键
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault(); // 阻止浏览器默认保存行为
        toggleSidebar();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [toggleSidebar]);

  return (
    <>
      {/* 柔和背景动画 */}
      <div className="background-gradients">
        <span className="bg-blue"></span>
        <span className="bg-purple"></span>
      </div>

      {/* Spring Festival Garland - 2026 Year of Horse */}
      <div className="spring-garland" style={{ gap: '6px', alignItems: 'flex-start', left: isSidebarCollapsed ? '72px' : '260px' }}>
        <div className="garland-string" />

        {/* 左侧春灯笼 */}
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          animation: 'swing 2.5s ease-in-out infinite',
          transformOrigin: 'top center'
        }}>
          <div style={{ width: '2px', height: '10px', background: '#fbbf24' }} />
          <svg width="36" height="50" viewBox="0 0 40 55" fill="none">
            <defs>
              <linearGradient id="lanternRed1" x1="20" y1="0" x2="20" y2="50" gradientUnits="userSpaceOnUse">
                <stop offset="0" stopColor="#EF4444" />
                <stop offset="1" stopColor="#991B1B" />
              </linearGradient>
            </defs>
            <rect x="14" y="2" width="12" height="4" rx="1" fill="#F59E0B" />
            <ellipse cx="20" cy="24" rx="16" ry="18" fill="url(#lanternRed1)" />
            <path d="M6 18 Q20 14 34 18" stroke="#B91C1C" strokeWidth="1.5" fill="none" />
            <path d="M4 24 Q20 20 36 24" stroke="#B91C1C" strokeWidth="1.5" fill="none" />
            <path d="M6 30 Q20 26 34 30" stroke="#B91C1C" strokeWidth="1.5" fill="none" />
            <text x="20" y="28" fontSize="12" fill="#FCD34D" textAnchor="middle" fontWeight="bold">春</text>
            <rect x="14" y="40" width="12" height="4" rx="1" fill="#F59E0B" />
            <path d="M17 44 L15 54" stroke="#F59E0B" strokeWidth="1.5" />
            <path d="M20 44 L20 55" stroke="#F59E0B" strokeWidth="1.5" />
            <path d="M23 44 L25 54" stroke="#F59E0B" strokeWidth="1.5" />
          </svg>
        </div>

        {/* 左侧鞭炮串 */}
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          animation: 'swing 2s ease-in-out infinite',
          transformOrigin: 'top center'
        }}>
          <div style={{ width: '2px', height: '8px', background: '#fbbf24' }} />
          <svg width="38" height="85" viewBox="0 0 50 110" fill="none">
            <defs>
              <linearGradient id="fcOrangeL" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0" stopColor="#EA580C" />
                <stop offset="0.3" stopColor="#F97316" />
                <stop offset="0.5" stopColor="#FDBA74" />
                <stop offset="0.7" stopColor="#F97316" />
                <stop offset="1" stopColor="#C2410C" />
              </linearGradient>
              <linearGradient id="fcCapL" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0" stopColor="#DC2626" />
                <stop offset="0.5" stopColor="#EF4444" />
                <stop offset="1" stopColor="#B91C1C" />
              </linearGradient>
            </defs>
            <path d="M25 5 Q28 20 22 35 Q28 50 22 65 Q28 80 25 95" stroke="#92400E" strokeWidth="1.5" fill="none" />
            {[0, 1, 2, 3, 4, 5].map((i) => {
              const isLeft = i % 2 === 0;
              const cx = isLeft ? 15 : 35;
              const cy = 12 + i * 15;
              return (
                <g key={i} transform={`rotate(${isLeft ? -15 : 15} ${cx} ${cy})`}>
                  <ellipse cx={cx} cy={cy - 5} rx="6" ry="2.5" fill="url(#fcCapL)" />
                  <rect x={cx - 6} y={cy - 5} width="12" height="14" fill="url(#fcOrangeL)" />
                  <ellipse cx={cx} cy={cy + 9} rx="6" ry="2.5" fill="#DC2626" />
                  <path d={`M${cx} ${cy - 7} Q${cx + (isLeft ? 3 : -3)} ${cy - 10} ${cx + (isLeft ? 5 : -5)} ${cy - 12}`} stroke="#78350F" strokeWidth="1" fill="none" />
                </g>
              );
            })}
            <circle cx="25" cy="100" r="3" fill="#FBBF24">
              <animate attributeName="r" values="3;5;3" dur="0.3s" repeatCount="indefinite" />
              <animate attributeName="opacity" values="1;0.6;1" dur="0.3s" repeatCount="indefinite" />
            </circle>
            <circle cx="20" cy="103" r="2" fill="#FCD34D">
              <animate attributeName="opacity" values="0.8;0.3;0.8" dur="0.25s" repeatCount="indefinite" />
            </circle>
            <circle cx="30" cy="102" r="2" fill="#FEF3C7">
              <animate attributeName="opacity" values="0.6;1;0.6" dur="0.35s" repeatCount="indefinite" />
            </circle>
          </svg>
        </div>

        {/* 金币串 */}
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          animation: 'swing 2.2s ease-in-out infinite',
          transformOrigin: 'top center'
        }}>
          <div style={{ width: '2px', height: '6px', background: '#fbbf24' }} />
          <svg width="16" height="72" viewBox="0 0 18 95" fill="none">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <g key={i}>
                <circle cx="9" cy={8 + i * 15} r="5" fill="#FCD34D" stroke="#D97706" strokeWidth="1" />
                <rect x="6.5" y={5.5 + i * 15} width="5" height="5" fill="#D97706" rx="1" />
                {i < 5 && <path d={`M9 ${13 + i * 15} L9 ${15 + i * 15}`} stroke="#D97706" strokeWidth="1" />}
              </g>
            ))}
          </svg>
        </div>

        {/* 2026 连在一起 */}
        <FestivalPendant content="2" delay="0s" ropeHeight={15} fontSize={64} />
        <FestivalPendant content="0" delay="0.2s" ropeHeight={10} fontSize={64} />
        <FestivalPendant content="2" delay="0.4s" ropeHeight={16} fontSize={64} />
        <FestivalPendant content="6" delay="0.6s" ropeHeight={12} fontSize={64} />

        {/* 小福袋B */}
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          animation: 'swing 2.2s ease-in-out infinite',
          transformOrigin: 'top center'
        }}>
          <div style={{ width: '2px', height: '10px', background: '#fbbf24' }} />
          <svg width="24" height="32" viewBox="0 0 60 70" fill="none">
            <defs>
              <linearGradient id="bagRedB" x1="30" y1="0" x2="30" y2="70" gradientUnits="userSpaceOnUse">
                <stop offset="0" stopColor="#EF4444" />
                <stop offset="0.6" stopColor="#DC2626" />
                <stop offset="1" stopColor="#991B1B" />
              </linearGradient>
              <linearGradient id="bagGoldB" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="#FCD34D" />
                <stop offset="1" stopColor="#D97706" />
              </linearGradient>
            </defs>
            <path d="M12 28 C 4 38, 2 58, 14 65 Q 30 73 46 65 C 58 58, 56 38, 48 28 Q 30 22 12 28 Z" fill="url(#bagRedB)" stroke="#B91C1C" strokeWidth="1" />
            <g transform="translate(0, -2)">
              <path d="M20 16 Q 30 24 40 16 L 44 12 Q 30 18 16 12 Z" fill="url(#bagGoldB)" stroke="#B45309" strokeWidth="1" />
            </g>
            <path d="M18 24 L 14 12 C 12 8, 20 4, 30 8 C 40 4, 48 8, 46 12 L 42 24 Z" fill="#EF4444" stroke="#B91C1C" strokeWidth="1" />
            <path d="M14 26 Q 30 30 46 26" stroke="#FCD34D" strokeWidth="4" strokeLinecap="round" />
            <circle cx="30" cy="27" r="5" fill="url(#bagGoldB)" stroke="#B45309" strokeWidth="0.5" />
            <text x="30" y="52" fontSize="18" fill="#FCD34D" textAnchor="middle" fontWeight="bold">福</text>
          </svg>
        </div>

        {/* 中国结 */}
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          animation: 'swing 1.8s ease-in-out infinite',
          transformOrigin: 'top center'
        }}>
          <div style={{ width: '2px', height: '6px', background: '#DC2626' }} />
          <svg width="52" height="112" viewBox="0 0 60 130" fill="none">
            <path d="M30 0 L30 12" stroke="#DC2626" strokeWidth="4" />
            <circle cx="30" cy="14" r="4" fill="#DC2626" />
            <path d="M30 18 L30 22" stroke="#DC2626" strokeWidth="4" />
            <circle cx="30" cy="26" r="5" fill="none" stroke="#DC2626" strokeWidth="3.5" />
            <g transform="translate(30, 58)">
              <path d="M0 -22 L22 0 L0 22 L-22 0 Z" fill="none" stroke="#DC2626" strokeWidth="4" />
              <path d="M-15 -7 L15 -7" stroke="#DC2626" strokeWidth="3.5" />
              <path d="M-15 0 L15 0" stroke="#DC2626" strokeWidth="3.5" />
              <path d="M-15 7 L15 7" stroke="#DC2626" strokeWidth="3.5" />
              <path d="M-7 -15 L-7 15" stroke="#DC2626" strokeWidth="3.5" />
              <path d="M0 -18 L0 18" stroke="#DC2626" strokeWidth="3.5" />
              <path d="M7 -15 L7 15" stroke="#DC2626" strokeWidth="3.5" />
              <circle cx="0" cy="-22" r="5" fill="none" stroke="#DC2626" strokeWidth="3" />
              <circle cx="22" cy="0" r="5" fill="none" stroke="#DC2626" strokeWidth="3" />
              <circle cx="0" cy="22" r="5" fill="none" stroke="#DC2626" strokeWidth="3" />
              <circle cx="-22" cy="0" r="5" fill="none" stroke="#DC2626" strokeWidth="3" />
            </g>
            <circle cx="30" cy="84" r="4" fill="#DC2626" />
            <path d="M30 88 L30 95" stroke="#DC2626" strokeWidth="4" />
            <circle cx="30" cy="97" r="3" fill="#DC2626" />
            <path d="M24 100 L24 125" stroke="#DC2626" strokeWidth="2" />
            <path d="M26 100 L26 127" stroke="#DC2626" strokeWidth="2" />
            <path d="M28 100 L28 128" stroke="#DC2626" strokeWidth="2" />
            <path d="M30 100 L30 130" stroke="#DC2626" strokeWidth="2" />
            <path d="M32 100 L32 128" stroke="#DC2626" strokeWidth="2" />
            <path d="M34 100 L34 127" stroke="#DC2626" strokeWidth="2" />
            <path d="M36 100 L36 125" stroke="#DC2626" strokeWidth="2" />
          </svg>
        </div>

        {/* 马年大吉 连在一起 */}
        <FestivalPendant content="马" delay="0.9s" ropeHeight={8} fontSize={48} />
        <FestivalPendant content="年" delay="1.1s" ropeHeight={18} fontSize={48} />
        <FestivalPendant content="大" delay="1.3s" ropeHeight={11} fontSize={48} />
        <FestivalPendant content="吉" delay="1.5s" ropeHeight={13} fontSize={48} />

        {/* 小福袋2 */}
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          animation: 'swing 2.4s ease-in-out infinite',
          transformOrigin: 'top center'
        }}>
          <div style={{ width: '2px', height: '10px', background: '#fbbf24' }} />
          <svg width="24" height="32" viewBox="0 0 60 70" fill="none">
            <defs>
              <linearGradient id="bagRed2" x1="30" y1="0" x2="30" y2="70" gradientUnits="userSpaceOnUse">
                <stop offset="0" stopColor="#EF4444" />
                <stop offset="0.6" stopColor="#DC2626" />
                <stop offset="1" stopColor="#991B1B" />
              </linearGradient>
              <linearGradient id="bagGold2" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="#FCD34D" />
                <stop offset="1" stopColor="#D97706" />
              </linearGradient>
            </defs>
            <path d="M12 28 C 4 38, 2 58, 14 65 Q 30 73 46 65 C 58 58, 56 38, 48 28 Q 30 22 12 28 Z" fill="url(#bagRed2)" stroke="#B91C1C" strokeWidth="1" />
            <g transform="translate(0, -2)">
              <path d="M20 16 Q 30 24 40 16 L 44 12 Q 30 18 16 12 Z" fill="url(#bagGold2)" stroke="#B45309" strokeWidth="1" />
            </g>
            <path d="M18 24 L 14 12 C 12 8, 20 4, 30 8 C 40 4, 48 8, 46 12 L 42 24 Z" fill="#EF4444" stroke="#B91C1C" strokeWidth="1" />
            <path d="M14 26 Q 30 30 46 26" stroke="#FCD34D" strokeWidth="4" strokeLinecap="round" />
            <circle cx="30" cy="27" r="5" fill="url(#bagGold2)" stroke="#B45309" strokeWidth="0.5" />
            <text x="30" y="52" fontSize="18" fill="#FCD34D" textAnchor="middle" fontWeight="bold">福</text>
          </svg>
        </div>

        {/* 金币串2 */}
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          animation: 'swing 2.5s ease-in-out infinite',
          transformOrigin: 'top center'
        }}>
          <div style={{ width: '2px', height: '7px', background: '#fbbf24' }} />
          <svg width="16" height="60" viewBox="0 0 18 80" fill="none">
            {[0, 1, 2, 3, 4].map((i) => (
              <g key={i}>
                <circle cx="9" cy={8 + i * 15} r="5" fill="#FCD34D" stroke="#D97706" strokeWidth="1" />
                <rect x="6.5" y={5.5 + i * 15} width="5" height="5" fill="#D97706" rx="1" />
                {i < 4 && <path d={`M9 ${13 + i * 15} L9 ${15 + i * 15}`} stroke="#D97706" strokeWidth="1" />}
              </g>
            ))}
          </svg>
        </div>

        {/* 右侧鞭炮串 */}
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          animation: 'swing 2s ease-in-out infinite',
          animationDelay: '0.3s',
          transformOrigin: 'top center'
        }}>
          <div style={{ width: '2px', height: '8px', background: '#fbbf24' }} />
          <svg width="38" height="85" viewBox="0 0 50 110" fill="none">
            <defs>
              <linearGradient id="fcOrangeR" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0" stopColor="#EA580C" />
                <stop offset="0.3" stopColor="#F97316" />
                <stop offset="0.5" stopColor="#FDBA74" />
                <stop offset="0.7" stopColor="#F97316" />
                <stop offset="1" stopColor="#C2410C" />
              </linearGradient>
              <linearGradient id="fcCapR" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0" stopColor="#DC2626" />
                <stop offset="0.5" stopColor="#EF4444" />
                <stop offset="1" stopColor="#B91C1C" />
              </linearGradient>
            </defs>
            <path d="M25 5 Q28 20 22 35 Q28 50 22 65 Q28 80 25 95" stroke="#92400E" strokeWidth="1.5" fill="none" />
            {[0, 1, 2, 3, 4, 5].map((i) => {
              const isLeft = i % 2 === 0;
              const cx = isLeft ? 15 : 35;
              const cy = 12 + i * 15;
              return (
                <g key={i} transform={`rotate(${isLeft ? -15 : 15} ${cx} ${cy})`}>
                  <ellipse cx={cx} cy={cy - 5} rx="6" ry="2.5" fill="url(#fcCapR)" />
                  <rect x={cx - 6} y={cy - 5} width="12" height="14" fill="url(#fcOrangeR)" />
                  <ellipse cx={cx} cy={cy + 9} rx="6" ry="2.5" fill="#DC2626" />
                  <path d={`M${cx} ${cy - 7} Q${cx + (isLeft ? 3 : -3)} ${cy - 10} ${cx + (isLeft ? 5 : -5)} ${cy - 12}`} stroke="#78350F" strokeWidth="1" fill="none" />
                </g>
              );
            })}
            <circle cx="25" cy="100" r="3" fill="#FBBF24">
              <animate attributeName="r" values="3;5;3" dur="0.3s" repeatCount="indefinite" />
              <animate attributeName="opacity" values="1;0.6;1" dur="0.3s" repeatCount="indefinite" />
            </circle>
            <circle cx="20" cy="103" r="2" fill="#FCD34D">
              <animate attributeName="opacity" values="0.8;0.3;0.8" dur="0.25s" repeatCount="indefinite" />
            </circle>
            <circle cx="30" cy="102" r="2" fill="#FEF3C7">
              <animate attributeName="opacity" values="0.6;1;0.6" dur="0.35s" repeatCount="indefinite" />
            </circle>
          </svg>
        </div>

        {/* 右侧春灯笼 */}
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          animation: 'swing 2.5s ease-in-out infinite',
          animationDelay: '0.5s',
          transformOrigin: 'top center'
        }}>
          <div style={{ width: '2px', height: '10px', background: '#fbbf24' }} />
          <svg width="36" height="50" viewBox="0 0 40 55" fill="none">
            <defs>
              <linearGradient id="lanternRed2" x1="20" y1="0" x2="20" y2="50" gradientUnits="userSpaceOnUse">
                <stop offset="0" stopColor="#EF4444" />
                <stop offset="1" stopColor="#991B1B" />
              </linearGradient>
            </defs>
            <rect x="14" y="2" width="12" height="4" rx="1" fill="#F59E0B" />
            <ellipse cx="20" cy="24" rx="16" ry="18" fill="url(#lanternRed2)" />
            <path d="M6 18 Q20 14 34 18" stroke="#B91C1C" strokeWidth="1.5" fill="none" />
            <path d="M4 24 Q20 20 36 24" stroke="#B91C1C" strokeWidth="1.5" fill="none" />
            <path d="M6 30 Q20 26 34 30" stroke="#B91C1C" strokeWidth="1.5" fill="none" />
            <text x="20" y="28" fontSize="12" fill="#FCD34D" textAnchor="middle" fontWeight="bold">春</text>
            <rect x="14" y="40" width="12" height="4" rx="1" fill="#F59E0B" />
            <path d="M17 44 L15 54" stroke="#F59E0B" strokeWidth="1.5" />
            <path d="M20 44 L20 55" stroke="#F59E0B" strokeWidth="1.5" />
            <path d="M23 44 L25 54" stroke="#F59E0B" strokeWidth="1.5" />
          </svg>
        </div>
      </div>

      <div className={`app-layout ${isSidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
        <Sidebar isCollapsed={isSidebarCollapsed} onToggle={toggleSidebar} />
        <main className="content">
          <div className="container">
            <Outlet />
          </div>
        </main>
      </div>
    </>
  );
}

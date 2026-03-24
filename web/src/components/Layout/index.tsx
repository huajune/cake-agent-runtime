import { useState, useEffect, useCallback } from 'react';
import { Outlet } from 'react-router-dom';
import Sidebar from '@/components/Sidebar';

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

      {/* 春日装饰 - 樱花枝 */}
      <div className="spring-garland" style={{ gap: '0', alignItems: 'flex-start', left: isSidebarCollapsed ? '72px' : '260px', justifyContent: 'space-between', padding: '0 20px' }}>
        {/* 左侧樱花枝 - 从左上角垂下 */}
        <svg width="120" height="90" viewBox="0 0 150 110" fill="none" style={{ marginTop: '-10px' }}>
          <defs>
            <radialGradient id="bloomL" cx="50%" cy="50%">
              <stop offset="0%" stopColor="#FDF2F8" />
              <stop offset="50%" stopColor="#FBCFE8" />
              <stop offset="100%" stopColor="#F9A8D4" />
            </radialGradient>
            <radialGradient id="bloomCenter" cx="50%" cy="50%">
              <stop offset="0%" stopColor="#FFF" />
              <stop offset="60%" stopColor="#FDE68A" />
              <stop offset="100%" stopColor="#FCD34D" />
            </radialGradient>
          </defs>
          {/* 主枝 */}
          <path d="M0 5 Q30 8 60 20 Q90 35 120 30 Q135 28 145 35" stroke="#86EFAC" strokeWidth="3" fill="none" />
          {/* 分枝 */}
          <path d="M40 14 Q45 30 38 45" stroke="#86EFAC" strokeWidth="2" fill="none" />
          <path d="M80 28 Q85 45 78 58" stroke="#86EFAC" strokeWidth="2" fill="none" />
          <path d="M110 30 Q118 18 125 12" stroke="#86EFAC" strokeWidth="2" fill="none" />
          {/* 花朵1 */}
          <g transform="translate(38, 48)">
            {[0, 72, 144, 216, 288].map((r) => (
              <ellipse key={r} cx="0" cy="-6" rx="4" ry="7" fill="url(#bloomL)" transform={`rotate(${r})`} opacity="0.9" />
            ))}
            <circle cx="0" cy="0" r="3" fill="url(#bloomCenter)" />
          </g>
          {/* 花朵2 */}
          <g transform="translate(78, 60)">
            {[0, 72, 144, 216, 288].map((r) => (
              <ellipse key={r} cx="0" cy="-5" rx="3.5" ry="6" fill="url(#bloomL)" transform={`rotate(${r})`} opacity="0.85" />
            ))}
            <circle cx="0" cy="0" r="2.5" fill="url(#bloomCenter)" />
          </g>
          {/* 花朵3 - 枝头 */}
          <g transform="translate(125, 10)">
            {[0, 72, 144, 216, 288].map((r) => (
              <ellipse key={r} cx="0" cy="-5" rx="3.5" ry="6" fill="url(#bloomL)" transform={`rotate(${r})`} opacity="0.9" />
            ))}
            <circle cx="0" cy="0" r="2.5" fill="url(#bloomCenter)" />
          </g>
          {/* 花朵4 - 主枝上 */}
          <g transform="translate(60, 18)">
            {[0, 72, 144, 216, 288].map((r) => (
              <ellipse key={r} cx="0" cy="-4" rx="3" ry="5" fill="url(#bloomL)" transform={`rotate(${r})`} opacity="0.8" />
            ))}
            <circle cx="0" cy="0" r="2" fill="url(#bloomCenter)" />
          </g>
          {/* 花苞 */}
          <ellipse cx="145" cy="38" rx="3" ry="4.5" fill="#FBCFE8" />
          <path d="M143 34 Q145 30 147 34" stroke="#86EFAC" strokeWidth="1.2" fill="#BBF7D0" />
          <ellipse cx="100" cy="32" rx="2.5" ry="3.5" fill="#FBCFE8" />
          {/* 叶子 */}
          <ellipse cx="25" cy="12" rx="4" ry="8" fill="#BBF7D0" transform="rotate(60, 25, 12)" opacity="0.7" />
          <ellipse cx="50" cy="22" rx="3" ry="6" fill="#BBF7D0" transform="rotate(40, 50, 22)" opacity="0.6" />
          <ellipse cx="95" cy="38" rx="3" ry="6" fill="#BBF7D0" transform="rotate(-20, 95, 38)" opacity="0.7" />
          {/* 飘落花瓣 */}
          <ellipse cx="55" cy="75" rx="3" ry="2" fill="#FBCFE8" opacity="0.6" transform="rotate(-30, 55, 75)">
            <animateTransform attributeName="transform" type="translate" values="0 0;5 15;10 30" dur="4s" repeatCount="indefinite" />
            <animate attributeName="opacity" values="0.6;0.3;0" dur="4s" repeatCount="indefinite" />
          </ellipse>
          <ellipse cx="90" cy="80" rx="2.5" ry="1.8" fill="#F9A8D4" opacity="0.5" transform="rotate(20, 90, 80)">
            <animateTransform attributeName="transform" type="translate" values="0 0;-3 12;-6 25" dur="5s" repeatCount="indefinite" />
            <animate attributeName="opacity" values="0.5;0.25;0" dur="5s" repeatCount="indefinite" />
          </ellipse>
        </svg>

        {/* 中间吊坠区 */}
        <div style={{ display: 'flex', flex: 1, justifyContent: 'space-evenly', alignItems: 'flex-start' }}>
          {/* 绿叶藤蔓1 */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', animation: 'swing 3.2s ease-in-out infinite', transformOrigin: 'top center' }}>
            <div style={{ width: '1.5px', height: '10px', background: '#86EFAC' }} />
            <svg width="28" height="50" viewBox="0 0 30 55" fill="none">
              <path d="M15 0 Q13 15 16 30 Q14 42 15 52" stroke="#86EFAC" strokeWidth="2" fill="none" />
              <ellipse cx="8" cy="12" rx="5" ry="8" fill="#BBF7D0" transform="rotate(-30, 8, 12)" opacity="0.8" />
              <ellipse cx="22" cy="24" rx="5" ry="8" fill="#86EFAC" transform="rotate(25, 22, 24)" opacity="0.7" />
              <ellipse cx="9" cy="38" rx="4" ry="7" fill="#BBF7D0" transform="rotate(-20, 9, 38)" opacity="0.75" />
            </svg>
          </div>

          {/* 樱花+叶子 */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', animation: 'swing 3s ease-in-out infinite', transformOrigin: 'top center' }}>
            <div style={{ width: '1.5px', height: '14px', background: 'linear-gradient(180deg, #86EFAC, #FBCFE8)' }} />
            <svg width="40" height="44" viewBox="0 0 44 48" fill="none">
              <path d="M22 0 Q20 12 24 24" stroke="#86EFAC" strokeWidth="2" fill="none" />
              <ellipse cx="16" cy="10" rx="4" ry="7" fill="#BBF7D0" transform="rotate(-25, 16, 10)" opacity="0.8" />
              <ellipse cx="30" cy="16" rx="3.5" ry="6" fill="#86EFAC" transform="rotate(20, 30, 16)" opacity="0.7" />
              <g transform="translate(22, 30)">
                {[0, 72, 144, 216, 288].map((r) => (
                  <ellipse key={r} cx="0" cy="-7" rx="4.5" ry="8" fill="#FBCFE8" transform={`rotate(${r})`} opacity="0.9" />
                ))}
                <circle cx="0" cy="0" r="3.5" fill="#FDE68A" />
              </g>
            </svg>
          </div>

          {/* 蝴蝶 */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', animation: 'butterflyFloat 4s ease-in-out infinite', transformOrigin: 'top center' }}>
            <div style={{ width: '1px', height: '10px', background: '#D8B4FE' }} />
            <svg width="42" height="36" viewBox="0 0 36 30" fill="none">
              <path d="M18 15 Q8 4 4 10 Q2 18 12 19 Q14 19 18 15Z" fill="#C4B5FD" opacity="0.85">
                <animateTransform attributeName="transform" type="rotate" values="-5 18 15;10 18 15;-5 18 15" dur="0.6s" repeatCount="indefinite" />
              </path>
              <path d="M18 15 Q28 4 32 10 Q34 18 24 19 Q22 19 18 15Z" fill="#DDD6FE" opacity="0.85">
                <animateTransform attributeName="transform" type="rotate" values="5 18 15;-10 18 15;5 18 15" dur="0.6s" repeatCount="indefinite" />
              </path>
              <path d="M18 15 Q12 22 10 25 Q14 28 18 22Z" fill="#C4B5FD" opacity="0.6" />
              <path d="M18 15 Q24 22 26 25 Q22 28 18 22Z" fill="#DDD6FE" opacity="0.6" />
              <ellipse cx="18" cy="17" rx="1.5" ry="5.5" fill="#7C3AED" />
              <path d="M17 12 Q14 6 12 4" stroke="#7C3AED" strokeWidth="0.8" fill="none" />
              <path d="M19 12 Q22 6 24 4" stroke="#7C3AED" strokeWidth="0.8" fill="none" />
              <circle cx="12" cy="4" r="1" fill="#A78BFA" />
              <circle cx="24" cy="4" r="1" fill="#A78BFA" />
            </svg>
          </div>

          {/* 小鸟+树枝 */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', animation: 'butterflyFloat 3.5s ease-in-out infinite', animationDelay: '1s', transformOrigin: 'top center' }}>
            <div style={{ width: '1.5px', height: '12px', background: '#86EFAC' }} />
            <svg width="44" height="38" viewBox="0 0 48 40" fill="none">
              <path d="M10 36 Q24 34 38 36" stroke="#86EFAC" strokeWidth="2.5" fill="none" />
              <ellipse cx="8" cy="32" rx="3" ry="5" fill="#BBF7D0" transform="rotate(-40, 8, 32)" opacity="0.8" />
              <ellipse cx="40" cy="32" rx="3" ry="5" fill="#86EFAC" transform="rotate(40, 40, 32)" opacity="0.7" />
              <ellipse cx="24" cy="24" rx="8" ry="6" fill="#FBBF24" />
              <circle cx="30" cy="18" r="5" fill="#FCD34D" />
              <circle cx="32" cy="17" r="1.2" fill="#1F2937" />
              <circle cx="32.3" cy="16.7" r="0.4" fill="#FFF" />
              <path d="M35 18 L39 19 L35 20Z" fill="#F97316" />
              <path d="M18 21 Q12 14 9 17 Q12 22 18 24Z" fill="#FDE68A" opacity="0.9">
                <animateTransform attributeName="transform" type="rotate" values="0 18 22;-12 18 22;0 18 22" dur="0.8s" repeatCount="indefinite" />
              </path>
              <path d="M16 24 Q10 26 8 30" stroke="#F59E0B" strokeWidth="1.5" fill="none" />
              <circle cx="28" cy="20" r="1.5" fill="#F9A8D4" opacity="0.5" />
            </svg>
          </div>

          {/* 绿叶花朵 */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', animation: 'swing 2.8s ease-in-out infinite', animationDelay: '0.3s', transformOrigin: 'top center' }}>
            <div style={{ width: '1.5px', height: '20px', background: 'linear-gradient(180deg, #86EFAC, #FBCFE8)' }} />
            <svg width="38" height="42" viewBox="0 0 40 46" fill="none">
              <path d="M20 0 Q18 14 22 28" stroke="#86EFAC" strokeWidth="2" fill="none" />
              <ellipse cx="14" cy="8" rx="4" ry="7" fill="#86EFAC" transform="rotate(-30, 14, 8)" opacity="0.75" />
              <ellipse cx="28" cy="18" rx="3.5" ry="6.5" fill="#BBF7D0" transform="rotate(25, 28, 18)" opacity="0.8" />
              <g transform="translate(20, 34)">
                {[0, 72, 144, 216, 288].map((r) => (
                  <ellipse key={r} cx="0" cy="-6" rx="4" ry="7" fill="#F9A8D4" transform={`rotate(${r})`} opacity="0.85" />
                ))}
                <circle cx="0" cy="0" r="3" fill="#FDE68A" />
              </g>
            </svg>
          </div>

          {/* 嫩芽 */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', animation: 'swing 3.5s ease-in-out infinite', animationDelay: '0.8s', transformOrigin: 'top center' }}>
            <div style={{ width: '1.5px', height: '16px', background: '#86EFAC' }} />
            <svg width="26" height="44" viewBox="0 0 28 48" fill="none">
              <path d="M14 0 Q12 16 14 32 Q13 40 14 46" stroke="#86EFAC" strokeWidth="2" fill="none" />
              <ellipse cx="7" cy="10" rx="5" ry="8" fill="#34D399" transform="rotate(-35, 7, 10)" opacity="0.7" />
              <ellipse cx="21" cy="22" rx="4.5" ry="7" fill="#6EE7B7" transform="rotate(30, 21, 22)" opacity="0.75" />
              <ellipse cx="8" cy="34" rx="4" ry="6.5" fill="#86EFAC" transform="rotate(-25, 8, 34)" opacity="0.7" />
              <ellipse cx="14" cy="45" rx="3" ry="3.5" fill="#FBCFE8" opacity="0.8" />
            </svg>
          </div>

          {/* 蝴蝶2 */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', animation: 'butterflyFloat 4.5s ease-in-out infinite', animationDelay: '1.5s', transformOrigin: 'top center' }}>
            <div style={{ width: '1px', height: '18px', background: '#F9A8D4' }} />
            <svg width="38" height="32" viewBox="0 0 36 30" fill="none">
              <path d="M18 15 Q8 3 4 10 Q2 18 12 19 Q14 19 18 15Z" fill="#FBCFE8" opacity="0.85">
                <animateTransform attributeName="transform" type="rotate" values="-5 18 15;12 18 15;-5 18 15" dur="0.5s" repeatCount="indefinite" />
              </path>
              <path d="M18 15 Q28 3 32 10 Q34 18 24 19 Q22 19 18 15Z" fill="#F9A8D4" opacity="0.85">
                <animateTransform attributeName="transform" type="rotate" values="5 18 15;-12 18 15;5 18 15" dur="0.5s" repeatCount="indefinite" />
              </path>
              <path d="M18 15 Q12 22 10 25 Q14 28 18 22Z" fill="#FBCFE8" opacity="0.6" />
              <path d="M18 15 Q24 22 26 25 Q22 28 18 22Z" fill="#F9A8D4" opacity="0.6" />
              <ellipse cx="18" cy="17" rx="1.5" ry="5.5" fill="#EC4899" />
              <path d="M17 12 Q14 5 12 3" stroke="#EC4899" strokeWidth="0.7" fill="none" />
              <path d="M19 12 Q22 5 24 3" stroke="#EC4899" strokeWidth="0.7" fill="none" />
              <circle cx="12" cy="3" r="0.8" fill="#F472B6" />
              <circle cx="24" cy="3" r="0.8" fill="#F472B6" />
            </svg>
          </div>
        </div>

        {/* 右侧樱花枝 - 镜像 */}
        <svg width="120" height="90" viewBox="0 0 150 110" fill="none" style={{ marginTop: '-10px', transform: 'scaleX(-1)' }}>
          <defs>
            <radialGradient id="bloomR" cx="50%" cy="50%">
              <stop offset="0%" stopColor="#FFF" />
              <stop offset="50%" stopColor="#FBCFE8" />
              <stop offset="100%" stopColor="#F472B6" />
            </radialGradient>
          </defs>
          {/* 主枝 */}
          <path d="M0 5 Q30 8 60 20 Q90 35 120 30 Q135 28 145 35" stroke="#86EFAC" strokeWidth="3" fill="none" />
          <path d="M40 14 Q45 30 38 45" stroke="#86EFAC" strokeWidth="2" fill="none" />
          <path d="M80 28 Q85 45 78 58" stroke="#86EFAC" strokeWidth="2" fill="none" />
          <path d="M110 30 Q118 18 125 12" stroke="#86EFAC" strokeWidth="2" fill="none" />
          {/* 花朵 */}
          <g transform="translate(38, 48)">
            {[0, 72, 144, 216, 288].map((r) => (
              <ellipse key={r} cx="0" cy="-6" rx="4" ry="7" fill="url(#bloomR)" transform={`rotate(${r})`} opacity="0.9" />
            ))}
            <circle cx="0" cy="0" r="3" fill="url(#bloomCenter)" />
          </g>
          <g transform="translate(78, 60)">
            {[0, 72, 144, 216, 288].map((r) => (
              <ellipse key={r} cx="0" cy="-5" rx="3.5" ry="6" fill="url(#bloomR)" transform={`rotate(${r})`} opacity="0.85" />
            ))}
            <circle cx="0" cy="0" r="2.5" fill="url(#bloomCenter)" />
          </g>
          <g transform="translate(125, 10)">
            {[0, 72, 144, 216, 288].map((r) => (
              <ellipse key={r} cx="0" cy="-5" rx="3.5" ry="6" fill="url(#bloomR)" transform={`rotate(${r})`} opacity="0.9" />
            ))}
            <circle cx="0" cy="0" r="2.5" fill="url(#bloomCenter)" />
          </g>
          <g transform="translate(60, 18)">
            {[0, 72, 144, 216, 288].map((r) => (
              <ellipse key={r} cx="0" cy="-4" rx="3" ry="5" fill="url(#bloomR)" transform={`rotate(${r})`} opacity="0.8" />
            ))}
            <circle cx="0" cy="0" r="2" fill="url(#bloomCenter)" />
          </g>
          {/* 花苞 */}
          <ellipse cx="145" cy="38" rx="3" ry="4.5" fill="#FBCFE8" />
          <path d="M143 34 Q145 30 147 34" stroke="#86EFAC" strokeWidth="1.2" fill="#BBF7D0" />
          <ellipse cx="100" cy="32" rx="2.5" ry="3.5" fill="#FBCFE8" />
          {/* 叶子 */}
          <ellipse cx="25" cy="12" rx="4" ry="8" fill="#BBF7D0" transform="rotate(60, 25, 12)" opacity="0.7" />
          <ellipse cx="50" cy="22" rx="3" ry="6" fill="#BBF7D0" transform="rotate(40, 50, 22)" opacity="0.6" />
          <ellipse cx="95" cy="38" rx="3" ry="6" fill="#BBF7D0" transform="rotate(-20, 95, 38)" opacity="0.7" />
          {/* 飘落花瓣 */}
          <ellipse cx="55" cy="75" rx="3" ry="2" fill="#FBCFE8" opacity="0.6" transform="rotate(-30, 55, 75)">
            <animateTransform attributeName="transform" type="translate" values="0 0;5 15;10 30" dur="4.5s" repeatCount="indefinite" />
            <animate attributeName="opacity" values="0.6;0.3;0" dur="4.5s" repeatCount="indefinite" />
          </ellipse>
        </svg>
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

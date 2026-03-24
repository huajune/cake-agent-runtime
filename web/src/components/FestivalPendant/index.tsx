interface FestivalPendantProps {
    content: string;
    delay?: string;
    ropeHeight?: number;
    fontSize?: number;
}

export default function FestivalPendant({ content, delay = '0s', ropeHeight = 15, fontSize = 56 }: FestivalPendantProps) {
    return (
        <div
            className="festival-pendant"
            style={{
                animationDelay: delay,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                zIndex: 20,
                transformOrigin: 'top center',
                animation: 'swing 4s ease-in-out infinite'
            }}
        >
            {/* 细绳 */}
            <div style={{
                width: '1px',
                height: `${ropeHeight}px`,
                background: 'linear-gradient(180deg, rgba(134,239,172,0.6), rgba(134,239,172,0.2))'
            }} />

            {/* 文字 */}
            <div style={{
                fontSize: `${fontSize}px`,
                fontWeight: '500',
                fontFamily: '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
                color: '#9D174D',
                textShadow: '0 0 8px rgba(255,255,255,0.9), 0 0 16px rgba(255,255,255,0.5), 0 1px 3px rgba(157,23,77,0.15)',
                lineHeight: 1,
                position: 'relative'
            }}>
                {content}
            </div>
        </div>
    );
}

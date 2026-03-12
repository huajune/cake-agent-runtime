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
                animation: 'swing 3s ease-in-out infinite'
            }}
        >
            {/* 挂绳 */}
            <div style={{ width: '2px', height: `${ropeHeight}px`, background: '#D97706' }} />

            {/* 金色闪光艺术字 */}
            <div style={{
                fontSize: `${fontSize}px`,
                fontWeight: '900',
                fontFamily: '"STZhongsong", "华文中宋", "SimSun", "宋体", serif',
                background: 'linear-gradient(180deg, #FFFBEB 0%, #FDE68A 20%, #FCD34D 40%, #FBBF24 60%, #F59E0B 80%, #FCD34D 100%)',
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
                backgroundClip: 'text',
                filter: 'drop-shadow(1px 1px 0 #D97706) drop-shadow(-1px -1px 0 #D97706) drop-shadow(1px -1px 0 #D97706) drop-shadow(-1px 1px 0 #D97706) drop-shadow(0 2px 4px rgba(251, 191, 36, 0.5))',
                lineHeight: 1,
                position: 'relative'
            }}>
                {content}
            </div>
        </div>
    );
}

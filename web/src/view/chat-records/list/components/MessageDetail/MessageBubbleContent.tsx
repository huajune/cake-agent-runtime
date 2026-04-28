import { useEffect, useState } from 'react';
import { ExternalLink, X, ZoomIn } from 'lucide-react';
import styles from './MessageBubbleContent.module.scss';

type Payload = Record<string, unknown> | undefined;

function pickString(payload: Payload, ...keys: string[]): string | undefined {
  if (!payload) return undefined;
  for (const key of keys) {
    const v = payload[key];
    if (typeof v === 'string' && v.trim().length > 0) return v;
  }
  return undefined;
}

function pickNumber(payload: Payload, ...keys: string[]): number | undefined {
  if (!payload) return undefined;
  for (const key of keys) {
    const v = payload[key];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  }
  return undefined;
}

function formatFileSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatDuration(seconds?: number): string {
  if (!seconds || seconds <= 0) return '';
  const sec = Math.round(seconds);
  if (sec < 60) return `${sec}″`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s > 0 ? `${m}′${s}″` : `${m}′`;
}

function stripLeadingTag(content: string): string {
  return content.replace(/^\[[^\]]+\]\s*/, '').trim();
}

interface Props {
  messageType?: string;
  content: string;
  payload?: Record<string, unknown>;
}

interface PreviewImage {
  url: string;
  alt: string;
}

function getImageUrls(payload: Payload): { previewUrl?: string; thumbnailUrl?: string } {
  const previewUrl = pickString(
    payload,
    'originalImageUrl',
    'originalUrl',
    'originImageUrl',
    'originUrl',
    'fullImageUrl',
    'fullUrl',
    'hdImageUrl',
    'hdUrl',
    'cdnOriginalImageUrl',
    'cdnOriginalUrl',
    'cdnorigimgurl',
    'downloadUrl',
    'mediaUrl',
    'imageUrl',
    'url',
  );
  const thumbnailUrl = pickString(
    payload,
    'thumbnailUrl',
    'thumbUrl',
    'thumbImageUrl',
    'thumb',
    'cdnThumbUrl',
    'cdnthumburl',
    'previewImageUrl',
    'previewUrl',
    'imageUrl',
    'url',
  );

  return {
    previewUrl,
    thumbnailUrl: thumbnailUrl || previewUrl,
  };
}

export function MessageBubbleContent({ messageType, content, payload }: Props) {
  const [previewImage, setPreviewImage] = useState<PreviewImage | null>(null);

  useEffect(() => {
    if (!previewImage) return undefined;

    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPreviewImage(null);
      }
    };

    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [previewImage]);

  const imagePreview = previewImage ? (
    <div
      className={styles.previewBackdrop}
      role="dialog"
      aria-modal="true"
      aria-label="图片预览"
      onClick={() => setPreviewImage(null)}
    >
      <div className={styles.previewToolbar} onClick={(event) => event.stopPropagation()}>
        <a
          href={previewImage.url}
          target="_blank"
          rel="noreferrer"
          className={styles.previewIconButton}
          title="新窗口打开原图"
          aria-label="新窗口打开原图"
        >
          <ExternalLink size={18} aria-hidden="true" />
        </a>
        <button
          type="button"
          className={styles.previewIconButton}
          onClick={() => setPreviewImage(null)}
          title="关闭预览"
          aria-label="关闭预览"
        >
          <X size={20} aria-hidden="true" />
        </button>
      </div>
      <img
        src={previewImage.url}
        alt={previewImage.alt}
        className={styles.previewImage}
        onClick={(event) => event.stopPropagation()}
      />
    </div>
  ) : null;

  switch (messageType) {
    case 'IMAGE': {
      const { previewUrl, thumbnailUrl } = getImageUrls(payload);
      const displayUrl = thumbnailUrl || previewUrl;
      const targetUrl = previewUrl || displayUrl;
      if (!displayUrl || !targetUrl) {
        return <span className={styles.fallback}>{content || '[图片消息]'}</span>;
      }
      return (
        <>
          <button
            type="button"
            className={styles.imageLink}
            onClick={() => setPreviewImage({ url: targetUrl, alt: '图片预览' })}
            title="放大预览图片"
            aria-label="放大预览图片"
          >
            <img
              src={displayUrl}
              alt="图片"
              className={styles.image}
              loading="lazy"
              decoding="async"
            />
            <span className={styles.imageOverlay} aria-hidden="true">
              <ZoomIn size={16} />
            </span>
          </button>
          {imagePreview}
        </>
      );
    }

    case 'EMOTION': {
      const { previewUrl, thumbnailUrl } = getImageUrls(payload);
      const displayUrl = thumbnailUrl || previewUrl;
      const targetUrl = previewUrl || displayUrl;
      if (!displayUrl || !targetUrl) {
        return <span className={styles.fallback}>{content || '[表情消息]'}</span>;
      }
      return (
        <>
          <button
            type="button"
            className={styles.emotionButton}
            onClick={() => setPreviewImage({ url: targetUrl, alt: '表情预览' })}
            title="放大预览表情"
            aria-label="放大预览表情"
          >
            <img
              src={displayUrl}
              alt="表情"
              className={styles.emotion}
              loading="lazy"
              decoding="async"
            />
          </button>
          {imagePreview}
        </>
      );
    }

    case 'VOICE': {
      const url = pickString(payload, 'voiceUrl', 'url', 'wxVoiceUrl');
      const transcript = pickString(payload, 'text');
      const duration = pickNumber(payload, 'duration');
      return (
        <div className={styles.voice}>
          <div className={styles.voiceHeader}>
            <span className={styles.voiceIcon}>🎤</span>
            <span className={styles.voiceLabel}>语音消息</span>
            {duration ? <span className={styles.voiceDuration}>{formatDuration(duration)}</span> : null}
          </div>
          {url ? (
            <audio controls src={url} preload="metadata" className={styles.voiceAudio} />
          ) : null}
          {transcript ? (
            <div className={styles.voiceTranscript}>
              <span className={styles.transcriptLabel}>转写</span>
              <span>{transcript}</span>
            </div>
          ) : null}
        </div>
      );
    }

    case 'VIDEO': {
      const url = pickString(payload, 'videoUrl', 'url');
      const poster = pickString(payload, 'thumbnailUrl', 'thumbUrl');
      const duration = pickNumber(payload, 'duration');
      if (!url) return <span className={styles.fallback}>{content || '[视频消息]'}</span>;
      return (
        <div className={styles.video}>
          <video
            controls
            preload="metadata"
            poster={poster}
            src={url}
            className={styles.videoPlayer}
          />
          {duration ? <div className={styles.mediaMeta}>时长 {formatDuration(duration)}</div> : null}
        </div>
      );
    }

    case 'FILE': {
      const url = pickString(payload, 'fileUrl', 'url');
      const name = pickString(payload, 'name', 'fileName') || '未命名文件';
      const size = pickNumber(payload, 'size');
      const body = (
        <>
          <span className={styles.fileIcon}>📎</span>
          <span className={styles.fileInfo}>
            <span className={styles.fileName}>{name}</span>
            {size ? <span className={styles.fileMeta}>{formatFileSize(size)}</span> : null}
          </span>
        </>
      );
      return url ? (
        <a href={url} target="_blank" rel="noreferrer" className={styles.file}>
          {body}
        </a>
      ) : (
        <div className={styles.file}>{body}</div>
      );
    }

    case 'LINK': {
      const url = pickString(payload, 'url');
      const title = pickString(payload, 'title') || '链接';
      const desc = pickString(payload, 'description', 'desc');
      const thumb = pickString(payload, 'thumbnailUrl', 'thumbUrl');
      const body = (
        <>
          {thumb ? <img src={thumb} alt="" className={styles.linkThumb} loading="lazy" /> : null}
          <span className={styles.linkBody}>
            <span className={styles.linkTitle}>{title}</span>
            {desc ? <span className={styles.linkDesc}>{desc}</span> : null}
            {url ? <span className={styles.linkUrl}>{url}</span> : null}
          </span>
        </>
      );
      return url ? (
        <a href={url} target="_blank" rel="noreferrer" className={styles.link}>
          {body}
        </a>
      ) : (
        <div className={styles.link}>{body}</div>
      );
    }

    case 'LOCATION': {
      const name = pickString(payload, 'name');
      const address = pickString(payload, 'address');
      const lat = pickString(payload, 'latitude') ?? pickNumber(payload, 'latitude')?.toString();
      const lng = pickString(payload, 'longitude') ?? pickNumber(payload, 'longitude')?.toString();
      const fallbackText = stripLeadingTag(content);
      const mapUrl =
        lat && lng
          ? `https://uri.amap.com/marker?position=${lng},${lat}${name ? `&name=${encodeURIComponent(name)}` : ''}&src=cake-dashboard&coordinate=gaode`
          : undefined;
      return (
        <div className={styles.location}>
          <div className={styles.locationHeader}>
            <span className={styles.locationIcon}>📍</span>
            <span className={styles.locationName}>{name || fallbackText || '位置分享'}</span>
          </div>
          {address && address !== name ? (
            <div className={styles.locationAddress}>{address}</div>
          ) : null}
          {mapUrl ? (
            <a href={mapUrl} target="_blank" rel="noreferrer" className={styles.locationLink}>
              在高德地图中查看
            </a>
          ) : null}
        </div>
      );
    }

    case 'MINI_PROGRAM': {
      const title = pickString(payload, 'title') || '小程序';
      const desc = pickString(payload, 'description');
      const thumb = pickString(payload, 'thumbUrl', 'thumbnailUrl');
      const icon = pickString(payload, 'iconUrl');
      return (
        <div className={styles.miniProgram}>
          <div className={styles.miniProgramHeader}>
            {icon ? <img src={icon} alt="" className={styles.miniProgramIcon} /> : null}
            <span className={styles.miniProgramTag}>小程序</span>
            <span className={styles.miniProgramTitle}>{title}</span>
          </div>
          {thumb ? <img src={thumb} alt="" className={styles.miniProgramThumb} loading="lazy" /> : null}
          {desc ? <div className={styles.miniProgramDesc}>{desc}</div> : null}
        </div>
      );
    }

    case 'CONTACT_CARD': {
      const name = pickString(payload, 'name', 'nickname') || '名片';
      const alias = pickString(payload, 'alias');
      const avatar = pickString(payload, 'avatar');
      return (
        <div className={styles.contact}>
          {avatar ? (
            <img src={avatar} alt="" className={styles.contactAvatar} loading="lazy" />
          ) : (
            <span className={styles.contactAvatarFallback}>👤</span>
          )}
          <span className={styles.contactInfo}>
            <span className={styles.contactLabel}>推荐名片</span>
            <span className={styles.contactName}>{name}</span>
            {alias ? <span className={styles.contactAlias}>{alias}</span> : null}
          </span>
        </div>
      );
    }

    case 'REVOKE':
    case 'SYSTEM':
    case 'WECOM_SYSTEM':
    case 'CALL_RECORD':
    case 'MONEY':
    case 'CHANNELS':
    case 'ROOM_INVITE':
    case 'GROUP_SOLITAIRE':
    case 'CHAT_HISTORY':
    case 'UNKNOWN':
      return <span className={styles.system}>{content || `[${messageType}]`}</span>;

    case 'TEXT':
    default:
      return <span className={styles.text}>{content}</span>;
  }
}

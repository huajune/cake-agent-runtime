export type ResumeFormat = 'pdf' | 'docx' | 'image' | 'legacy_doc' | 'unknown';

export type ResumeReadErrorKind =
  | 'too_large'
  | 'download_failed'
  | 'not_pdf'
  | 'parse_failed'
  | 'unsupported_format'
  | 'vision_failed';

export class ResumeReadError extends Error {
  constructor(
    readonly kind: ResumeReadErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'ResumeReadError';
  }
}

/** 按 magic bytes 分发简历容器，不信任扩展名或 Content-Type。 */
export function detectResumeFormat(buffer: Buffer): ResumeFormat {
  if (buffer.subarray(0, 5).toString('ascii') === '%PDF-') return 'pdf';
  if (buffer.length >= 4 && buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    return 'docx';
  }
  if (buffer.length >= 3 && buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
    return 'image';
  }
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image';
  }
  if (buffer.length >= 4 && buffer.subarray(0, 4).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0]))) {
    return 'legacy_doc';
  }
  return 'unknown';
}

export function imageMediaType(buffer: Buffer): 'image/jpeg' | 'image/png' | null {
  if (buffer.length >= 3 && buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
    return 'image/jpeg';
  }
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png';
  }
  return null;
}

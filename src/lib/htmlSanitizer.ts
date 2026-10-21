import DOMPurify from 'dompurify';

const config = {
  ALLOWED_TAGS: ['b', 'i', 'em', 'strong', 'a', 'p', 'br', 'ul', 'ol', 'li', 'blockquote', 'code', 'pre'],
  ALLOWED_ATTR: ['href', 'title', 'target', 'rel'],
  KEEP_CONTENT: true,
  RETURN_TRUSTED_TYPE: false,
};

DOMPurify.setConfig(config);

export function sanitizeHtml(dirtyHtml: string): string {
  return DOMPurify.sanitize(dirtyHtml, config);
}

export function sanitizeText(text: string): string {
  return DOMPurify.sanitize(text, { ALLOWED_TAGS: [] });
}

export interface SanitizedContent {
  html: string;
  isClean: boolean;
}

export function analyzeSanitization(original: string, sanitized: string): SanitizedContent {
  return {
    html: sanitized,
    isClean: original === sanitized,
  };
}

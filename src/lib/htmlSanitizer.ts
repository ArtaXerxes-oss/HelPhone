import React from 'react';
import DOMPurify from 'dompurify';

export const ALLOWED_TAGS = Object.freeze([
  'b',
  'i',
  'em',
  'strong',
  'a',
  'p',
  'br',
  'ul',
  'ol',
  'li',
  'blockquote',
  'code',
  'pre',
]);

export const ALLOWED_ATTR = Object.freeze(['href', 'title', 'target', 'rel']);

export const SANITIZER_CONFIG = Object.freeze({
  ALLOWED_TAGS: [...ALLOWED_TAGS],
  ALLOWED_ATTR: [...ALLOWED_ATTR],
  KEEP_CONTENT: true,
  RETURN_TRUSTED_TYPE: false,
});

export const TEXT_ONLY_CONFIG = Object.freeze({
  ALLOWED_TAGS: [],
  ALLOWED_ATTR: [],
  KEEP_CONTENT: true,
  RETURN_TRUSTED_TYPE: false,
});

export function sanitizeHtml(dirtyHtml: string | null | undefined): string {
  if (dirtyHtml == null) return '';
  if (typeof dirtyHtml !== 'string') return String(dirtyHtml);
  return DOMPurify.sanitize(dirtyHtml, SANITIZER_CONFIG);
}

export function sanitizeText(text: string | null | undefined): string {
  if (text == null) return '';
  if (typeof text !== 'string') return String(text);
  return DOMPurify.sanitize(text, TEXT_ONLY_CONFIG);
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

export interface SanitizedHtmlProps {
  html: string | null | undefined;
  className?: string;
  style?: React.CSSProperties;
  as?: keyof JSX.IntrinsicElements;
  'data-testid'?: string;
}

export function SanitizedHtml({
  html,
  className,
  style,
  as: Component = 'div',
  'data-testid': testId,
}: SanitizedHtmlProps) {
  const clean = sanitizeHtml(html);
  return React.createElement(Component, {
    className,
    style,
    'data-testid': testId,
    dangerouslySetInnerHTML: { __html: clean },
  });
}

export default {
  sanitizeHtml,
  sanitizeText,
  analyzeSanitization,
  SanitizedHtml,
  ALLOWED_TAGS,
  ALLOWED_ATTR,
  SANITIZER_CONFIG,
};

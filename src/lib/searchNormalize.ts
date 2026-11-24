/**
 * Script-aware query normalisation for offline city search (#771 / ISP-101).
 *
 * Latin: NFKD + strip combining marks + lowercase (typo-friendly).
 * Arabic: keep letters, collapse alef variants, drop tatweel/diacritics only.
 * CJK: keep ideographs; do not NFKD-decompose compatibility forms away.
 */

export type ScriptFamily = 'latin' | 'arabic' | 'cjk' | 'mixed' | 'other'

const ARABIC_LETTER = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/
const CJK_LETTER = /[\u3040-\u30FF\u3400-\u9FFF\uF900-\uFAFF]/
const LATIN_LETTER = /[A-Za-z\u00C0-\u024F]/

export function detectScript(input: string): ScriptFamily {
  let arabic = 0
  let cjk = 0
  let latin = 0
  for (const ch of input) {
    if (ARABIC_LETTER.test(ch)) arabic += 1
    else if (CJK_LETTER.test(ch)) cjk += 1
    else if (LATIN_LETTER.test(ch)) latin += 1
  }
  const kinds = [arabic > 0, cjk > 0, latin > 0].filter(Boolean).length
  if (kinds > 1) return 'mixed'
  if (arabic) return 'arabic'
  if (cjk) return 'cjk'
  if (latin) return 'latin'
  return 'other'
}

/** Collapse Arabic presentation noise without destroying the word. */
function normalizeArabic(input: string): string {
  return input
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '') // harakat + tatweel
    .replace(/[\u0622\u0623\u0625\u0671]/g, '\u0627') // alef variants → ا
    .replace(/\u0649/g, '\u064A') // alef maqsura → yeh
    .trim()
}

function normalizeLatin(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .trim()
}

function normalizeCjk(input: string): string {
  // NFC keeps CJK compatibility variants stable for exact/prefix match.
  return input.normalize('NFC').replace(/\s+/g, '').trim()
}

export function normalizeSearchQuery(input: string): string {
  if (!input) return ''
  const script = detectScript(input)
  switch (script) {
    case 'arabic':
      return normalizeArabic(input)
    case 'cjk':
      return normalizeCjk(input)
    case 'mixed':
      // Normalise each run with the matching script helper.
      return input
        .split(/(\s+)/)
        .map((part) => {
          if (/^\s+$/.test(part)) return part
          const s = detectScript(part)
          if (s === 'arabic') return normalizeArabic(part)
          if (s === 'cjk') return normalizeCjk(part)
          return normalizeLatin(part)
        })
        .join('')
        .trim()
    default:
      return normalizeLatin(input)
  }
}

/** Cheap edit distance for golden-set recall checks (unit tests). */
export function levenshtein(a: string, b: string): number {
  const m = a.length
  const n = b.length
  const dp = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))
  for (let i = 0; i <= m; i++) dp[i][0] = i
  for (let j = 0; j <= n; j++) dp[0][j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost)
    }
  }
  return dp[m][n]
}

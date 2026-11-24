import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

export const SUPPORTED_LANGUAGES = ['en', 'ar'] as const
export const DEFAULT_LNG = 'en'
export const DEFAULT_NS = 'common'

const ready = (async () => {
  // Lazy-load HttpBackend to reduce initial bundle (#744)
  const { default: HttpBackend } = await import('i18next-http-backend')

  return i18n
    .use(HttpBackend)
    .use(initReactI18next)
    .init({
      lng: DEFAULT_LNG,
      fallbackLng: DEFAULT_LNG,
      supportedLngs: [...SUPPORTED_LANGUAGES],
      nonExplicitSupportedLngs: true,
      load: 'languageOnly',
      defaultNS: DEFAULT_NS,
      ns: [DEFAULT_NS],
      backend: {
        loadPath: '/locales/{{lng}}/{{ns}}.json',
        requestOptions: { cache: 'no-cache' },
      },
      interpolation: { escapeValue: false },
      react: { useSuspense: false },
    })
})()

function syncDocumentLocale(language: string): void {
  if (typeof document === 'undefined') return
  const locale = language.split('-')[0]
  document.documentElement.lang = locale
  document.documentElement.dir = i18n.dir(language)
}

i18n.on('languageChanged', syncDocumentLocale)
export const i18nReady: Promise<void> = ready.then(() => {
  syncDocumentLocale(i18n.resolvedLanguage || i18n.language)
})

export default i18n

import { useEffect } from 'react'

const APP_NAME = 'HelPhone'
const TITLE_SUFFIX = ` | ${APP_NAME}`

/** Generic document.title updater shared by every routed page.
 *  Keeps the app name as a suffix so screen readers announce the
 *  current page context together with the site identity. */
export function setPageTitle(title: string): void {
  document.title = title ? `${title}${TITLE_SUFFIX}` : APP_NAME
}

/** Set the document title while the calling page is mounted.
 *  Re-applies automatically when the title changes. */
export default function useDocumentTitle(title: string): void {
  useEffect(() => {
    setPageTitle(title)
  }, [title])
}

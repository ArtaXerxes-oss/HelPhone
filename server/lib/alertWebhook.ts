export type AlertSeverity = 'warning' | 'page'

export interface OperationalAlert {
  rule: string
  severity: AlertSeverity
  summary: string
  dashboardUrl: string
  runbookUrl: string
}

/** Deliver a deliberately metadata-only operational alert. */
export async function sendOperationalAlert(
  alert: OperationalAlert,
  options: { webhookUrl?: string; fetch?: typeof fetch } = {},
): Promise<boolean> {
  const webhookUrl = options.webhookUrl ?? process.env.ALERT_WEBHOOK_URL
  if (!webhookUrl) return false
  const response = await (options.fetch ?? fetch)(webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(alert),
  })
  if (!response.ok) throw new Error(`alert webhook returned ${response.status}`)
  return true
}

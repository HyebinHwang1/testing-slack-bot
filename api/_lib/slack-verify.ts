import crypto from 'node:crypto'

/**
 * Slack 요청 서명 검증.
 * https://api.slack.com/authentication/verifying-requests-from-slack
 */
export function verifySlackSignature(
  signingSecret: string,
  timestamp: string,
  rawBody: string,
  signature: string,
): boolean {
  // 5분 이상 지난 요청은 reject (replay attack 방지)
  const now = Math.floor(Date.now() / 1000)
  if (Math.abs(now - Number(timestamp)) > 60 * 5) {
    return false
  }

  const baseString = `v0:${timestamp}:${rawBody}`
  const hmac = crypto.createHmac('sha256', signingSecret)
  hmac.update(baseString)
  const expected = `v0=${hmac.digest('hex')}`

  // timing-safe 비교
  const a = Buffer.from(expected)
  const b = Buffer.from(signature)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

import { readFileSync, writeFileSync, copyFileSync } from 'node:fs'

const ENV_PATH = '.env.local'
const BACKUP_PATH = '.env.local.bak'

const text = readFileSync(ENV_PATH, 'utf8')

const lines = text.split('\n')
let modified = false

const newLines = lines.map((line) => {
  const m = line.match(/^DATABASE_URL=(.*)$/)
  if (!m) return line

  let raw = m[1].trim()
  // 따옴표 제거
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    raw = raw.slice(1, -1)
  }

  // postgresql://USER:PASSWORD@HOST:PORT/DB?... 형식
  // - 스킴 뒤 첫 ":"는 user/password 구분자
  // - 마지막 "@"는 auth/host 구분자
  const schemeMatch = raw.match(/^(postgres(?:ql)?:\/\/)([^/]+)(\/.*)?$/)
  if (!schemeMatch) {
    console.error('❌ DATABASE_URL 형식을 인식하지 못함. 변경 없이 종료.')
    return line
  }
  const [, scheme, auth, rest = ''] = schemeMatch

  const lastAt = auth.lastIndexOf('@')
  if (lastAt === -1) {
    console.error('❌ DATABASE_URL에 @ 없음. 변경 없이 종료.')
    return line
  }
  const userPass = auth.slice(0, lastAt)
  const hostPart = auth.slice(lastAt + 1)

  const firstColon = userPass.indexOf(':')
  if (firstColon === -1) {
    console.log('ℹ️ password가 없는 형태. 변경 없이 종료.')
    return line
  }
  const user = userPass.slice(0, firstColon)
  const password = userPass.slice(firstColon + 1)

  // 이미 인코딩된 것 같으면 스킵
  // 휴리스틱: %XX 패턴이 있고 그게 디코딩 가능하면 이미 인코딩된 것으로 간주
  let alreadyEncoded = false
  if (/%[0-9A-Fa-f]{2}/.test(password)) {
    try {
      const decoded = decodeURIComponent(password)
      // 디코딩했을 때 원본과 다르면 인코딩되어 있는 것
      if (decoded !== password) alreadyEncoded = true
    } catch {
      alreadyEncoded = false
    }
  }

  if (alreadyEncoded) {
    console.log('ℹ️ password가 이미 URL 인코딩된 것으로 보임. 변경 없이 종료.')
    return line
  }

  const encodedPassword = encodeURIComponent(password)
  if (encodedPassword === password) {
    console.log('ℹ️ password에 인코딩 필요한 문자 없음. 변경 없이 종료.')
    return line
  }

  const newUrl = `${scheme}${user}:${encodedPassword}@${hostPart}${rest}`
  modified = true
  console.log('✅ password URL 인코딩 적용')
  console.log(`   변경 전 길이: ${password.length}자`)
  console.log(`   변경 후 길이: ${encodedPassword.length}자`)
  console.log(`   인코딩된 문자 수: ${encodedPassword.length - password.length}`)
  return `DATABASE_URL=${newUrl}`
})

if (modified) {
  copyFileSync(ENV_PATH, BACKUP_PATH)
  writeFileSync(ENV_PATH, newLines.join('\n'))
  console.log(`💾 백업: ${BACKUP_PATH}`)
  console.log(`💾 갱신: ${ENV_PATH}`)
} else {
  console.log('변경사항 없음.')
}

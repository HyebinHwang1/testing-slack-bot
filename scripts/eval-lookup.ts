import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { decideLookup, executeLookup, type LookupType } from '../api/_lib/lookup.js'

// .env.local 로드 (dotenv/config은 .env만 읽음)
const envPath = join(process.cwd(), '.env.local')
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([^#=\s][^=]*)=(.*)$/)
    if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim()
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url))

interface GoldenCase {
  id: string
  input: string
  category: string
  expected_needs_lookup: boolean
  expected_lookup_type?: LookupType
  expected_query?: string
  expected_result_status?: 'hit' | 'not_found' | 'ambiguous'
  note?: string
}

interface CaseResult {
  id: string
  input: string
  category: string
  plan_correct: boolean
  type_correct: boolean | null
  query_match: boolean | null
  result_correct: boolean | null
  fatal: boolean
  actual_needs_lookup: boolean
  actual_type?: string
  actual_query?: string
  actual_result_status?: string
  usage: { input: number; output: number }
  error?: string
}

async function runEval(goldenPath: string, label: string): Promise<void> {
  const cases: GoldenCase[] = JSON.parse(readFileSync(goldenPath, 'utf8'))
  const results: CaseResult[] = []
  let totalInput = 0, totalOutput = 0

  // PII 미커밋(스펙 §5.4): 골든셋엔 {{CUSTOMER_KEY}} 플레이스홀더만 두고, 실제 키(로그인 ID)는
  // .env.local의 EVAL_CUSTOMER_KEY에서 주입. 치환값은 decideLookup 입력으로만 쓰고,
  // 콘솔·결과 JSON엔 절대 남기지 않는다(§6: PII 평문 로그 금지). 출력 시 키→플레이스홀더로 역치환(mask).
  const customerKey = process.env.EVAL_CUSTOMER_KEY
  const needsKey = cases.some((c) => c.input.includes('{{CUSTOMER_KEY}}'))
  if (needsKey && !customerKey) {
    console.warn('⚠️  EVAL_CUSTOMER_KEY 미설정 — {{CUSTOMER_KEY}} 케이스는 치환되지 않아 not_found로 떨어집니다.\n')
  }
  const inject = (s: string) => (customerKey ? s.replaceAll('{{CUSTOMER_KEY}}', customerKey) : s)
  const mask = (s: string | undefined) =>
    customerKey && s ? s.replaceAll(customerKey, '{{CUSTOMER_KEY}}') : s

  console.log(`\n=== ${label} — ${cases.length}건 ===\n`)

  for (const c of cases) {
    // 콘솔엔 원본(플레이스홀더) 표시, LLM엔 치환본 입력
    process.stdout.write(`[${c.id}] ${c.input.slice(0, 45).padEnd(45)} `)
    const injectedInput = inject(c.input)
    const expectedQuery = inject(c.expected_query ?? '') || undefined
    try {
      const { plan, usage } = await decideLookup(injectedInput, null)
      totalInput += usage.input
      totalOutput += usage.output

      const planCorrect = plan.needs_lookup === c.expected_needs_lookup
      const fatal = !c.expected_needs_lookup && plan.needs_lookup

      let typeCorrect: boolean | null = null
      let queryMatch: boolean | null = null
      let resultCorrect: boolean | null = null
      let actualType: string | undefined
      let actualQuery: string | undefined
      let actualResultStatus: string | undefined

      if (plan.needs_lookup) {
        actualType = plan.lookup.type
        actualQuery = plan.lookup.params.query
        if (c.expected_needs_lookup) {
          typeCorrect = plan.lookup.type === c.expected_lookup_type
          // 정확 일치(trim+소문자). includes는 추가 텍스트를 통과시켜 정확도를 과장하므로 ===로 검증.
          queryMatch = expectedQuery
            ? plan.lookup.params.query.trim().toLowerCase() === expectedQuery.trim().toLowerCase()
            : null
          const execResult = await executeLookup(plan.lookup)
          actualResultStatus = execResult.status
          if (c.expected_result_status) {
            resultCorrect = execResult.status === c.expected_result_status
          }
        }
      }

      const allOk = planCorrect && (typeCorrect ?? true) && (resultCorrect ?? true) && (queryMatch ?? true)
      const mark = fatal ? '🚨' : allOk ? '✅' : '❌'
      const detail = fatal
        ? `(false-positive: ${actualType}?${mask(actualQuery)})`
        : !planCorrect
          ? `(plan: expected ${c.expected_needs_lookup}, got ${plan.needs_lookup})`
          : typeCorrect === false
            ? `(type: expected ${c.expected_lookup_type}, got ${actualType})`
            : resultCorrect === false
              ? `(result: expected ${c.expected_result_status}, got ${actualResultStatus})`
              : queryMatch === false
                ? `(query: expected "${c.expected_query}", got "${mask(actualQuery)}")`
                : ''
      console.log(`${mark} ${detail}`)

      results.push({
        id: c.id, input: c.input, category: c.category,
        plan_correct: planCorrect, type_correct: typeCorrect, query_match: queryMatch,
        result_correct: resultCorrect, fatal,
        actual_needs_lookup: plan.needs_lookup, actual_type: actualType,
        actual_query: mask(actualQuery), actual_result_status: actualResultStatus, usage,
      })
    } catch (err) {
      console.log(`💥 ${(err as Error).message}`)
      results.push({
        id: c.id, input: c.input, category: c.category,
        plan_correct: false, type_correct: null, query_match: null, result_correct: null,
        fatal: false, actual_needs_lookup: false,
        usage: { input: 0, output: 0 }, error: (err as Error).message,
      })
    }
  }

  // 카테고리별 집계
  const categories = [...new Set(results.map(r => r.category))]
  console.log('\n' + '─'.repeat(84))
  console.log(`${'카테고리'.padEnd(18)} ${'N'.padEnd(4)} ${'plan정확도'.padEnd(17)} ${'type정확도'.padEnd(17)} ${'result정확도'.padEnd(17)}`)
  console.log('─'.repeat(84))

  for (const cat of categories) {
    const cr = results.filter(r => r.category === cat)
    const n = cr.length
    const planOk = cr.filter(r => r.plan_correct).length
    const typeN = cr.filter(r => r.type_correct !== null).length
    const typeOk = cr.filter(r => r.type_correct === true).length
    const resN = cr.filter(r => r.result_correct !== null).length
    const resOk = cr.filter(r => r.result_correct === true).length
    const pStr = `${planOk}/${n} (${Math.round(planOk / n * 100)}%)`
    const tStr = typeN > 0 ? `${typeOk}/${typeN} (${Math.round(typeOk / typeN * 100)}%)` : '-'
    const rStr = resN > 0 ? `${resOk}/${resN} (${Math.round(resOk / resN * 100)}%)` : '-'
    console.log(`${cat.padEnd(18)} ${String(n).padEnd(4)} ${pStr.padEnd(17)} ${tStr.padEnd(17)} ${rStr.padEnd(17)}`)
  }

  console.log('─'.repeat(84))
  const totalPlanOk = results.filter(r => r.plan_correct).length
  const fatalCount = results.filter(r => r.fatal).length

  console.log(`\n총 plan 정확도 : ${totalPlanOk}/${results.length} (${Math.round(totalPlanOk / results.length * 100)}%)`)
  console.log(`치명적 오답     : ${fatalCount}건 (라우팅 케이스인데 lookup 시도)`)
  console.log(`총 토큰         : input=${totalInput.toLocaleString()} output=${totalOutput.toLocaleString()}`)

  const outPath = join(__dirname, `eval-result-${label.toLowerCase().replace(/[^a-z0-9]/g, '-')}.json`)
  writeFileSync(outPath, JSON.stringify({
    label,
    summary: {
      total: results.length,
      plan_ok: totalPlanOk,
      plan_pct: Math.round(totalPlanOk / results.length * 100),
      fatal: fatalCount,
      tokens: { input: totalInput, output: totalOutput },
    },
    results,
  }, null, 2))
  console.log(`결과 저장       : ${outPath}\n`)
}

const goldenPath = join(__dirname, 'golden-set-b.json')
runEval(goldenPath, 'Phase B').catch(console.error)

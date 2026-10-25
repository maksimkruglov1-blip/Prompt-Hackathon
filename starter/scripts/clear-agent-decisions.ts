/**
 * Clears approved / changed / dismissed agent runs so the Control Room
 * attention queue only shows cases that still need a person.
 *
 * Demo seeds (CD-420299 / CD-420322) are recreated as pending on next
 * Control Room load via ensureDemoSeed.
 *
 * Usage (from starter/):
 *   npm run agent:clear-decisions
 */
import "dotenv/config"
import postgres from "postgres"

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error("Set DATABASE_URL before clearing decisions. See .env.example.")
  const sql = postgres(url, { max: 1 })
  try {
    const deleted = await sql`
      DELETE FROM agent_runs
      WHERE status IN ('approved', 'changed', 'dismissed')
      RETURNING id
    `
    console.log(`Cleared ${deleted.length} decided agent_runs. Reload Control Room to reseed demo pending proposals.`)
  } finally {
    await sql.end({ timeout: 5 })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

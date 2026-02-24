import type Database from 'better-sqlite3';

export function backfillAuditColumns(db: Database.Database): void {
  // Find all rows that need backfilling
  const rows = db.prepare(`SELECT id, notes FROM audit WHERE notes IS NOT NULL AND category IS NULL`).all() as { id: number, notes: string }[];
  if (rows.length === 0) return;

  console.log(`[Migration] Backfilling audit columns for ${rows.length} legacy entries...`);

  const updateStmt = db.prepare(`UPDATE audit SET category = ?, error_code = ?, metadata = ?, notes = ? WHERE id = ?`);
  
  db.transaction(() => {
    for (const row of rows) {
      let { notes } = row;
      let category: string | null = null;
      let errorCode: string | null = null;
      let metadata: any = null;

      // Check [must_implement]
      if (notes.startsWith('[must_implement]')) {
        category = 'must_implement';
        const rcMatch = notes.match(/\[rc=(\d+)\]/);
        if (rcMatch) {
          metadata = { rejection_count: parseInt(rcMatch[1], 10) };
        }
        notes = notes.replace(/^\[must_implement\](?:\[rc=\d+\])?\s*/i, '').trim();
      } 
      // Check [retry] FALLBACK
      else if (notes.includes('[retry] FALLBACK:') || notes.includes('[retry] Orchestrator failed')) {
        category = 'fallback';
        errorCode = '[retry] FALLBACK: Orchestrator failed, defaulting to retry';
      }
      // Check [unclear] FALLBACK
      else if (notes.includes('[unclear] FALLBACK:') || notes.includes('[unclear] Orchestrator failed')) {
        category = 'fallback';
        errorCode = '[unclear] FALLBACK: Orchestrator failed, retrying review';
      }
      // Check contract violations
      else if (notes.includes('[contract:checklist]')) {
        category = 'contract_violation';
        errorCode = 'checklist_required';
        notes = notes.replace('[contract:checklist]', '').trim();
      }
      else if (notes.includes('[contract:rejection_response]')) {
        category = 'contract_violation';
        errorCode = 'rejection_response_required';
        notes = notes.replace('[contract:rejection_response]', '').trim();
      }

      if (category !== null) {
        updateStmt.run(category, errorCode, metadata ? JSON.stringify(metadata) : null, notes, row.id);
      }
    }
  })();
}

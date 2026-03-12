async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForRunnerRegistration(
  globalDb: any,
  projectPath: string,
  parallelMode: boolean,
  timeoutMs: number = 8000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (parallelMode) {
      const parallelRunner = globalDb
        .prepare(
          `SELECT 1
           FROM runners r
           JOIN parallel_sessions ps ON ps.id = r.parallel_session_id
           WHERE ps.project_path = ?
             AND r.status != 'stopped'
             AND r.heartbeat_at > datetime('now', '-5 minutes')
           LIMIT 1`
        )
        .get(projectPath) as { 1: number } | undefined;

      if (parallelRunner !== undefined) {
        return true;
      }
    } else {
      const standaloneRunner = globalDb
        .prepare(
          `SELECT 1
           FROM runners
           WHERE project_path = ?
             AND parallel_session_id IS NULL
             AND status != 'stopped'
             AND heartbeat_at > datetime('now', '-5 minutes')
           LIMIT 1`
        )
        .get(projectPath) as { 1: number } | undefined;

      if (standaloneRunner !== undefined) {
        return true;
      }
    }

    await delay(250);
  }

  return false;
}

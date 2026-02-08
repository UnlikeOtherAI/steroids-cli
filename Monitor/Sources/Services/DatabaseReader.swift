import Foundation
import GRDB

/// Reads runner/task/log data from Steroids SQLite databases
class DatabaseReader {
    private var dbPools: [URL: DatabasePool] = [:]

    /// Read all runners from the global database
    func readRunners(from dbPath: URL) throws -> [Runner] {
        let db = try getDatabase(at: dbPath)

        return try db.read { db in
            // Read from task_locks to see active tasks per runner
            let locks = try Row.fetchAll(db, sql: """
                SELECT runner_id, task_id, acquired_at, heartbeat_at
                FROM task_locks
                WHERE expires_at > datetime('now')
            """)

            // Get unique runner IDs from locks
            var runners: [Runner] = []

            for lock in locks {
                let runnerId: String = lock["runner_id"]
                let taskId: String = lock["task_id"]

                // Fetch task details
                let task = try fetchTask(db: db, taskId: taskId)

                let runner = Runner(
                    id: runnerId,
                    name: runnerId,
                    projectPath: dbPath.deletingLastPathComponent().deletingLastPathComponent().path,
                    status: task?.status.isActive == true ? .active : .idle
                )
                var mutableRunner = runner
                mutableRunner.currentTask = task
                runners.append(mutableRunner)
            }

            return runners
        }
    }

    /// Fetch a specific task
    private func fetchTask(db: Database, taskId: String) throws -> SteroidTask? {
        guard let row = try Row.fetchOne(db, sql: """
            SELECT id, title, status, section_id, source_file, rejection_count, created_at, updated_at
            FROM tasks
            WHERE id = ?
        """, arguments: [taskId]) else {
            return nil
        }

        return SteroidTask(
            id: row["id"],
            title: row["title"],
            status: TaskStatus(rawValue: row["status"]) ?? .pending,
            sectionId: row["section_id"],
            sourceFile: row["source_file"],
            rejectionCount: row["rejection_count"],
            createdAt: parseDate(row["created_at"]) ?? Date(),
            updatedAt: parseDate(row["updated_at"]) ?? Date()
        )
    }

    /// Get current task for a runner
    func currentTask(for runnerId: String, from dbPath: URL) throws -> SteroidTask? {
        let db = try getDatabase(at: dbPath)

        return try db.read { db in
            guard let lock = try Row.fetchOne(db, sql: """
                SELECT task_id FROM task_locks
                WHERE runner_id = ? AND expires_at > datetime('now')
            """, arguments: [runnerId]) else {
                return nil
            }

            let taskId: String = lock["task_id"]
            return try fetchTask(db: db, taskId: taskId)
        }
    }

    /// Get recent audit log entries for a task
    func recentLogs(for taskId: String, limit: Int = 5, from dbPath: URL) throws -> [LogEntry] {
        let db = try getDatabase(at: dbPath)

        return try db.read { db in
            let rows = try Row.fetchAll(db, sql: """
                SELECT id, task_id, from_status, to_status, actor, notes, commit_sha, created_at
                FROM audit
                WHERE task_id = ?
                ORDER BY created_at DESC
                LIMIT ?
            """, arguments: [taskId, limit])

            return rows.map { row in
                LogEntry(
                    id: row["id"],
                    taskId: row["task_id"],
                    fromStatus: row["from_status"],
                    toStatus: row["to_status"],
                    actor: row["actor"],
                    notes: row["notes"],
                    commitSha: row["commit_sha"],
                    createdAt: parseDate(row["created_at"]) ?? Date()
                )
            }
        }
    }

    /// Get all active tasks (in_progress or review)
    func activeTasks(from dbPath: URL) throws -> [SteroidTask] {
        let db = try getDatabase(at: dbPath)

        return try db.read { db in
            let rows = try Row.fetchAll(db, sql: """
                SELECT id, title, status, section_id, source_file, rejection_count, created_at, updated_at
                FROM tasks
                WHERE status IN ('in_progress', 'review')
                ORDER BY updated_at DESC
            """)

            return rows.map { row in
                SteroidTask(
                    id: row["id"],
                    title: row["title"],
                    status: TaskStatus(rawValue: row["status"]) ?? .pending,
                    sectionId: row["section_id"],
                    sourceFile: row["source_file"],
                    rejectionCount: row["rejection_count"],
                    createdAt: parseDate(row["created_at"]) ?? Date(),
                    updatedAt: parseDate(row["updated_at"]) ?? Date()
                )
            }
        }
    }

    /// Read schema version to verify compatibility
    func schemaVersion(from dbPath: URL) throws -> String? {
        let db = try getDatabase(at: dbPath)

        return try db.read { db in
            let row = try Row.fetchOne(db, sql: """
                SELECT value FROM _schema WHERE key = 'version'
            """)
            return row?["value"]
        }
    }

    // MARK: - Private

    private func getDatabase(at path: URL) throws -> DatabasePool {
        if let existing = dbPools[path] {
            return existing
        }

        var config = Configuration()
        config.readonly = true
        config.busyMode = .timeout(5)

        let pool = try DatabasePool(path: path.path, configuration: config)
        dbPools[path] = pool
        return pool
    }

    private func parseDate(_ value: String?) -> Date? {
        guard let value = value else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: value) {
            return date
        }
        // Try SQLite datetime format
        let sqlFormatter = DateFormatter()
        sqlFormatter.dateFormat = "yyyy-MM-dd HH:mm:ss"
        sqlFormatter.timeZone = TimeZone(identifier: "UTC")
        return sqlFormatter.date(from: value)
    }
}

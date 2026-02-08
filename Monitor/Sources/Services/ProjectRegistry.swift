import Foundation
import Combine
import GRDB

/// Manages the list of projects to monitor by reading from the global Steroids database
@MainActor
class ProjectRegistry: ObservableObject {
    @Published var projects: [MonitoredProject] = []
    @Published var isLoading = false
    @Published var lastError: Error?

    private let globalDbPath: URL
    private var globalDbWatcher: FileWatcher?
    private var projectWatchers: [UUID: FileWatcher] = [:]
    private var refreshTimer: Timer?

    init(globalDbPath: URL? = nil) {
        self.globalDbPath = globalDbPath ?? Self.defaultGlobalDbPath
    }

    static var defaultGlobalDbPath: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".steroids/steroids.db")
    }

    /// Load projects from the global Steroids database
    func load() async {
        isLoading = true
        defer { isLoading = false }

        do {
            projects = try loadProjectsFromGlobalDb()
            await refreshAllRunners()
            setupGlobalDbWatcher()
            setupProjectWatchers()
            startPollingTimer()
        } catch {
            lastError = error
            projects = []
        }
    }

    /// Refresh runner data for all projects
    func refreshAllProjects() async {
        // Reload projects list from global db
        do {
            let updatedProjects = try loadProjectsFromGlobalDb()

            // Merge with existing projects to preserve runtime state
            for updated in updatedProjects {
                if let index = projects.firstIndex(where: { $0.path == updated.path }) {
                    projects[index].name = updated.name
                    projects[index].enabled = updated.enabled
                } else {
                    projects.append(updated)
                    setupProjectWatcher(for: updated)
                }
            }

            // Remove projects no longer in global db
            projects.removeAll { project in
                !updatedProjects.contains(where: { $0.path == project.path })
            }
        } catch {
            lastError = error
        }

        await refreshAllRunners()
    }

    /// Refresh runner data for all projects
    func refreshAllRunners() async {
        do {
            let runners = try loadRunnersFromGlobalDb()

            // Assign runners to their projects
            for i in projects.indices {
                projects[i].runners = runners.filter {
                    $0.projectPath == projects[i].path.path
                }
                projects[i].lastUpdated = Date()
            }
        } catch {
            lastError = error
        }
    }

    /// Compute overall status across all projects
    var overallStatus: OverallStatus {
        let enabledProjects = projects.filter(\.enabled)
        guard !enabledProjects.isEmpty else { return .noRunners }

        if enabledProjects.contains(where: { $0.overallStatus == .hasErrors }) {
            return .hasErrors
        }
        if enabledProjects.contains(where: { $0.overallStatus == .working }) {
            return .working
        }
        return .allGood
    }

    // MARK: - Private Database Access

    private func loadProjectsFromGlobalDb() throws -> [MonitoredProject] {
        guard FileManager.default.fileExists(atPath: globalDbPath.path) else {
            return []
        }

        var config = Configuration()
        config.readonly = true
        config.busyMode = .timeout(5)

        let dbPool = try DatabasePool(path: globalDbPath.path, configuration: config)

        return try dbPool.read { db in
            let rows = try Row.fetchAll(db, sql: """
                SELECT path, name, enabled, pending_count, in_progress_count, review_count, completed_count
                FROM projects
                ORDER BY name, path
            """)

            return rows.compactMap { row -> MonitoredProject? in
                let pathString: String = row["path"]
                let path = URL(fileURLWithPath: pathString)
                let name: String? = row["name"]
                let enabled: Int = row["enabled"] ?? 1

                return MonitoredProject(
                    path: path,
                    name: name ?? path.lastPathComponent,
                    enabled: enabled == 1
                )
            }
        }
    }

    private func loadRunnersFromGlobalDb() throws -> [Runner] {
        guard FileManager.default.fileExists(atPath: globalDbPath.path) else {
            return []
        }

        var config = Configuration()
        config.readonly = true
        config.busyMode = .timeout(5)

        let dbPool = try DatabasePool(path: globalDbPath.path, configuration: config)

        return try dbPool.read { db in
            let rows = try Row.fetchAll(db, sql: """
                SELECT id, status, pid, project_path, current_task_id, started_at, heartbeat_at
                FROM runners
                WHERE status != 'stopped'
            """)

            return rows.map { row in
                let id: String = row["id"]
                let statusStr: String = row["status"] ?? "idle"
                let pid: Int? = row["pid"]
                let projectPath: String = row["project_path"] ?? ""
                let startedAt: String? = row["started_at"]

                let status: RunnerStatus
                switch statusStr {
                case "active", "running": status = .active
                case "idle": status = .idle
                case "error": status = .error
                case "stopped": status = .stopped
                default: status = .idle
                }

                var runner = Runner(
                    id: id,
                    name: id,
                    pid: pid,
                    projectPath: projectPath,
                    status: status
                )

                if let startedAtStr = startedAt {
                    runner.startedAt = parseDate(startedAtStr)
                }

                return runner
            }
        }
    }

    private func parseDate(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: value) {
            return date
        }
        let sqlFormatter = DateFormatter()
        sqlFormatter.dateFormat = "yyyy-MM-dd HH:mm:ss"
        sqlFormatter.timeZone = TimeZone(identifier: "UTC")
        return sqlFormatter.date(from: value)
    }

    // MARK: - File Watching

    private func setupGlobalDbWatcher() {
        globalDbWatcher?.stop()
        globalDbWatcher = FileWatcher(directory: globalDbPath.deletingLastPathComponent())
        globalDbWatcher?.onChange = { [weak self] in
            Task { @MainActor in
                await self?.refreshAllProjects()
            }
        }
        globalDbWatcher?.start()
    }

    private func setupProjectWatchers() {
        for project in projects {
            setupProjectWatcher(for: project)
        }
    }

    private func setupProjectWatcher(for project: MonitoredProject) {
        guard project.databaseExists else { return }

        let watcher = FileWatcher(directory: project.databasePath.deletingLastPathComponent())
        watcher.onChange = { [weak self] in
            Task { @MainActor in
                await self?.refreshAllRunners()
            }
        }
        watcher.start()
        projectWatchers[project.id] = watcher
    }

    private func startPollingTimer() {
        refreshTimer?.invalidate()
        refreshTimer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in
            Task { @MainActor in
                await self?.refreshAllRunners()
            }
        }
    }
}

// MARK: - Preferences (stored separately)

struct MonitorPreferences: Codable {
    var refreshInterval: Int
    var showIdleRunners: Bool
    var notifyOnError: Bool
    var launchAtLogin: Bool

    static var `default`: MonitorPreferences {
        MonitorPreferences(
            refreshInterval: 5,
            showIdleRunners: true,
            notifyOnError: true,
            launchAtLogin: false
        )
    }
}

// MARK: - Errors

enum MonitorError: LocalizedError {
    case projectAlreadyExists
    case databaseNotFound(URL)
    case globalDbNotFound

    var errorDescription: String? {
        switch self {
        case .projectAlreadyExists:
            return "Project is already being monitored"
        case .databaseNotFound(let url):
            return "Steroids database not found at \(url.path)"
        case .globalDbNotFound:
            return "Global Steroids database not found at ~/.steroids/steroids.db"
        }
    }
}

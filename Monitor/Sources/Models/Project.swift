import Foundation

/// A project being monitored by the Monitor app
struct MonitoredProject: Identifiable, Codable, Hashable {
    let id: UUID
    let path: URL
    var name: String
    var enabled: Bool
    var runners: [Runner]
    var lastUpdated: Date

    init(id: UUID = UUID(), path: URL, name: String? = nil, enabled: Bool = true) {
        self.id = id
        self.path = path
        self.name = name ?? path.lastPathComponent
        self.enabled = enabled
        self.runners = []
        self.lastUpdated = Date()
    }

    /// Path to the project's Steroids database
    var databasePath: URL {
        path.appendingPathComponent(".steroids/steroids.db")
    }

    /// Check if the project database exists
    var databaseExists: Bool {
        FileManager.default.fileExists(atPath: databasePath.path)
    }

    /// Compute overall status from all runners
    var overallStatus: OverallStatus {
        guard !runners.isEmpty else { return .noRunners }

        if runners.contains(where: { $0.status == .error }) {
            return .hasErrors
        }
        if runners.contains(where: { $0.status == .active }) {
            return .working
        }
        return .allGood
    }
}

/// Overall status for the menu bar icon
enum OverallStatus: String, CaseIterable {
    case allGood      // Green: All runners idle or succeeding
    case working      // Yellow: At least one runner active
    case hasErrors    // Red: At least one runner in error state
    case noRunners    // Gray: No runners configured
}

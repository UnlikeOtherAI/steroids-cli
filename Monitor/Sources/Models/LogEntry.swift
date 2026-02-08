import Foundation

/// A log entry from the audit trail
struct LogEntry: Identifiable, Codable, Hashable {
    let id: Int
    let taskId: String
    let fromStatus: String?
    let toStatus: String
    let actor: String
    let notes: String?
    let commitSha: String?
    let createdAt: Date

    init(
        id: Int,
        taskId: String,
        fromStatus: String? = nil,
        toStatus: String,
        actor: String,
        notes: String? = nil,
        commitSha: String? = nil,
        createdAt: Date = Date()
    ) {
        self.id = id
        self.taskId = taskId
        self.fromStatus = fromStatus
        self.toStatus = toStatus
        self.actor = actor
        self.notes = notes
        self.commitSha = commitSha
        self.createdAt = createdAt
    }

    /// Log level inferred from content
    var level: LogLevel {
        if toStatus == "failed" || (notes?.lowercased().contains("error") ?? false) {
            return .error
        }
        if notes?.lowercased().contains("warn") ?? false {
            return .warning
        }
        return .info
    }

    /// Formatted display string for the log entry
    var displayText: String {
        var text = "[\(level.rawValue.uppercased())] \(fromStatus ?? "nil") → \(toStatus)"
        if let notes = notes, !notes.isEmpty {
            text += ": \(notes)"
        }
        return text
    }
}

/// Log severity levels
enum LogLevel: String, Codable {
    case info
    case warning
    case error
}

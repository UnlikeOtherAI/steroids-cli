import Foundation

/// A Steroids runner instance
struct Runner: Identifiable, Codable, Hashable {
    let id: String
    let name: String
    let pid: Int?
    let projectPath: String
    var status: RunnerStatus
    var currentTask: SteroidTask?
    var startedAt: Date?
    var lastHeartbeat: Date?

    init(id: String, name: String, pid: Int? = nil, projectPath: String, status: RunnerStatus = .idle) {
        self.id = id
        self.name = name
        self.pid = pid
        self.projectPath = projectPath
        self.status = status
    }

    /// Display name combining name and optional task info
    var displayName: String {
        if let task = currentTask {
            let truncatedTitle = task.title.prefix(30)
            return "\(name): Task #\(task.id) \"\(truncatedTitle)...\""
        }
        return "\(name): Idle"
    }
}

/// Runner status states
enum RunnerStatus: String, Codable, CaseIterable {
    case idle       // Not actively processing
    case active     // Currently working on a task
    case reviewing  // Task in review phase
    case error      // Runner encountered an error
    case stopped    // Runner has been stopped

    var icon: String {
        switch self {
        case .idle: return "circle.fill"
        case .active: return "circle.fill"
        case .reviewing: return "circle.fill"
        case .error: return "exclamationmark.circle.fill"
        case .stopped: return "circle"
        }
    }

    var colorName: String {
        switch self {
        case .idle: return "green"
        case .active: return "yellow"
        case .reviewing: return "yellow"
        case .error: return "red"
        case .stopped: return "gray"
        }
    }
}

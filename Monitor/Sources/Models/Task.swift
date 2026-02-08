import Foundation

/// A Steroids task
struct SteroidTask: Identifiable, Codable, Hashable {
    let id: String
    let title: String
    var status: TaskStatus
    let sectionId: String?
    let sourceFile: String?
    var rejectionCount: Int
    let createdAt: Date
    var updatedAt: Date

    init(
        id: String,
        title: String,
        status: TaskStatus = .pending,
        sectionId: String? = nil,
        sourceFile: String? = nil,
        rejectionCount: Int = 0,
        createdAt: Date = Date(),
        updatedAt: Date = Date()
    ) {
        self.id = id
        self.title = title
        self.status = status
        self.sectionId = sectionId
        self.sourceFile = sourceFile
        self.rejectionCount = rejectionCount
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    /// Time elapsed since task was started
    var elapsedTime: TimeInterval? {
        guard status == .inProgress || status == .review else { return nil }
        return Date().timeIntervalSince(updatedAt)
    }
}

/// Task status values matching the CLI
enum TaskStatus: String, Codable, CaseIterable {
    case pending = "pending"
    case inProgress = "in_progress"
    case review = "review"
    case completed = "completed"
    case skipped = "skipped"
    case partial = "partial"
    case failed = "failed"
    case disputed = "disputed"

    var displayName: String {
        switch self {
        case .pending: return "Pending"
        case .inProgress: return "In Progress"
        case .review: return "Review"
        case .completed: return "Completed"
        case .skipped: return "Skipped"
        case .partial: return "Partial"
        case .failed: return "Failed"
        case .disputed: return "Disputed"
        }
    }

    var isActive: Bool {
        self == .inProgress || self == .review
    }
}

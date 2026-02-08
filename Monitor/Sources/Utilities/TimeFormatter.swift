import Foundation

/// Formats time intervals as relative strings
struct TimeFormatter {
    /// Format a date as relative time ("2 minutes ago")
    static func relativeTime(from date: Date) -> String {
        let interval = Date().timeIntervalSince(date)
        return formatInterval(interval)
    }

    /// Format a time interval as duration ("2 minutes")
    static func duration(from interval: TimeInterval) -> String {
        formatInterval(interval, includeSuffix: false)
    }

    private static func formatInterval(_ interval: TimeInterval, includeSuffix: Bool = true) -> String {
        let suffix = includeSuffix ? " ago" : ""

        if interval < 5 {
            return "just now"
        }

        if interval < 60 {
            let seconds = Int(interval)
            return "\(seconds) second\(seconds == 1 ? "" : "s")\(suffix)"
        }

        if interval < 3600 {
            let minutes = Int(interval / 60)
            return "\(minutes) minute\(minutes == 1 ? "" : "s")\(suffix)"
        }

        if interval < 86400 {
            let hours = Int(interval / 3600)
            return "\(hours) hour\(hours == 1 ? "" : "s")\(suffix)"
        }

        let days = Int(interval / 86400)
        return "\(days) day\(days == 1 ? "" : "s")\(suffix)"
    }

    /// Format elapsed time for a task
    static func taskElapsed(_ task: SteroidTask) -> String? {
        guard let elapsed = task.elapsedTime else { return nil }
        return duration(from: elapsed)
    }
}

/// Extension for convenient date formatting
extension Date {
    var relativeTime: String {
        TimeFormatter.relativeTime(from: self)
    }
}

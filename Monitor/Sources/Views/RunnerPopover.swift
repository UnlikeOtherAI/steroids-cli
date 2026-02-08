import SwiftUI

/// Detailed popover shown when hovering over a runner
struct RunnerPopover: View {
    let runner: Runner
    let projectPath: URL
    @State private var logs: [LogEntry] = []
    @State private var isLoadingLogs = false

    private let databaseReader = DatabaseReader()

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            // Header
            HStack {
                Text("Runner: \(runner.name)")
                    .font(.headline)
                Spacer()
                StatusBadge(status: runner.status)
            }

            Divider()

            // Task info
            if let task = runner.currentTask {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Current Task: #\(task.id)")
                        .font(.subheadline)
                        .foregroundColor(.secondary)
                    Text(task.title)
                        .font(.body)
                        .lineLimit(2)

                    Divider()

                    HStack {
                        Label {
                            if let elapsed = TimeFormatter.taskElapsed(task) {
                                Text("Started: \(elapsed) ago")
                            } else {
                                Text("Started: N/A")
                            }
                        } icon: {
                            Image(systemName: "clock")
                        }
                        .font(.caption)
                        .foregroundColor(.secondary)

                        Spacer()

                        Label {
                            Text("Attempts: \(task.rejectionCount + 1)")
                        } icon: {
                            Image(systemName: "arrow.counterclockwise")
                        }
                        .font(.caption)
                        .foregroundColor(.secondary)
                    }
                }
            } else {
                Text("No active task")
                    .foregroundColor(.secondary)
            }

            // Error logs (if in error state)
            if runner.status == .error {
                Divider()

                VStack(alignment: .leading, spacing: 4) {
                    Text("Recent Log Entries")
                        .font(.subheadline)
                        .foregroundColor(.secondary)

                    if isLoadingLogs {
                        ProgressView()
                            .scaleEffect(0.7)
                    } else if logs.isEmpty {
                        Text("No logs available")
                            .font(.caption)
                            .foregroundColor(.secondary)
                    } else {
                        ForEach(logs.prefix(5)) { log in
                            LogEntryRow(entry: log)
                        }
                    }
                }

                Button(action: viewFullLogs) {
                    Label("View Full Logs", systemImage: "doc.text")
                }
                .buttonStyle(.link)
                .font(.caption)
            }
        }
        .padding(16)
        .frame(width: 300)
        .task {
            await loadLogs()
        }
    }

    private func loadLogs() async {
        guard let taskId = runner.currentTask?.id else { return }

        isLoadingLogs = true
        defer { isLoadingLogs = false }

        do {
            let dbPath = projectPath.appendingPathComponent(".steroids/steroids.db")
            logs = try databaseReader.recentLogs(for: taskId, limit: 5, from: dbPath)
        } catch {
            print("Failed to load logs: \(error)")
        }
    }

    private func viewFullLogs() {
        // Open terminal or log viewer
        guard let pid = runner.pid else { return }
        let script = "tell application \"Terminal\" to do script \"steroids runners logs \(pid)\""
        if let appleScript = NSAppleScript(source: script) {
            var error: NSDictionary?
            appleScript.executeAndReturnError(&error)
        }
    }
}

/// Status badge showing runner status
struct StatusBadge: View {
    let status: RunnerStatus

    var body: some View {
        Text(status.rawValue.capitalized)
            .font(.caption)
            .padding(.horizontal, 8)
            .padding(.vertical, 2)
            .background(Color.forStatus(status).opacity(0.2))
            .foregroundColor(Color.forStatus(status))
            .cornerRadius(4)
    }
}

/// Single log entry row
struct LogEntryRow: View {
    let entry: LogEntry

    var body: some View {
        HStack(alignment: .top, spacing: 4) {
            Circle()
                .fill(colorForLevel(entry.level))
                .frame(width: 6, height: 6)
                .padding(.top, 4)

            Text(entry.displayText)
                .font(.system(size: 10, design: .monospaced))
                .foregroundColor(.secondary)
                .lineLimit(2)
        }
    }

    private func colorForLevel(_ level: LogLevel) -> Color {
        switch level {
        case .info: return .blue
        case .warning: return .yellow
        case .error: return .red
        }
    }
}

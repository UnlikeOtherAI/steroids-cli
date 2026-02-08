import SwiftUI

/// A menu item showing a single runner
struct RunnerMenuItem: View {
    let runner: Runner
    let projectPath: URL
    @State private var isHovering = false
    @State private var showPopover = false

    var body: some View {
        HStack(spacing: 8) {
            // Tree connector
            HStack(spacing: 0) {
                Rectangle()
                    .fill(Color.gray.opacity(0.3))
                    .frame(width: 1, height: 20)
                Rectangle()
                    .fill(Color.gray.opacity(0.3))
                    .frame(width: 8, height: 1)
            }

            // Status indicator
            Circle()
                .fill(Color.forStatus(runner.status))
                .frame(width: 8, height: 8)

            // Runner info
            VStack(alignment: .leading, spacing: 2) {
                Text(runner.name)
                    .font(.system(size: 12, weight: .medium))

                if let task = runner.currentTask {
                    Text("Task #\(task.id): \(truncate(task.title, to: 25))")
                        .font(.system(size: 11))
                        .foregroundColor(.secondary)
                        .lineLimit(1)
                } else {
                    Text("Idle")
                        .font(.system(size: 11))
                        .foregroundColor(.secondary)
                }
            }

            Spacer()

            // Elapsed time
            if let task = runner.currentTask,
               let elapsed = TimeFormatter.taskElapsed(task) {
                Text(elapsed)
                    .font(.system(size: 10))
                    .foregroundColor(.secondary)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 4)
        .background(isHovering ? Color.gray.opacity(0.1) : Color.clear)
        .contentShape(Rectangle())
        .onHover { hovering in
            isHovering = hovering
            if hovering {
                // Delay showing popover
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                    if isHovering {
                        showPopover = true
                    }
                }
            } else {
                showPopover = false
            }
        }
        .popover(isPresented: $showPopover, arrowEdge: .trailing) {
            RunnerPopover(runner: runner, projectPath: projectPath)
        }
    }

    private func truncate(_ text: String, to length: Int) -> String {
        if text.count <= length {
            return text
        }
        return String(text.prefix(length)) + "..."
    }
}

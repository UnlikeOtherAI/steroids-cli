import SwiftUI

/// A section showing a project and its runners
struct ProjectSection: View {
    let project: MonitoredProject
    @State private var isExpanded = true
    @State private var isHovering = false

    var body: some View {
        VStack(spacing: 0) {
            // Project header
            HStack(spacing: 8) {
                Image(systemName: "folder.fill")
                    .foregroundColor(.accentColor)
                    .font(.system(size: 14))

                Text(project.name)
                    .font(.system(size: 13, weight: .medium))

                Spacer()

                // Status indicator
                Circle()
                    .fill(Color.forOverallStatus(project.overallStatus))
                    .frame(width: 8, height: 8)

                // Expand/collapse
                Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundColor(.secondary)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(isHovering ? Color.gray.opacity(0.1) : Color.clear)
            .contentShape(Rectangle())
            .onTapGesture {
                withAnimation(.easeInOut(duration: 0.15)) {
                    isExpanded.toggle()
                }
            }
            .onHover { hovering in
                isHovering = hovering
            }

            // Runners list
            if isExpanded {
                if project.runners.isEmpty {
                    HStack(spacing: 8) {
                        Image(systemName: "circle")
                            .font(.system(size: 8))
                            .foregroundColor(.gray)
                        Text("No active runners")
                            .font(.system(size: 12))
                            .foregroundColor(.secondary)
                        Spacer()
                    }
                    .padding(.leading, 32)
                    .padding(.trailing, 12)
                    .padding(.vertical, 4)
                } else {
                    ForEach(project.runners) { runner in
                        RunnerMenuItem(runner: runner, projectPath: project.path)
                            .padding(.leading, 20)
                    }
                }
            }
        }
    }
}

import SwiftUI
import AppKit

/// Main dropdown menu shown when clicking the status bar icon
struct StatusBarMenu: View {
    @EnvironmentObject var registry: ProjectRegistry
    @StateObject private var projectInitializer = ProjectInitializer()
    @StateObject private var webUILauncher = WebUILauncher()

    var body: some View {
        VStack(spacing: 0) {
            // Header
            HStack {
                Text("STEROIDS MONITOR")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundColor(.secondary)
                Spacer()
                Button(action: { Task { await registry.refreshAllProjects() } }) {
                    Image(systemName: "arrow.clockwise")
                        .font(.system(size: 11))
                }
                .buttonStyle(.plain)
                .help("Refresh all projects")
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)

            Divider()

            // Projects list
            ScrollView {
                LazyVStack(spacing: 0) {
                    if registry.projects.isEmpty {
                        EmptyStateView(onAddProject: { selectAndInitializeProject() })
                    } else {
                        ForEach(registry.projects) { project in
                            ProjectSection(project: project)
                        }
                    }
                }
            }
            .frame(maxHeight: 280)

            Divider()

            // Actions
            VStack(spacing: 0) {
                MenuButton(title: "+ Add Project...", icon: "plus.circle") {
                    selectAndInitializeProject()
                }

                Divider()
                    .padding(.horizontal, 8)

                MenuButton(title: "Launch Web UI", icon: "globe") {
                    Task { await webUILauncher.launchWebUI() }
                }

                MenuButton(title: "Quit Monitor", icon: "power") {
                    NSApplication.shared.terminate(nil)
                }
            }
        }
        .frame(width: 320)
        .background(Color(nsColor: .windowBackgroundColor))
        .overlay {
            if webUILauncher.isLaunching {
                ZStack {
                    Color.black.opacity(0.3)
                    VStack(spacing: 12) {
                        ProgressView()
                            .scaleEffect(1.2)
                        Text("Starting Web UI...")
                            .font(.caption)
                    }
                    .padding(20)
                    .background(.regularMaterial)
                    .cornerRadius(8)
                }
            }
        }
        .alert("Web UI Error", isPresented: $webUILauncher.showingError) {
            Button("OK") { }
        } message: {
            Text(webUILauncher.errorMessage)
        }
        .alert("Initialize Steroids?", isPresented: $projectInitializer.showingInitAlert) {
            Button("Cancel", role: .cancel) { }
            Button("Initialize") {
                Task {
                    await projectInitializer.initializeProject()
                    await registry.refreshAllProjects()
                }
            }
        } message: {
            Text("This folder doesn't have Steroids configured.\n\nWould you like to initialize it? This will run 'steroids init' and register the project.")
        }
        .alert("Already Registered", isPresented: $projectInitializer.showingAlreadyRegistered) {
            Button("OK") { }
        } message: {
            Text("This project is already registered with Steroids.")
        }
        .alert("Initialization Failed", isPresented: $projectInitializer.showingError) {
            Button("OK") { }
        } message: {
            Text(projectInitializer.errorMessage)
        }
        .alert("Success", isPresented: $projectInitializer.showingSuccess) {
            Button("OK") {
                Task { await registry.refreshAllProjects() }
            }
        } message: {
            Text("Project initialized successfully! It will now appear in the monitor.")
        }
    }

    private func selectAndInitializeProject() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.message = "Select a project folder to monitor"
        panel.prompt = "Select"

        if panel.runModal() == .OK, let url = panel.url {
            projectInitializer.checkAndInitialize(url: url, existingProjects: registry.projects)
        }
    }
}

/// Handles project initialization logic
@MainActor
class ProjectInitializer: ObservableObject {
    @Published var showingInitAlert = false
    @Published var showingAlreadyRegistered = false
    @Published var showingError = false
    @Published var showingSuccess = false
    @Published var errorMessage = ""

    private var selectedURL: URL?

    func checkAndInitialize(url: URL, existingProjects: [MonitoredProject]) {
        selectedURL = url

        // Check if already registered
        if existingProjects.contains(where: { $0.path == url }) {
            showingAlreadyRegistered = true
            return
        }

        // Check if .steroids folder exists
        let steroidsPath = url.appendingPathComponent(".steroids/steroids.db")
        if FileManager.default.fileExists(atPath: steroidsPath.path) {
            // Has steroids but not in global registry - might be unregistered
            // Still offer to init (it will re-register)
            showingInitAlert = true
        } else {
            // No steroids folder - needs initialization
            showingInitAlert = true
        }
    }

    func initializeProject() async {
        guard let url = selectedURL else { return }

        do {
            let result = try await runSteroidsInit(in: url)
            if result.success {
                showingSuccess = true
            } else {
                errorMessage = result.output
                showingError = true
            }
        } catch {
            errorMessage = error.localizedDescription
            showingError = true
        }
    }

    private func runSteroidsInit(in directory: URL) async throws -> (success: Bool, output: String) {
        return try await withCheckedThrowingContinuation { continuation in
            let process = Process()
            let pipe = Pipe()

            process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            process.arguments = ["steroids", "init"]
            process.currentDirectoryURL = directory
            process.standardOutput = pipe
            process.standardError = pipe

            do {
                try process.run()
                process.waitUntilExit()

                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                let output = String(data: data, encoding: .utf8) ?? ""

                continuation.resume(returning: (process.terminationStatus == 0, output))
            } catch {
                continuation.resume(throwing: error)
            }
        }
    }
}

/// Empty state when no projects are configured
struct EmptyStateView: View {
    var onAddProject: () -> Void

    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: "folder.badge.questionmark")
                .font(.system(size: 32))
                .foregroundColor(.secondary)
            Text("No projects found")
                .font(.headline)
            Text("Add a project folder to start monitoring")
                .font(.caption)
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)

            Button("Add Project...") {
                onAddProject()
            }
            .buttonStyle(.bordered)
            .padding(.top, 8)
        }
        .padding(24)
    }
}

/// Reusable menu button
struct MenuButton: View {
    let title: String
    let icon: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Image(systemName: icon)
                    .frame(width: 16)
                Text(title)
                Spacer()
            }
            .contentShape(Rectangle())
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
        }
        .buttonStyle(.plain)
        .background(Color.clear)
        .contentShape(Rectangle())
    }
}

/// Handles launching the Web UI
@MainActor
class WebUILauncher: ObservableObject {
    @Published var isLaunching = false
    @Published var showingError = false
    @Published var errorMessage = ""

    private let webUIURL = "http://localhost:3500"
    private let apiURL = "http://localhost:3501"

    func launchWebUI() async {
        // First check if already running
        if await isWebUIRunning() {
            openBrowser()
            return
        }

        // Need to start the services
        isLaunching = true
        defer { isLaunching = false }

        do {
            try await startWebUIServices()

            // Wait for services to be ready (poll for up to 30 seconds)
            var ready = false
            for _ in 0..<30 {
                try await Task.sleep(nanoseconds: 1_000_000_000) // 1 second
                if await isWebUIRunning() {
                    ready = true
                    break
                }
            }

            if ready {
                openBrowser()
            } else {
                errorMessage = "Web UI failed to start. Make sure the WebUI is installed."
                showingError = true
            }
        } catch {
            errorMessage = error.localizedDescription
            showingError = true
        }
    }

    private func isWebUIRunning() async -> Bool {
        guard let url = URL(string: webUIURL) else { return false }

        do {
            let (_, response) = try await URLSession.shared.data(from: url)
            if let httpResponse = response as? HTTPURLResponse {
                return httpResponse.statusCode == 200
            }
        } catch {
            // Not running
        }
        return false
    }

    private func startWebUIServices() async throws {
        // Try running 'steroids webui' command first (future command)
        // Fall back to make launch

        let steroidsPath = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Projects/steroids-cli")

        // Try make launch in the steroids-cli directory
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/make")
        process.arguments = ["launch"]
        process.currentDirectoryURL = steroidsPath

        // Run in background, don't wait
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe

        try process.run()

        // Don't wait for completion - the services run indefinitely
    }

    private func openBrowser() {
        if let url = URL(string: webUIURL) {
            NSWorkspace.shared.open(url)
        }
    }
}

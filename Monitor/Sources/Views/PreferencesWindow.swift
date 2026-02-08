import SwiftUI
import ServiceManagement

/// Preferences window for app settings
struct PreferencesWindow: View {
    @EnvironmentObject var registry: ProjectRegistry
    @State private var preferences = MonitorPreferences.default
    @State private var launchAtLogin = false

    var body: some View {
        TabView {
            GeneralPreferencesView(preferences: $preferences, launchAtLogin: $launchAtLogin)
                .tabItem {
                    Label("General", systemImage: "gearshape")
                }

            ProjectsPreferencesView()
                .environmentObject(registry)
                .tabItem {
                    Label("Projects", systemImage: "folder")
                }

            AboutView()
                .tabItem {
                    Label("About", systemImage: "info.circle")
                }
        }
        .frame(width: 450, height: 300)
        .onAppear {
            loadPreferences()
        }
    }

    private func loadPreferences() {
        // Load preferences from config
        launchAtLogin = SMAppService.mainApp.status == .enabled
    }
}

/// General preferences tab
struct GeneralPreferencesView: View {
    @Binding var preferences: MonitorPreferences
    @Binding var launchAtLogin: Bool

    var body: some View {
        Form {
            Section {
                Toggle("Launch at login", isOn: $launchAtLogin)
                    .onChange(of: launchAtLogin) { newValue in
                        updateLaunchAtLogin(newValue)
                    }

                Toggle("Show idle runners", isOn: $preferences.showIdleRunners)

                Toggle("Notify on errors", isOn: $preferences.notifyOnError)

                Picker("Refresh interval", selection: $preferences.refreshInterval) {
                    Text("5 seconds").tag(5)
                    Text("10 seconds").tag(10)
                    Text("30 seconds").tag(30)
                    Text("1 minute").tag(60)
                }
            }
        }
        .formStyle(.grouped)
        .padding()
    }

    private func updateLaunchAtLogin(_ enabled: Bool) {
        do {
            if enabled {
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
        } catch {
            print("Failed to update launch at login: \(error)")
        }
    }
}

/// Projects management tab (read-only view, projects managed via CLI)
struct ProjectsPreferencesView: View {
    @EnvironmentObject var registry: ProjectRegistry

    var body: some View {
        VStack(spacing: 0) {
            List {
                ForEach(registry.projects) { project in
                    HStack {
                        Image(systemName: "folder.fill")
                            .foregroundColor(.accentColor)
                        VStack(alignment: .leading) {
                            Text(project.name)
                                .font(.body)
                            Text(project.path.path)
                                .font(.caption)
                                .foregroundColor(.secondary)
                        }
                        Spacer()
                        if !project.enabled {
                            Text("Disabled")
                                .font(.caption)
                                .foregroundColor(.secondary)
                        }
                    }
                }
            }

            Divider()

            HStack {
                Image(systemName: "info.circle")
                    .foregroundColor(.secondary)
                Text("Projects are auto-discovered from ~/.steroids/steroids.db")
                    .font(.caption)
                    .foregroundColor(.secondary)
                Spacer()
            }
            .padding(8)
        }
    }
}

/// About tab
struct AboutView: View {
    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "circle.hexagonpath.fill")
                .font(.system(size: 64))
                .foregroundColor(.accentColor)

            Text("Steroids Monitor")
                .font(.title)

            Text("Version 1.0.0")
                .foregroundColor(.secondary)

            Text("Monitor your Steroids runners across multiple projects")
                .multilineTextAlignment(.center)
                .foregroundColor(.secondary)

            Link("GitHub Repository", destination: URL(string: "https://github.com/UnlikeOtherAI/steroids-cli")!)
        }
        .padding()
    }
}

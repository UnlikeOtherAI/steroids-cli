import SwiftUI

@main
struct MonitorApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    var body: some Scene {
        Settings {
            PreferencesWindow()
                .environmentObject(appDelegate.registry)
        }
    }
}

import AppKit
import SwiftUI

@MainActor
class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var popover: NSPopover!
    private let statusIconManager = StatusIconManager()

    let registry: ProjectRegistry

    override init() {
        self.registry = ProjectRegistry()
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Hide dock icon - menu bar app only
        NSApp.setActivationPolicy(.accessory)

        // Setup status bar item
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusIconManager.setStatusItem(statusItem)

        if let button = statusItem.button {
            button.action = #selector(togglePopover)
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        }

        // Setup popover with menu
        popover = NSPopover()
        popover.contentSize = NSSize(width: 320, height: 400)
        popover.behavior = .transient
        popover.contentViewController = NSHostingController(
            rootView: StatusBarMenu()
                .environmentObject(registry)
        )

        // Load projects and update icon
        Task { @MainActor in
            await registry.load()
            updateStatusIcon()
        }

        // Observe registry changes to update icon
        setupRegistryObserver()
    }

    @objc private func togglePopover() {
        guard let button = statusItem.button else { return }

        if popover.isShown {
            popover.performClose(nil)
        } else {
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
            popover.contentViewController?.view.window?.makeKey()
        }
    }

    private func setupRegistryObserver() {
        // Observe changes to update the status icon
        Task { @MainActor in
            for await _ in registry.$projects.values {
                updateStatusIcon()
            }
        }
    }

    private func updateStatusIcon() {
        statusIconManager.updateIcon(for: registry.overallStatus)
    }
}

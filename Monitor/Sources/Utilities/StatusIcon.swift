import AppKit
import SwiftUI

/// Manages the menu bar status icon
class StatusIconManager {
    private weak var statusItem: NSStatusItem?

    init(statusItem: NSStatusItem? = nil) {
        self.statusItem = statusItem
    }

    func setStatusItem(_ item: NSStatusItem) {
        self.statusItem = item
    }

    /// Update the icon based on overall status
    func updateIcon(for status: OverallStatus) {
        guard let button = statusItem?.button else { return }

        let image = createStatusImage(for: status)
        image.isTemplate = false // We want colored icons
        button.image = image
    }

    /// Create a colored circle image for the status
    private func createStatusImage(for status: OverallStatus) -> NSImage {
        let size = NSSize(width: 18, height: 18)
        let image = NSImage(size: size)

        image.lockFocus()

        let color = statusColor(for: status)
        color.setFill()

        let circleSize: CGFloat = status == .noRunners ? 10 : 12
        let origin = (size.width - circleSize) / 2
        let rect = NSRect(x: origin, y: origin, width: circleSize, height: circleSize)

        if status == .noRunners {
            // Draw hollow circle for no runners
            let path = NSBezierPath(ovalIn: rect)
            path.lineWidth = 1.5
            NSColor.gray.setStroke()
            path.stroke()
        } else {
            // Draw filled circle
            let path = NSBezierPath(ovalIn: rect)
            path.fill()
        }

        image.unlockFocus()
        return image
    }

    /// Get the color for a status
    private func statusColor(for status: OverallStatus) -> NSColor {
        switch status {
        case .allGood:
            return NSColor.systemGreen
        case .working:
            return NSColor.systemYellow
        case .hasErrors:
            return NSColor.systemRed
        case .noRunners:
            return NSColor.gray
        }
    }
}

/// SwiftUI color extension for status
extension Color {
    static func forStatus(_ status: RunnerStatus) -> Color {
        switch status {
        case .idle:
            return .green
        case .active, .reviewing:
            return .yellow
        case .error:
            return .red
        case .stopped:
            return .gray
        }
    }

    static func forOverallStatus(_ status: OverallStatus) -> Color {
        switch status {
        case .allGood:
            return .green
        case .working:
            return .yellow
        case .hasErrors:
            return .red
        case .noRunners:
            return .gray
        }
    }
}

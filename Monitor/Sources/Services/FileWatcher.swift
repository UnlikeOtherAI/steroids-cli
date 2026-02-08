import Foundation

/// Watches a directory for changes using FSEvents
class FileWatcher {
    private let directory: URL
    private var source: DispatchSourceFileSystemObject?
    private var fileDescriptor: Int32 = -1

    var onChange: (() -> Void)?

    init(directory: URL) {
        self.directory = directory
    }

    deinit {
        stop()
    }

    /// Start watching the directory
    func start() {
        stop() // Clean up any existing watcher

        fileDescriptor = open(directory.path, O_EVTONLY)
        guard fileDescriptor >= 0 else {
            print("FileWatcher: Failed to open \(directory.path)")
            return
        }

        source = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: fileDescriptor,
            eventMask: [.write, .rename, .delete],
            queue: .main
        )

        source?.setEventHandler { [weak self] in
            self?.onChange?()
        }

        source?.setCancelHandler { [weak self] in
            guard let self = self, self.fileDescriptor >= 0 else { return }
            close(self.fileDescriptor)
            self.fileDescriptor = -1
        }

        source?.resume()
    }

    /// Stop watching the directory
    func stop() {
        source?.cancel()
        source = nil
    }
}

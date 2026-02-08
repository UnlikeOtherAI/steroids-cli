import Foundation

/// Executes Steroids CLI commands
class CLIBridge {
    private let cliPath: String

    init(cliPath: String = "steroids") {
        self.cliPath = cliPath
    }

    /// Execute a CLI command and return the output
    func execute(_ arguments: [String], in directory: URL? = nil) async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            let process = Process()
            let pipe = Pipe()

            process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            process.arguments = [cliPath] + arguments
            process.standardOutput = pipe
            process.standardError = pipe

            if let directory = directory {
                process.currentDirectoryURL = directory
            }

            do {
                try process.run()
                process.waitUntilExit()

                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                let output = String(data: data, encoding: .utf8) ?? ""

                if process.terminationStatus == 0 {
                    continuation.resume(returning: output)
                } else {
                    continuation.resume(throwing: CLIError.executionFailed(output))
                }
            } catch {
                continuation.resume(throwing: error)
            }
        }
    }

    /// Get runners list via CLI
    func listRunners(in projectPath: URL) async throws -> [Runner] {
        let output = try await execute(["runners", "list", "--json"], in: projectPath)
        guard let data = output.data(using: .utf8) else {
            throw CLIError.invalidOutput
        }

        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode([Runner].self, from: data)
    }

    /// Get task details via CLI
    func taskAudit(taskId: String, in projectPath: URL) async throws -> String {
        return try await execute(["tasks", "audit", taskId], in: projectPath)
    }

    /// Get logs for a runner via CLI
    func logs(runnerId: String, limit: Int = 20, in projectPath: URL) async throws -> String {
        return try await execute(["runners", "logs", runnerId, "--limit", String(limit)], in: projectPath)
    }

    /// Check if CLI is available
    func isAvailable() async -> Bool {
        do {
            _ = try await execute(["--version"])
            return true
        } catch {
            return false
        }
    }
}

enum CLIError: LocalizedError {
    case executionFailed(String)
    case invalidOutput
    case notInstalled

    var errorDescription: String? {
        switch self {
        case .executionFailed(let output):
            return "CLI command failed: \(output)"
        case .invalidOutput:
            return "Invalid CLI output"
        case .notInstalled:
            return "Steroids CLI is not installed"
        }
    }
}

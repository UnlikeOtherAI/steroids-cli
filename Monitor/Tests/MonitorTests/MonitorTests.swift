import XCTest
@testable import Monitor

final class MonitorTests: XCTestCase {
    func testTimeFormatterSeconds() {
        let result = TimeFormatter.duration(from: 45)
        XCTAssertEqual(result, "45 seconds")
    }

    func testTimeFormatterMinutes() {
        let result = TimeFormatter.duration(from: 120)
        XCTAssertEqual(result, "2 minutes")
    }

    func testTimeFormatterHours() {
        let result = TimeFormatter.duration(from: 7200)
        XCTAssertEqual(result, "2 hours")
    }

    func testOverallStatusAllGood() {
        var project = MonitoredProject(path: URL(fileURLWithPath: "/test"))
        project.runners = [
            Runner(id: "1", name: "runner-1", projectPath: "/test", status: .idle)
        ]
        XCTAssertEqual(project.overallStatus, .allGood)
    }

    func testOverallStatusWorking() {
        var project = MonitoredProject(path: URL(fileURLWithPath: "/test"))
        project.runners = [
            Runner(id: "1", name: "runner-1", projectPath: "/test", status: .active)
        ]
        XCTAssertEqual(project.overallStatus, .working)
    }

    func testOverallStatusHasErrors() {
        var project = MonitoredProject(path: URL(fileURLWithPath: "/test"))
        project.runners = [
            Runner(id: "1", name: "runner-1", projectPath: "/test", status: .error)
        ]
        XCTAssertEqual(project.overallStatus, .hasErrors)
    }

    func testOverallStatusNoRunners() {
        let project = MonitoredProject(path: URL(fileURLWithPath: "/test"))
        XCTAssertEqual(project.overallStatus, .noRunners)
    }
}

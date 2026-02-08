// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "Monitor",
    platforms: [
        .macOS(.v13)
    ],
    products: [
        .executable(name: "Monitor", targets: ["Monitor"])
    ],
    dependencies: [
        .package(url: "https://github.com/groue/GRDB.swift.git", from: "6.24.0")
    ],
    targets: [
        .executableTarget(
            name: "Monitor",
            dependencies: [
                .product(name: "GRDB", package: "GRDB.swift")
            ],
            path: "Sources"
        ),
        .testTarget(
            name: "MonitorTests",
            dependencies: ["Monitor"],
            path: "Tests/MonitorTests"
        )
    ]
)

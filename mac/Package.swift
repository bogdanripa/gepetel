// swift-tools-version:5.9
// The Gepetel menu-bar app: a status item that keeps the agent in ../agent
// running, with the Node it needs bundled inside it. SwiftPM rather than an
// Xcode project, so nothing here needs Xcode to build — Command Line Tools on a
// Mac, or a GitHub macOS runner. scripts/build.sh turns the binary into a
// signed .app and a notarized .dmg.
import PackageDescription

let package = Package(
    name: "Gepetel",
    platforms: [.macOS(.v13)],   // SMAppService, for launch at login
    targets: [
        .executableTarget(
            name: "Gepetel",
            path: "Sources/Gepetel",
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("ServiceManagement"),
                .linkedFramework("IOKit"),
            ]
        ),
    ]
)

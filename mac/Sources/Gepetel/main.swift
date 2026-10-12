import AppKit

// `Gepetel --self-check`: the updater's trust decisions, without a menu bar.
// CI runs it on the signed app, so a build whose signature the updater could
// not read — and which would therefore never update — fails there, not on
// people's Macs months later.
if CommandLine.arguments.contains("--self-check") {
    var failed = 0
    func expect(_ ok: Bool, _ what: String) {
        print(ok ? "  ok   \(what)" : "  FAIL \(what)")
        if !ok { failed += 1 }
    }
    expect(Updater.isNewer("0.4.10", than: "0.4.9"), "0.4.10 is newer than 0.4.9")
    expect(!Updater.isNewer("0.4.9", than: "0.4.10"), "0.4.9 is not newer than 0.4.10")
    expect(!Updater.isNewer("0.4.0", than: "0.4"), "0.4.0 is the same as 0.4")
    expect(Updater.isNewer("1.0", than: "0.9.9"), "1.0 is newer than 0.9.9")
    expect(!Updater.isNewer("0.5.0-beta", than: "0.4.0"), "an unparsable version is never newer")
    expect(!Updater.isNewer("", than: "0.4.0"), "an empty version is never newer")
    let team = Updater.teamID(of: Bundle.main.bundleURL)
    print("  team \(team ?? "none — this build will not update itself")")
    if CommandLine.arguments.contains("--require-team") { expect(team != nil, "signed with a Developer ID team") }
    exit(failed == 0 ? 0 : 1)
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
// A menu-bar app: no Dock icon, no main window (LSUIElement says the same in
// Info.plist; this covers running the bare binary from a checkout).
app.setActivationPolicy(.accessory)
app.run()

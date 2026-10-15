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
    let tok = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcd"
    expect(ChromeSetup.token(fromPasted: "PLAYWRIGHT_MCP_EXTENSION_TOKEN=\(tok)") == tok, "the copied line is read as its token")
    expect(ChromeSetup.token(fromPasted: "  \(tok)\n") == tok, "a bare token, with whitespace, is read too")
    expect(ChromeSetup.token(fromPasted: "123456") == nil, "a pairing code is not a Chrome token")
    expect(ChromeSetup.token(fromPasted: "rm -rf / ; \(tok)") == nil, "anything with spaces or punctuation is refused")
    if CommandLine.arguments.contains("--keychain") {
        expect(Keychain.roundTrip(), "the Keychain stores, updates and deletes an item")
    }
    let team = Updater.teamID(of: Bundle.main.bundleURL)
    print("  team \(team ?? "none — this build will not update itself")")
    if CommandLine.arguments.contains("--require-team") { expect(team != nil, "signed with a Developer ID team") }
    exit(failed == 0 ? 0 : 1)
}

// `Gepetel --render-svg in.svg out.png`: the agent's `send_file` turns an
// SVG into a picture WhatsApp can show. macOS renders SVG itself (NSImage), at
// a size readable on a phone (long side 1200–2400 px), on white. The agent runs this inside the same
// Seatbelt sandbox as any command, so the SVG is parsed by a process that
// cannot read the person's files. (Quick Look's qlmanage was tried first: it
// forces a square and crops.)
if CommandLine.arguments.count == 4, CommandLine.arguments[1] == "--render-svg" {
    let input = CommandLine.arguments[2], output = CommandLine.arguments[3]
    guard let img = NSImage(contentsOfFile: input), img.size.width > 0, img.size.height > 0 else {
        FileHandle.standardError.write(Data("not an SVG this Mac can draw\n".utf8)); exit(1)
    }
    // Big enough to read on a phone, small enough to send: the long side
    // lands between 1200 and 2400 pixels.
    let long = max(img.size.width, img.size.height)
    let scale = min(4, max(1, 1200 / long, min(2, 2400 / long)))
    let w = Int(img.size.width * scale), h = Int(img.size.height * scale)
    guard w <= 8000, h <= 8000,
          let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: w, pixelsHigh: h, bitsPerSample: 8,
                                     samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                     colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else {
        FileHandle.standardError.write(Data("the drawing is too large\n".utf8)); exit(1)
    }
    rep.size = img.size
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    // White, not transparent: WhatsApp shows transparency as black.
    NSColor.white.setFill()
    NSRect(origin: .zero, size: img.size).fill()
    img.draw(in: NSRect(origin: .zero, size: img.size))
    NSGraphicsContext.current = nil
    guard let png = rep.representation(using: .png, properties: [:]),
          (try? png.write(to: URL(fileURLWithPath: output))) != nil else {
        FileHandle.standardError.write(Data("could not write the picture\n".utf8)); exit(1)
    }
    exit(0)
}

// Writing to a dead agent's stdin raises SIGPIPE, which ends the app by
// default: an error from the write instead (Agent.send).
signal(SIGPIPE, SIG_IGN)

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
// A menu-bar app: no Dock icon, no main window (LSUIElement says the same in
// Info.plist; this covers running the bare binary from a checkout).
app.setActivationPolicy(.accessory)
app.run()

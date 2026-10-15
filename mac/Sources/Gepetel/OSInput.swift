// Real input from macOS itself, for Chrome tabs the debugger can't reach.
//
// When another extension's frame is in a tab (iCloud Passwords puts a hidden
// one on every sign-in page), Chrome takes the tab from Gepetel's debugger,
// and the extension can only click from inside the page — a scripted click,
// which isn't a user gesture: "Sign in with Google" did nothing from the
// owner's phone (2026-10-14). Events made here go through the window server
// like a mouse and a keyboard: the actual pointer moves, the page can't tell
// them from a person's, and Google's sign-in window opens.
//
// The owner's Mac sits at home; nobody is using it while this moves the
// pointer. Needs macOS's Accessibility permission for Gepetel (System
// Settings → Privacy & Security → Accessibility), and a Mac that isn't at its
// lock screen.
//
// The agent asks in one line on its stdout — `@input {json}` — and gets the
// answer as one JSON line on its stdin.
import AppKit
import ApplicationServices
import CoreGraphics

enum OSInput {
    static let chromeBundle = "com.google.Chrome"

    /// Whether this Mac can take real input now, and why not.
    static func readiness() -> (ok: Bool, why: String) {
        if !AXIsProcessTrusted() { return (false, "Gepetel isn't allowed to control this Mac (System Settings → Privacy & Security → Accessibility)") }
        if screenLocked() { return (false, "the Mac is at its lock screen") }
        if NSRunningApplication.runningApplications(withBundleIdentifier: chromeBundle).isEmpty { return (false, "Chrome isn't running") }
        return (true, "")
    }

    static func screenLocked() -> Bool {
        guard let d = CGSessionCopyCurrentDictionary() as? [String: Any] else { return false }
        return (d["CGSSessionScreenIsLocked"] as? Bool) == true || (d["CGSSessionScreenIsLocked"] as? Int) == 1
    }

    /// One request from the agent. Runs off the main thread (it sleeps
    /// between steps, as a hand does); answers with ok, or why not.
    static func perform(_ req: [String: Any]) -> [String: Any] {
        let op = req["op"] as? String ?? ""
        if op == "check" {
            let r = readiness()
            return ["ok": r.ok, "why": r.why]
        }
        let r = readiness()
        guard r.ok else { return ["ok": false, "why": r.why] }
        if op == "passkey" { return cancelPasskey() }
        // Nothing held going in or left held coming out: a held ⌘ turns
        // typed letters into shortcuts.
        releaseModifiers()
        defer { releaseModifiers() }
        guard let win = chromeWindow(width: num(req["winW"]), height: num(req["winH"]), url: req["url"] as? String ?? "") else {
            return ["ok": false, "why": "couldn't find Gepetel's Chrome window"]
        }
        bringForward(win.element)
        // The tab too, not just its window (the owner: "the app should bring
        // into focus the tab it's working on"): the address bar must show the
        // tab's address; if not, the tabs are pressed one by one until it
        // does. Never a click on another tab's page.
        if let want = req["url"] as? String, !want.isEmpty, !showTab(in: win.element, url: want) {
            return ["ok": false, "why": "couldn't bring Gepetel's tab to the front"]
        }
        // The page's zoom and where its content starts, from the window's
        // size and the page's own (CSS) size: the window has no side borders
        // on a Mac, and Chrome's toolbars sit above the content.
        let innerW = max(1, num(req["innerW"])), innerH = max(1, num(req["innerH"]))
        // Where the page is on screen: Chrome's web area, as Accessibility
        // reports it — exact, whatever sits above or below it (the debugging
        // bar, a popup's own frame). Taps were off vertically on the owner's
        // phone (2026-10-14) with the window's frame minus the page's height.
        let area = webArea(in: win.element) ?? {
            let z = win.frame.width / innerW
            return CGRect(x: win.frame.minX, y: win.frame.maxY - innerH * z, width: innerW * z, height: innerH * z)
        }()
        let zoom = area.width / innerW
        func screen(_ x: Double, _ y: Double) -> CGPoint {
            CGPoint(x: area.minX + x * zoom, y: area.minY + y * zoom)
        }
        let geo = String(format: "window %.0f,%.0f %.0fx%.0f; page area %.0f,%.0f %.0fx%.0f; page %.0fx%.0f; zoom %.3f",
                         win.frame.minX, win.frame.minY, win.frame.width, win.frame.height,
                         area.minX, area.minY, area.width, area.height, innerW, innerH, zoom)
        switch op {
        case "tap":
            let p = screen(num(req["x"]), num(req["y"]))
            travel(to: p)
            pause(0.08, 0.2)
            click(at: p)
            return ["ok": true, "why": "", "geo": geo + String(format: "; at %.0f,%.0f", p.x, p.y)]
        case "text":
            // All or nothing: a password cut short would be typed wrong.
            guard type(req["text"] as? String ?? "") else { return ["ok": false, "why": "too long to type (over \(maxTyped) characters); nothing was typed"] }
        case "key":
            // "Meta+A": with ⌘ held, as a person clears a field (⌘A, then
            // Delete) — the owner's way, 2026-10-14.
            var name = req["key"] as? String ?? "", flags: CGEventFlags = []
            while let plus = name.firstIndex(of: "+"), plus != name.index(before: name.endIndex) {
                switch name[..<plus].lowercased() {
                case "meta", "cmd": flags.insert(.maskCommand)
                case "shift": flags.insert(.maskShift)
                case "alt", "option": flags.insert(.maskAlternate)
                case "control", "ctrl": flags.insert(.maskControl)
                default: return ["ok": false, "why": "no such key"]
                }
                name = String(name[name.index(after: plus)...])
            }
            guard let code = keyCodes[name] ?? letterCodes[name.lowercased()] else { return ["ok": false, "why": "no such key"] }
            press(code, flags: flags)
        case "scroll":
            let p = screen(innerW / 2, innerH / 2)
            travel(to: p)
            scroll(dy: num(req["dy"]) * zoom)
        case "drag":
            let pts = (req["points"] as? [[Double]] ?? []).filter { $0.count >= 2 }
            guard pts.count >= 2 else { return ["ok": false, "why": "a drag needs a path"] }
            drag(pts.map { (screen($0[0], $0[1]), $0.count > 2 ? $0[2] : 0) })
        default:
            return ["ok": false, "why": "unknown op \(op)"]
        }
        return ["ok": true, "why": "", "geo": geo]
    }

    static func num(_ v: Any?) -> Double {
        if let d = v as? Double { return d }
        if let i = v as? Int { return Double(i) }
        if let n = v as? NSNumber { return n.doubleValue }
        return 0
    }
}

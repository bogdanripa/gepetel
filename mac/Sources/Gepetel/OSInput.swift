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
            type(req["text"] as? String ?? "")
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

    // MARK: - Chrome's window

    struct Window { let element: AXUIElement; let frame: CGRect }

    /// Gepetel's window among Chrome's: the one whose tab strip shows
    /// Gepetel's tab group ("Playwright · Gepetel"). A maximized window of the
    /// person's has the same size, so size alone decides only when exactly
    /// one window has it. Never a guess between windows: a click in the
    /// person's own window would be a click on their behalf.
    static func chromeWindow(width: Double, height: Double, url: String = "") -> Window? {
        guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: chromeBundle).first else { return nil }
        let ax = AXUIElementCreateApplication(app.processIdentifier)
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(ax, kAXWindowsAttribute as CFString, &value) == .success,
              let windows = value as? [AXUIElement] else { return nil }
        let framed = windows.compactMap { w in frame(of: w).map { Window(element: w, frame: $0) } }
        // A window showing exactly this page in its address bar: a popup —
        // Google's sign-in from booking.com's — has no tab strip to carry
        // the group's label, but it is the only window on its page.
        // Only a window with no tab strip: the person's own window may show
        // the same page, and the job's clicks come here too (every one of
        // them, since 0.13.5) — a labelled window showing it comes first.
        if !url.isEmpty {
            let showing = framed.filter { w in addressBar(w.element).map { samePage($0, url) } ?? false }
            let mine = showing.filter { shows($0.element, "Gepetel") }
            if mine.count == 1 { return mine[0] }
            let popups = showing.filter { tabs($0.element).isEmpty }
            if popups.count == 1 { return popups[0] }
        }
        let labelled = framed.filter { shows($0.element, "Gepetel") }
        let sized = { (ws: [Window]) in ws.filter { abs($0.frame.width - width) <= 2 && abs($0.frame.height - height) <= 2 } }
        if labelled.count == 1 { return labelled[0] }
        if labelled.count > 1 { return sized(labelled).count == 1 ? sized(labelled)[0] : nil }
        return sized(framed).count == 1 ? sized(framed)[0] : nil
    }

    /// Whether something in this window (its tab strip) is titled with this.
    static func shows(_ e: AXUIElement, _ text: String, depth: Int = 0, budget: inout Int) -> Bool {
        if depth > 12 || budget <= 0 { return false }
        budget -= 1
        for attr in [kAXTitleAttribute, kAXDescriptionAttribute] {
            var v: CFTypeRef?
            if AXUIElementCopyAttributeValue(e, attr as CFString, &v) == .success, let s = v as? String,
               s.localizedCaseInsensitiveContains(text) { return true }
        }
        var c: CFTypeRef?
        guard AXUIElementCopyAttributeValue(e, kAXChildrenAttribute as CFString, &c) == .success, let kids = c as? [AXUIElement] else { return false }
        for k in kids where shows(k, text, depth: depth + 1, budget: &budget) { return true }
        return false
    }
    static func shows(_ e: AXUIElement, _ text: String) -> Bool { var budget = 3000; return shows(e, text, budget: &budget) }

    static func frame(of w: AXUIElement) -> CGRect? {
        var pos: CFTypeRef?, size: CFTypeRef?
        guard AXUIElementCopyAttributeValue(w, kAXPositionAttribute as CFString, &pos) == .success,
              AXUIElementCopyAttributeValue(w, kAXSizeAttribute as CFString, &size) == .success else { return nil }
        var p = CGPoint.zero, s = CGSize.zero
        AXValueGetValue(pos as! AXValue, .cgPoint, &p)
        AXValueGetValue(size as! AXValue, .cgSize, &s)
        return CGRect(origin: p, size: s)
    }

    /// The page's own rectangle on screen: the largest web area in the window.
    static func webArea(in w: AXUIElement) -> CGRect? {
        var best: CGRect?, budget = 4000
        func walk(_ e: AXUIElement, _ d: Int) {
            if d > 16 || budget <= 0 { return }
            budget -= 1
            if attr(e, kAXRoleAttribute) == "AXWebArea", let f = frame(of: e), f.width > 50, f.height > 50 {
                if best == nil || f.width * f.height > best!.width * best!.height { best = f }
                return   // frames inside it are smaller
            }
            for k in children(e) { walk(k, d + 1) }
        }
        walk(w, 0)
        return best
    }

    // MARK: - The tab

    /// The address bar's text: Chrome shows the visible tab's address there.
    static func addressBar(_ w: AXUIElement) -> String? {
        var budget = 3000
        return findText(w, depth: 0, budget: &budget)
    }
    private static func findText(_ e: AXUIElement, depth: Int, budget: inout Int) -> String? {
        if depth > 14 || budget <= 0 { return nil }
        budget -= 1
        if attr(e, kAXRoleAttribute) == (kAXTextFieldRole as String), let v = attr(e, kAXValueAttribute), v.contains(".") { return v }
        for k in children(e) { if let v = findText(k, depth: depth + 1, budget: &budget) { return v } }
        return nil
    }

    /// The tabs in the window's tab strip (AXRadioButton under the tab group).
    static func tabs(_ w: AXUIElement) -> [AXUIElement] {
        var out: [AXUIElement] = [], budget = 3000
        func walk(_ e: AXUIElement, _ d: Int, inStrip: Bool) {
            if d > 14 || budget <= 0 { return }
            budget -= 1
            let role = attr(e, kAXRoleAttribute) ?? ""
            if inStrip && role == (kAXRadioButtonRole as String) { out.append(e); return }
            for k in children(e) { walk(k, d + 1, inStrip: inStrip || role == (kAXTabGroupRole as String)) }
        }
        walk(w, 0, inStrip: false)
        return out
    }

    /// Same page: host and path, the way the address bar shows them (no
    /// scheme, no "www.", no trailing slash, no query or fragment).
    static func samePage(_ shown: String, _ url: String) -> Bool {
        func norm(_ s: String) -> String {
            var t = s.lowercased()
            for p in ["https://", "http://"] where t.hasPrefix(p) { t.removeFirst(p.count) }
            if t.hasPrefix("www.") { t.removeFirst(4) }
            if let q = t.firstIndex(where: { $0 == "?" || $0 == "#" }) { t = String(t[..<q]) }
            while t.hasSuffix("/") { t.removeLast() }
            return t
        }
        let a = norm(shown), b = norm(url)
        // Exactly: a parent path is another tab's page (the trips list is not
        // a trip).
        return !a.isEmpty && a == b
    }

    static func showTab(in w: AXUIElement, url: String) -> Bool {
        if let shown = addressBar(w), samePage(shown, url) { return true }
        for t in tabs(w).prefix(30) {
            AXUIElementPerformAction(t, kAXPressAction as CFString)
            usleep(250_000)
            if let shown = addressBar(w), samePage(shown, url) { return true }
        }
        return false
    }

    static func attr(_ e: AXUIElement, _ a: String) -> String? {
        var v: CFTypeRef?
        guard AXUIElementCopyAttributeValue(e, a as CFString, &v) == .success else { return nil }
        return v as? String
    }
    static func children(_ e: AXUIElement) -> [AXUIElement] {
        var c: CFTypeRef?
        guard AXUIElementCopyAttributeValue(e, kAXChildrenAttribute as CFString, &c) == .success else { return [] }
        return c as? [AXUIElement] ?? []
    }

    static func bringForward(_ w: AXUIElement) {
        NSRunningApplication.runningApplications(withBundleIdentifier: chromeBundle).first?.activate()
        AXUIElementPerformAction(w, kAXRaiseAction as CFString)
        AXUIElementSetAttributeValue(w, kAXMainAttribute as CFString, kCFBooleanTrue)
        usleep(150_000)
    }

    // MARK: - A hand

    static let source = CGEventSource(stateID: .hidSystemState)

    static func pause(_ lo: Double, _ hi: Double) { usleep(useconds_t(Double.random(in: lo...hi) * 1_000_000)) }

    static func here() -> CGPoint { CGEvent(source: nil)?.location ?? .zero }

    /// To a point the way a hand goes: eased, a slight curve, a tremor.
    static func travel(to p: CGPoint) {
        let from = here(), d = hypot(p.x - from.x, p.y - from.y)
        let n = max(6, Int(Double.random(in: 10...16) + d / 80)), bend = Double.random(in: -0.12...0.12)
        for i in 1...n {
            let t = Double(i) / Double(n)
            let e = t < 0.5 ? 2 * t * t : 1 - pow(-2 * t + 2, 2) / 2, off = sin(t * .pi) * bend
            let jig = i < n ? 1.2 : 0
            let q = CGPoint(x: from.x + (p.x - from.x) * e - (p.y - from.y) * off + Double.random(in: -jig...jig),
                            y: from.y + (p.y - from.y) * e + (p.x - from.x) * off + Double.random(in: -jig...jig))
            CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: q, mouseButton: .left)?.post(tap: .cghidEventTap)
            pause(0.006, 0.018)
        }
    }

    static func click(at p: CGPoint) {
        CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
        pause(0.05, 0.12)
        CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
    }

    static func drag(_ pts: [(CGPoint, Double)]) {
        travel(to: pts[0].0)
        CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: pts[0].0, mouseButton: .left)?.post(tap: .cghidEventTap)
        var last = pts[0].1
        for (p, t) in pts.dropFirst() {
            usleep(useconds_t(min(200, max(0, t - last)) * 1000)); last = t
            CGEvent(mouseEventSource: source, mouseType: .leftMouseDragged, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
        }
        CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: pts[pts.count - 1].0, mouseButton: .left)?.post(tap: .cghidEventTap)
    }

    static func scroll(dy: Double) {
        // Pixels, down positive as on the phone; macOS's wheel is the other way.
        CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 1, wheel1: Int32(-dy), wheel2: 0, wheel3: 0)?.post(tap: .cghidEventTap)
    }

    /// Text as keystrokes, a character at a time, at a person's uneven pace.
    static func type(_ text: String) {
        for ch in text.prefix(2000) {
            let units = Array(String(ch).utf16)
            for down in [true, false] {
                let e = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down)
                e?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
                // No modifiers, said outright: the source would otherwise
                // carry whatever macOS thinks is held.
                e?.flags = []
                e?.post(tap: .cghidEventTap)
            }
            pause(0.04, 0.13)
        }
    }

    /// A key, with modifiers held around it as a person holds them: each
    /// modifier pressed and let go as its own key. A ⌘A that only carried
    /// the ⌘ flag left ⌘ held for all of macOS (0.13.5, 2026-10-14): the
    /// letters typed next became shortcuts — ⌘N, ⌘P — in Chrome.
    static func press(_ code: CGKeyCode, flags: CGEventFlags = []) {
        let mods = modifierKeys.filter { flags.contains($0.flag) }
        var held: CGEventFlags = []
        for m in mods { held.insert(m.flag); modifier(m.code, down: true, flags: held); pause(0.02, 0.05) }
        let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true)
        let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false)
        down?.flags = held; up?.flags = held
        down?.post(tap: .cghidEventTap)
        pause(0.03, 0.08)
        up?.post(tap: .cghidEventTap)
        for m in mods.reversed() { pause(0.02, 0.05); held.remove(m.flag); modifier(m.code, down: false, flags: held) }
    }

    static let modifierKeys: [(code: CGKeyCode, flag: CGEventFlags)] = [
        (55, .maskCommand), (56, .maskShift), (58, .maskAlternate), (59, .maskControl),
    ]

    private static func modifier(_ code: CGKeyCode, down: Bool, flags: CGEventFlags) {
        let e = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down)
        e?.type = .flagsChanged
        e?.flags = flags
        e?.post(tap: .cghidEventTap)
    }

    /// Every modifier let go, if macOS thinks one is held — after each input,
    /// before typing, and at launch (a ⌘ left held by 0.13.5 clears itself
    /// on update). The Mac is the person's when they're away: no hand on it.
    static func releaseModifiers() {
        let session = CGEventSource.flagsState(.combinedSessionState)
        let hardware = CGEventSource.flagsState(.hidSystemState)
        for m in modifierKeys where session.contains(m.flag) || hardware.contains(m.flag) {
            modifier(m.code, down: false, flags: [])
        }
    }

    /// Letters for shortcuts (⌘A), by their place on a US keyboard.
    static let letterCodes: [String: CGKeyCode] = [
        "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12,
        "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "o": 31, "u": 32, "i": 34, "p": 35, "l": 37, "j": 38,
        "k": 40, "n": 45, "m": 46,
    ]

    static let keyCodes: [String: CGKeyCode] = [
        "Enter": 36, "Tab": 48, "Backspace": 51, "Escape": 53, "Delete": 117,
        "ArrowLeft": 123, "ArrowRight": 124, "ArrowDown": 125, "ArrowUp": 126,
        "PageUp": 116, "PageDown": 121, "Home": 115, "End": 119, " ": 49,
    ]

    static func num(_ v: Any?) -> Double {
        if let d = v as? Double { return d }
        if let i = v as? Int { return Double(i) }
        if let n = v as? NSNumber { return n.doubleValue }
        return 0
    }
}

/// Asking for the Accessibility permission the way the owner asked for it
/// (2026-10-14): say why first, then macOS's own dialog, then check it took.
enum InputPermission {
    private static var timer: Timer?

    /// From the menu, and once after Chrome is connected. `log` gets one line
    /// per outcome.
    static func ask(log: @escaping (String) -> Void = { _ in }) {
        if AXIsProcessTrusted() { return }
        NSApp.activate(ignoringOtherApps: true)
        let why = NSAlert()
        why.messageText = "Let Gepetel use the mouse and keyboard"
        why.informativeText = """
            When you take over a page from your phone — signing in, a check only you can do — some \
            sites only react to a real mouse and keyboard. Gepetel then moves this Mac's pointer and \
            types for you, in Gepetel's Chrome window only, and only while you're doing it from your phone.

            macOS will ask next: turn on Gepetel under Privacy & Security → Accessibility. Gepetel checks \
            that it worked.
            """
        why.addButton(withTitle: "Continue")
        why.addButton(withTitle: "Not Now")
        guard why.runModal() == .alertFirstButtonReturn else { log("app: Accessibility — not now"); return }
        let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(opts)
        log("app: Accessibility — asked macOS")
        // Watch for the switch, up to three minutes.
        timer?.invalidate()
        let started = Date()
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { t in
            if AXIsProcessTrusted() {
                t.invalidate(); timer = nil
                log("app: Accessibility — allowed")
                NSApp.activate(ignoringOtherApps: true)
                let ok = NSAlert()
                ok.messageText = "Done"
                ok.informativeText = "Gepetel can use the mouse and keyboard. Taps and typing from your phone now reach every page like your own."
                ok.runModal()
            } else if Date().timeIntervalSince(started) > 180 {
                t.invalidate(); timer = nil
                log("app: Accessibility — not allowed yet")
                NSApp.activate(ignoringOtherApps: true)
                let later = NSAlert()
                later.messageText = "Not turned on yet"
                later.informativeText = "Everything else works without it. To finish later: Gepetel menu → Let Gepetel Use the Mouse and Keyboard…"
                later.runModal()
            }
        }
    }
}

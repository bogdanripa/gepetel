// A hand for OSInput.swift: the pointer and the keys, at a person's pace,
// through the window server.
import AppKit
import CoreGraphics

extension OSInput {
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
        // Clamped: Int32() of a huge (or not finite) number traps.
        let px = dy.isFinite ? max(-20_000, min(20_000, -dy)) : 0
        CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 1, wheel1: Int32(px), wheel2: 0, wheel3: 0)?.post(tap: .cghidEventTap)
    }

    /// The most typed in one go.
    static let maxTyped = 2000

    /// Text as keystrokes, a character at a time, at a person's uneven pace.
    /// False, and nothing typed, when it's longer than `maxTyped`.
    @discardableResult
    static func type(_ text: String) -> Bool {
        guard text.count <= maxTyped else { return false }
        for ch in text {
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
        return true
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
}

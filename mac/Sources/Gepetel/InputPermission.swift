// The Accessibility permission OSInput.swift needs.
import AppKit
import ApplicationServices

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

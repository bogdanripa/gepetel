// Chrome's own windows over the page — a passkey's, a saved password's —
// that nobody away from the Mac can answer, cancelled through Accessibility
// (OSInput.swift; the AX helpers are in Accessibility.swift).
import AppKit
import ApplicationServices

extension OSInput {
    // MARK: - Passkey windows

    /// Chrome's passkey windows — "Use a saved passkey for google.com", then
    /// macOS's Touch ID sheet — are drawn outside the page: the phone never
    /// sees them, and Touch ID needs a finger on the Mac. The owner was stuck
    /// on one in a sign-in from his phone (2026-10-14). Cancelled here, so
    /// the page offers "Try another way". Only a window that is about a
    /// passkey or Touch ID, and only its Cancel (or Escape).
    static func cancelPasskey() -> [String: Any] {
        if let done = cancelTouchIDForChrome() { return done }
        guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: chromeBundle).first else { return ["ok": false, "why": "Chrome isn't running"] }
        let ax = AXUIElementCreateApplication(app.processIdentifier)
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(ax, kAXWindowsAttribute as CFString, &value) == .success,
              let windows = value as? [AXUIElement] else { return ["ok": false, "why": "no windows"] }
        for w in windows {
            // Its own title, or a sheet on a browser window.
            let candidates = [w] + children(w).filter { attr($0, kAXRoleAttribute) == (kAXSheetRole as String) }
            for c in candidates {
                let title = attr(c, kAXTitleAttribute) ?? ""
                var budget = 400
                let words = (title + " " + texts(c, depth: 0, budget: &budget).joined(separator: " ")).lowercased()
                if let done = savedPasswordChooser(c, window: w, words: words) { return done }
                guard words.contains("passkey") || words.contains("touch id") else { continue }
                // Not a browser window that merely shows a page about passkeys.
                if c == w && addressBar(w) != nil { continue }
                var b2 = 400
                if let cancel = button(in: c, titled: ["cancel", "anulează", "abbrechen", "annuler", "cancelar", "annulla"], depth: 0, budget: &b2) {
                    AXUIElementPerformAction(cancel, kAXPressAction as CFString)
                } else {
                    AXUIElementPerformAction(c, kAXRaiseAction as CFString)
                    usleep(150_000)
                    press(53)   // Escape
                }
                return ["ok": true, "why": "", "found": String(title.prefix(120))]
            }
        }
        return ["ok": true, "why": "", "found": ""]
    }

    /// macOS's own Touch ID sheet for Chrome — "Google Chrome.app is trying to
    /// fill your password on btpay.bancatransilvania.ro" — drawn by the system's
    /// authentication agent, not Chrome, so the look at Chrome's windows never
    /// saw it. Nobody away from the Mac can give a fingerprint; during a job it
    /// is cancelled (the owner, 2026-10-16: "this page should be dismissed
    /// automatically during a task"), and the job types the sign-in itself.
    /// Only a sheet that names Chrome and is about a password or Touch ID —
    /// never another app's, never the Mac's own unlock — and only its Cancel.
    static let authAgents = ["com.apple.LocalAuthentication.UIAgent", "com.apple.LocalAuthenticationRemoteService", "com.apple.coreautha"]
    static func cancelTouchIDForChrome() -> [String: Any]? {
        for id in authAgents {
            for app in NSRunningApplication.runningApplications(withBundleIdentifier: id) {
                let ax = AXUIElementCreateApplication(app.processIdentifier)
                var value: CFTypeRef?
                guard AXUIElementCopyAttributeValue(ax, kAXWindowsAttribute as CFString, &value) == .success,
                      let windows = value as? [AXUIElement] else { continue }
                for w in windows {
                    var budget = 200
                    let words = ((attr(w, kAXTitleAttribute) ?? "") + " " + texts(w, depth: 0, budget: &budget).joined(separator: " ")).lowercased()
                    guard words.contains("google chrome"), words.contains("password") || words.contains("parol") || words.contains("touch id") else { continue }
                    var b2 = 200
                    guard let cancel = button(in: w, titled: ["cancel", "anulează", "abbrechen", "annuler", "cancelar", "annulla"], depth: 0, budget: &b2) else { continue }
                    AXUIElementPerformAction(cancel, kAXPressAction as CFString)
                    return ["ok": true, "why": "", "found": "macOS's Touch ID sheet for Chrome's saved password"]
                }
            }
        }
        return nil
    }

    /// Chrome's own "Sign in to www.facebook.com" window, offering the
    /// passwords in the person's Google Password Manager (seen 2026-10-15):
    /// outside the page, so neither the job nor the phone can see or press
    /// it — and choosing one makes macOS ask for a fingerprint before Chrome
    /// fills it (the owner: "we had the OS's scan your fingerprint window on
    /// top"), which nobody away from the Mac can give. So it's cancelled, as
    /// passkey windows are; the page's own form is then there, and the job
    /// signs in from Gepetel's store or the person's phone form. Nil: not
    /// that window. Never logs or returns an account.
    private static func savedPasswordChooser(_ c: AXUIElement, window w: AXUIElement, words: String) -> [String: Any]? {
        let heads = ["sign in to ", "conectează-te la ", "conecteaza-te la ", "anmelden bei ", "se connecter à "]
        guard let head = heads.first(where: { words.contains($0) }) else { return nil }
        if c == w && addressBar(w) != nil { return nil }   // a page about signing in, not the window
        var b1 = 400, b2 = 400
        guard button(in: c, titled: ["sign in", "conectează-te", "conecteaza-te", "anmelden", "se connecter", "iniciar sesión", "accedi"], depth: 0, budget: &b1) != nil else { return nil }
        let after = words.components(separatedBy: head).dropFirst().first ?? ""
        let site = String(after.split(whereSeparator: { $0 == " " || $0 == "\n" }).first ?? "")
        if let cancel = button(in: c, titled: ["cancel", "anulează", "abbrechen", "annuler", "cancelar", "annulla"], depth: 0, budget: &b2) {
            AXUIElementPerformAction(cancel, kAXPressAction as CFString)
        } else {
            AXUIElementPerformAction(c, kAXRaiseAction as CFString); usleep(150_000); press(53)
        }
        return ["ok": true, "why": "", "found": "cancelled Chrome's saved-password window for \(site.prefix(80)) (it needs a fingerprint on the Mac)"]
    }
}

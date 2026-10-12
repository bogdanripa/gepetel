// Connect Chrome: from "nothing installed" to "Gepetel can browse", with
// the fewest things a person has to do and nothing typed but one paste.
//
//  1. No Chrome → offer the download.
//  2. Open the Playwright Extension's Web Store page; the person adds it and
//     says so.
//  3. Open the extension's status page and ask for the token it shows behind
//     a Copy button.
//  4. Prove it: the agent connects to Chrome through the extension with that
//     token (`gepetel-agent checkchrome`) and the person is told the result.
//
// It does NOT look in Chrome's profile folder for the extension. It did, and
// macOS protects that folder from other apps ("Operation not permitted", even
// for a listing), so it never saw an extension that was installed and kept
// asking for it. Connecting is a better test anyway: it checks the token too.
//
// The extension is Microsoft's (id below). It gives each client its own named
// tab group, so Gepetel's tabs are its own and the person's are left alone.
import AppKit

enum ChromeSetup {
    /// Gepetel for Chrome. Until the Chrome Web Store listing exists, "Get
    /// It" opens the page that says how to add it.
    static let storeURL = URL(string: "https://gepetel.com/computer")!
    /// Is Chrome installed? Asks Launch Services, not Chrome's folder.
    static var chromeApp: URL? { NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.google.Chrome") }

    static func open(_ url: URL) {
        guard let chrome = chromeApp else { NSWorkspace.shared.open(url); return }
        NSWorkspace.shared.open([url], withApplicationAt: chrome, configuration: NSWorkspace.OpenConfiguration())
    }

    /// What the person pasted, as a token — accepting the whole line the
    /// extension copies (`PLAYWRIGHT_MCP_EXTENSION_TOKEN=…`) or the bare value.
    static func token(fromPasted s: String) -> String? {
        var t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        if let eq = t.range(of: "PLAYWRIGHT_MCP_EXTENSION_TOKEN=") { t = String(t[eq.upperBound...]) }
        t = t.trimmingCharacters(in: CharacterSet(charactersIn: "\"' \n\t"))
        let ok = t.count >= 20 && t.count <= 100 && t.unicodeScalars.allSatisfy {
            CharacterSet.alphanumerics.contains($0) || $0 == "-" || $0 == "_"
        }
        return ok ? t : nil
    }
}

extension AppDelegate {
    /// Connect Chrome, with Gepetel's own extension: the app makes the key,
    /// Chrome asks the person once to allow it. Nothing to copy or paste.
    @objc func connectChrome() {
        NSApp.activate(ignoringOtherApps: true)
        guard ChromeSetup.chromeApp != nil else {
            let a = NSAlert()
            a.messageText = "Gepetel uses Google Chrome"
            a.informativeText = "To do things in your browser — where you're logged in — Gepetel needs Chrome. Install it, then choose Connect Chrome… again."
            a.addButton(withTitle: "Download Chrome")
            a.addButton(withTitle: "Cancel")
            if a.runModal() == .alertFirstButtonReturn { NSWorkspace.shared.open(URL(string: "https://www.google.com/chrome/")!) }
            return
        }
        let a = NSAlert()
        a.messageText = "Add Gepetel for Chrome"
        a.informativeText = "It's how Gepetel uses your Chrome — in its own tab group, without touching your other tabs.\n\nAdd it to Chrome, then come back here. Already added? Choose “It's Added”."
        a.addButton(withTitle: "Get It")
        a.addButton(withTitle: "It's Added")
        a.addButton(withTitle: "Cancel")
        switch a.runModal() {
        case .alertFirstButtonReturn:
            ChromeSetup.open(ChromeSetup.storeURL)
            let b = NSAlert()
            b.messageText = "Added it?"
            b.informativeText = "Once Chrome shows it as added, continue."
            b.addButton(withTitle: "Continue")
            b.addButton(withTitle: "Cancel")
            NSApp.activate(ignoringOtherApps: true)
            guard b.runModal() == .alertFirstButtonReturn else { return }
        case .alertSecondButtonReturn:
            break
        default:
            return
        }
        allowInChrome()
    }

    /// Make a key if there isn't one for our extension, then connect for
    /// real: Chrome shows "Allow Gepetel to use this browser?" the first time.
    private func allowInChrome() {
        if !AgentConfig.chromeConnected || (AgentConfig.readFile()["chrome_extension"] as? String) != "gepetel" {
            var bytes = [UInt8](repeating: 0, count: 32)
            guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
                tell("Couldn't set up Chrome", "macOS didn't give us a random key. Try again.")
                return
            }
            let key = Data(bytes).base64EncodedString()
                .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
            do {
                try AgentConfig.set("chrome_token", key)
                try AgentConfig.set("chrome_extension", "gepetel")
            } catch {
                tell("Couldn't save that", error.localizedDescription)
                return
            }
        }
        let a = NSAlert()
        a.messageText = "One click in Chrome"
        a.informativeText = "Chrome will ask “Allow \"Gepetel\" to use this browser?” — click Allow. You have two minutes."
        a.addButton(withTitle: "Continue")
        a.addButton(withTitle: "Cancel")
        guard a.runModal() == .alertFirstButtonReturn else { return }
        checkChromeThenRestart()
    }

    /// Connect to Chrome through the extension for real, then say how it went.
    func checkChromeThenRestart() {
        agentOnce(["checkchrome"]) { [weak self] status, text in
            guard let self else { return }
            // The agent reads its settings when it starts, and offers browsing
            // once it has a key.
            self.agentRestart()
            if status == 0 {
                self.tell("Chrome is connected", "Ask Gepetel to look something up or get something done where you're logged in — your latest bill, a booking. Before anything that pays, books or sends, it asks you.")
            } else {
                let why = text.split(separator: "\n").last.map(String.init) ?? ""
                self.tell("Chrome didn't connect", "\(why)\n\nIs Chrome open, with Gepetel for Chrome added? Then choose Connect Chrome… again and click Allow when Chrome asks.")
            }
        }
    }

    /// Once, after the update that brought browsing, for someone already
    /// paired: offer it, then leave it to the menu.
    func offerChromeOnce() {
        let key = "offeredChrome"
        guard AgentConfig.isPaired, !AgentConfig.chromeConnected, !UserDefaults.standard.bool(forKey: key) else { return }
        UserDefaults.standard.set(true, forKey: key)
        NSApp.activate(ignoringOtherApps: true)
        let a = NSAlert()
        a.messageText = "Gepetel can now use your Chrome"
        a.informativeText = "To look things up where you're logged in — read-only, in its own tab group. It takes a minute to set up."
        a.addButton(withTitle: "Set Up Now")
        a.addButton(withTitle: "Later")
        if a.runModal() == .alertFirstButtonReturn { connectChrome() }
    }
}

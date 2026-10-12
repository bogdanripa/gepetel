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
    static let extensionID = "mmlmfjhmonkocbjadbfplnigmagldckm"
    static let storeURL = URL(string: "https://chromewebstore.google.com/detail/playwright-extension/\(extensionID)")!
    static let statusURL = URL(string: "chrome-extension://\(extensionID)/status.html")!
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
    /// The whole flow, from wherever the person is in it.
    @objc func connectChrome() {
        NSApp.activate(ignoringOtherApps: true)
        guard ChromeSetup.chromeApp != nil else {
            let a = NSAlert()
            a.messageText = "Gepetel uses Google Chrome"
            a.informativeText = "To look things up in your browser — where you're logged in — Gepetel needs Chrome. Install it, then choose Connect Chrome… again."
            a.addButton(withTitle: "Download Chrome")
            a.addButton(withTitle: "Cancel")
            if a.runModal() == .alertFirstButtonReturn { NSWorkspace.shared.open(URL(string: "https://www.google.com/chrome/")!) }
            return
        }
        let a = NSAlert()
        a.messageText = "Add the Playwright Extension to Chrome"
        a.informativeText = "It's how Gepetel uses your Chrome — in its own tab group, without touching your other tabs.\n\nClick “Add to Chrome” on the page that opens, then come back here. Already added it? Choose “It's Added”."
        a.addButton(withTitle: "Open in Chrome")
        a.addButton(withTitle: "It's Added")
        a.addButton(withTitle: "Cancel")
        switch a.runModal() {
        case .alertFirstButtonReturn:
            ChromeSetup.open(ChromeSetup.storeURL)
            let b = NSAlert()
            b.messageText = "Added it?"
            b.informativeText = "Once Chrome shows “Remove from Chrome” on that page, it's in."
            b.addButton(withTitle: "Continue")
            b.addButton(withTitle: "Cancel")
            NSApp.activate(ignoringOtherApps: true)
            if b.runModal() == .alertFirstButtonReturn { askForChromeToken(note: nil) }
        case .alertSecondButtonReturn:
            askForChromeToken(note: nil)
        default:
            return
        }
    }

    private func askForChromeToken(note: String?) {
        ChromeSetup.open(ChromeSetup.statusURL)
        NSApp.activate(ignoringOtherApps: true)
        let a = NSAlert()
        a.messageText = "One last step: paste the key"
        a.informativeText = (note.map { "\($0)\n\n" } ?? "")
            + "A Playwright page has opened in Chrome. Click the copy button next to the token on it, then paste it here (⌘V).\n\n"
            + "If no page opened, click the Playwright icon in Chrome's toolbar."
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24))
        field.placeholderString = "PLAYWRIGHT_MCP_EXTENSION_TOKEN=…"
        a.accessoryView = field
        a.addButton(withTitle: "Connect")
        a.addButton(withTitle: "Cancel")
        a.window.initialFirstResponder = field
        guard a.runModal() == .alertFirstButtonReturn else { return }
        guard let token = ChromeSetup.token(fromPasted: field.stringValue) else {
            askForChromeToken(note: "That doesn't look like the key — paste exactly what the copy button copied.")
            return
        }
        do {
            try AgentConfig.set("chrome_token", token)
        } catch {
            tell("Couldn't save that", error.localizedDescription)
            return
        }
        // Prove it before saying so: connect to Chrome through the extension.
        // (Chrome picks the last profile used that has the extension.)
        checkChromeThenRestart()
    }

    func checkChromeThenRestart() {
        agentOnce(["checkchrome"]) { [weak self] status, text in
            guard let self else { return }
            // The agent reads its settings when it starts, and offers browsing
            // once it has a token.
            self.agentRestart()
            if status == 0 {
                self.tell("Chrome is connected", "Ask Gepetel to look something up or get something done where you're logged in — your latest bill, a booking. Before anything that pays, books or sends, it asks you.")
            } else {
                let why = text.split(separator: "\n").last.map(String.init) ?? ""
                self.tell("Chrome didn't answer", "\(why)\n\nIs Chrome open? Then try Connect Chrome… again — and paste the token from the Playwright page exactly as copied.")
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

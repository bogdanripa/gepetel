// Connect Chrome: from "nothing installed" to "Gepetel can browse", with
// the fewest things a person has to do and nothing typed but one paste.
//
//  1. No Chrome → offer the download.
//  2. No Playwright Extension in any Chrome profile → open its Web Store page,
//     and notice by itself when "Add to Chrome" has been clicked.
//  3. Open the extension's status page and ask for the token it shows behind
//     a Copy button — the one thing this can't read for the person.
//
// The extension is Microsoft's (id below). It gives each client its own named
// tab group, so Gepetel's tabs are its own and the person's are left alone.
import AppKit

enum ChromeSetup {
    static let extensionID = "mmlmfjhmonkocbjadbfplnigmagldckm"
    static let storeURL = URL(string: "https://chromewebstore.google.com/detail/playwright-extension/\(extensionID)")!
    static let statusURL = URL(string: "chrome-extension://\(extensionID)/status.html")!
    static var chromeDir: URL { Paths.home.appendingPathComponent("Library/Application Support/Google/Chrome") }

    static var chromeApp: URL? { NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.google.Chrome") }

    /// The Chrome profile directories ("Default", "Profile 1", …) that have
    /// the extension installed.
    static func profilesWithExtension() -> [String] {
        let fm = FileManager.default
        guard let dirs = try? fm.contentsOfDirectory(atPath: chromeDir.path) else { return [] }
        return dirs.filter { dir in
            fm.fileExists(atPath: chromeDir.appendingPathComponent(dir).appendingPathComponent("Extensions/\(extensionID)").path)
        }.sorted()
    }

    /// The profile the person last used, which is the one Playwright MCP
    /// would pick by itself — said explicitly so a second profile never
    /// silently wins.
    static func lastUsedProfile() -> String? {
        guard let data = try? Data(contentsOf: chromeDir.appendingPathComponent("Local State")),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let profile = obj["profile"] as? [String: Any] else { return nil }
        return profile["last_used"] as? String
    }

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
        if ChromeSetup.profilesWithExtension().isEmpty {
            let a = NSAlert()
            a.messageText = "Add the Playwright Extension to Chrome"
            a.informativeText = "It's how Gepetel uses your Chrome — in its own tab group, without touching your other tabs. Click “Add to Chrome” on the page that opens; Gepetel will notice and carry on."
            a.addButton(withTitle: "Open in Chrome")
            a.addButton(withTitle: "Cancel")
            guard a.runModal() == .alertFirstButtonReturn else { return }
            ChromeSetup.open(ChromeSetup.storeURL)
            waitForExtension()
            return
        }
        askForChromeToken(note: nil)
    }

    /// Poll for the extension for up to ten minutes; carry on the moment it
    /// appears.
    private func waitForExtension() {
        let deadline = Date().addingTimeInterval(600)
        Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] t in
            if !ChromeSetup.profilesWithExtension().isEmpty {
                t.invalidate()
                self?.askForChromeToken(note: nil)
            } else if Date() > deadline {
                t.invalidate()
            }
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
        let profiles = ChromeSetup.profilesWithExtension()
        let last = ChromeSetup.lastUsedProfile()
        let profile = profiles.count == 1 ? profiles[0] : (last.flatMap { profiles.contains($0) ? $0 : nil } ?? profiles.first)
        do {
            try AgentConfig.set("chrome_token", token)
            if let profile { try AgentConfig.set("chrome_profile", profile) }
        } catch {
            tell("Couldn't save that", error.localizedDescription)
            return
        }
        // The agent reads its settings when it starts, and says "browse" once
        // it has a token.
        agentRestart()
        tell("Chrome is connected", "Ask Gepetel to look something up where you're logged in — your latest bill, your notifications. It reads only: it never types, buys or sends.")
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

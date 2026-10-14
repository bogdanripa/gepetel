// The status item and its menu.
//
// Everything a person does with their computer and Gepetel, without a
// terminal: type the code from WhatsApp, see whether it is connected, turn the
// sandbox's internet off, open the one folder Gepetel can touch, disconnect.
import AppKit
import ApplicationServices
import IOKit.pwr_mgt
import ServiceManagement

final class AppDelegate: NSObject, NSApplicationDelegate {
    private let agent = Agent()
    private let updater = Updater()
    private var item: NSStatusItem!
    private let menu = NSMenu()

    private let stateLine = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    /// "Gepetel 0.7.0 — up to date", at the very top: which build this is,
    /// and whether it is the latest, without hunting for it.
    private let versionLine = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    private let detailLine = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    private lazy var connectItem = NSMenuItem(title: "Connect to Gepetel…", action: #selector(connect), keyEquivalent: "")
    private lazy var disconnectItem = NSMenuItem(title: "Disconnect This Mac…", action: #selector(disconnect), keyEquivalent: "")
    private lazy var networkItem = NSMenuItem(title: "Let Commands Use the Internet", action: #selector(toggleNetwork), keyEquivalent: "")
    private lazy var loginItem = NSMenuItem(title: "Open at Login", action: #selector(toggleLogin), keyEquivalent: "")
    private lazy var chromeItem = NSMenuItem(title: "Connect Chrome…", action: #selector(connectChrome), keyEquivalent: "")
    private lazy var stopItem = NSMenuItem(title: "Stop Everything", action: #selector(stopEverything), keyEquivalent: "")
    private lazy var welcomeItem = NSMenuItem(title: "Welcome to Gepetel…", action: #selector(showWelcome), keyEquivalent: "")
    /// The three steps of setting up, with why (Welcome.swift).
    private lazy var welcome = WelcomeWindow(steps: [
        .init(title: "Connect this Mac to your chat",
              why: "In your private WhatsApp chat with me, say “connect my computer”, then type the six-digit code I send.",
              button: "Enter Code…", done: { AgentConfig.isPaired }, ready: { true },
              action: { [weak self] in self?.connect() }),
        .init(title: "Connect Chrome",
              why: "I work in my own Chrome window and tab group; your tabs stay yours. Chrome asks you once to allow me.",
              button: "Connect Chrome…", done: { AgentConfig.isPaired && AgentConfig.chromeConnected }, ready: { AgentConfig.isPaired },
              action: { [weak self] in self?.connectChrome() }),
        .init(title: "Let me use the mouse and keyboard",
              why: "So I click and type the way a person does — the pointer really moves, in my own Chrome window only — and your taps from the phone work on every site. macOS asks you to switch it on once.",
              button: "Allow…", done: { AXIsProcessTrusted() }, ready: { AgentConfig.isPaired },
              action: { [weak self] in InputPermission.ask(log: { self?.agent.note($0) }) }),
    ])
    /// Real input (OSInput): macOS asks the person once, in its own dialog.
    private lazy var inputItem = NSMenuItem(title: "Let Gepetel Use the Mouse and Keyboard…", action: #selector(allowInput), keyEquivalent: "")

    /// Held while a job runs, so the Mac does not idle-sleep halfway through.
    private var awake: IOPMAssertionID = 0

    private var version: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev"
    }

    func applicationDidFinishLaunching(_ note: Notification) {
        installEditMenu()
        if offerToMoveToApplications() { return }
        // A ⌘ left held by 0.13.5's ⌘A (OSInput.press) goes on update.
        if AXIsProcessTrusted() { OSInput.releaseModifiers() }

        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        item.menu = menu
        buildMenu()

        agent.onChange = { [weak self] s in self?.render(s) }
        render(agent.state)

        // Tokens from before the Keychain, out of the file and into it.
        let moved = Keychain.migrateFromFile()
        if !moved.isEmpty { agent.note("app: moved \(moved.joined(separator: ", ")) into the Keychain") }
        firstRun()
        updater.isBusy = { [weak self] in if case .busy = self?.agent.state { return true }; return false }
        updater.log = { [weak self] line in self?.agent.note(line) }
        updater.onStatus = { [weak self] in self?.renderVersion() }
        renderVersion()
        updater.start()
        // A token left in the Keychain with no settings beside it (the app
        // deleted with its folder, then installed again) isn't a pairing: the
        // agent had no server and crashed every 30 s, and the menu said
        // "connected". Cleared, so setup starts over.
        if Keychain.get("device_token") != nil && !AgentConfig.hasServer {
            Keychain.delete("device_token"); Keychain.delete("chrome_token")
            agent.note("app: tokens without settings — cleared; not paired")
        }
        if AgentConfig.isPaired { agent.start() }
        // Setup not finished: the welcome window, which walks through it —
        // this is the moment someone who just installed the app expects it.
        // "Later" holds once paired: each step then comes up in context.
        if !welcome.allDone && (!AgentConfig.isPaired || !WelcomeWindow.later) { DispatchQueue.main.async { self.welcome.show() } }
        else if AgentConfig.isPaired { DispatchQueue.main.asyncAfter(deadline: .now() + 3) { self.offerChromeOnce() } }
    }

    func applicationWillTerminate(_ note: Notification) {
        agent.stopNow()
    }

    // MARK: - Menu

    private func buildMenu() {
        stateLine.isEnabled = false
        detailLine.isEnabled = false
        versionLine.isEnabled = false
        menu.addItem(versionLine)
        menu.addItem(.separator())
        for i in [connectItem, disconnectItem, networkItem, loginItem, chromeItem, stopItem, inputItem, welcomeItem] { i.target = self }
        menu.addItem(stateLine)
        menu.addItem(detailLine)
        menu.addItem(stopItem)
        menu.addItem(.separator())
        menu.addItem(connectItem)
        menu.addItem(disconnectItem)
        menu.addItem(.separator())
        menu.addItem(chromeItem)
        menu.addItem(inputItem)
        menu.addItem(networkItem)
        menu.addItem(withTitle: "Open Workspace Folder", action: #selector(openWorkspace), keyEquivalent: "").target = self
        menu.addItem(withTitle: "Check the Sandbox…", action: #selector(selftest), keyEquivalent: "").target = self
        menu.addItem(.separator())
        menu.addItem(welcomeItem)
        menu.addItem(loginItem)
        menu.addItem(withTitle: "Show Log", action: #selector(showLog), keyEquivalent: "").target = self
        menu.addItem(withTitle: "Quit Gepetel", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    }

    private func render(_ s: AgentState) {
        let paired = AgentConfig.isPaired
        var title: String, detail = "", icon: NSImage
        switch s {
        case .stopped:
            title = paired ? "Not running" : "Not connected to Gepetel"
            icon = Glyph.image(faint: true, mark: .ring)
        case .connecting:
            title = "Connecting…"; icon = Glyph.image(faint: true)
        case .online:
            title = "Connected — Gepetel can use this Mac"; icon = Glyph.image()
            detail = "Only from your private chat"
        case .busy(let what):
            title = "Working on something for you"; icon = Glyph.image(mark: .dot)
            detail = what == "shell" ? "Running a command" : what == "fetch_url" ? "Reading a page" : what == "browse" ? "Using Chrome" : ""
        case .offline(let why):
            title = "Can't reach Gepetel — retrying"; icon = Glyph.image(faint: true, mark: .ring)
            detail = why
        case .unpaired:
            title = "Not connected to Gepetel"; icon = Glyph.image(faint: true, mark: .ring)
            detail = "Connect with a code from your chat"
        case .broken(let why):
            title = "Something is wrong with the app"; icon = Glyph.image(faint: true, mark: .ring)
            detail = why
        }
        if case .busy = s { holdAwake(true); stopItem.isHidden = false } else { holdAwake(false); stopItem.isHidden = true }

        stateLine.title = title
        detailLine.title = detail
        detailLine.isHidden = detail.isEmpty
        let needsCode: Bool = { if case .unpaired = s { return true }; return !paired }()
        connectItem.isHidden = !needsCode
        disconnectItem.isHidden = needsCode
        networkItem.isHidden = needsCode
        chromeItem.isHidden = needsCode
        chromeItem.title = AgentConfig.chromeConnected ? "Chrome Connected — Reconnect…" : "Connect Chrome…"
        // Checked when allowed; a click then does nothing new.
        inputItem.isHidden = needsCode
        inputItem.state = AXIsProcessTrusted() ? .on : .off
        networkItem.state = AgentConfig.networkOn ? .on : .off
        loginItem.state = SMAppService.mainApp.status == .enabled ? .on : .off

        icon.accessibilityDescription = title
        let img = icon
        item.button?.image = img
        item.button?.toolTip = "Gepetel — \(title)"
    }

    private func renderVersion() {
        let bold = NSAttributedString(string: "Gepetel \(version)", attributes: [.font: NSFont.menuFont(ofSize: 0).bold])
        let line = NSMutableAttributedString(attributedString: bold)
        line.append(NSAttributedString(string: "  —  \(updater.status)", attributes: [.font: NSFont.menuFont(ofSize: 0), .foregroundColor: NSColor.secondaryLabelColor]))
        versionLine.attributedTitle = line
    }

    // MARK: - Pairing

    @objc private func connect() {
        askForCode(note: nil)
    }

    private func askForCode(note: String?) {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = "Connect this Mac to Gepetel"
        alert.informativeText = (note.map { "\($0)\n\n" } ?? "")
            + "In your private WhatsApp chat with Gepetel, say “connect my computer”. "
            + "Type the six-digit code it sends you:"
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 220, height: 28))
        field.placeholderString = "123456"
        field.font = .monospacedDigitSystemFont(ofSize: 18, weight: .regular)
        field.alignment = .center
        alert.accessoryView = field
        alert.addButton(withTitle: "Connect")
        alert.addButton(withTitle: "Cancel")
        alert.window.initialFirstResponder = field
        guard alert.runModal() == .alertFirstButtonReturn else { return }

        let code = field.stringValue.filter(\.isNumber)
        guard code.count == 6 else {
            askForCode(note: "That isn't six digits.")
            return
        }
        stateLine.title = "Connecting…"
        agent.stop { [weak self] in
            self?.agent.once(["pair", code]) { status, raw in
                guard let self else { return }
                // The new device token comes up as one "@secret" line: into
                // the Keychain, and out of the text before anything shows it.
                var text = raw
                if let line = raw.split(separator: "\n").first(where: { $0.hasPrefix("@secret ") }),
                   let obj = try? JSONSerialization.jsonObject(with: Data(line.dropFirst(8).utf8)) as? [String: String],
                   let token = obj["device_token"] {
                    Keychain.set("device_token", token)
                    text = raw.split(separator: "\n").filter { !$0.hasPrefix("@secret ") }.joined(separator: "\n")
                }
                if status == 0 {
                    self.agent.start()
                    self.tell("Connected", "Gepetel will confirm in your WhatsApp chat. Ask it “is my computer on?” any time.")
                    self.offerChromeOnce()
                } else {
                    self.render(self.agent.state)
                    // The agent's own last line is written for this.
                    let why = text.split(separator: "\n").last.map(String.init) ?? "Pairing failed."
                    self.askForCode(note: "\(why) Codes last ten minutes and work once — ask Gepetel for a new one if it expired.")
                }
            }
        }
    }

    @objc private func disconnect() {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = "Disconnect this Mac?"
        alert.informativeText = "Gepetel will no longer be able to use it, and this Mac's key stops working. You can connect again with a new code."
        alert.addButton(withTitle: "Disconnect")
        alert.addButton(withTitle: "Cancel")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        agent.stop { [weak self] in
            self?.agent.once(["unpair"]) { _, text in
                guard let self else { return }
                // Revoked on the server (or told how to): this Mac forgets it too.
                Keychain.delete("device_token")
                self.render(.unpaired(""))
                self.tell("Disconnected", text.split(separator: "\n").last.map(String.init) ?? "")
            }
        }
    }

    // MARK: - Settings

    @objc private func toggleNetwork() {
        let on = !AgentConfig.networkOn
        do {
            try AgentConfig.set("shell_network", on)
        } catch {
            tell("Couldn't change that", error.localizedDescription)
            return
        }
        networkItem.state = on ? .on : .off
        // The agent reads its settings when it starts.
        agent.stop { [weak self] in self?.agent.start() }
    }

    @objc private func toggleLogin() {
        do {
            if SMAppService.mainApp.status == .enabled {
                try SMAppService.mainApp.unregister()
            } else {
                try SMAppService.mainApp.register()
            }
        } catch {
            tell("Couldn't change that", "\(error.localizedDescription)\n\nYou can also add Gepetel in System Settings → General → Login Items.")
        }
        loginItem.state = SMAppService.mainApp.status == .enabled ? .on : .off
    }

    /// Open at login unless the person has said otherwise — a computer that
    /// is only connected while somebody remembers to start an app is not one
    /// Gepetel can count on.
    private func firstRun() {
        let key = "didFirstRun"
        guard !UserDefaults.standard.bool(forKey: key) else { return }
        UserDefaults.standard.set(true, forKey: key)
        try? SMAppService.mainApp.register()
    }

    // MARK: - Folders, log, self-test

    @objc private func openWorkspace() {
        try? FileManager.default.createDirectory(at: Paths.workspace, withIntermediateDirectories: true)
        NSWorkspace.shared.open(Paths.workspace)
    }

    /// Taps and typing from the phone on a sign-in page reach Chrome as a real
    /// mouse and keyboard (OSInput): macOS's Accessibility permission. Its own
    /// dialog takes the person to the switch in System Settings.
    @objc private func showWelcome() { welcome.show() }

    @objc private func allowInput() {
        InputPermission.ask(log: { [weak self] in self?.agent.note($0) })
    }

    @objc private func stopEverything() {
        agent.stopAllJobs()
    }

    @objc private func showLog() {
        if FileManager.default.fileExists(atPath: Paths.logFile.path) {
            NSWorkspace.shared.open(Paths.logFile)
        } else {
            tell("No log yet", "The agent has not run on this Mac yet.")
        }
    }

    @objc private func selftest() {
        stateLine.title = "Checking the sandbox…"
        agent.once(["selftest"]) { [weak self] status, text in
            guard let self else { return }
            self.render(self.agent.state)
            NSApp.activate(ignoringOtherApps: true)
            let alert = NSAlert()
            alert.messageText = status == 0 ? "The sandbox is a sandbox" : "Something in the sandbox check failed"
            alert.informativeText = "Each line is a real command, run on this Mac just now."
            let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 560, height: 260))
            scroll.hasVerticalScroller = true
            let view = NSTextView(frame: scroll.bounds)
            view.isEditable = false
            view.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
            view.string = text
            view.autoresizingMask = [.width]
            scroll.documentView = view
            alert.accessoryView = scroll
            alert.runModal()
        }
    }

    // MARK: - Helpers

    /// ⌘V, ⌘C, ⌘X, ⌘A and ⌘Z in the code box. A menu-bar app has no menu bar
    /// of its own, so it has no Edit menu, and those shortcuts are menu items
    /// — without this, pasting the code from WhatsApp silently did nothing.
    /// The menu is never shown; only its key equivalents are used.
    private func installEditMenu() {
        let main = NSMenu()
        let editItem = NSMenuItem()
        main.addItem(editItem)
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        NSApp.mainMenu = main
    }

    /// A one-shot agent command, for the other files' flows.
    func agentOnce(_ args: [String], done: @escaping (Int32, String) -> Void) {
        agent.once(args, done: done)
    }

    /// Restart the agent so it re-reads its settings.
    /// A line from the app into the Mac's log (for ChromeSetup and others).
    func appNote(_ line: String) { agent.note(line) }

    func agentRestart() {
        agent.stop { [weak self] in self?.agent.start() }
    }

    func tell(_ title: String, _ text: String) {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = text
        alert.runModal()
    }

    private func holdAwake(_ on: Bool) {
        if on, awake == 0 {
            IOPMAssertionCreateWithName(kIOPMAssertionTypePreventUserIdleSystemSleep as CFString,
                                        IOPMAssertionLevel(kIOPMAssertionLevelOn),
                                        "Gepetel is running a task" as CFString, &awake)
        } else if !on, awake != 0 {
            IOPMAssertionRelease(awake)
            awake = 0
        }
    }

    /// Run from the disk image, the app vanishes when the image is ejected
    /// and "open at login" points at nothing. Offer the move once, up front.
    private func offerToMoveToApplications() -> Bool {
        let here = Bundle.main.bundleURL
        guard here.path.hasPrefix("/Volumes/") else { return false }
        // A development build must never replace the real app: that is how a
        // Mac once ended up on an unsigned build that could not update itself.
        guard !(Bundle.main.bundleIdentifier ?? "").hasSuffix(".dev") else { return false }
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = "Move Gepetel to Applications?"
        alert.informativeText = "It's running from the disk image, so it would stop working once that is ejected."
        alert.addButton(withTitle: "Move to Applications")
        alert.addButton(withTitle: "Not Now")
        guard alert.runModal() == .alertFirstButtonReturn else { return false }
        let fm = FileManager.default
        for dir in [URL(fileURLWithPath: "/Applications"), fm.homeDirectoryForCurrentUser.appendingPathComponent("Applications")] {
            let dest = dir.appendingPathComponent(here.lastPathComponent)
            do {
                try fm.createDirectory(at: dir, withIntermediateDirectories: true)
                if fm.fileExists(atPath: dest.path) { try fm.removeItem(at: dest) }
                try fm.copyItem(at: here, to: dest)
                let cfg = NSWorkspace.OpenConfiguration()
                cfg.createsNewApplicationInstance = true
                NSWorkspace.shared.openApplication(at: dest, configuration: cfg) { _, _ in
                    DispatchQueue.main.async { NSApp.terminate(nil) }
                }
                return true
            } catch { continue }
        }
        tell("Couldn't move it", "Drag Gepetel from the disk image into your Applications folder, then open it from there.")
        return false
    }
}

private extension NSFont {
    var bold: NSFont { NSFontManager.shared.convert(self, toHaveTrait: .boldFontMask) }
}

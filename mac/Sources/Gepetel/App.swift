// The status item and its menu.
//
// Everything a person does with their computer and Gepetel, without a
// terminal: type the code from WhatsApp, see whether it is connected, turn the
// sandbox's internet off, open the one folder Gepetel can touch, disconnect.
import AppKit
import IOKit.pwr_mgt
import ServiceManagement

final class AppDelegate: NSObject, NSApplicationDelegate {
    private let agent = Agent()
    private let updater = Updater()
    private var item: NSStatusItem!
    private let menu = NSMenu()

    private let stateLine = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    private let detailLine = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    private lazy var connectItem = NSMenuItem(title: "Connect to Gepetel…", action: #selector(connect), keyEquivalent: "")
    private lazy var disconnectItem = NSMenuItem(title: "Disconnect This Mac…", action: #selector(disconnect), keyEquivalent: "")
    private lazy var networkItem = NSMenuItem(title: "Let Commands Use the Internet", action: #selector(toggleNetwork), keyEquivalent: "")
    private lazy var loginItem = NSMenuItem(title: "Open at Login", action: #selector(toggleLogin), keyEquivalent: "")

    /// Held while a job runs, so the Mac does not idle-sleep halfway through.
    private var awake: IOPMAssertionID = 0

    private var version: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev"
    }

    func applicationDidFinishLaunching(_ note: Notification) {
        if offerToMoveToApplications() { return }

        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        item.menu = menu
        buildMenu()

        agent.onChange = { [weak self] s in self?.render(s) }
        render(agent.state)

        firstRun()
        updater.isBusy = { [weak self] in if case .busy = self?.agent.state { return true }; return false }
        updater.log = { [weak self] line in self?.agent.note(line) }
        updater.start()
        if AgentConfig.isPaired {
            agent.start()
        } else {
            // Nothing to do until there is a code, so ask for it now — this
            // is the moment someone who just installed the app expects it.
            DispatchQueue.main.async { self.connect() }
        }
    }

    func applicationWillTerminate(_ note: Notification) {
        agent.stopNow()
    }

    // MARK: - Menu

    private func buildMenu() {
        stateLine.isEnabled = false
        detailLine.isEnabled = false
        for i in [connectItem, disconnectItem, networkItem, loginItem] { i.target = self }
        menu.addItem(stateLine)
        menu.addItem(detailLine)
        menu.addItem(.separator())
        menu.addItem(connectItem)
        menu.addItem(disconnectItem)
        menu.addItem(.separator())
        menu.addItem(networkItem)
        menu.addItem(withTitle: "Open Workspace Folder", action: #selector(openWorkspace), keyEquivalent: "").target = self
        menu.addItem(withTitle: "Check the Sandbox…", action: #selector(selftest), keyEquivalent: "").target = self
        menu.addItem(.separator())
        menu.addItem(loginItem)
        menu.addItem(withTitle: "Show Log", action: #selector(showLog), keyEquivalent: "").target = self
        let about = menu.addItem(withTitle: "Gepetel \(version)", action: nil, keyEquivalent: "")
        about.isEnabled = false
        menu.addItem(withTitle: "Quit Gepetel", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    }

    private func render(_ s: AgentState) {
        let paired = AgentConfig.isPaired
        var title: String, detail = "", symbol: String
        switch s {
        case .stopped:
            title = paired ? "Not running" : "Not connected to Gepetel"
            symbol = "desktopcomputer.trianglebadge.exclamationmark"
        case .connecting:
            title = "Connecting…"; symbol = "desktopcomputer"
        case .online:
            title = "Connected — Gepetel can use this Mac"; symbol = "desktopcomputer"
            detail = "Only from your private chat"
        case .busy(let what):
            title = "Working on something for you"; symbol = "desktopcomputer.and.arrow.down"
            detail = what == "shell" ? "Running a command" : what == "fetch_url" ? "Reading a page" : ""
        case .offline(let why):
            title = "Can't reach Gepetel — retrying"; symbol = "desktopcomputer.trianglebadge.exclamationmark"
            detail = why
        case .unpaired:
            title = "Not connected to Gepetel"; symbol = "desktopcomputer.trianglebadge.exclamationmark"
            detail = "Connect with a code from your chat"
        case .broken(let why):
            title = "Something is wrong with the app"; symbol = "exclamationmark.triangle"
            detail = why
        }
        if case .busy = s { holdAwake(true) } else { holdAwake(false) }

        stateLine.title = title
        detailLine.title = detail
        detailLine.isHidden = detail.isEmpty
        let needsCode: Bool = { if case .unpaired = s { return true }; return !paired }()
        connectItem.isHidden = !needsCode
        disconnectItem.isHidden = needsCode
        networkItem.isHidden = needsCode
        networkItem.state = AgentConfig.networkOn ? .on : .off
        loginItem.state = SMAppService.mainApp.status == .enabled ? .on : .off

        let img = NSImage(systemSymbolName: symbol, accessibilityDescription: title)
            ?? NSImage(systemSymbolName: "desktopcomputer", accessibilityDescription: title)
        img?.isTemplate = true
        item.button?.image = img
        item.button?.toolTip = "Gepetel — \(title)"
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
            self?.agent.once(["pair", code]) { status, text in
                guard let self else { return }
                if status == 0 {
                    self.agent.start()
                    self.tell("Connected", "Gepetel will confirm in your WhatsApp chat. Ask it “is my computer on?” any time.")
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

    private func tell(_ title: String, _ text: String) {
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

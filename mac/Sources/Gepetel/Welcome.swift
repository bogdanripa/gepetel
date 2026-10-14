// The first thing someone sees after installing: what Gepetel does on this
// Mac, and the three steps to set it up — each with why, a button, and a tick
// once it's done (the owner, 2026-10-14: "a welcome screen that guides me on
// what to do, including the accessibility requirements"). It re-reads the
// state every second, so a step done elsewhere — the switch in System
// Settings — ticks here by itself. Reopened from the menu.
import AppKit
import ApplicationServices

final class WelcomeWindow: NSObject, NSWindowDelegate {
    struct Step {
        let title: String
        let why: String
        let button: String
        let done: () -> Bool
        let ready: () -> Bool
        let action: () -> Void
    }

    private var window: NSWindow?
    private var timer: Timer?
    private var rows: [(mark: NSTextField, button: NSButton, step: Step)] = []
    private let footer = NSTextField(wrappingLabelWithString: "")
    private let close = NSButton(title: "Later", target: nil, action: nil)

    /// "Later" pressed: it doesn't open by itself again — each step also
    /// comes up when it's needed (Chrome when browsing is asked for, the
    /// mouse and keyboard right after Chrome). The menu still opens it.
    static var later: Bool {
        get { UserDefaults.standard.bool(forKey: "welcomeLater") }
        set { UserDefaults.standard.set(newValue, forKey: "welcomeLater") }
    }
    private let steps: [Step]

    init(steps: [Step]) { self.steps = steps }

    var allDone: Bool { steps.allSatisfy { $0.done() } }

    func show() {
        if window == nil { build() }
        refresh()
        NSApp.activate(ignoringOtherApps: true)
        window?.center()
        window?.makeKeyAndOrderFront(nil)
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.refresh() }
    }

    func windowWillClose(_ notification: Notification) { timer?.invalidate(); timer = nil }

    private func build() {
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 560, height: 470), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        w.title = "Welcome to Gepetel"
        w.isReleasedWhenClosed = false
        w.delegate = self

        let intro = NSTextField(wrappingLabelWithString: "Gepetel can do things for you on this Mac — in your own Chrome, where you're already signed in — while you're away, from your WhatsApp chat. Anything that pays, books or sends waits for your OK. Three steps to set it up:")
        intro.font = .systemFont(ofSize: 13)

        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 18
        stack.edgeInsets = NSEdgeInsets(top: 22, left: 24, bottom: 22, right: 24)
        stack.addArrangedSubview(intro)

        for (i, s) in steps.enumerated() {
            let mark = NSTextField(labelWithString: "\(i + 1)")
            mark.font = .systemFont(ofSize: 18, weight: .semibold)
            mark.alignment = .center
            mark.widthAnchor.constraint(equalToConstant: 28).isActive = true

            let title = NSTextField(labelWithString: s.title)
            title.font = .systemFont(ofSize: 14, weight: .semibold)
            let why = NSTextField(wrappingLabelWithString: s.why)
            why.font = .systemFont(ofSize: 12)
            why.textColor = .secondaryLabelColor
            why.preferredMaxLayoutWidth = 330
            let text = NSStackView(views: [title, why])
            text.orientation = .vertical
            text.alignment = .leading
            text.spacing = 3

            let button = NSButton(title: s.button, target: self, action: #selector(press(_:)))
            button.tag = i
            button.bezelStyle = .rounded

            let row = NSStackView(views: [mark, text, button])
            row.orientation = .horizontal
            row.alignment = .top
            row.spacing = 12
            stack.addArrangedSubview(row)
            rows.append((mark, button, s))
        }

        footer.font = .systemFont(ofSize: 13, weight: .medium)
        close.target = self
        close.action = #selector(finish)
        close.bezelStyle = .rounded
        close.keyEquivalent = "\r"
        let bottom = NSStackView(views: [footer, close])
        bottom.orientation = .horizontal
        bottom.alignment = .centerY
        bottom.spacing = 16
        stack.addArrangedSubview(bottom)
        w.contentView = stack
        window = w
    }

    @objc private func finish() {
        if !allDone { WelcomeWindow.later = true }
        window?.close()
    }

    @objc private func press(_ sender: NSButton) {
        steps[sender.tag].action()
        refresh()
    }

    private func refresh() {
        for (i, r) in rows.enumerated() {
            let done = r.step.done(), ready = r.step.ready()
            r.mark.stringValue = done ? "✓" : "\(i + 1)"
            r.mark.textColor = done ? .systemGreen : (ready ? .labelColor : .tertiaryLabelColor)
            r.button.isEnabled = ready && !done
            r.button.isHidden = done
        }
        footer.stringValue = allDone
            ? "You're all set. Ask Gepetel something in your chat — your next bill, a booking — and it can use this Mac."
            : "Each step also comes up when it's needed. This list is in the Gepetel menu: Welcome to Gepetel…"
        footer.preferredMaxLayoutWidth = 400
        close.title = allDone ? "Done" : "Later"
    }
}

// The first thing someone sees after installing: what Gepetel does on this
// Mac, and the three steps to set it up — each with why, a button, and a tick
// once it's done (the owner, 2026-10-14: "a welcome screen that guides me on
// what to do, including the accessibility requirements"). It re-reads the
// state every second, so a step done elsewhere — the switch in System
// Settings — ticks here by itself. Reopened from the menu.
//
// Gepetel's portrait on the left, and Gepetel talking (the owner: "make this
// one a bit more fun … adding gepetel's photo on the left"): a line under the
// portrait follows the steps, and the portrait gives a little nod at each tick.
import AppKit
import QuartzCore
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
    private let says = NSTextField(wrappingLabelWithString: "")
    private let portrait = NSImageView()
    private var doneBefore = -1
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
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 780, height: 500), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        w.title = "Welcome to Gepetel"
        w.isReleasedWhenClosed = false
        w.delegate = self

        let hello = NSTextField(labelWithString: "Hi, I'm Gepetel 👋")
        hello.font = .systemFont(ofSize: 22, weight: .bold)
        let intro = NSTextField(wrappingLabelWithString: "I do things for you on this Mac while you're away — in your own Chrome, where you're already signed in. You just ask me in WhatsApp. Anything that pays, books or sends waits for your OK. Three quick things and we're off:")
        intro.font = .systemFont(ofSize: 13)
        intro.preferredMaxLayoutWidth = 500

        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 18
        stack.edgeInsets = NSEdgeInsets(top: 22, left: 8, bottom: 22, right: 24)
        stack.addArrangedSubview(hello)
        stack.setCustomSpacing(8, after: hello)
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
            why.preferredMaxLayoutWidth = 310
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

        footer.font = .systemFont(ofSize: 12)
        footer.textColor = .secondaryLabelColor
        close.target = self
        close.action = #selector(finish)
        close.bezelStyle = .rounded
        close.keyEquivalent = "\r"
        let bottom = NSStackView(views: [footer, close])
        bottom.orientation = .horizontal
        bottom.alignment = .centerY
        bottom.spacing = 16
        stack.addArrangedSubview(bottom)

        // The left side: the portrait (in the app's bundle; a dev build has
        // none and shows only the words), and what Gepetel says right now.
        portrait.image = Bundle.main.url(forResource: "gepetel", withExtension: "png").flatMap { NSImage(contentsOf: $0) }
        portrait.imageScaling = .scaleProportionallyUpOrDown
        portrait.wantsLayer = true
        portrait.layer?.cornerRadius = 14
        portrait.layer?.masksToBounds = true
        portrait.widthAnchor.constraint(equalToConstant: 190).isActive = true
        portrait.heightAnchor.constraint(equalToConstant: 173).isActive = true
        says.font = .systemFont(ofSize: 14, weight: .semibold)
        says.alignment = .center
        says.preferredMaxLayoutWidth = 180
        // A speech bubble: rounded, tinted, as tall as what's said.
        let bubble = NSView()
        bubble.wantsLayer = true
        bubble.layer?.cornerRadius = 12
        bubble.layer?.backgroundColor = NSColor.controlAccentColor.withAlphaComponent(0.13).cgColor
        says.translatesAutoresizingMaskIntoConstraints = false
        bubble.addSubview(says)
        NSLayoutConstraint.activate([
            says.leadingAnchor.constraint(equalTo: bubble.leadingAnchor, constant: 10),
            says.trailingAnchor.constraint(equalTo: bubble.trailingAnchor, constant: -10),
            says.topAnchor.constraint(equalTo: bubble.topAnchor, constant: 10),
            says.bottomAnchor.constraint(equalTo: bubble.bottomAnchor, constant: -10),
        ])
        bubble.setContentHuggingPriority(.required, for: .vertical)
        let rest = NSView()
        rest.setContentHuggingPriority(.defaultLow, for: .vertical)
        let left = NSStackView(views: [portrait, bubble, rest])
        left.orientation = .vertical
        left.alignment = .centerX
        left.spacing = 12
        left.edgeInsets = NSEdgeInsets(top: 26, left: 24, bottom: 22, right: 8)
        bubble.widthAnchor.constraint(equalToConstant: 190).isActive = true
        if portrait.image == nil { portrait.isHidden = true }

        let all = NSStackView(views: [left, stack])
        all.orientation = .horizontal
        all.alignment = .top
        all.spacing = 12
        w.contentView = all
        all.widthAnchor.constraint(equalToConstant: 800).isActive = true
        w.setContentSize(all.fittingSize)
        window = w
    }

    /// What Gepetel says, by how many steps are done.
    private static let lines = ["Let's get you set up!", "Nice one! Two to go.", "One more and I'm all yours.", "We're all set! 🎉 See you in WhatsApp."]

    /// A little nod: a tilt there and back.
    private func nod() {
        guard let layer = portrait.layer, !portrait.isHidden else { return }
        let a = CAKeyframeAnimation(keyPath: "transform.rotation.z")
        a.values = [0, 0.06, -0.05, 0.03, 0]
        a.duration = 0.6
        layer.add(a, forKey: "nod")
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
        let n = rows.filter { $0.step.done() }.count
        says.stringValue = Self.lines[min(n, Self.lines.count - 1)]
        if doneBefore >= 0 && n > doneBefore { nod() }
        doneBefore = n
        footer.stringValue = allDone
            ? "Try me: ask in your chat for your next bill, or a booking."
            : "Each step also comes up when it's needed. This list stays in the Gepetel menu: Welcome to Gepetel…"
        footer.preferredMaxLayoutWidth = 380
        close.title = allDone ? "Done" : "Later"
    }
}

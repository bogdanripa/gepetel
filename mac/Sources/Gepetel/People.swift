// People: the details forms keep asking for — the owner's own, and those of
// the people he does things for. The owner, 2026-10-14: "we store data about
// others as well, so those need to be managed too, like my wife's passport
// info, my son's ID details" (specs/GEP-30.md, Phase 9, "People, too").
//
// On this Mac only, encrypted: people.enc in the agent's folder is one
// AES-GCM sealed box (CryptoKit; a fresh random nonce on every write), its
// 256-bit key in the Keychain beside the device token ("people_key"). Never
// logged, never sent to the relay or the model, never handed to the agent.
//
// Phase 9 (not built): a job will use these without the model ever seeing
// a value — it sees placeholders like ‹Ana's passport number› and the agent
// puts the real value into the page. The agent never reads the Keychain, so
// the values will reach it the way the tokens do: from this app, over its
// stdin pipe (Keychain.secretsLine), only for the job that needs them.
// PeopleStore.load() is the one reader to build that on.
//
// Passwords, card numbers and one-time codes stay out, as the spec says —
// a field labelled like one is refused here.
import AppKit
import CryptoKit

struct Person: Codable {
    var id: String = UUID().uuidString
    var name: String
    /// "me", "wife", "son", "mother" — free text.
    var relation: String
    var fields: [Field] = []

    struct Field: Codable {
        var id: String = UUID().uuidString
        var label: String
        var value: String
        /// Shown as dots until "Show" is pressed.
        var sensitive: Bool
    }
}

enum PeopleStore {
    static var file: URL { SiteFiles.dir.appendingPathComponent("people.enc") }
    static let keyAccount = "people_key"
    /// Bound into the seal: a box made for something else won't open as this.
    private static let aad = Data("gepetel-people-v1".utf8)
    /// The spec's bound: "at most ~50 people".
    static let maxPeople = 50
    static let maxFields = 40

    enum Failure: LocalizedError {
        case noKey, unreadable, keychain
        var errorDescription: String? {
            switch self {
            case .noKey: return "The key to the people file isn't in this Mac's Keychain, so it can't be opened. Nothing was changed. (A development build has its own Keychain items and can't open the release's file.)"
            case .unreadable: return "The people file couldn't be opened — it isn't one this app wrote, or it was damaged. Nothing was changed."
            case .keychain: return "The Keychain didn't accept the key, so nothing was saved."
            }
        }
    }

    private struct Envelope: Codable {
        var version = 1
        var people: [Person]
    }

    /// Everyone, or [] when there's no file yet.
    static func load() throws -> [Person] {
        guard let sealed = try? Data(contentsOf: file) else { return [] }
        guard let key = existingKey() else { throw Failure.noKey }
        do {
            let plain = try AES.GCM.open(try AES.GCM.SealedBox(combined: sealed), using: key, authenticating: aad)
            return try JSONDecoder().decode(Envelope.self, from: plain).people
        } catch { throw Failure.unreadable }
    }

    static func save(_ people: [Person]) throws {
        // A file with no key is someone's data we can't read: never write a
        // new key over it.
        let key: SymmetricKey
        if let k = existingKey() { key = k }
        else if FileManager.default.fileExists(atPath: file.path) { throw Failure.noKey }
        else { key = try newKey() }
        let plain = try JSONEncoder().encode(Envelope(people: people))
        // seal() picks a random 96-bit nonce each call; combined = nonce + ciphertext + tag.
        guard let sealed = try AES.GCM.seal(plain, using: key, authenticating: aad).combined else { throw Failure.unreadable }
        try writeFileAtomically(sealed, to: file)
    }

    /// The agent's requests (Agent.swift, `@people`). A person is matched by
    /// name or relation ("Ana", "wife", "me"), a field by its label, both
    /// without case. Values leave only for "value" — to be typed by the Mac.
    static func answer(_ req: [String: Any]) -> [String: Any] {
        let op = req["op"] as? String ?? ""
        let who = (req["person"] as? String ?? "").trimmingCharacters(in: .whitespaces).lowercased()
        let label = (req["label"] as? String ?? "").trimmingCharacters(in: .whitespaces).lowercased()
        let match = { (p: Person) in p.name.lowercased() == who || p.relation.lowercased() == who || (who == "me" && p.relation.lowercased() == "me") }
        do {
            var people = try load()
            switch op {
            case "list":
                return ["ok": true, "people": people.map { ["name": $0.name, "relation": $0.relation, "labels": $0.fields.map(\.label)] }]
            case "value":
                guard let p = people.first(where: match), let f = p.fields.first(where: { $0.label.lowercased() == label }) else { return ["ok": false, "why": "no such detail"] }
                return ["ok": true, "value": f.value]
            case "set":
                let value = (req["value"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                guard !who.isEmpty, !label.isEmpty, !value.isEmpty else { return ["ok": false, "why": "whose, which detail, and what"] }
                if PeopleTab.isRefused(label) { return ["ok": false, "why": "passwords, card numbers and one-time codes aren't kept here"] }
                let sensitive = PeopleTab.presets.first(where: { $0.label.lowercased() == label })?.sensitive ?? (label.range(of: "passport|id |cnp|number|series", options: .regularExpression) != nil)
                if let i = people.firstIndex(where: match) {
                    if let j = people[i].fields.firstIndex(where: { $0.label.lowercased() == label }) { people[i].fields[j].value = value }
                    else {
                        guard people[i].fields.count < maxFields else { return ["ok": false, "why": "too many details for one person"] }
                        people[i].fields.append(.init(label: req["label"] as? String ?? label, value: value, sensitive: sensitive))
                    }
                } else {
                    guard people.count < maxPeople else { return ["ok": false, "why": "too many people"] }
                    let name = req["person"] as? String ?? who
                    let relation = (req["relation"] as? String) ?? (who == "me" ? "me" : "")
                    people.append(Person(name: name, relation: relation, fields: [.init(label: req["label"] as? String ?? label, value: value, sensitive: sensitive)]))
                }
                try save(people)
                return ["ok": true]
            case "forget":
                guard let i = people.firstIndex(where: match) else { return ["ok": false, "why": "no one by that name"] }
                if label.isEmpty { people.remove(at: i) }
                else {
                    let before = people[i].fields.count
                    people[i].fields.removeAll { $0.label.lowercased() == label }
                    if people[i].fields.count == before { return ["ok": false, "why": "no such detail"] }
                }
                try save(people)
                return ["ok": true]
            default:
                return ["ok": false, "why": "unknown op"]
            }
        } catch {
            return ["ok": false, "why": error.localizedDescription]
        }
    }

    private static func existingKey() -> SymmetricKey? {
        guard let b64 = Keychain.get(keyAccount), let d = Data(base64Encoded: b64), d.count == 32 else { return nil }
        return SymmetricKey(data: d)
    }

    private static func newKey() throws -> SymmetricKey {
        let key = SymmetricKey(size: .bits256)
        let b64 = key.withUnsafeBytes { Data($0).base64EncodedString() }
        // Read back before anything is sealed with it.
        guard Keychain.set(keyAccount, b64), Keychain.get(keyAccount) == b64 else { throw Failure.keychain }
        return key
    }
}

/// The People tab of "Manage Memories…".
final class PeopleTab: NSObject {
    private weak var host: MemoriesWindow?
    private let list = NSStackView()
    private let status = NSTextField(wrappingLabelWithString: "")
    private lazy var addButton = NSButton(title: "Add Person…", target: self, action: #selector(addPerson))
    private var people: [Person] = []
    /// Field ids shown in clear; emptied when the window closes.
    private var revealed = Set<String>()
    /// Couldn't open the file: show why, change nothing.
    private var locked = false

    static let relations = ["me", "wife", "husband", "partner", "son", "daughter", "mother", "father", "sister", "brother", "friend"]
    /// Labels forms ask for, and whether each is hidden by default.
    static let presets: [(label: String, sensitive: Bool)] = [
        ("Date of birth", true), ("Phone", false), ("Email", false),
        ("Home address", false), ("Other address", false),
        ("ID card number", true), ("ID card series", true), ("ID card expiry", false),
        ("Personal numeric code (CNP)", true),
        ("Passport number", true), ("Passport expiry", false), ("Passport issuing country", false),
        ("Nationality", false),
    ]
    private static let refused = try! NSRegularExpression(pattern: "pass ?word|parol|\\bpin\\b|cvv|cvc|card number|credit card|debit card|one[- ]time|\\botp\\b|security code", options: .caseInsensitive)
    /// A label that names a secret (a password, a card, a code): never kept here.
    static func isRefused(_ label: String) -> Bool { refused.firstMatch(in: label, range: NSRange(label.startIndex..., in: label)) != nil }

    init(host: MemoriesWindow) { self.host = host }

    func view() -> NSView {
        guard let host else { return NSView() }
        let intro = host.label("Details forms keep asking for — yours and the people you do things for. Kept only on this Mac, encrypted, the key in your Keychain; never sent to Gepetel's server or the model. Passwords, card numbers and one-time codes don't belong here.", secondary: true)
        addButton.bezelStyle = .rounded
        let bar = NSStackView(views: [addButton, NSView()])
        bar.orientation = .horizontal
        status.font = .systemFont(ofSize: 12)
        status.preferredMaxLayoutWidth = 660
        return host.page([intro, bar, status], list: list)
    }

    func reload() {
        do {
            people = try PeopleStore.load()
            locked = false
            say(people.isEmpty ? "No one yet." : "\(people.count) \(people.count == 1 ? "person" : "people").")
        } catch {
            people = []
            locked = true
            say(error.localizedDescription, error: true)
        }
        render()
    }

    func hideAll() { revealed.removeAll(); render() }

    private func say(_ s: String, error: Bool = false) {
        status.stringValue = s
        status.textColor = error ? .systemRed : .secondaryLabelColor
    }

    /// Saved, or put back as it was on disk.
    private func commit(_ next: [Person]) {
        do {
            try PeopleStore.save(next)
            people = next
            say("Saved. \(people.count) \(people.count == 1 ? "person" : "people").")
        } catch {
            say(error.localizedDescription, error: true)
        }
        render()
    }

    private func render() {
        guard let host else { return }
        addButton.isEnabled = !locked && people.count < PeopleStore.maxPeople
        list.arrangedSubviews.forEach { $0.removeFromSuperview() }
        for p in people {
            let title = host.label(p.relation.isEmpty ? p.name : "\(p.name) — \(p.relation)", size: 14, weight: .semibold)
            let edit = button("Edit…", #selector(editPerson(_:)), p.id)
            let del = button("Delete…", #selector(deletePerson(_:)), p.id)
            // The card's full inner width (640 less its 12 pt margins).
            let head = stack([title, NSView(), stack([edit, del], .horizontal)], .horizontal)
            head.widthAnchor.constraint(equalToConstant: 616).isActive = true
            var views: [NSView] = [head]
            if p.fields.isEmpty { views.append(host.label("No details yet.", size: 11, secondary: true)) }
            for f in p.fields {
                let shown = !f.sensitive || revealed.contains(f.id)
                let value = host.label(shown ? f.value : "••••••••", size: 12)
                // Dots aren't worth copying; a shown value is.
                value.isSelectable = shown
                let text = stack([host.label(f.label, size: 11, secondary: true), value], .vertical, spacing: 1)
                var buttons: [NSView] = []
                if f.sensitive { buttons.append(button(shown ? "Hide" : "Show", #selector(toggleShow(_:)), f.id)) }
                buttons.append(button("Edit…", #selector(editField(_:)), "\(p.id)|\(f.id)"))
                buttons.append(button("Delete…", #selector(deleteField(_:)), "\(p.id)|\(f.id)"))
                views.append(host.row(text, stack(buttons, .horizontal), indent: 18))
            }
            let add = button("Add Detail…", #selector(addField(_:)), p.id)
            add.isEnabled = p.fields.count < PeopleStore.maxFields
            views.append(add)
            list.addArrangedSubview(card(stack(views, .vertical, spacing: 6)))
        }
    }

    // MARK: People

    @objc private func addPerson() {
        askPerson(title: "Add a person", name: "", relation: people.isEmpty ? "me" : "", button: "Add") { name, relation in
            self.commit(self.people + [Person(name: name, relation: relation)])
        }
    }

    @objc private func editPerson(_ sender: NSButton) {
        guard let i = people.firstIndex(where: { $0.id == sender.identifier?.rawValue }) else { return }
        askPerson(title: "Edit person", name: people[i].name, relation: people[i].relation, button: "Save") { name, relation in
            var next = self.people
            next[i].name = name; next[i].relation = relation
            self.commit(next)
        }
    }

    @objc private func deletePerson(_ sender: NSButton) {
        guard let p = people.first(where: { $0.id == sender.identifier?.rawValue }) else { return }
        confirm("Delete \(p.name)?", "Everything kept about \(p.name) — \(p.fields.count) detail\(p.fields.count == 1 ? "" : "s") — is deleted from this Mac. This can't be undone.") {
            self.commit(self.people.filter { $0.id != p.id })
        }
    }

    private func askPerson(title: String, name: String, relation: String, button: String, done: @escaping (String, String) -> Void) {
        guard let window = host?.sheetWindow else { return }
        let a = NSAlert()
        a.messageText = title
        let n = NSTextField(string: name)
        n.placeholderString = "Ana Popescu"
        let r = NSComboBox()
        r.addItems(withObjectValues: Self.relations)
        r.stringValue = relation
        r.placeholderString = "wife, son, mother…"
        for v in [n, r] { v.widthAnchor.constraint(equalToConstant: 320).isActive = true }
        a.accessoryView = form([("Name", n), ("Who they are to you", r)])
        a.addButton(withTitle: button)
        a.addButton(withTitle: "Cancel")
        a.window.initialFirstResponder = n
        a.beginSheetModal(for: window) { resp in
            guard resp == .alertFirstButtonReturn else { return }
            let name = n.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !name.isEmpty else { self.say("A person needs a name — nothing was saved.", error: true); return }
            done(String(name.prefix(120)), String(r.stringValue.trimmingCharacters(in: .whitespacesAndNewlines).prefix(60)))
        }
    }

    // MARK: Details

    @objc private func toggleShow(_ sender: NSButton) {
        guard let id = sender.identifier?.rawValue else { return }
        if revealed.contains(id) { revealed.remove(id) } else { revealed.insert(id) }
        render()
    }

    private func find(_ sender: NSButton) -> (Int, Int)? {
        let parts = (sender.identifier?.rawValue ?? "").split(separator: "|").map(String.init)
        guard parts.count == 2, let i = people.firstIndex(where: { $0.id == parts[0] }),
              let j = people[i].fields.firstIndex(where: { $0.id == parts[1] }) else { return nil }
        return (i, j)
    }

    @objc private func addField(_ sender: NSButton) {
        guard let i = people.firstIndex(where: { $0.id == sender.identifier?.rawValue }) else { return }
        askField(title: "Add a detail for \(people[i].name)", field: nil) { f in
            var next = self.people
            next[i].fields.append(f)
            self.commit(next)
        }
    }

    @objc private func editField(_ sender: NSButton) {
        guard let (i, j) = find(sender) else { return }
        askField(title: "Edit \(people[i].name)'s detail", field: people[i].fields[j]) { f in
            var next = self.people
            next[i].fields[j] = f
            self.commit(next)
        }
    }

    @objc private func deleteField(_ sender: NSButton) {
        guard let (i, j) = find(sender) else { return }
        let p = people[i], f = p.fields[j]
        confirm("Delete \(p.name)'s \(f.label.lowercased())?", "It's deleted from this Mac. This can't be undone.") {
            var next = self.people
            next[i].fields.removeAll { $0.id == f.id }
            self.revealed.remove(f.id)
            self.commit(next)
        }
    }

    /// Label (a preset, or Other… with your own), value, and whether it's hidden.
    private func askField(title: String, field: Person.Field?, done: @escaping (Person.Field) -> Void) {
        guard let window = host?.sheetWindow else { return }
        let picker = PresetPicker(field: field)
        let a = NSAlert()
        a.messageText = title
        a.informativeText = "Kept on this Mac only, encrypted. Gepetel will offer it when a form asks — the value is never shown to the model."
        a.accessoryView = form([("Detail", picker.popup), ("", picker.custom), ("Value", picker.value), ("", picker.sensitive)])
        a.addButton(withTitle: field == nil ? "Add" : "Save")
        a.addButton(withTitle: "Cancel")
        a.window.initialFirstResponder = picker.value
        a.beginSheetModal(for: window) { resp in
            guard resp == .alertFirstButtonReturn else { return }
            let label = picker.label, value = picker.value.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !label.isEmpty, !value.isEmpty else { self.say("A detail needs a name and a value — nothing was saved.", error: true); return }
            if Self.refused.firstMatch(in: label, range: NSRange(label.startIndex..., in: label)) != nil {
                self.say("Passwords, card numbers and one-time codes stay out of Gepetel's memory — nothing was saved.", error: true)
                return
            }
            var f = field ?? Person.Field(label: label, value: value, sensitive: true)
            f.label = String(label.prefix(60)); f.value = String(value.prefix(500)); f.sensitive = picker.sensitive.state == .on
            done(f)
        }
    }

    // MARK: Helpers

    private func confirm(_ title: String, _ text: String, _ yes: @escaping () -> Void) {
        guard let window = host?.sheetWindow else { return }
        let a = NSAlert()
        a.messageText = title
        a.informativeText = text
        a.addButton(withTitle: "Delete")
        a.addButton(withTitle: "Cancel")
        a.buttons.first?.hasDestructiveAction = true
        a.beginSheetModal(for: window) { if $0 == .alertFirstButtonReturn { yes() } }
    }

    private func button(_ title: String, _ action: Selector, _ id: String) -> NSButton {
        let b = NSButton(title: title, target: self, action: action)
        b.bezelStyle = .rounded
        b.controlSize = .small
        b.identifier = NSUserInterfaceItemIdentifier(id)
        return b
    }

    private func stack(_ views: [NSView], _ o: NSUserInterfaceLayoutOrientation, spacing: CGFloat = 6) -> NSStackView {
        let s = NSStackView(views: views)
        s.orientation = o
        s.alignment = o == .vertical ? .leading : .centerY
        s.spacing = spacing
        if o == .horizontal { s.setContentHuggingPriority(.required, for: .horizontal) }
        return s
    }

    private func card(_ content: NSView) -> NSView {
        let c = CardView()
        content.translatesAutoresizingMaskIntoConstraints = false
        c.addSubview(content)
        NSLayoutConstraint.activate([
            content.leadingAnchor.constraint(equalTo: c.leadingAnchor, constant: 12),
            content.trailingAnchor.constraint(equalTo: c.trailingAnchor, constant: -12),
            content.topAnchor.constraint(equalTo: c.topAnchor, constant: 10),
            content.bottomAnchor.constraint(equalTo: c.bottomAnchor, constant: -10),
            c.widthAnchor.constraint(equalToConstant: 640),
        ])
        return c
    }

    private func form(_ rows: [(String, NSView)]) -> NSView {
        var views: [NSView] = []
        for (title, v) in rows {
            if !title.isEmpty {
                let l = NSTextField(labelWithString: title)
                l.font = .systemFont(ofSize: 11)
                l.textColor = .secondaryLabelColor
                views.append(l)
            }
            views.append(v)
        }
        let f = stack(views, .vertical, spacing: 4)
        f.frame = NSRect(origin: .zero, size: f.fittingSize)
        return f
    }
}

/// The detail form's controls: picking a preset sets whether it's hidden;
/// "Other…" turns on the box for your own label (always there, so the sheet keeps its size).
private final class PresetPicker: NSObject {
    let popup = NSPopUpButton()
    let custom = NSTextField()
    let value = NSTextField()
    let sensitive = NSButton(checkboxWithTitle: "Hide it on screen (show with a click)", target: nil, action: nil)
    private static let other = "Other…"

    init(field: Person.Field?) {
        super.init()
        popup.addItems(withTitles: PeopleTab.presets.map(\.label))
        popup.menu?.addItem(.separator())
        popup.addItem(withTitle: Self.other)
        popup.target = self
        popup.action = #selector(picked)
        custom.placeholderString = "e.g. Driving licence number"
        value.placeholderString = "the value"
        for v in [popup, custom, value] as [NSView] { v.widthAnchor.constraint(equalToConstant: 340).isActive = true }
        if let field {
            if PeopleTab.presets.contains(where: { $0.label == field.label }) { popup.selectItem(withTitle: field.label) }
            else { popup.selectItem(withTitle: Self.other); custom.stringValue = field.label }
            value.stringValue = field.value
            sensitive.state = field.sensitive ? .on : .off
            custom.isEnabled = popup.titleOfSelectedItem == Self.other
        } else {
            picked()
        }
    }

    var label: String {
        let t = popup.titleOfSelectedItem ?? ""
        return (t == Self.other ? custom.stringValue : t).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    @objc private func picked() {
        let t = popup.titleOfSelectedItem ?? ""
        custom.isEnabled = t == Self.other
        // Your own label: hidden unless you say otherwise.
        sensitive.state = (PeopleTab.presets.first { $0.label == t }?.sensitive ?? true) ? .on : .off
    }
}

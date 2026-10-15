// People: the details forms keep asking for — the owner's own, and those of
// the people he does things for. The owner, 2026-10-14: "we store data about
// others as well, so those need to be managed too, like my wife's passport
// info, my son's ID details" (specs/GEP-30.md, Phase 9, "People, too").
//
// On this Mac only, encrypted: people.enc in the agent's folder is one
// AES-GCM sealed box (SealedStore.swift), its 256-bit key in the Keychain
// beside the device token ("people_key"). Never logged, never sent to the
// relay or the model.
//
// A job uses them without the model ever seeing a value (Phase 9;
// agent/src/people.ts): the agent asks this app for whose and which over
// `@people` (Agent.swift), and for one value only at the moment it types it
// into the page.
//
// Passwords, card numbers and one-time codes stay out, as the spec says —
// a field labelled like one is refused here.
import AppKit

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
    /// The spec's bound: "at most ~50 people".
    static let maxPeople = 50
    static let maxFields = 40
    /// The UI's bounds (PeopleTab), held to for the agent's "set" too.
    static let maxName = 120, maxRelation = 60, maxLabel = 60, maxValue = 500

    private struct Envelope: Codable {
        var version = 1
        var people: [Person]
    }

    /// JSONEncoder's own date coding, as people.enc was first written.
    private static let store = SealedStore<Envelope>(name: "people.enc", keyAccount: "people_key",
                                                     aad: Data("gepetel-people-v1".utf8), noun: "people", dates: .standard)
    static var file: URL { store.file }

    /// Everyone, or [] when there's no file yet.
    static func load() throws -> [Person] { try store.load()?.people ?? [] }

    static func save(_ people: [Person]) throws { try store.save(Envelope(people: people)) }

    /// The agent's requests (Agent.swift, `@people`). A person is matched by
    /// name or relation ("Ana", "wife", "me"), a field by its label, both
    /// without case. Values leave only for "value" — to be typed by the Mac.
    static func answer(_ req: [String: Any]) -> [String: Any] {
        let op = req["op"] as? String ?? ""
        let who = (req["person"] as? String ?? "").trimmingCharacters(in: .whitespaces).lowercased()
        let label = (req["label"] as? String ?? "").trimmingCharacters(in: .whitespaces).lowercased()
        // No one is "": an empty name would match everyone with no relation.
        let match = { (p: Person) in !who.isEmpty && (p.name.lowercased() == who || p.relation.lowercased() == who || (who == "me" && p.relation.lowercased() == "me")) }
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
                // The UI's bounds: the agent's "set" is no way around them.
                let relationIn = req["relation"] as? String
                guard who.count <= maxName, label.count <= maxLabel, value.count <= maxValue, (relationIn ?? "").count <= maxRelation else { return ["ok": false, "why": "too long"] }
                if PeopleTab.isRefused(label) { return ["ok": false, "why": "passwords, card numbers and one-time codes aren't kept here"] }
                let sensitive = PeopleTab.presets.first(where: { $0.label.lowercased() == label })?.sensitive ?? (label.range(of: "passport|id |cnp|number|series", options: .regularExpression) != nil)
                if let i = people.firstIndex(where: match) {
                    if let j = people[i].fields.firstIndex(where: { $0.label.lowercased() == label }) { people[i].fields[j].value = value }
                    else {
                        guard people[i].fields.count < maxFields else { return ["ok": false, "why": "too many details for one person"] }
                        people[i].fields.append(.init(label: (req["label"] as? String)?.trimmingCharacters(in: .whitespaces) ?? label, value: value, sensitive: sensitive))
                    }
                } else {
                    guard people.count < maxPeople else { return ["ok": false, "why": "too many people"] }
                    let name = (req["person"] as? String)?.trimmingCharacters(in: .whitespaces) ?? who
                    let relation = relationIn ?? (who == "me" ? "me" : "")
                    people.append(Person(name: name, relation: relation, fields: [.init(label: (req["label"] as? String)?.trimmingCharacters(in: .whitespaces) ?? label, value: value, sensitive: sensitive)]))
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

    /// A change, made to the file as it is now — the agent may have kept or
    /// forgotten something while the window was open — by id, then saved.
    /// `change` says false when what it was for is gone.
    private func commit(_ change: (inout [Person]) -> Bool) {
        do {
            var next = try PeopleStore.load()
            if change(&next) {
                try PeopleStore.save(next)
                people = next
                say("Saved. \(people.count) \(people.count == 1 ? "person" : "people").")
            } else {
                people = next
                say("That was changed elsewhere meanwhile — nothing was saved. Here it is as it is now.", error: true)
            }
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
            let edit = host.button("Edit…", self, #selector(editPerson(_:)), id: p.id)
            let del = host.button("Delete…", self, #selector(deletePerson(_:)), id: p.id)
            // The card's full inner width (640 less its 12 pt margins).
            let head = host.stack([title, NSView(), host.stack([edit, del], .horizontal)], .horizontal)
            head.widthAnchor.constraint(equalToConstant: 616).isActive = true
            var views: [NSView] = [head]
            if p.fields.isEmpty { views.append(host.label("No details yet.", size: 11, secondary: true)) }
            for f in p.fields {
                let shown = !f.sensitive || revealed.contains(f.id)
                let value = host.label(shown ? f.value : "••••••••", size: 12)
                // Dots aren't worth copying; a shown value is.
                value.isSelectable = shown
                let text = host.stack([host.label(f.label, size: 11, secondary: true), value], .vertical, spacing: 1)
                var buttons: [NSView] = []
                if f.sensitive { buttons.append(host.button(shown ? "Hide" : "Show", self, #selector(toggleShow(_:)), id: f.id)) }
                buttons.append(host.button("Edit…", self, #selector(editField(_:)), id: "\(p.id)|\(f.id)"))
                buttons.append(host.button("Delete…", self, #selector(deleteField(_:)), id: "\(p.id)|\(f.id)"))
                views.append(host.row(text, host.stack(buttons, .horizontal), indent: 18))
            }
            let add = host.button("Add Detail…", self, #selector(addField(_:)), id: p.id)
            add.isEnabled = p.fields.count < PeopleStore.maxFields
            views.append(add)
            list.addArrangedSubview(host.card(host.stack(views, .vertical, spacing: 6), inset: 10))
        }
    }

    // MARK: People

    @objc private func addPerson() {
        askPerson(title: "Add a person", name: "", relation: people.isEmpty ? "me" : "", button: "Add") { name, relation in
            self.commit { people in
                guard people.count < PeopleStore.maxPeople else { return false }
                people.append(Person(name: name, relation: relation))
                return true
            }
        }
    }

    @objc private func editPerson(_ sender: NSButton) {
        guard let p = people.first(where: { $0.id == sender.identifier?.rawValue }) else { return }
        askPerson(title: "Edit person", name: p.name, relation: p.relation, button: "Save") { name, relation in
            self.commit { people in
                guard let i = people.firstIndex(where: { $0.id == p.id }) else { return false }
                people[i].name = name; people[i].relation = relation
                return true
            }
        }
    }

    @objc private func deletePerson(_ sender: NSButton) {
        guard let p = people.first(where: { $0.id == sender.identifier?.rawValue }) else { return }
        host?.confirm("Delete \(p.name)?", "Everything kept about \(p.name) — \(p.fields.count) detail\(p.fields.count == 1 ? "" : "s") — is deleted from this Mac. This can't be undone.") {
            self.commit { people in
                people.removeAll { $0.id == p.id }
                return true
            }
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
            done(String(name.prefix(PeopleStore.maxName)), String(r.stringValue.trimmingCharacters(in: .whitespacesAndNewlines).prefix(PeopleStore.maxRelation)))
        }
    }

    // MARK: Details

    @objc private func toggleShow(_ sender: NSButton) {
        guard let id = sender.identifier?.rawValue else { return }
        if revealed.contains(id) { revealed.remove(id) } else { revealed.insert(id) }
        render()
    }

    /// The person and the detail a button is for, as shown.
    private func find(_ sender: NSButton) -> (Person, Person.Field)? {
        let parts = (sender.identifier?.rawValue ?? "").split(separator: "|").map(String.init)
        guard parts.count == 2, let p = people.first(where: { $0.id == parts[0] }),
              let f = p.fields.first(where: { $0.id == parts[1] }) else { return nil }
        return (p, f)
    }

    @objc private func addField(_ sender: NSButton) {
        guard let p = people.first(where: { $0.id == sender.identifier?.rawValue }) else { return }
        askField(title: "Add a detail for \(p.name)", field: nil) { f in
            self.commit { people in
                guard let i = people.firstIndex(where: { $0.id == p.id }), people[i].fields.count < PeopleStore.maxFields else { return false }
                people[i].fields.append(f)
                return true
            }
        }
    }

    @objc private func editField(_ sender: NSButton) {
        guard let (p, f) = find(sender) else { return }
        askField(title: "Edit \(p.name)'s detail", field: f) { edited in
            self.commit { people in
                guard let i = people.firstIndex(where: { $0.id == p.id }),
                      let j = people[i].fields.firstIndex(where: { $0.id == f.id }) else { return false }
                people[i].fields[j] = edited
                return true
            }
        }
    }

    @objc private func deleteField(_ sender: NSButton) {
        guard let (p, f) = find(sender) else { return }
        host?.confirm("Delete \(p.name)'s \(f.label.lowercased())?", "It's deleted from this Mac. This can't be undone.") {
            self.revealed.remove(f.id)
            self.commit { people in
                guard let i = people.firstIndex(where: { $0.id == p.id }) else { return true }
                people[i].fields.removeAll { $0.id == f.id }
                return true
            }
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
            f.label = String(label.prefix(PeopleStore.maxLabel)); f.value = String(value.prefix(PeopleStore.maxValue)); f.sensitive = picker.sensitive.state == .on
            done(f)
        }
    }

    // MARK: Helpers

    private func form(_ rows: [(String, NSView)]) -> NSView {
        guard let host else { return NSView() }
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
        let f = host.stack(views, .vertical, spacing: 4)
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

// Passwords: a small password manager of Gepetel's own, on this Mac only.
// The owner, 2026-10-15: "build your own local password manager. something
// very simple".
//
// Kept like people's details (People.swift): passwords.enc in the agent's
// folder is one AES-GCM sealed box, a fresh nonce on every write, its 256-bit
// key in the Keychain ("passwords_key"). Never logged, never sent to the relay
// or the model. The agent asks for one sign-in at the moment it fills a form
// (`@passwords`, Agent.swift) and types it into the page; the model only ever
// learns that a sign-in exists, and for which username.
//
// Kept by host, as the site notes are (SiteFiles.siteKey): a login for
// secure.booking.com is that host's. Asked for on another host of the same
// site, the nearest one serves — the exact host first, then any host with the
// same registrable domain, most recently used first.
import AppKit
import CryptoKit

struct SavedLogin: Codable {
    var id: String = UUID().uuidString
    /// The host, as SiteFiles.siteKey gives it.
    var site: String
    /// Empty when the site only asks for a password.
    var username: String
    var password: String
    var created = Date()
    var changed = Date()
    var used: Date?
}

enum PasswordStore {
    static var file: URL { SiteFiles.dir.appendingPathComponent("passwords.enc") }
    static let keyAccount = "passwords_key"
    /// Bound into the seal: a box made for something else won't open as this.
    private static let aad = Data("gepetel-passwords-v1".utf8)
    static let maxLogins = 300

    enum Failure: LocalizedError {
        case noKey, unreadable, keychain
        var errorDescription: String? {
            switch self {
            case .noKey: return "The key to the passwords file isn't in this Mac's Keychain, so it can't be opened. Nothing was changed. (A development build has its own Keychain items and can't open the release's file.)"
            case .unreadable: return "The passwords file couldn't be opened — it isn't one this app wrote, or it was damaged. Nothing was changed."
            case .keychain: return "The Keychain didn't accept the key, so nothing was saved."
            }
        }
    }

    private struct Envelope: Codable {
        var version = 1
        var logins: [SavedLogin]
    }

    private static var encoder: JSONEncoder { let e = JSONEncoder(); e.dateEncodingStrategy = .iso8601; return e }
    private static var decoder: JSONDecoder { let d = JSONDecoder(); d.dateDecodingStrategy = .iso8601; return d }

    /// Every saved sign-in, or [] when there's no file yet.
    static func load() throws -> [SavedLogin] {
        guard let sealed = try? Data(contentsOf: file) else { return [] }
        guard let key = existingKey() else { throw Failure.noKey }
        do {
            let plain = try AES.GCM.open(try AES.GCM.SealedBox(combined: sealed), using: key, authenticating: aad)
            return try decoder.decode(Envelope.self, from: plain).logins
        } catch { throw Failure.unreadable }
    }

    static func save(_ logins: [SavedLogin]) throws {
        // A file with no key is someone's passwords we can't read: never
        // write a new key over it.
        let key: SymmetricKey
        if let k = existingKey() { key = k }
        else if FileManager.default.fileExists(atPath: file.path) { throw Failure.noKey }
        else { key = try newKey() }
        let plain = try encoder.encode(Envelope(logins: logins))
        guard let sealed = try AES.GCM.seal(plain, using: key, authenticating: aad).combined else { throw Failure.unreadable }
        try writeFileAtomically(sealed, to: file)
    }

    /// The sign-in for a site: the exact host first, then another host of the
    /// same registrable domain; among several, the most recently used. With a
    /// username, only that username's.
    static func match(_ logins: [SavedLogin], site: String, username: String? = nil) -> Int? {
        let key = SiteFiles.siteKey(site)
        guard !key.isEmpty else { return nil }
        let reg = SiteFiles.registrable(key)
        let recent = { (l: SavedLogin) in l.used ?? l.changed }
        let fits = { (l: SavedLogin) in username.map { l.username.lowercased() == $0.lowercased() } ?? true }
        let order = logins.indices.filter { fits(logins[$0]) }.sorted { recent(logins[$0]) > recent(logins[$1]) }
        return order.first { logins[$0].site == key } ?? order.first { SiteFiles.registrable(logins[$0].site) == reg }
    }

    /// The agent's requests (Agent.swift, `@passwords`). The password leaves
    /// only for "get" — to be typed into the page by the agent, never shown
    /// to the model. Its `why`s never carry a site, a username or a password.
    static func answer(_ req: [String: Any]) -> [String: Any] {
        let op = req["op"] as? String ?? ""
        let site = SiteFiles.siteKey(req["site"] as? String ?? "")
        let username = (req["username"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !site.isEmpty else { return ["ok": false, "why": "which site"] }
        // For has/get, an empty username picks no one in particular.
        let pick = username?.isEmpty == false ? username : nil
        do {
            var logins = try load()
            switch op {
            case "has":
                guard let i = match(logins, site: site, username: pick) else { return ["ok": false, "why": "none saved"] }
                return ["ok": true, "site": logins[i].site, "username": logins[i].username]
            case "get":
                guard let i = match(logins, site: site, username: pick) else { return ["ok": false, "why": "none saved"] }
                logins[i].used = Date()
                // Typed all the same if the note of its use can't be saved.
                try? save(logins)
                return ["ok": true, "site": logins[i].site, "username": logins[i].username, "password": logins[i].password]
            case "set":
                let password = req["password"] as? String ?? ""
                guard !password.isEmpty else { return ["ok": false, "why": "no password"] }
                guard password.count <= 1000, (username ?? "").count <= 320, site.count <= 253 else { return ["ok": false, "why": "too long"] }
                let name = username ?? ""
                if let i = logins.firstIndex(where: { $0.site == site && $0.username.lowercased() == name.lowercased() }) {
                    logins[i].username = name; logins[i].password = password; logins[i].changed = Date()
                } else {
                    guard logins.count < maxLogins else { return ["ok": false, "why": "too many saved"] }
                    logins.append(SavedLogin(site: site, username: name, password: password))
                }
                try save(logins)
                return ["ok": true]
            case "forget":
                // The exact host only: forgetting one host's never reaches another's.
                let before = logins.count
                logins.removeAll { l in l.site == site && (username.map { l.username.lowercased() == $0.lowercased() } ?? true) }
                guard logins.count < before else { return ["ok": false, "why": "none saved"] }
                try save(logins)
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

/// The Passwords tab of "Manage Memories…".
final class PasswordsTab: NSObject {
    private weak var host: MemoriesWindow?
    private let list = NSStackView()
    private let status = NSTextField(wrappingLabelWithString: "")
    private lazy var addButton = NSButton(title: "Add…", target: self, action: #selector(addLogin))
    private var logins: [SavedLogin] = []
    /// Ids shown in clear; emptied when the window closes.
    private var revealed = Set<String>()
    /// Couldn't open the file: show why, change nothing.
    private var locked = false

    init(host: MemoriesWindow) { self.host = host }

    func view() -> NSView {
        guard let host else { return NSView() }
        let intro = host.label("Sign-ins Gepetel uses for you in Chrome on this Mac. Kept only here, encrypted; the key is in your Keychain. Jobs fill them in for you — the model never sees them.", secondary: true)
        addButton.bezelStyle = .rounded
        let bar = NSStackView(views: [addButton, NSView()])
        bar.orientation = .horizontal
        status.font = .systemFont(ofSize: 12)
        status.preferredMaxLayoutWidth = 660
        return host.page([intro, bar, status], list: list)
    }

    func reload() {
        do {
            logins = try PasswordStore.load()
            locked = false
            say(logins.isEmpty ? "No sign-ins saved yet." : count)
        } catch {
            logins = []
            locked = true
            say(error.localizedDescription, error: true)
        }
        render()
    }

    func hideAll() { revealed.removeAll(); render() }

    private var count: String { "\(logins.count) sign-in\(logins.count == 1 ? "" : "s")." }

    private func say(_ s: String, error: Bool = false) {
        status.stringValue = s
        status.textColor = error ? .systemRed : .secondaryLabelColor
    }

    /// Saved, or put back as it was on disk.
    private func commit(_ next: [SavedLogin]) {
        do {
            try PasswordStore.save(next)
            logins = next
            say("Saved. \(count)")
        } catch {
            say(error.localizedDescription, error: true)
        }
        render()
    }

    private func render() {
        guard let host else { return }
        addButton.isEnabled = !locked && logins.count < PasswordStore.maxLogins
        list.arrangedSubviews.forEach { $0.removeFromSuperview() }
        for l in logins.sorted(by: { ($0.site, $0.username.lowercased()) < ($1.site, $1.username.lowercased()) }) {
            let shown = revealed.contains(l.id)
            let password = host.label(shown ? l.password : "••••••••", size: 12)
            // Dots aren't worth copying; a shown password is.
            password.isSelectable = shown
            let text = stack([host.label(l.site, size: 13, weight: .semibold),
                              host.label(l.username.isEmpty ? "(no username)" : l.username, size: 12, secondary: l.username.isEmpty),
                              password], .vertical, spacing: 2)
            let buttons = stack([button(shown ? "Hide" : "Show", #selector(toggleShow(_:)), l.id),
                                 button("Edit…", #selector(editLogin(_:)), l.id),
                                 button("Delete…", #selector(deleteLogin(_:)), l.id)], .horizontal)
            list.addArrangedSubview(host.row(text, buttons))
        }
    }

    @objc private func toggleShow(_ sender: NSButton) {
        guard let id = sender.identifier?.rawValue else { return }
        if revealed.contains(id) { revealed.remove(id) } else { revealed.insert(id) }
        render()
    }

    @objc private func addLogin() {
        ask(title: "Add a sign-in", login: nil) { site, user, password in
            var next = self.logins
            // The same site and username again is a new password, not a second entry.
            if let i = next.firstIndex(where: { $0.site == site && $0.username.lowercased() == user.lowercased() }) {
                next[i].username = user; next[i].password = password; next[i].changed = Date()
            } else {
                next.append(SavedLogin(site: site, username: user, password: password))
            }
            self.commit(next)
        }
    }

    @objc private func editLogin(_ sender: NSButton) {
        guard let i = logins.firstIndex(where: { $0.id == sender.identifier?.rawValue }) else { return }
        ask(title: "Edit sign-in", login: logins[i]) { site, user, password in
            var next = self.logins
            next[i].site = site; next[i].username = user; next[i].password = password
            next[i].changed = Date()
            // Edited into another entry's site and username: one is enough.
            let id = next[i].id
            next.removeAll { $0.id != id && $0.site == site && $0.username.lowercased() == user.lowercased() }
            self.commit(next)
        }
    }

    @objc private func deleteLogin(_ sender: NSButton) {
        guard let l = logins.first(where: { $0.id == sender.identifier?.rawValue }), let window = host?.sheetWindow else { return }
        let a = NSAlert()
        a.messageText = "Delete the sign-in for \(l.site)?"
        a.informativeText = "\(l.username.isEmpty ? "The password" : "\(l.username) and its password") will be deleted from this Mac. Jobs on \(l.site) will ask you to sign in again. This can't be undone."
        a.addButton(withTitle: "Delete")
        a.addButton(withTitle: "Cancel")
        a.buttons.first?.hasDestructiveAction = true
        a.beginSheetModal(for: window) { resp in
            guard resp == .alertFirstButtonReturn else { return }
            self.revealed.remove(l.id)
            self.commit(self.logins.filter { $0.id != l.id })
        }
    }

    /// Site, username and password, as a sheet.
    private func ask(title: String, login: SavedLogin?, done: @escaping (String, String, String) -> Void) {
        guard let host, let window = host.sheetWindow else { return }
        let a = NSAlert()
        a.messageText = title
        a.informativeText = "Kept on this Mac only, encrypted. A job signs in with it on that site — the model never sees the password."
        let site = NSTextField(string: login?.site ?? "")
        site.placeholderString = "e.g. secure.booking.com"
        let user = NSTextField(string: login?.username ?? "")
        user.placeholderString = "email or username (empty if the site asks only a password)"
        let pass = NSSecureTextField(string: login?.password ?? "")
        pass.placeholderString = "password"
        var views: [NSView] = []
        for (t, v) in [("Site", site), ("Username", user), ("Password", pass)] as [(String, NSTextField)] {
            v.widthAnchor.constraint(equalToConstant: 340).isActive = true
            views += [host.label(t, size: 11, secondary: true), v]
        }
        let form = stack(views, .vertical, spacing: 4)
        form.frame = NSRect(origin: .zero, size: form.fittingSize)
        a.accessoryView = form
        a.addButton(withTitle: login == nil ? "Add" : "Save")
        a.addButton(withTitle: "Cancel")
        a.window.initialFirstResponder = login == nil ? site : pass
        a.beginSheetModal(for: window) { resp in
            guard resp == .alertFirstButtonReturn else { return }
            // A pasted address keeps only its host.
            let s = SiteFiles.siteKey(site.stringValue)
            let u = user.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
            let p = pass.stringValue
            guard !s.isEmpty, !p.isEmpty else { self.say("A sign-in needs a site and a password — nothing was saved.", error: true); return }
            guard s.count <= 253, u.count <= 320, p.count <= 1000 else { self.say("That's too long to be a sign-in — nothing was saved.", error: true); return }
            done(s, u, p)
        }
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
}

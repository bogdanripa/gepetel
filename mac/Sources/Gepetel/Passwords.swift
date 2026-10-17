// Passwords: a small password manager of Gepetel's own, on this Mac only.
// The owner, 2026-10-15: "build your own local password manager. something
// very simple".
//
// Kept like people's details (People.swift): passwords.enc in the agent's
// folder is one AES-GCM sealed box (SealedStore.swift), a fresh nonce on every
// write, its 256-bit key in the Keychain ("passwords_key"). Never logged, never sent to the relay
// or the model. The agent asks for one sign-in at the moment it fills a form
// (`@passwords`, Agent.swift) and types it into the page; the model only ever
// learns that a sign-in exists, and for which username.
//
// Kept by host, as the site notes are (SiteFiles.siteKey): a login for
// secure.booking.com is that host's. Asked for on another host of the same
// site, the nearest one serves — the exact host first, then a parent or child
// host (account.booking.com ↔ booking.com), most recently used first. Never a
// sibling: with no public-suffix list here, "same registrable domain" made
// foo.github.io's sign-in evil.github.io's too.
import AppKit
import LocalAuthentication

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
    static let maxLogins = 300

    private struct Envelope: Codable {
        var version = 1
        var logins: [SavedLogin]
    }

    /// ISO-8601 dates, as passwords.enc was first written.
    private static let store = SealedStore<Envelope>(name: "passwords.enc", keyAccount: "passwords_key",
                                                     aad: Data("gepetel-passwords-v1".utf8), noun: "passwords", dates: .iso8601)
    static var file: URL { store.file }

    /// Every saved sign-in, or [] when there's no file yet.
    static func load() throws -> [SavedLogin] { try store.load()?.logins ?? [] }

    static func save(_ logins: [SavedLogin]) throws { try store.save(Envelope(logins: logins)) }

    /// The sign-in for a site: the exact host first, then one saved for a
    /// parent of it; among several, the most recently used. With a username,
    /// only that username's.
    static func match(_ logins: [SavedLogin], site: String, username: String? = nil) -> Int? {
        let key = SiteFiles.siteKey(site)
        guard !key.isEmpty else { return nil }
        let recent = { (l: SavedLogin) in l.used ?? l.changed }
        let fits = { (l: SavedLogin) in username.map { l.username.lowercased() == $0.lowercased() } ?? true }
        let order = logins.indices.filter { fits(logins[$0]) }.sorted { recent(logins[$0]) > recent(logins[$1]) }
        return order.first { logins[$0].site == key } ?? order.first { related(logins[$0].site, key) }
    }

    /// A login saved for a site serves its subdomains (saved for booking.com,
    /// used on account.booking.com) — never the other way, never a sibling,
    /// never under a bare "com". One saved for btpay.bancatransilvania.ro was
    /// offered on the bank's information site (www., so bancatransilvania.ro)
    /// and typed into its newsletter box (2026-10-17).
    static func related(_ saved: String, _ asked: String) -> Bool {
        saved.contains(".") && asked.hasSuffix("." + saved)
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
            // Which hosts of this site's domain have a saved sign-in — the
            // hosts only, never a username or a password: so a job on the
            // bank's information site knows they sign in at BT Pay, not at its
            // other internet banking (2026-10-17).
            case "sites":
                let parts = site.split(separator: ".")
                let base = parts.count >= 2 ? parts.suffix(2).joined(separator: ".") : site
                let hosts = Set(logins.filter { $0.username != "(api key)" && ($0.site == base || $0.site.hasSuffix("." + base)) }.map(\.site))
                return ["ok": true, "sites": Array(hosts).sorted()]
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

    /// A change, made to the file as it is now — a job may have saved a
    /// sign-in (or noted one's use) while the window was open — by id, then
    /// saved. `change` says false when what it was for is gone.
    private func commit(_ change: (inout [SavedLogin]) -> Bool) {
        do {
            var next = try PasswordStore.load()
            if change(&next) {
                try PasswordStore.save(next)
                logins = next
                say("Saved. \(count)")
            } else {
                logins = next
                say("That was changed elsewhere meanwhile — nothing was saved. Here it is as it is now.", error: true)
            }
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
            let text = host.stack([host.label(l.site, size: 13, weight: .semibold),
                                   host.label(l.username.isEmpty ? "(no username)" : l.username, size: 12, secondary: l.username.isEmpty),
                                   password], .vertical, spacing: 2)
            let buttons = host.stack([host.button(shown ? "Hide" : "Show", self, #selector(toggleShow(_:)), id: l.id),
                                      host.button("Edit…", self, #selector(editLogin(_:)), id: l.id),
                                      host.button("Delete…", self, #selector(deleteLogin(_:)), id: l.id)], .horizontal)
            list.addArrangedSubview(host.row(text, buttons))
        }
    }

    /// A saved password is shown only to the owner of this Mac: Touch ID, or
    /// the Mac's own password (the owner, 2026-10-16: "never display passwords
    /// unless you auth me with fingerprint/etc"). Shown for a minute.
    @objc private func toggleShow(_ sender: NSButton) {
        guard let id = sender.identifier?.rawValue else { return }
        if revealed.contains(id) { revealed.remove(id); render(); return }
        let site = logins.first(where: { $0.id == id })?.site ?? "this site"
        let ctx = LAContext()
        var err: NSError?
        guard ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: &err) else {
            say("This Mac can't confirm it's you (no Touch ID or password set up), so the password stays hidden.", error: true)
            return
        }
        ctx.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "show your saved password for \(site)") { ok, _ in
            DispatchQueue.main.async {
                guard ok else { return }
                self.revealed.insert(id)
                self.render()
                DispatchQueue.main.asyncAfter(deadline: .now() + 60) { [weak self] in
                    guard let self, self.revealed.contains(id) else { return }
                    self.revealed.remove(id)
                    self.render()
                }
            }
        }
    }

    @objc private func addLogin() {
        ask(title: "Add a sign-in", login: nil) { site, user, newPassword in
            guard let password = newPassword else { return }
            self.commit { next in
                // The same site and username again is a new password, not a second entry.
                if let i = next.firstIndex(where: { $0.site == site && $0.username.lowercased() == user.lowercased() }) {
                    next[i].username = user; next[i].password = password; next[i].changed = Date()
                } else {
                    guard next.count < PasswordStore.maxLogins else { return false }
                    next.append(SavedLogin(site: site, username: user, password: password))
                }
                return true
            }
        }
    }

    @objc private func editLogin(_ sender: NSButton) {
        guard let l = logins.first(where: { $0.id == sender.identifier?.rawValue }) else { return }
        ask(title: "Edit sign-in", login: l) { site, user, newPassword in
            self.commit { next in
                guard let i = next.firstIndex(where: { $0.id == l.id }) else { return false }
                next[i].site = site; next[i].username = user
                // Left empty: the password stays as it was.
                if let p = newPassword { next[i].password = p }
                next[i].changed = Date()
                // Edited into another entry's site and username: one is enough.
                next.removeAll { $0.id != l.id && $0.site == site && $0.username.lowercased() == user.lowercased() }
                return true
            }
        }
    }

    @objc private func deleteLogin(_ sender: NSButton) {
        guard let l = logins.first(where: { $0.id == sender.identifier?.rawValue }) else { return }
        host?.confirm("Delete the sign-in for \(l.site)?", "\(l.username.isEmpty ? "The password" : "\(l.username) and its password") will be deleted from this Mac. Jobs on \(l.site) will ask you to sign in again. This can't be undone.") {
            self.revealed.remove(l.id)
            self.commit { next in
                next.removeAll { $0.id == l.id }
                return true
            }
        }
    }

    /// Site, username and password, as a sheet. The saved password is never
    /// put in it: editing, the box starts empty and stays so to keep it.
    /// What they type can be shown as they type it, by their choice. `nil`
    /// for the password: unchanged.
    private func ask(title: String, login: SavedLogin?, done: @escaping (String, String, String?) -> Void) {
        guard let host, let window = host.sheetWindow else { return }
        let a = NSAlert()
        a.messageText = title
        a.informativeText = "Kept on this Mac only, encrypted. A job signs in with it on that site — the model never sees the password."
        let site = NSTextField(string: login?.site ?? "")
        site.placeholderString = "e.g. secure.booking.com"
        let user = NSTextField(string: login?.username ?? "")
        user.placeholderString = "email or username (empty if the site asks only a password)"
        let pass = NSSecureTextField(string: "")
        let plain = NSTextField(string: "")
        let hint = login == nil ? "password" : "unchanged — type a new one to replace it"
        pass.placeholderString = hint; plain.placeholderString = hint
        plain.isHidden = true
        let see = ShowTyping(secure: pass, plain: plain)
        let check = NSButton(checkboxWithTitle: "Show what I type", target: see, action: #selector(ShowTyping.flip(_:)))
        var views: [NSView] = []
        for (t, v) in [("Site", site), ("Username", user), ("Password", pass)] as [(String, NSTextField)] {
            v.widthAnchor.constraint(equalToConstant: 340).isActive = true
            views += [host.label(t, size: 11, secondary: true), v]
        }
        plain.widthAnchor.constraint(equalToConstant: 340).isActive = true
        views += [plain, check]
        let form = host.stack(views, .vertical, spacing: 4)
        form.frame = NSRect(origin: .zero, size: form.fittingSize)
        a.accessoryView = form
        a.addButton(withTitle: login == nil ? "Add" : "Save")
        a.addButton(withTitle: "Cancel")
        a.window.initialFirstResponder = login == nil ? site : pass
        a.beginSheetModal(for: window) { resp in
            _ = see   // kept alive with the sheet
            guard resp == .alertFirstButtonReturn else { return }
            // A pasted address keeps only its host.
            let s = SiteFiles.siteKey(site.stringValue)
            let u = user.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
            let p = see.value
            guard !s.isEmpty, !(p.isEmpty && login == nil) else { self.say("A sign-in needs a site and a password — nothing was saved.", error: true); return }
            guard s.count <= 253, u.count <= 320, p.count <= 1000 else { self.say("That's too long to be a sign-in — nothing was saved.", error: true); return }
            done(s, u, p.isEmpty ? nil : p)
        }
    }
}

/// The password box of the sheet: dots, or in clear when they tick "Show what
/// I type" — what they are typing now, never what was saved.
final class ShowTyping: NSObject {
    let secure: NSSecureTextField, plain: NSTextField
    init(secure: NSSecureTextField, plain: NSTextField) { self.secure = secure; self.plain = plain }
    var value: String { plain.isHidden ? secure.stringValue : plain.stringValue }
    @objc func flip(_ sender: NSButton) {
        let show = sender.state == .on
        if show { plain.stringValue = secure.stringValue } else { secure.stringValue = plain.stringValue }
        plain.isHidden = !show; secure.isHidden = show
        (show ? plain : secure).window?.makeFirstResponder(show ? plain : secure)
    }
}

// "Manage Memories…": what Gepetel remembers, seen and edited from the Mac.
// The owner, 2026-10-14: "lets add a manage memories function, where I can see
// / edit global memories as well as per-site memories … if anything it's nice
// for debugging".
//
// Four tabs (People is People.swift, Passwords is Passwords.swift):
//  - About you — the memories the relay keeps for the owner's chat, through
//    /device/memories with this Mac's device token (the same token and server
//    the agent uses; src/device/memories.ts). Nothing is cached here: offline,
//    the tab says so and shows nothing stale.
//  - Sites — what the agent keeps on this Mac, read straight from its folder
//    (agent/src/sites.ts, agent/src/recipes.ts): which hosts need the desktop
//    layout, and the saved recipes. Written back in the agent's own format; the
//    agent re-reads both at the start of every browse job.
//
// The relay's side is MemoryAPI.swift; the agent's files, SiteFiles.swift.
import AppKit

private func shortDate(_ d: Date?) -> String {
    guard let d else { return "" }
    let f = DateFormatter()
    f.dateStyle = .medium
    f.timeStyle = .short
    return f.string(from: d)
}

// MARK: - The window

final class MemoriesWindow: NSObject, NSWindowDelegate {
    private var window: NSWindow?
    private lazy var people = PeopleTab(host: self)
    private lazy var passwords = PasswordsTab(host: self)
    private let tabs = NSTabView()
    private let width: CGFloat = 720

    // About you
    private let memList = NSStackView()
    private let memStatus = NSTextField(wrappingLabelWithString: "")
    private lazy var addButton = NSButton(title: "Add Memory…", target: self, action: #selector(addMemory))
    private lazy var reloadButton = NSButton(title: "Reload", target: self, action: #selector(reloadMemories))
    private var memories: [MemoryAPI.Memory] = []

    // Sites
    private let siteList = NSStackView()
    private let siteStatus = NSTextField(wrappingLabelWithString: "")
    private var recipes: [SiteFiles.Recipe] = []
    private var desktop: [String] = []
    private var notes: [SiteFiles.Note] = []
    private var logins: [SavedLogin] = []
    /// The site whose details are shown; nil for the list of sites.
    private var openSite: String?
    /// Said once, over the counts the next render would put there.
    private var siteError: String?

    func show() {
        if window == nil { build() }
        NSApp.activate(ignoringOtherApps: true)
        if window?.isVisible == false { window?.center() }
        window?.makeKeyAndOrderFront(nil)
        reloadMemories()
        reloadSites()
        people.reload()
        passwords.reload()
    }

    /// Closed: every shown passport number goes back behind its dots.
    func windowWillClose(_ notification: Notification) { people.hideAll(); passwords.hideAll() }

    /// For the People tab's sheets.
    var sheetWindow: NSWindow? { window }

    private func build() {
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: 560), styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
        w.title = "Gepetel's Memories"
        w.isReleasedWhenClosed = false
        w.delegate = self
        // Taller as much as you like; the rows wrap at one width.
        w.contentMinSize = NSSize(width: width, height: 360)
        w.contentMaxSize = NSSize(width: width, height: 4000)

        let about = NSTabViewItem(identifier: "about")
        about.label = "About You"
        about.view = aboutView()
        let sites = NSTabViewItem(identifier: "sites")
        sites.label = "Sites (this Mac)"
        sites.view = sitesView()
        tabs.addTabViewItem(about)
        tabs.addTabViewItem(sites)
        // The owner, the same day: "we store data about others as well, so
        // those need to be managed too" (People.swift).
        let folks = NSTabViewItem(identifier: "people")
        folks.label = "People (this Mac)"
        folks.view = people.view()
        tabs.addTabViewItem(folks)
        // The owner, 2026-10-15: "build your own local password manager.
        // something very simple" (Passwords.swift).
        let signIns = NSTabViewItem(identifier: "passwords")
        signIns.label = "Passwords (this Mac)"
        signIns.view = passwords.view()
        tabs.addTabViewItem(signIns)
        w.contentView = tabs
        window = w
    }

    private func aboutView() -> NSView {
        let intro = label("What Gepetel remembers about you, from your chats. It reads the newest of these before it answers you. Changes here take effect at once.", secondary: true)
        for b in [addButton, reloadButton] { b.bezelStyle = .rounded }
        let bar = NSStackView(views: [addButton, reloadButton, NSView()])
        bar.orientation = .horizontal
        memStatus.font = .systemFont(ofSize: 12)
        memStatus.preferredMaxLayoutWidth = width - 60
        return page([intro, bar, memStatus], list: memList)
    }

    private func sitesView() -> NSView {
        let intro = label("What Gepetel learned about sites while using Chrome on this Mac — kept only here, not on the server. A recipe is a job remembered step by step, so the next one like it needs no model.", secondary: true)
        let reload = NSButton(title: "Reload", target: self, action: #selector(reloadSites))
        let folder = NSButton(title: "Show in Finder", target: self, action: #selector(showFolder))
        for b in [reload, folder] { b.bezelStyle = .rounded }
        let bar = NSStackView(views: [reload, folder, NSView()])
        bar.orientation = .horizontal
        siteStatus.font = .systemFont(ofSize: 12)
        siteStatus.textColor = .secondaryLabelColor
        siteStatus.preferredMaxLayoutWidth = width - 60
        return page([intro, bar, siteStatus], list: siteList)
    }

    /// A header above a scrolling list of rows.
    func page(_ header: [NSView], list: NSStackView) -> NSView {
        list.orientation = .vertical
        list.alignment = .leading
        list.spacing = 10
        list.edgeInsets = NSEdgeInsets(top: 4, left: 0, bottom: 16, right: 0)
        list.translatesAutoresizingMaskIntoConstraints = false
        let doc = FlippedView()
        doc.translatesAutoresizingMaskIntoConstraints = false
        doc.addSubview(list)
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.drawsBackground = false
        scroll.documentView = doc
        NSLayoutConstraint.activate([
            list.leadingAnchor.constraint(equalTo: doc.leadingAnchor),
            list.trailingAnchor.constraint(equalTo: doc.trailingAnchor),
            list.topAnchor.constraint(equalTo: doc.topAnchor),
            list.bottomAnchor.constraint(equalTo: doc.bottomAnchor),
            doc.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor),
        ])
        let top = NSStackView(views: header)
        top.orientation = .vertical
        top.alignment = .leading
        top.spacing = 8
        let all = NSStackView(views: [top, scroll])
        all.orientation = .vertical
        all.alignment = .leading
        all.spacing = 10
        all.edgeInsets = NSEdgeInsets(top: 12, left: 16, bottom: 12, right: 16)
        for v in [top, scroll] { v.widthAnchor.constraint(equalTo: all.widthAnchor, constant: -32).isActive = true }
        scroll.setContentHuggingPriority(.defaultLow, for: .vertical)
        // Pinned inside a plain view: a tab that isn't the first is otherwise
        // given its fitting size, and the list a scroll view 0 points tall.
        let holder = NSView()
        all.translatesAutoresizingMaskIntoConstraints = false
        holder.addSubview(all)
        NSLayoutConstraint.activate([
            all.leadingAnchor.constraint(equalTo: holder.leadingAnchor),
            all.trailingAnchor.constraint(equalTo: holder.trailingAnchor),
            all.topAnchor.constraint(equalTo: holder.topAnchor),
            all.bottomAnchor.constraint(equalTo: holder.bottomAnchor),
        ])
        return holder
    }

    // MARK: About you

    @objc private func reloadMemories() {
        memStatus.textColor = .secondaryLabelColor
        memStatus.stringValue = "Loading…"
        setBusy(true)
        MemoryAPI.list { [weak self] r in
            guard let self else { return }
            self.setBusy(false)
            switch r {
            case .success(let list):
                self.memories = list
                self.memStatus.textColor = .secondaryLabelColor
                self.memStatus.stringValue = list.isEmpty ? "Nothing remembered yet." : "\(list.count) memor\(list.count == 1 ? "y" : "ies"), newest first."
            case .failure(let f):
                // Nothing stale on screen: what's shown is what the server said.
                self.memories = []
                self.memStatus.textColor = .systemRed
                self.memStatus.stringValue = f.words
            }
            self.renderMemories()
        }
    }

    private func setBusy(_ busy: Bool) {
        let paired = AgentConfig.isPaired
        addButton.isEnabled = !busy && paired
        reloadButton.isEnabled = !busy
    }

    private func renderMemories() {
        memList.arrangedSubviews.forEach { $0.removeFromSuperview() }
        for (i, m) in memories.enumerated() {
            let summary = label(m.summary, size: 13, weight: .semibold)
            var lines: [NSView] = [summary]
            if !m.details.isEmpty { lines.append(label(m.details, size: 12)) }
            var meta: [String] = []
            if !m.tags.isEmpty { meta.append(m.tags.map { "#\($0)" }.joined(separator: " ")) }
            if let d = m.createdAt { meta.append(shortDate(d)) }
            if !meta.isEmpty { lines.append(label(meta.joined(separator: "  ·  "), size: 11, secondary: true)) }
            let text = NSStackView(views: lines)
            text.orientation = .vertical
            text.alignment = .leading
            text.spacing = 3
            let edit = NSButton(title: "Edit…", target: self, action: #selector(editMemory(_:)))
            let del = NSButton(title: "Delete…", target: self, action: #selector(deleteMemory(_:)))
            for b in [edit, del] { b.tag = i; b.bezelStyle = .rounded; b.controlSize = .small }
            let buttons = NSStackView(views: [edit, del])
            buttons.orientation = .horizontal
            buttons.setContentHuggingPriority(.required, for: .horizontal)
            memList.addArrangedSubview(row(text, buttons))
        }
    }

    @objc private func addMemory() {
        ask(title: "Add a memory", summary: "", details: "", tags: [], button: "Add") { s, d, t in
            self.memStatus.stringValue = "Saving…"
            MemoryAPI.add(summary: s, details: d, tags: t) { r in self.after(r) }
        }
    }

    @objc private func editMemory(_ sender: NSButton) {
        guard memories.indices.contains(sender.tag) else { return }
        var m = memories[sender.tag]
        ask(title: "Edit memory", summary: m.summary, details: m.details, tags: m.tags, button: "Save") { s, d, t in
            m.summary = s; m.details = d; m.tags = t
            self.memStatus.stringValue = "Saving…"
            MemoryAPI.save(m) { r in self.after(r) }
        }
    }

    @objc private func deleteMemory(_ sender: NSButton) {
        guard memories.indices.contains(sender.tag), let window else { return }
        let m = memories[sender.tag]
        let a = NSAlert()
        a.messageText = "Delete this memory?"
        a.informativeText = "“\(m.summary)”\n\nGepetel won't remember it any more. This can't be undone."
        a.addButton(withTitle: "Delete")
        a.addButton(withTitle: "Cancel")
        a.buttons.first?.hasDestructiveAction = true
        a.beginSheetModal(for: window) { [weak self] resp in
            guard resp == .alertFirstButtonReturn else { return }
            self?.memStatus.stringValue = "Deleting…"
            MemoryAPI.delete(m.id) { r in self?.after(r) }
        }
    }

    /// A write done: the list again from the server, or why not.
    private func after(_ r: Result<Void, MemoryAPI.Failure>) {
        switch r {
        case .success: reloadMemories()
        case .failure(let f):
            memStatus.textColor = .systemRed
            memStatus.stringValue = f.words
        }
    }

    /// The summary / details / tags form, as a sheet.
    private func ask(title: String, summary: String, details: String, tags: [String], button: String,
                     done: @escaping (String, String, [String]) -> Void) {
        guard let window else { return }
        let a = NSAlert()
        a.messageText = title
        a.informativeText = "A short summary (up to 240 characters), any details (up to 1200), and tags separated by commas."
        let s = NSTextField(string: summary)
        s.placeholderString = "e.g. Prefers window seats"
        let t = NSTextField(string: tags.joined(separator: ", "))
        t.placeholderString = "travel, flights"
        let dScroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 420, height: 110))
        dScroll.hasVerticalScroller = true
        dScroll.borderType = .bezelBorder
        let d = NSTextView(frame: dScroll.bounds)
        d.string = details
        d.font = .systemFont(ofSize: 13)
        d.isRichText = false
        d.autoresizingMask = [.width]
        dScroll.documentView = d
        dScroll.heightAnchor.constraint(equalToConstant: 110).isActive = true
        let form = NSStackView(views: [label("Summary", size: 11, secondary: true), s,
                                       label("Details", size: 11, secondary: true), dScroll,
                                       label("Tags", size: 11, secondary: true), t])
        form.orientation = .vertical
        form.alignment = .leading
        form.spacing = 4
        for v in [s, dScroll, t] { v.widthAnchor.constraint(equalToConstant: 420).isActive = true }
        form.frame = NSRect(origin: .zero, size: form.fittingSize)
        a.accessoryView = form
        a.addButton(withTitle: button)
        a.addButton(withTitle: "Cancel")
        a.window.initialFirstResponder = s
        a.beginSheetModal(for: window) { [weak self] resp in
            guard resp == .alertFirstButtonReturn else { return }
            let summary = s.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !summary.isEmpty else {
                self?.memStatus.textColor = .systemRed
                self?.memStatus.stringValue = "A memory needs a summary — nothing was saved."
                return
            }
            let tags = t.stringValue.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
            self?.memStatus.textColor = .secondaryLabelColor
            done(summary, d.string.trimmingCharacters(in: .whitespacesAndNewlines), tags)
        }
    }

    // MARK: Sites

    @objc private func reloadSites() {
        recipes = SiteFiles.recipes()
        desktop = SiteFiles.desktopHosts()
        notes = SiteFiles.notes()
        // Only to say a host has one; a locked file just shows none here
        // (the Passwords tab says why).
        logins = (try? PasswordStore.load()) ?? []
        renderSites()
    }

    /// The list of sites, or one site's details in its place. The owner,
    /// 2026-10-15: "have them be separate lines for each site, then go into
    /// the detail view to see the details for a specific site."
    private func renderSites() {
        siteList.arrangedSubviews.forEach { $0.removeFromSuperview() }
        // By host, as the notes are kept: secure.booking.com is its own line.
        let hosts = Set(desktop.map { SiteFiles.siteKey($0) }).union(recipes.map { SiteFiles.siteKey($0.site) }.filter { !$0.isEmpty }).union(notes.map(\.site))
        siteStatus.textColor = siteError == nil ? .secondaryLabelColor : .systemRed
        if let host = openSite {
            siteStatus.stringValue = siteError ?? ""
            siteError = nil
            siteDetail(host)
            return
        }
        siteStatus.stringValue = siteError ?? (hosts.isEmpty
            ? "No sites yet — a site shows up here once Gepetel has used it in Chrome."
            : "\(hosts.count) site\(hosts.count == 1 ? "" : "s"), \(notes.count) note\(notes.count == 1 ? "" : "s"), \(recipes.count) recipe\(recipes.count == 1 ? "" : "s").")
        siteError = nil
        for host in hosts.sorted() { siteList.addArrangedSubview(siteRow(host)) }
        // A recipe saved without a site (none should be) still gets a place.
        if recipes.contains(where: { $0.site.isEmpty }) { siteList.addArrangedSubview(siteRow("")) }
        // Addresses on their home network they let Gepetel open (by naming
        // them in a request). Everything else private stays refused.
        let home = SiteFiles.homeHosts()
        if !home.isEmpty {
            var views: [NSView] = [label("Your home network", size: 14, weight: .semibold),
                                   label("Addresses you let Gepetel open, by naming them in a request. Any other address on your home network stays off limits — a web page can't send it there.", size: 11, secondary: true)]
            for h in home.sorted() {
                views.append(row(label(h, size: 12, weight: .medium), button("Remove…", self, #selector(removeHomeHost(_:)), id: h), indent: 0))
            }
            siteList.addArrangedSubview(card(stack(views, .vertical), inset: 12))
        }
    }

    @objc private func removeHomeHost(_ sender: NSButton) {
        guard let h = sender.identifier?.rawValue else { return }
        confirm("Remove \(h)?", "Gepetel won't open it again until you name it in a request.") { [weak self] in
            do { try SiteFiles.removeHomeHost(h) } catch { self?.siteError = "Couldn't remove it: \(error.localizedDescription)" }
            self?.reloadSites()
        }
    }

    private func plural(_ n: Int, _ word: String) -> String { "\(n) \(word)\(n == 1 ? "" : "s")" }

    /// One line per host: what's kept about it, and the way in.
    private func siteRow(_ host: String) -> NSView {
        var parts: [String] = []
        let n = notes.filter { $0.site == host }.count
        let r = recipes.filter { SiteFiles.siteKey($0.site) == host }.count
        if n > 0 { parts.append(plural(n, "note")) }
        if r > 0 { parts.append(plural(r, "recipe")) }
        if !host.isEmpty, desktop.contains(where: { SiteFiles.siteKey($0) == host }) { parts.append("desktop layout") }
        if !host.isEmpty, logins.contains(where: { $0.site == host }) { parts.append("sign-in saved") }
        let name = label(host.isEmpty ? "(no site)" : host, size: 13, weight: .semibold)
        let meta = label(parts.joined(separator: " · "), size: 11, secondary: true)
        // Not selectable here: a click on the line opens it.
        for l in [name, meta] { l.isSelectable = false }
        let text = NSStackView(views: [name, meta])
        text.orientation = .vertical
        text.alignment = .leading
        text.spacing = 2
        let open = NSButton(title: "Details ›", target: self, action: #selector(openSiteDetail(_:)))
        open.bezelStyle = .rounded
        open.controlSize = .small
        open.identifier = NSUserInterfaceItemIdentifier(host)
        let line = NSStackView(views: [text, NSView(), open])
        line.orientation = .horizontal
        line.alignment = .centerY
        line.spacing = 12
        let c = card(line, inset: 8)
        c.identifier = NSUserInterfaceItemIdentifier(host)
        c.addGestureRecognizer(NSClickGestureRecognizer(target: self, action: #selector(clickedSite(_:))))
        return c
    }

    @objc private func openSiteDetail(_ sender: NSButton) { show(site: sender.identifier?.rawValue ?? "") }
    @objc private func clickedSite(_ g: NSClickGestureRecognizer) { show(site: g.view?.identifier?.rawValue ?? "") }
    @objc private func backToSites() { show(site: nil) }

    private func show(site: String?) {
        openSite = site
        renderSites()
        // Each view starts at its top.
        siteList.enclosingScrollView?.documentView?.scroll(.zero)
    }

    /// One site in full, in the list's place: its desktop flag, notes,
    /// recipes, and the sign-in kept for this exact host.
    private func siteDetail(_ host: String) {
        let back = NSButton(title: "‹ All sites", target: self, action: #selector(backToSites))
        back.bezelStyle = .rounded
        siteList.addArrangedSubview(back)
        siteList.addArrangedSubview(label(host.isEmpty ? "(no site)" : host, size: 16, weight: .semibold))

        var views: [NSView] = []
        if !host.isEmpty {
            // The flag is per host; any spelling of it (www.) on counts.
            let flagged = desktop.filter { SiteFiles.siteKey($0) == host }
            let check = NSButton(checkboxWithTitle: "Open with the desktop layout (this site doesn't fit a phone)", target: self, action: #selector(toggleDesktop(_:)))
            check.state = flagged.isEmpty ? .off : .on
            check.identifier = NSUserInterfaceItemIdentifier(flagged.first ?? host)
            views.append(check)
        }
        // A sign-in for this host; managed in its own tab, never shown here.
        for l in logins.filter({ $0.site == host }).sorted(by: { $0.username.lowercased() < $1.username.lowercased() }) {
            let text = NSStackView(views: [label("Sign-in: \(l.username.isEmpty ? "(no username)" : l.username)", size: 12, weight: .medium),
                                           label("Password saved  ·  manage it in Passwords", size: 11, secondary: true)])
            text.orientation = .vertical
            text.alignment = .leading
            text.spacing = 2
            let manage = NSButton(title: "Manage in Passwords", target: self, action: #selector(showPasswords))
            manage.bezelStyle = .rounded
            manage.controlSize = .small
            views.append(row(text, manage, indent: 18))
        }
        // What Gepetel knows about the site in words (site notes, Phase 9):
        // the person's own first, then the most used.
        for n in notes.filter({ $0.site == host }).sorted(by: { ($0.source == "person" ? 1 : 0, $0.uses) > ($1.source == "person" ? 1 : 0, $1.uses) }) {
            let what = n.kind == "address" ? "A page that worked: \(n.text)" : n.text
            let meta = "\(n.source == "person" ? "from you" : n.source == "review" ? "from the daily review" : "learned by a job")  ·  read \(n.uses)×"
            let text = NSStackView(views: [label(what, size: 12, weight: .medium), label(meta, size: 11, secondary: true)])
            text.orientation = .vertical
            text.alignment = .leading
            text.spacing = 2
            let edit = NSButton(title: "Edit…", target: self, action: #selector(editNote(_:)))
            edit.identifier = NSUserInterfaceItemIdentifier(n.id)
            edit.bezelStyle = .rounded
            edit.controlSize = .small
            let del = NSButton(title: "Delete…", target: self, action: #selector(deleteNote(_:)))
            del.identifier = NSUserInterfaceItemIdentifier(n.id)
            del.bezelStyle = .rounded
            del.controlSize = .small
            let buttons = NSStackView(views: [edit, del])
            buttons.spacing = 6
            views.append(row(text, buttons, indent: 18))
        }
        let mine = recipes.enumerated().filter { SiteFiles.siteKey($0.element.site) == host }.sorted { $0.element.used > $1.element.used }
        for (i, r) in mine {
            var meta = ["saved \(shortDate(r.created))", "used \(r.used)×"]
            if r.repaired > 0 { meta.append("repaired \(r.repaired)×") }
            if !r.params.isEmpty { meta.append("asks for \(r.params.joined(separator: ", "))") }
            let text = NSStackView(views: [label("Recipe: \(r.intent)", size: 12, weight: .medium),
                                           label(meta.joined(separator: "  ·  "), size: 11, secondary: true),
                                           label(SiteFiles.brief(r.steps), size: 11, secondary: true)])
            text.orientation = .vertical
            text.alignment = .leading
            text.spacing = 2
            let del = NSButton(title: "Delete…", target: self, action: #selector(deleteRecipe(_:)))
            del.tag = i
            del.bezelStyle = .rounded
            del.controlSize = .small
            views.append(row(text, del, indent: 18))
        }
        // The last thing deleted: the page stays, and says so.
        if views.count <= 1 && mine.isEmpty { views.append(label("No notes or recipes kept for this site.", size: 12, secondary: true)) }

        let stack = NSStackView(views: views)
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 6
        siteList.addArrangedSubview(card(stack, inset: 10))
    }

    /// A card as tall as what's in it (an NSBox's content view doesn't size
    /// it under Auto Layout; pinned edges do).
    func card(_ content: NSView, inset: CGFloat) -> NSView {
        let c = CardView()
        content.translatesAutoresizingMaskIntoConstraints = false
        c.addSubview(content)
        NSLayoutConstraint.activate([
            content.leadingAnchor.constraint(equalTo: c.leadingAnchor, constant: 12),
            content.trailingAnchor.constraint(equalTo: c.trailingAnchor, constant: -12),
            content.topAnchor.constraint(equalTo: c.topAnchor, constant: inset),
            content.bottomAnchor.constraint(equalTo: c.bottomAnchor, constant: -inset),
            c.widthAnchor.constraint(equalToConstant: width - 80),
        ])
        return c
    }

    @objc private func showPasswords() { tabs.selectTabViewItem(withIdentifier: "passwords") }

    @objc private func toggleDesktop(_ sender: NSButton) {
        guard let host = sender.identifier?.rawValue else { return }
        do { try SiteFiles.setDesktop(host, sender.state == .on) } catch {
            siteError = "Couldn't save that: \(error.localizedDescription)"
        }
        reloadSites()
    }

    @objc private func editNote(_ sender: NSButton) {
        guard let id = sender.identifier?.rawValue, let n = notes.first(where: { $0.id == id }), let window else { return }
        let a = NSAlert()
        a.messageText = "Edit this note about \(n.site)"
        a.informativeText = "How the site works or how you use it — never anyone's details. At most 200 characters."
        let field = NSTextField(string: n.text)
        field.frame = NSRect(x: 0, y: 0, width: 360, height: 24)
        a.accessoryView = field
        a.addButton(withTitle: "Save")
        a.addButton(withTitle: "Cancel")
        a.beginSheetModal(for: window) { [weak self] resp in
            guard let self, resp == .alertFirstButtonReturn else { return }
            let text = String(field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines).prefix(200))
            guard !text.isEmpty else { return }
            do { try SiteFiles.editNote(id, text: text) } catch { self.siteError = "Couldn't save it: \(error.localizedDescription)" }
            self.reloadSites()
        }
    }

    @objc private func deleteNote(_ sender: NSButton) {
        guard let id = sender.identifier?.rawValue, let n = notes.first(where: { $0.id == id }), let window else { return }
        let a = NSAlert()
        a.messageText = "Delete this note?"
        a.informativeText = "“\(n.text)” on \(n.site). Jobs won't know it any more."
        a.addButton(withTitle: "Delete")
        a.addButton(withTitle: "Cancel")
        a.buttons.first?.hasDestructiveAction = true
        a.beginSheetModal(for: window) { [weak self] resp in
            guard let self, resp == .alertFirstButtonReturn else { return }
            do { try SiteFiles.editNote(id, text: nil) } catch { self.siteError = "Couldn't delete it: \(error.localizedDescription)" }
            self.reloadSites()
        }
    }

    @objc private func deleteRecipe(_ sender: NSButton) {
        guard recipes.indices.contains(sender.tag), let window else { return }
        let r = recipes[sender.tag]
        let a = NSAlert()
        a.messageText = "Delete this recipe?"
        a.informativeText = "“\(r.intent)” on \(r.site). The next job like it will be worked out by the model again, and saved again if it works."
        a.addButton(withTitle: "Delete")
        a.addButton(withTitle: "Cancel")
        a.buttons.first?.hasDestructiveAction = true
        a.beginSheetModal(for: window) { [weak self] resp in
            guard let self, resp == .alertFirstButtonReturn else { return }
            do { try SiteFiles.deleteRecipe(r) } catch {
                self.siteError = "Couldn't delete it: \(error.localizedDescription)"
            }
            self.reloadSites()
        }
    }

    @objc private func showFolder() {
        let dir = FileManager.default.fileExists(atPath: SiteFiles.recipesDir.path) ? SiteFiles.recipesDir : SiteFiles.dir
        NSWorkspace.shared.activateFileViewerSelecting([dir])
    }

    // MARK: Helpers

    func label(_ s: String, size: CGFloat = 12, weight: NSFont.Weight = .regular, secondary: Bool = false) -> NSTextField {
        let l = NSTextField(wrappingLabelWithString: s)
        l.font = .systemFont(ofSize: size, weight: weight)
        if secondary { l.textColor = .secondaryLabelColor }
        // Selectable: it's for debugging too — copy an id, a host, a step.
        l.isSelectable = true
        l.preferredMaxLayoutWidth = width - 200
        return l
    }

    /// Text on the left, buttons on the right, a hairline under it.
    func row(_ text: NSView, _ buttons: NSView, indent: CGFloat = 0) -> NSView {
        let r = NSStackView(views: [text, NSView(), buttons])
        r.orientation = .horizontal
        r.alignment = .top
        r.spacing = 12
        r.edgeInsets = NSEdgeInsets(top: 4, left: indent, bottom: 4, right: 4)
        r.widthAnchor.constraint(equalToConstant: width - 90 - indent).isActive = true
        return r
    }

    // For the People and Passwords tabs too.

    /// A small button that carries the id of what it's for.
    func button(_ title: String, _ target: AnyObject, _ action: Selector, id: String) -> NSButton {
        let b = NSButton(title: title, target: target, action: action)
        b.bezelStyle = .rounded
        b.controlSize = .small
        b.identifier = NSUserInterfaceItemIdentifier(id)
        return b
    }

    func stack(_ views: [NSView], _ o: NSUserInterfaceLayoutOrientation, spacing: CGFloat = 6) -> NSStackView {
        let s = NSStackView(views: views)
        s.orientation = o
        s.alignment = o == .vertical ? .leading : .centerY
        s.spacing = spacing
        if o == .horizontal { s.setContentHuggingPriority(.required, for: .horizontal) }
        return s
    }

    /// "Delete" or "Cancel", as a sheet; `yes` only for Delete.
    func confirm(_ title: String, _ text: String, _ yes: @escaping () -> Void) {
        guard let window else { return }
        let a = NSAlert()
        a.messageText = title
        a.informativeText = text
        a.addButton(withTitle: "Delete")
        a.addButton(withTitle: "Cancel")
        a.buttons.first?.hasDestructiveAction = true
        a.beginSheetModal(for: window) { if $0 == .alertFirstButtonReturn { yes() } }
    }
}

/// One site's card: rounded, faintly filled, redrawn for dark mode.
final class CardView: NSView {
    override var wantsUpdateLayer: Bool { true }
    override func updateLayer() {
        layer?.cornerRadius = 8
        layer?.borderWidth = 1
        layer?.borderColor = NSColor.separatorColor.cgColor
        layer?.backgroundColor = NSColor.controlBackgroundColor.cgColor
    }
    override init(frame: NSRect) { super.init(frame: frame); wantsLayer = true }
    required init?(coder: NSCoder) { super.init(coder: coder); wantsLayer = true }
}

/// Top-down, so a short list sits at the top of its scroll view.
private final class FlippedView: NSView {
    override var isFlipped: Bool { true }
}

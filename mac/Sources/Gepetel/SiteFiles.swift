// The agent's own files on this Mac, for the Sites tab (Memories.swift)
// and the stores beside them (People.swift, Passwords.swift).
import Foundation

/// The agent's files in Application Support/Gepetel. Read fresh every time
/// the tab is shown; nothing is held here between reads.
enum SiteFiles {
    static var dir: URL { Paths.configFile.deletingLastPathComponent() }
    static var sitesFile: URL { dir.appendingPathComponent("sites.json") }
    static var recipesDir: URL { dir.appendingPathComponent("recipes") }

    struct Recipe {
        let file: URL
        let intent: String
        let site: String
        let created: Date?
        let used: Int
        let repaired: Int
        let params: [String]
        let steps: [[String: Any]]
    }

    /// `{ desktop: [host, …] }` — SiteMemory's file.
    static func desktopHosts() -> [String] {
        guard let data = try? Data(contentsOf: sitesFile),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [] }
        return (obj["desktop"] as? [Any] ?? []).compactMap { $0 as? String }
    }

    static func setDesktop(_ host: String, _ on: Bool) throws {
        // Anything else in the file stays as it was; only the list changes.
        var obj = (try? Data(contentsOf: sitesFile)).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
        var hosts = (obj["desktop"] as? [Any] ?? []).compactMap { $0 as? String }
        let h = host.lowercased()
        hosts.removeAll { $0 == h }
        if on { hosts.append(h) }
        obj["desktop"] = hosts
        try writeAtomically(obj, to: sitesFile)
    }

    static func recipes() -> [Recipe] {
        let fm = FileManager.default
        guard let names = try? fm.contentsOfDirectory(atPath: recipesDir.path) else { return [] }
        return names.filter { $0.hasSuffix(".json") }.compactMap { name in
            let file = recipesDir.appendingPathComponent(name)
            guard let data = try? Data(contentsOf: file),
                  let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
            return Recipe(file: file, intent: j["intent"] as? String ?? "(no intent)", site: (j["site"] as? String ?? "").lowercased(),
                          created: (j["created"] as? String).flatMap(isoDate),
                          used: (j["used"] as? NSNumber)?.intValue ?? 0, repaired: (j["repaired"] as? NSNumber)?.intValue ?? 0,
                          params: (j["params"] as? [[String: Any]] ?? []).compactMap { $0["name"] as? String },
                          steps: j["steps"] as? [[String: Any]] ?? [])
        }
    }

    // Site notes (Phase 9; agent/src/siteNotes.ts): `{ notes: [ … ] }`.
    static var notesFile: URL { dir.appendingPathComponent("site-notes.json") }

    struct Note {
        let id: String
        let site: String
        let text: String
        let kind: String
        let source: String
        let uses: Int
    }

    static func notes() -> [Note] {
        guard let data = try? Data(contentsOf: notesFile),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [] }
        return (obj["notes"] as? [[String: Any]] ?? []).compactMap { n in
            guard let id = n["id"] as? String, let site = n["site"] as? String, let text = n["text"] as? String else { return nil }
            return Note(id: id, site: site.lowercased(), text: text, kind: n["kind"] as? String ?? "note",
                        source: n["source"] as? String ?? "job", uses: (n["uses"] as? NSNumber)?.intValue ?? 0)
        }
    }

    /// Change or drop one note; the rest of the file as it was.
    /// Home-network addresses the person let Gepetel open (the agent's
    /// homeHosts.ts): "homeassistant:8123". Shown in Sites, removable.
    static var homeHostsFile: URL { dir.appendingPathComponent("home-hosts.json") }
    static func homeHosts() -> [String] {
        guard let data = try? Data(contentsOf: homeHostsFile),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let list = obj["hosts"] as? [[String: Any]] else { return [] }
        return list.compactMap { $0["host"] as? String }
    }
    static func removeHomeHost(_ host: String) throws {
        guard let data = try? Data(contentsOf: homeHostsFile),
              var obj = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let list = obj["hosts"] as? [[String: Any]] else { return }
        obj["hosts"] = list.filter { ($0["host"] as? String) != host }
        try writeAtomically(obj, to: homeHostsFile)
    }

    static func editNote(_ id: String, text: String?) throws {
        var obj = (try? Data(contentsOf: notesFile)).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
        var list = obj["notes"] as? [[String: Any]] ?? []
        if let text {
            let now = ISO8601DateFormatter().string(from: Date())
            for i in list.indices where list[i]["id"] as? String == id { list[i]["text"] = text; list[i]["changed"] = now; list[i]["source"] = "person" }
        } else {
            list.removeAll { $0["id"] as? String == id }
        }
        obj["notes"] = list
        try writeAtomically(obj, to: notesFile)
    }

    /// A site as the notes key it: the host, lowercased, without "www.", a
    /// trailing dot or a port — secure.booking.com stays apart from
    /// booking.com. The owner, 2026-10-15: "sometimes we deal with subdomains,
    /// so be careful not merging them together". Same as agent/src/siteNotes.ts.
    static func siteKey(_ hostOrUrl: String) -> String {
        var h = hostOrUrl.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if h.range(of: #"^[a-z]+://"#, options: .regularExpression) != nil, let host = URL(string: h)?.host { h = host.lowercased() }
        if let r = h.range(of: #":\d+$"#, options: .regularExpression) { h.removeSubrange(r) }
        if h.hasSuffix(".") { h.removeLast() }
        if h.hasPrefix("www.") { h = String(h.dropFirst(4)) }
        return h
    }

    static func deleteRecipe(_ r: Recipe) throws {
        try FileManager.default.removeItem(at: r.file)
    }

    /// The steps in a line: open → click “Facturi” → type {p1} into “Caută”.
    static func brief(_ steps: [[String: Any]]) -> String {
        func q(_ s: Any?) -> String {
            let t = (s as? String ?? "").replacingOccurrences(of: "\n", with: " ")
            return "“\(t.count > 32 ? String(t.prefix(31)) + "…" : t)”"
        }
        let parts: [String] = steps.prefix(10).map { s in
            switch s["do"] as? String ?? "" {
            case "navigate":
                let u = (s["url"] as? String).flatMap(URL.init(string:))
                return "open \(u.map { ($0.host ?? "") + ($0.path.count > 1 ? $0.path : "") } ?? "a page")"
            case "click": return "click \(q(s["name"]))"
            case "type": return "type \(q(s["text"])) into \(q(s["name"]))\((s["submit"] as? Bool) == true ? " ⏎" : "")"
            case "select": return "choose \(q(s["value"])) in \(q(s["name"]))"
            case "press_key": return "press \(s["key"] as? String ?? "a key")"
            default: return "?"
            }
        }
        let more = steps.count > 10 ? " → … (\(steps.count - 10) more)" : ""
        return parts.isEmpty ? "(no steps)" : parts.joined(separator: " → ") + more
    }

    static func writeAtomically(_ obj: Any, to url: URL) throws {
        try writeFileAtomically(try JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .withoutEscapingSlashes]), to: url)
    }
}

/// 0600 from the first byte, then renamed over the old file — a reader (the
/// agent, or this app next time) sees the old contents or the new, never half.
func writeFileAtomically(_ data: Data, to url: URL) throws {
    let fm = FileManager.default
    try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    let tmp = url.deletingLastPathComponent().appendingPathComponent(".\(url.lastPathComponent).tmp")
    let fail = { (what: String) -> NSError in
        NSError(domain: NSPOSIXErrorDomain, code: Int(errno), userInfo: [NSLocalizedDescriptionKey: "Couldn't \(what) \(url.lastPathComponent)."])
    }
    unlink(tmp.path)   // a leftover from a crash; O_EXCL below wants it gone
    let fd = open(tmp.path, O_WRONLY | O_CREAT | O_EXCL, 0o600)
    guard fd >= 0 else { throw fail("write") }
    let wrote = data.withUnsafeBytes { buf in write(fd, buf.baseAddress, buf.count) }
    let synced = fsync(fd) == 0
    close(fd)
    guard wrote == data.count, synced, rename(tmp.path, url.path) == 0 else {
        unlink(tmp.path)
        throw fail("save")
    }
}

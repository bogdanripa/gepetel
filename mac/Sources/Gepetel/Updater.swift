// Updates itself, without asking.
//
// A product decision, not a default: the app is part of the platform, so a new
// release reaches every Mac the way a server deploy reaches the server. Nobody
// is asked, and nobody has to remember.
//
// Why this and not Sparkle (which the spec first named): Sparkle is built
// around asking, its silent mode installs on quit — which a menu-bar app
// almost never does — and it would add an embedded framework, a second
// signing key and an appcast to host. What this needs is smaller and is
// already guaranteed by how the app ships:
//
//  - **Where:** the highest-versioned GitHub release of bogdanripa/gepetel
//    tagged `mac-v<version>` (not drafts, not pre-releases), asset
//    `Gepetel.dmg`.
//  - **Trust, which is the whole point:** a downloaded app is installed only if
//    its code signature is valid, it is signed by **the same Apple Team ID as
//    the app that is running**, it has the same bundle id, and Gatekeeper
//    accepts it (which means Apple notarized it). Someone who could publish a
//    release but not sign as us gets nothing installed. A build that is not
//    Developer ID signed (a developer's ad-hoc build) never updates at all.
//  - **When:** at launch and every six hours, and never in the middle of a
//    job: a busy agent defers the swap until it is idle.
//  - **How:** the new app is staged beside the old one, the two are swapped by
//    rename, the new one is launched, this one quits. If the swap fails the
//    old app is put back.
import AppKit
import Security

// `working` and the timer are touched on the main thread only; the network and
// disk work runs detached and reports back through `log`.
final class Updater: @unchecked Sendable {
    static let repo = "bogdanripa/gepetel"
    static let tagPrefix = "mac-v"
    static let every: TimeInterval = 6 * 3600

    /// True while the agent is running a job; checked before swapping.
    var isBusy: () -> Bool = { false }
    var log: (String) -> Void = { _ in }
    /// Called on the main thread whenever `status` changes.
    var onStatus: () -> Void = {}
    /// For the menu: where this copy stands.
    private(set) var status = "checking for updates…" {
        didSet { DispatchQueue.main.async { self.onStatus() } }
    }

    private var timer: Timer?
    private var working = false
    private let fm = FileManager.default

    var current: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
    }

    func start() {
        guard let team = Updater.teamID(of: Bundle.main.bundleURL) else {
            log("updater: this build is not Developer ID signed; it will not update itself")
            status = "development build, never updates"
            return
        }
        log("updater: on, team \(team), version \(current)")
        DispatchQueue.main.asyncAfter(deadline: .now() + 30) { self.check() }
        timer = Timer.scheduledTimer(withTimeInterval: Updater.every, repeats: true) { [weak self] _ in self?.check() }
        cleanUpPrevious()
    }

    /// Asked for from the menu ("Check for Updates…"): the result is said
    /// once, even "up to date" — the timed checks stay quiet.
    var onAsked: (String) -> Void = { _ in }
    private var asked = false
    var isDevBuild: Bool { Updater.teamID(of: Bundle.main.bundleURL) == nil }

    func checkNow() {
        guard !isDevBuild else { onAsked("This is a development build; it doesn't update itself."); return }
        asked = true
        status = "checking for updates…"
        check()
    }

    func check() {
        guard !working else { return }
        working = true
        Task.detached { [self] in
            defer { DispatchQueue.main.async { self.working = false } }
            do { try await run() } catch {
                log("updater: \(error.localizedDescription)")
                status = "couldn't check for updates"
            }
            if asked {
                asked = false
                let said = status == "up to date" ? "Gepetel \(current) is up to date."
                    : status.hasPrefix("couldn't") ? "Couldn't check for updates. Try again in a while."
                    : "Gepetel is \(status)"
                DispatchQueue.main.async { self.onAsked(said) }
            }
        }
    }

    private struct Release: Decodable {
        let tag_name: String
        let draft: Bool
        let prerelease: Bool
        let assets: [Asset]
        struct Asset: Decodable { let name: String; let browser_download_url: String }
    }

    private func run() async throws {
        // The list, not /releases/latest: "latest" is whatever release was
        // published last, and a release of anything else in this repo would
        // hide every Mac update behind it.
        var req = URLRequest(url: URL(string: "https://api.github.com/repos/\(Updater.repo)/releases?per_page=30")!)
        req.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        req.setValue("Gepetel/\(current)", forHTTPHeaderField: "User-Agent")
        req.timeoutInterval = 30
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard (resp as? HTTPURLResponse)?.statusCode == 200 else {
            throw err("release check answered \((resp as? HTTPURLResponse)?.statusCode ?? 0)")
        }
        let releases = try JSONDecoder().decode([Release].self, from: data)
            .filter { !$0.draft && !$0.prerelease && $0.tag_name.hasPrefix(Updater.tagPrefix) }
        let version = { (r: Release) in String(r.tag_name.dropFirst(Updater.tagPrefix.count)) }
        guard let rel = releases.max(by: { Updater.isNewer(version($1), than: version($0)) }) else { status = "up to date"; return }
        let latest = version(rel)
        guard Updater.isNewer(latest, than: current) else { status = "up to date"; return }
        status = "updating to \(latest)…"
        guard let asset = rel.assets.first(where: { $0.name == "Gepetel.dmg" }),
              let url = URL(string: asset.browser_download_url) else { throw err("release \(latest) has no Gepetel.dmg") }

        log("updater: \(current) → \(latest), downloading")
        let (tmp, dresp) = try await URLSession.shared.download(from: url)
        guard (dresp as? HTTPURLResponse)?.statusCode == 200 else { throw err("download failed") }
        let work = fm.temporaryDirectory.appendingPathComponent("gepetel-update-\(UUID().uuidString)")
        try fm.createDirectory(at: work, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: work) }
        let dmg = work.appendingPathComponent("Gepetel.dmg")
        try fm.moveItem(at: tmp, to: dmg)

        // Staged next to the running app, so the swap is a rename on one volume.
        let here = Bundle.main.bundleURL
        let staged = here.deletingLastPathComponent().appendingPathComponent(".Gepetel-\(latest).app")
        try? fm.removeItem(at: staged)
        let mount = work.appendingPathComponent("mnt")
        try shell("/usr/bin/hdiutil", ["attach", "-nobrowse", "-readonly", "-noautoopen", "-mountpoint", mount.path, dmg.path])
        defer { _ = try? shell("/usr/bin/hdiutil", ["detach", "-force", mount.path]) }
        try fm.copyItem(at: mount.appendingPathComponent("Gepetel.app"), to: staged)

        do {
            try verify(staged, version: latest)
        } catch {
            try? fm.removeItem(at: staged)
            throw error
        }
        log("updater: \(latest) verified")
        await waitUntilIdle()
        try await MainActor.run { try swap(to: staged, version: latest) }
    }

    /// Everything that must hold before a downloaded app replaces this one.
    private func verify(_ app: URL, version: String) throws {
        guard let mine = Updater.teamID(of: Bundle.main.bundleURL) else { throw err("not signed; refusing") }
        guard let theirs = Updater.teamID(of: app), theirs == mine else {
            throw err("the download is not signed by team \(mine); refusing it")
        }
        // Valid, all of it, against a requirement naming our team.
        let requirement = "anchor apple generic and certificate leaf[subject.OU] = \"\(mine)\""
        try shell("/usr/bin/codesign", ["--verify", "--deep", "--strict", "-R=\(requirement)", app.path])
        // Gatekeeper's own verdict: Developer ID and notarized.
        try shell("/usr/sbin/spctl", ["--assess", "--type", "execute", app.path])
        let info = Bundle(url: app)?.infoDictionary
        guard info?["CFBundleIdentifier"] as? String == Bundle.main.bundleIdentifier else { throw err("different bundle id; refusing") }
        guard info?["CFBundleShortVersionString"] as? String == version else { throw err("version inside does not match the release") }
    }

    private func waitUntilIdle() async {
        while await MainActor.run(body: { isBusy() }) {
            try? await Task.sleep(nanoseconds: 30_000_000_000)
        }
    }

    @MainActor
    private func swap(to staged: URL, version: String) throws {
        let here = Bundle.main.bundleURL
        let old = here.deletingLastPathComponent().appendingPathComponent(".Gepetel-previous.app")
        try? fm.removeItem(at: old)
        try fm.moveItem(at: here, to: old)
        do {
            try fm.moveItem(at: staged, to: here)
        } catch {
            try? fm.moveItem(at: old, to: here)   // put it back
            throw error
        }
        log("updater: installed \(version), relaunching")
        // Launched after this process has gone, so there is never two of us.
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sh")
        p.arguments = ["-c", "sleep 2; /usr/bin/open \"$0\"", here.path]
        try p.run()
        NSApp.terminate(nil)
    }

    private func cleanUpPrevious() {
        let old = Bundle.main.bundleURL.deletingLastPathComponent().appendingPathComponent(".Gepetel-previous.app")
        try? fm.removeItem(at: old)
    }

    // MARK: - pieces

    static func teamID(of app: URL) -> String? {
        var code: SecStaticCode?
        guard SecStaticCodeCreateWithPath(app as CFURL, [], &code) == errSecSuccess, let code else { return nil }
        var info: CFDictionary?
        guard SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
              let dict = info as? [String: Any] else { return nil }
        let team = dict[kSecCodeInfoTeamIdentifier as String] as? String
        return (team?.isEmpty == false) ? team : nil
    }

    /// 0.4.10 is newer than 0.4.9; anything unparsable is never newer.
    static func isNewer(_ a: String, than b: String) -> Bool {
        let pa = a.split(separator: ".").map { Int($0) }, pb = b.split(separator: ".").map { Int($0) }
        guard !pa.isEmpty, !pa.contains(nil), !pb.contains(nil) else { return false }
        for i in 0..<max(pa.count, pb.count) {
            let x = i < pa.count ? pa[i]! : 0, y = i < pb.count ? pb[i]! : 0
            if x != y { return x > y }
        }
        return false
    }

    @discardableResult
    private func shell(_ tool: String, _ args: [String]) throws -> String {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: tool)
        p.arguments = args
        let out = Pipe()
        p.standardOutput = out
        p.standardError = out
        try p.run()
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        let text = String(decoding: data, as: UTF8.self)
        guard p.terminationStatus == 0 else { throw err("\((tool as NSString).lastPathComponent) failed: \(text.prefix(200))") }
        return text
    }

    private func err(_ s: String) -> NSError {
        NSError(domain: "Gepetel.Updater", code: 1, userInfo: [NSLocalizedDescriptionKey: s])
    }
}

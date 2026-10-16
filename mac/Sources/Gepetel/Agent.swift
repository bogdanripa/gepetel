// Keeps the agent running, and runs its one-shot commands.
//
// The agent is the Node program in ../agent, unchanged: the app is a supervisor
// and a face for it, not a second implementation. It runs as a child with
// GEPETEL_APP=1, which makes it print one `@status {json}` line per change —
// that, not its prose, is what this reads. Its stdin is a pipe from here, so
// if this app dies the agent notices and stops rather than lingering as an
// online computer with no menu bar to stop it.
import Foundation
import AppKit

enum AgentState: Equatable {
    case stopped
    case connecting
    case online(String)
    case busy(String)
    case offline(String)
    /// The server does not know this Mac (never paired, or revoked).
    /// Restarting would not help; a new code would.
    case unpaired(String)
    /// The bundled agent could not even start.
    case broken(String)
}

struct Paths {
    let node: URL
    let script: URL

    /// Inside the app in a real build; overridable for running from a
    /// checkout (`GEPETEL_NODE`, `GEPETEL_AGENT_DIR`).
    static func resolve() -> Paths {
        let env = ProcessInfo.processInfo.environment
        let res = Bundle.main.resourceURL ?? URL(fileURLWithPath: ".")
        let node = env["GEPETEL_NODE"].map { URL(fileURLWithPath: $0) }
            ?? res.appendingPathComponent("node/bin/node")
        let agentDir = env["GEPETEL_AGENT_DIR"].map { URL(fileURLWithPath: $0) }
            ?? res.appendingPathComponent("agent")
        return Paths(node: node, script: agentDir.appendingPathComponent("dist/index.js"))
    }

    static var home: URL { FileManager.default.homeDirectoryForCurrentUser }
    static var configFile: URL {
        home.appendingPathComponent("Library/Application Support/Gepetel/agent.json")
    }
    static var workspace: URL { home.appendingPathComponent("Gepetel/workspace") }
    static var logFile: URL { home.appendingPathComponent("Library/Logs/Gepetel/agent.log") }
}

/// The agent's settings file, which it also reads — non-secret settings only.
/// The tokens are in the Keychain (Keychain.swift); a token still in this file
/// is from before that, and is moved at launch. Written back 0600 all the same.
enum AgentConfig {
    static func readFile() -> [String: Any] {
        guard let data = try? Data(contentsOf: Paths.configFile),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
        return obj
    }

    private static func has(_ key: String) -> Bool {
        if let v = Keychain.get(key), !v.isEmpty { return true }
        return ((readFile()[key] as? String) ?? "").isEmpty == false
    }

    /// A token and the settings that go with it: a token alone (its folder
    /// deleted) is left over, not a pairing.
    static var isPaired: Bool { has("device_token") && hasServer }

    /// Where the relay is: written when pairing.
    static var hasServer: Bool { (readFile()["ws_url"] as? String).map { !$0.isEmpty } ?? false }

    /// `shell_network` absent means on — the agent's own default.
    static var networkOn: Bool { (readFile()["shell_network"] as? Bool) ?? true }

    /// A token from the Playwright Extension is saved: browsing is set up.
    static var chromeConnected: Bool { has("chrome_token") }

    /// A setting. Tokens go to the Keychain, everything else to the file.
    static func set(_ key: String, _ value: Any) throws {
        if key == "device_token" || key == "chrome_token" {
            guard let v = value as? String, Keychain.set(key, v) else {
                throw NSError(domain: "Gepetel", code: 1, userInfo: [NSLocalizedDescriptionKey: "The Keychain didn't accept it."])
            }
            var obj = readFile()
            if obj.removeValue(forKey: key) != nil { try write(obj) }
            return
        }
        var obj = readFile()
        guard !obj.isEmpty else { return }   // not paired yet: nothing to attach a setting to
        obj[key] = value
        try write(obj)
    }

    static func write(_ obj: [String: Any]) throws {
        try writeFileAtomically(try JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .sortedKeys]), to: Paths.configFile)
    }
}

/// Append-only, rotated at 5 MB so a chatty month cannot fill a disk.
final class LogFile {
    private let url = Paths.logFile
    private var handle: FileHandle?
    private let queue = DispatchQueue(label: "gepetel.log")

    func write(_ line: String) {
        queue.async {
            let fm = FileManager.default
            if self.handle == nil {
                try? fm.createDirectory(at: self.url.deletingLastPathComponent(), withIntermediateDirectories: true)
                if let size = (try? fm.attributesOfItem(atPath: self.url.path))?[.size] as? Int, size > 5_000_000 {
                    let old = self.url.appendingPathExtension("1")
                    try? fm.removeItem(at: old)
                    try? fm.moveItem(at: self.url, to: old)
                }
                if !fm.fileExists(atPath: self.url.path) { fm.createFile(atPath: self.url.path, contents: nil) }
                self.handle = try? FileHandle(forWritingTo: self.url)
                _ = try? self.handle?.seekToEnd()
            }
            let stamp = ISO8601DateFormatter().string(from: Date())
            self.handle?.write(Data("\(stamp) \(line)\n".utf8))
        }
    }
}

final class Agent {
    var onChange: ((AgentState) -> Void)?
    private(set) var state: AgentState = .stopped {
        didSet { if state != oldValue { onChange?(state) } }
    }

    private let paths = Paths.resolve()
    private let log = LogFile()
    private var proc: Process?
    private var stdin: Pipe?
    private var wanted = false
    private var backoff: TimeInterval = 2
    private var startedAt = Date()
    private var restart: DispatchWorkItem?

    var isRunning: Bool { proc?.isRunning ?? false }

    /// A line from the app itself, into the same log as the agent's.
    func note(_ line: String) { log.write(line) }

    /// Run, and keep running: a crash or a lost network is retried with
    /// backoff; only "unpaired" stops it, because no retry fixes that.
    func start() {
        wanted = true
        restart?.cancel()
        if isRunning { return }
        launch()
    }

    func stop(then done: (() -> Void)? = nil) {
        wanted = false
        restart?.cancel()
        guard let p = proc, p.isRunning else { state = .stopped; done?(); return }
        p.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async { self?.proc = nil; self?.state = .stopped; done?() }
        }
        p.terminate()
    }

    /// "Stop Everything" in the menu: every job on this Mac ends now — a
    /// browse going round in circles, a long command — and the agent stays
    /// connected. It tells the relay, so the chat knows too.
    func stopAllJobs() {
        guard isRunning, stdin != nil else { return }
        send("{\"t\":\"stop-all\"}\n")
        log.write("app: stop everything")
    }

    /// For quitting: stop the agent and wait for it, here, on this thread.
    /// `stop(then:)` reports back on the main thread, which is exactly the
    /// thread a quitting app is blocking — waiting for it deadlocked until a
    /// timeout, so every Quit took three seconds.
    func stopNow(timeout: TimeInterval = 3) {
        wanted = false
        restart?.cancel()
        guard let p = proc, p.isRunning else { return }
        p.terminationHandler = nil
        p.terminate()
        let deadline = Date().addingTimeInterval(timeout)
        while p.isRunning && Date() < deadline { usleep(20_000) }
        if p.isRunning { kill(p.processIdentifier, SIGKILL) }
        proc = nil
    }

    private func launch() {
        guard FileManager.default.isExecutableFile(atPath: paths.node.path),
              FileManager.default.fileExists(atPath: paths.script.path) else {
            state = .broken("The app is missing its agent. Download Gepetel again.")
            return
        }
        let p = Process()
        p.executableURL = paths.node
        p.arguments = [paths.script.path, "run"]
        p.environment = environment()
        let out = Pipe(), inp = Pipe()
        p.standardOutput = out
        p.standardError = out
        p.standardInput = inp
        var buffer = Data()
        out.fileHandleForReading.readabilityHandler = { [weak self] h in
            let chunk = h.availableData
            if chunk.isEmpty { h.readabilityHandler = nil; return }
            buffer.append(chunk)
            while let nl = buffer.firstIndex(of: 0x0A) {
                let line = String(decoding: buffer[buffer.startIndex..<nl], as: UTF8.self)
                buffer.removeSubrange(buffer.startIndex...nl)
                DispatchQueue.main.async { self?.handle(line) }
            }
        }
        p.terminationHandler = { [weak self] proc in
            let code = proc.terminationStatus
            DispatchQueue.main.async { self?.exited(code) }
        }
        do {
            try p.run()
            proc = p
            stdin = inp
            // The tokens, from the Keychain, as the first line on its stdin.
            send(Keychain.secretsLine())
            startedAt = Date()
            state = .connecting
            log.write("app: started agent (pid \(p.processIdentifier))")
        } catch {
            state = .broken("The agent could not start: \(error.localizedDescription)")
            log.write("app: could not start agent: \(error)")
        }
    }

    /// Real input asked for by the agent (OSInput): performed off the main
    /// thread, one at a time, and answered on its stdin.
    private let inputQueue = DispatchQueue(label: "gepetel.osinput")

    /// Into the agent's stdin. A dead agent's pipe throws (SIGPIPE is
    /// ignored, main.swift): that's dropped here, and its exit handled in
    /// exited() — never a crash of the app.
    private func send(_ text: String) { Self.send(text, to: stdin) }
    private static func send(_ text: String, to pipe: Pipe?) {
        try? pipe?.fileHandleForWriting.write(contentsOf: Data(text.utf8))
    }

    /// One of the agent's requests — `prefix` then JSON — answered with one
    /// JSON line on its stdin: the answer, with `t` and the request's id.
    /// `answer` runs on `queue` (here, on the main thread, when nil) and does
    /// its own logging: the op and the outcome, never a value.
    private func serve(line: String, prefix: String, t: String, queue: DispatchQueue? = nil, answer: @escaping ([String: Any]) -> [String: Any]) -> Bool {
        guard line.hasPrefix(prefix) else { return false }
        guard let data = line.dropFirst(prefix.count).data(using: .utf8),
              let req = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return true }
        let id = req["id"] as? String ?? ""
        let reply = { [weak self] in
            var out = answer(req)
            out["t"] = t; out["id"] = id
            guard let d = try? JSONSerialization.data(withJSONObject: out), let s = String(data: d, encoding: .utf8) else { return }
            if Thread.isMainThread { self?.send(s + "\n") } else { DispatchQueue.main.async { self?.send(s + "\n") } }
        }
        if let queue { queue.async(execute: reply) } else { reply() }
        return true
    }

    private func handle(_ line: String) {
        // People's details for a job (Phase 9; agent/src/people.ts): the list
        // of whose and which — never values — or one value at the moment of
        // typing it; kept and forgotten from the chat. Logged by op only.
        if serve(line: line, prefix: "@people ", t: "people-done", answer: { [log] req in
            let op = req["op"] as? String ?? "?"
            log.write("app: people \(op)")
            let out = PeopleStore.answer(req)
            if (out["ok"] as? Bool) != true { log.write("app: people \(op) failed: \(out["why"] as? String ?? "")") }
            return out
        }) { return }
        // A saved sign-in for a job (Passwords.swift): whether there is one,
        // or the password at the moment of typing it; kept and forgotten.
        // Logged by op and outcome only — never a site, username or password.
        if serve(line: line, prefix: "@passwords ", t: "passwords-done", answer: { [log] req in
            let op = req["op"] as? String ?? "?"
            let out = PasswordStore.answer(req)
            log.write("app: passwords \(op) \((out["ok"] as? Bool) == true ? "ok" : (out["why"] as? String) == "none saved" ? "none saved" : "failed")")
            return out
        }) { return }
        // Never what's typed in the log: the op and whether it worked.
        // The passkey look runs every 2 s: logged only when it cancelled one.
        if serve(line: line, prefix: "@input ", t: "input-done", queue: inputQueue, answer: { [log] req in
            let op = req["op"] as? String ?? "?"
            if op != "passkey" { log.write("app: input \(op)") }
            let out = OSInput.perform(req)
            if (out["ok"] as? Bool) != true { log.write("app: input \(op) failed: \(out["why"] as? String ?? "")") }
            if let found = out["found"] as? String, !found.isEmpty { log.write(found.contains("saved-password") ? "app: \(found)" : "app: cancelled a passkey window (\(found))") }
            return out
        }) { return }
        log.write(line)
        guard line.hasPrefix("@status "),
              let data = line.dropFirst(8).data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let s = obj["state"] as? String else { return }
        let detail = obj["detail"] as? String ?? ""
        switch s {
        case "connecting": state = .connecting
        case "online": state = .online(detail); backoff = 2
        case "busy": state = .busy(detail)
        case "offline": state = .offline(detail)
        case "unpaired": state = .unpaired(detail)
        default: break
        }
    }

    private func exited(_ code: Int32) {
        proc = nil
        stdin = nil
        log.write("app: agent exited (\(code))")
        if case .unpaired = state { wanted = false; return }
        guard wanted else { state = .stopped; return }
        // A run that lasted a while was a good run; start the ladder again.
        if Date().timeIntervalSince(startedAt) > 60 { backoff = 2 }
        state = .offline("restarting in \(Int(backoff))s")
        let work = DispatchWorkItem { [weak self] in if self?.wanted == true { self?.launch() } }
        restart = work
        DispatchQueue.main.asyncAfter(deadline: .now() + backoff, execute: work)
        backoff = min(backoff * 2, 60)
    }

    private func environment() -> [String: String] {
        var env = ProcessInfo.processInfo.environment
        env["GEPETEL_APP"] = "1"
        // Tokens come over stdin, never argv or the environment (Keychain.swift).
        env["GEPETEL_SECRETS"] = "stdin"
        // Where Chrome is, from Launch Services — so nothing has to read
        // Chrome's own folder (macOS keeps other apps out of it).
        if let chrome = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.google.Chrome") { env["GEPETEL_CHROME"] = chrome.path }
        // This app's own binary renders SVG for `send_file` (main.swift).
        if let me = Bundle.main.executablePath { env["GEPETEL_RENDERER"] = me }
        // A login item starts with launchd's bare PATH; the agent builds the
        // sandbox's own PATH, so this only has to find the system tools.
        env["PATH"] = "/usr/bin:/bin:/usr/sbin:/sbin"
        return env
    }

    /// A one-shot agent command — pair, unpair, selftest. Off the main
    /// thread; `done` is called on it with the exit code and everything the
    /// command printed.
    func once(_ args: [String], done: @escaping (Int32, String) -> Void) {
        let paths = self.paths
        let env = environment().filter { $0.key != "GEPETEL_APP" }
        let secrets = Keychain.secretsLine()
        let log = self.log
        DispatchQueue.global(qos: .userInitiated).async {
            let p = Process()
            p.executableURL = paths.node
            p.arguments = [paths.script.path] + args
            p.environment = env
            let out = Pipe()
            p.standardOutput = out
            p.standardError = out
            let inp = Pipe()
            p.standardInput = inp
            var text = ""
            var code: Int32 = -1
            do {
                try p.run()
                Self.send(secrets, to: inp)
                try? inp.fileHandleForWriting.close()
                let data = out.fileHandleForReading.readDataToEndOfFile()
                p.waitUntilExit()
                text = String(decoding: data, as: UTF8.self)
                code = p.terminationStatus
            } catch {
                text = "Could not start the agent: \(error.localizedDescription)"
            }
            // The pairing code is in the args; never log it.
            log.write("app: ran \(args.first ?? "?") → \(code)")
            DispatchQueue.main.async { done(code, text.trimmingCharacters(in: .whitespacesAndNewlines)) }
        }
    }
}

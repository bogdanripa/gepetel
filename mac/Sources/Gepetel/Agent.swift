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

/// The agent's own settings file, which it also reads. Written back with the
/// same 0600 the agent uses, because it holds the device token.
/// The agent's settings file, which it also reads — non-secret settings only.
/// The tokens are in the Keychain (Keychain.swift); a token still in this file
/// is from before that, and is moved at launch.
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

    static var isPaired: Bool { has("device_token") }

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
        let data = try JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .sortedKeys])
        let url = Paths.configFile
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let tmp = url.deletingLastPathComponent().appendingPathComponent(".agent.json.tmp")
        FileManager.default.createFile(atPath: tmp.path, contents: nil, attributes: [.posixPermissions: 0o600])
        try data.write(to: tmp)
        if FileManager.default.fileExists(atPath: url.path) {
            _ = try FileManager.default.replaceItemAt(url, withItemAt: tmp)
        } else {
            try FileManager.default.moveItem(at: tmp, to: url)
        }
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
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
            // The tokens, from the Keychain, as the first line on its stdin.
            inp.fileHandleForWriting.write(Data(Keychain.secretsLine().utf8))
            proc = p
            stdin = inp
            startedAt = Date()
            state = .connecting
            log.write("app: started agent (pid \(p.processIdentifier))")
        } catch {
            state = .broken("The agent could not start: \(error.localizedDescription)")
            log.write("app: could not start agent: \(error)")
        }
    }

    private func handle(_ line: String) {
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
                inp.fileHandleForWriting.write(Data(secrets.utf8))
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

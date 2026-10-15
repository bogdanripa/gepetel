// The relay's memories for the About you tab (Memories.swift).
import Foundation

/// The relay's /device/memories, authenticated like /device/llm.
enum MemoryAPI {
    struct Memory {
        let id: String
        var summary: String
        var details: String
        var tags: [String]
        let createdAt: Date?
    }

    enum Failure: Error {
        case notPaired, offline, revoked, server(String)
        var words: String {
            switch self {
            case .notPaired: return "This Mac isn't connected to Gepetel yet. Memories live with your chat — connect first (Connect to Gepetel… in the menu)."
            case .offline: return "Couldn't reach Gepetel. Check the internet connection and try again."
            case .revoked: return "Gepetel doesn't know this Mac any more. Connect it again with a new code."
            case .server(let why): return "Gepetel said: \(why)"
            }
        }
    }

    /// Where the agent talks to: `server` in agent.json, written when pairing;
    /// failing that, the same host as its WebSocket.
    static var server: URL? {
        let cfg = AgentConfig.readFile()
        if let s = cfg["server"] as? String, let u = URL(string: s), u.scheme?.hasPrefix("http") == true { return u }
        guard let ws = cfg["ws_url"] as? String, var c = URLComponents(string: ws) else { return nil }
        c.scheme = c.scheme == "wss" ? "https" : "http"
        c.path = ""
        return c.url
    }

    /// The Keychain, or agent.json for a token from before the Keychain.
    static var token: String? {
        if let t = Keychain.get("device_token"), !t.isEmpty { return t }
        return (AgentConfig.readFile()["device_token"] as? String).flatMap { $0.isEmpty ? nil : $0 }
    }

    static func list(_ done: @escaping (Result<[Memory], Failure>) -> Void) {
        call("GET", "/device/memories", nil) { r in
            done(r.map { ($0 as? [[String: Any]] ?? []).compactMap(memory) })
        }
    }

    static func add(summary: String, details: String, tags: [String], _ done: @escaping (Result<Void, Failure>) -> Void) {
        call("POST", "/device/memories", ["summary": summary, "details": details, "tags": tags]) { done($0.map { _ in () }) }
    }

    static func save(_ m: Memory, _ done: @escaping (Result<Void, Failure>) -> Void) {
        call("PATCH", "/device/memories/\(m.id)", ["summary": m.summary, "details": m.details, "tags": m.tags]) { done($0.map { _ in () }) }
    }

    static func delete(_ id: String, _ done: @escaping (Result<Void, Failure>) -> Void) {
        call("DELETE", "/device/memories/\(id)", nil) { done($0.map { _ in () }) }
    }

    private static func memory(_ j: [String: Any]) -> Memory? {
        guard let id = j["id"] as? String, !id.isEmpty else { return nil }
        return Memory(id: id, summary: j["summary"] as? String ?? "", details: j["details"] as? String ?? "",
                      tags: j["tags"] as? [String] ?? [], createdAt: (j["createdAt"] as? String).flatMap(isoDate))
    }

    /// Answers on the main queue, always.
    private static func call(_ method: String, _ path: String, _ body: [String: Any]?, _ done: @escaping (Result<Any, Failure>) -> Void) {
        let finish = { (r: Result<Any, Failure>) in DispatchQueue.main.async { done(r) } }
        guard AgentConfig.isPaired, let server, let token, let url = URL(string: path, relativeTo: server) else {
            finish(.failure(.notPaired)); return
        }
        var req = URLRequest(url: url, timeoutInterval: 20)
        req.httpMethod = method
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        }
        URLSession.shared.dataTask(with: req) { data, res, err in
            guard err == nil, let http = res as? HTTPURLResponse else { finish(.failure(.offline)); return }
            let json = data.flatMap { try? JSONSerialization.jsonObject(with: $0) }
            if http.statusCode == 401 { finish(.failure(.revoked)); return }
            guard (200..<300).contains(http.statusCode) else {
                let why = (json as? [String: Any])?["error"] as? String ?? "it answered \(http.statusCode)"
                finish(.failure(.server(why))); return
            }
            finish(.success(json ?? [:]))
        }.resume()
    }
}

/// JavaScript's toISOString(), with or without the milliseconds.
func isoDate(_ s: String) -> Date? {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let d = f.date(from: s) { return d }
    f.formatOptions = [.withInternetDateTime]
    return f.date(from: s)
}

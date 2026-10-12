// The device token and the Chrome token, in the macOS Keychain.
//
// The item is created by this app, so the Keychain's access list trusts this
// app — by its code signature — and nothing else. Another process asking for
// it (a script, `security find-generic-password`, a command in the sandbox)
// gets a macOS prompt naming itself, not the token. That is the whole point of
// moving them: in agent.json, mode 0600 kept other users out but not other
// programs running as this one.
//
// The agent never reads the Keychain. The app reads it and hands the tokens
// over a pipe when it starts the agent (Agent.swift); after pairing, the agent
// hands the new token back up the same way.
//
// The service is the bundle id, so a development build (com.gepetel.app.dev)
// never touches the release's items.
import Foundation
import Security

enum Keychain {
    static var service: String { Bundle.main.bundleIdentifier ?? "com.gepetel.app" }

    static func get(_ account: String) -> String? {
        let q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return nil }
        return String(data: d, encoding: .utf8)
    }

    @discardableResult
    static func set(_ account: String, _ value: String) -> Bool {
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let data = Data(value.utf8)
        let update = SecItemUpdate(base as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if update == errSecSuccess { return true }
        guard update == errSecItemNotFound else { return false }
        var add = base
        add[kSecValueData as String] = data
        add[kSecAttrLabel as String] = "Gepetel — \(account.replacingOccurrences(of: "_", with: " "))"
        // Available once the Mac has been unlocked after starting — the agent
        // runs at login — and never synced to another device.
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
    }

    static func delete(_ account: String) {
        let q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(q as CFDictionary)
    }

    /// The line the agent reads first on its stdin.
    static func secretsLine() -> String {
        var j: [String: String] = [:]
        for k in ["device_token", "chrome_token"] { if let v = get(k) { j[k] = v } }
        let data = (try? JSONSerialization.data(withJSONObject: j)) ?? Data("{}".utf8)
        return String(decoding: data, as: UTF8.self) + "\n"
    }

    /// Tokens still in agent.json — from before this version, or from the
    /// command line — move into the Keychain. Each is read back before it is
    /// removed from the file, so a failure leaves it where it was.
    static func migrateFromFile() -> [String] {
        // A development build shares agent.json with the real app but has its
        // own Keychain items: moving the tokens would strand the real app
        // unpaired. It reads the file and leaves it alone.
        guard !service.hasSuffix(".dev") else { return [] }
        guard let data = try? Data(contentsOf: Paths.configFile),
              var obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [] }
        var moved: [String] = []
        for k in ["device_token", "chrome_token"] {
            guard let v = obj[k] as? String, !v.isEmpty else { continue }
            if set(k, v), get(k) == v {
                obj.removeValue(forKey: k)
                moved.append(k)
            }
        }
        if !moved.isEmpty { try? AgentConfig.write(obj) }
        return moved
    }

    /// Self-check: write, read back, delete — under a throwaway account.
    static func roundTrip() -> Bool {
        let account = "selfcheck-\(UUID().uuidString)"
        defer { delete(account) }
        return set(account, "x1") && get(account) == "x1" && set(account, "x2") && get(account) == "x2"
    }
}

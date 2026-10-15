// One sealed file in the agent's folder: people.enc (People.swift) and
// passwords.enc (Passwords.swift). Each is one AES-GCM sealed box (CryptoKit;
// a fresh random nonce on every write), its 256-bit key in the Keychain under
// its own account, its own AAD bound into the seal.
//
// Each store keeps the JSON date coding it was first written with: people.enc
// has JSONEncoder's default, passwords.enc ISO-8601 — the owner's files must
// still open.
import Foundation
import CryptoKit

struct SealedStore<Envelope: Codable> {
    enum Dates { case standard, iso8601 }

    /// The file's name in the agent's folder.
    let name: String
    let keyAccount: String
    /// Bound into the seal: a box made for something else won't open as this.
    let aad: Data
    /// "people", "passwords" — for what the person is told.
    let noun: String
    let dates: Dates

    var file: URL { SiteFiles.dir.appendingPathComponent(name) }

    enum Failure: LocalizedError {
        case noKey(String), unreadable(String), keychain
        var errorDescription: String? {
            switch self {
            case .noKey(let noun): return "The key to the \(noun) file isn't in this Mac's Keychain, so it can't be opened. Nothing was changed. (A development build has its own Keychain items and can't open the release's file.)"
            case .unreadable(let noun): return "The \(noun) file couldn't be opened — it isn't one this app wrote, or it was damaged. Nothing was changed."
            case .keychain: return "The Keychain didn't accept the key, so nothing was saved."
            }
        }
    }

    private var encoder: JSONEncoder { let e = JSONEncoder(); if dates == .iso8601 { e.dateEncodingStrategy = .iso8601 }; return e }
    private var decoder: JSONDecoder { let d = JSONDecoder(); if dates == .iso8601 { d.dateDecodingStrategy = .iso8601 }; return d }

    /// What's in the file, or nil when there's no file yet.
    func load() throws -> Envelope? {
        guard let sealed = try? Data(contentsOf: file) else { return nil }
        guard let key = existingKey() else { throw Failure.noKey(noun) }
        do {
            let plain = try AES.GCM.open(try AES.GCM.SealedBox(combined: sealed), using: key, authenticating: aad)
            return try decoder.decode(Envelope.self, from: plain)
        } catch { throw Failure.unreadable(noun) }
    }

    func save(_ envelope: Envelope) throws {
        // A file with no key is someone's data we can't read: never write a
        // new key over it.
        let key: SymmetricKey
        if let k = existingKey() { key = k }
        else if FileManager.default.fileExists(atPath: file.path) { throw Failure.noKey(noun) }
        else { key = try newKey() }
        let plain = try encoder.encode(envelope)
        // seal() picks a random 96-bit nonce each call; combined = nonce + ciphertext + tag.
        guard let sealed = try AES.GCM.seal(plain, using: key, authenticating: aad).combined else { throw Failure.unreadable(noun) }
        try writeFileAtomically(sealed, to: file)
    }

    private func existingKey() -> SymmetricKey? {
        guard let b64 = Keychain.get(keyAccount), let d = Data(base64Encoded: b64), d.count == 32 else { return nil }
        return SymmetricKey(data: d)
    }

    private func newKey() throws -> SymmetricKey {
        let key = SymmetricKey(size: .bits256)
        let b64 = key.withUnsafeBytes { Data($0).base64EncodedString() }
        // Read back before anything is sealed with it.
        guard Keychain.set(keyAccount, b64), Keychain.get(keyAccount) == b64 else { throw Failure.keychain }
        return key
    }
}

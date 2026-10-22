import Foundation
import Network

/// App 內的小型網頁伺服器（只聽 127.0.0.1）：提供 App 裡的 web 資料夾（和線上版同一份網頁）。
/// 用 http://127.0.0.1 載入才算「安全來源」：ES 模組、IndexedDB、麥克風都能用。
/// 固定埠號，網頁資料（權杖、產生紀錄、自訂聲音）綁在這個網址上，每次開啟都還在。
final class LocalServer {
    static let shared = LocalServer()
    private(set) var port: UInt16 = 48181
    private var listener: NWListener?
    private let queue = DispatchQueue(label: "xkt.server", attributes: .concurrent)
    private let root = Bundle.main.url(forResource: "web", withExtension: nil)!
    /// 代號 → 從「檔案」App 開啟的專案檔（網頁用 /__xke_file/代號 讀取）
    private var files: [String: URL] = [:]
    private let lock = NSLock()

    var url: URL { URL(string: "http://127.0.0.1:\(port)/")! }

    func start() {
        for p in [UInt16(48181), 48182, 48183, 0] {
            do {
                let params = NWParameters.tcp
                params.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: p)!)
                params.allowLocalEndpointReuse = true
                let l = try NWListener(using: params)
                let ready = DispatchSemaphore(value: 0)
                var ok = false
                l.stateUpdateHandler = { st in
                    switch st {
                    case .ready: ok = true; ready.signal()
                    case .failed, .cancelled: ready.signal()
                    default: break
                    }
                }
                l.newConnectionHandler = { [weak self] c in self?.handle(c) }
                l.start(queue: queue)
                _ = ready.wait(timeout: .now() + 2)
                if ok { listener = l; port = l.port?.rawValue ?? p; return }
                l.cancel()
            } catch { continue }
        }
    }

    func register(_ file: URL) -> String {
        let token = UUID().uuidString.replacingOccurrences(of: "-", with: "")
        lock.lock(); files[token] = file; lock.unlock()
        return token
    }

    private func handle(_ c: NWConnection) {
        c.start(queue: queue)
        var buf = Data()
        func read() {
            c.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, done, err in
                guard let self else { return }
                if let data { buf.append(data) }
                if let end = buf.range(of: Data("\r\n\r\n".utf8)) {
                    let head = String(decoding: buf[..<end.lowerBound], as: UTF8.self)
                    self.respond(c, head: head)
                } else if done || err != nil || buf.count > 1_000_000 {
                    c.cancel()
                } else { read() }
            }
        }
        read()
    }

    private func respond(_ c: NWConnection, head: String) {
        let first = head.split(separator: "\r\n").first.map(String.init) ?? ""
        let parts = first.split(separator: " ")
        var path = parts.count > 1 ? String(parts[1]) : "/"
        if let q = path.firstIndex(of: "?") { path = String(path[..<q]) }
        path = path.removingPercentEncoding ?? path
        if path == "/" { path = "/index.html" }
        var body: Data?
        var type = "application/octet-stream"
        if path.hasPrefix("/__xke_file/") {
            let token = String(path.dropFirst("/__xke_file/".count))
            lock.lock(); let f = files[token]; lock.unlock()
            if let f {
                let ok = f.startAccessingSecurityScopedResource()
                body = try? Data(contentsOf: f)
                if ok { f.stopAccessingSecurityScopedResource() }
            }
        } else if !path.contains("..") {
            let file = root.appendingPathComponent(String(path.dropFirst()))
            body = try? Data(contentsOf: file)
            type = Self.mime(file.pathExtension.lowercased())
        }
        var h: String
        if let body {
            h = "HTTP/1.1 200 OK\r\nContent-Type: \(type)\r\nContent-Length: \(body.count)\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n"
            var out = Data(h.utf8); out.append(body)
            c.send(content: out, completion: .contentProcessed { _ in c.cancel() })
        } else {
            h = "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            c.send(content: Data(h.utf8), completion: .contentProcessed { _ in c.cancel() })
        }
    }

    static func mime(_ ext: String) -> String {
        switch ext {
        case "html": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json": return "application/json; charset=utf-8"
        case "webmanifest": return "application/manifest+json"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "wasm": return "application/wasm"
        case "md": return "text/plain; charset=utf-8"
        case "mp3": return "audio/mpeg"
        case "ico": return "image/x-icon"
        default: return "application/octet-stream"
        }
    }
}

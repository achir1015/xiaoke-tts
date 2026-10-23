import SwiftUI
import UIKit
import WebKit

/// 小柯機器人台灣語音 MP3 工具 — iPhone／iPad 版
/// WKWebView 開啟 App 內建的網頁（和線上版同一份），由 LocalServer 在 127.0.0.1 提供。
/// 打開就能用：語音引擎由網頁自動連線；App 進入背景太久或被關掉時，系統會停止網頁，所有工作一起結束。
@main
struct XiaokeTTSApp: App {
    init() { LocalServer.shared.start() }

    var body: some Scene {
        WindowGroup {
            WebContainer()
                .background(Color(red: 0.957, green: 0.965, blue: 0.961))
                .ignoresSafeArea(.container, edges: .bottom)
        }
    }
}

struct WebContainer: UIViewRepresentable {
    func makeUIView(context: Context) -> WKWebView { Web.shared.view }
    func updateUIView(_ v: WKWebView, context: Context) {}
}

/// 網頁與 App 之間的橋：網頁呼叫 window.webkit.messageHandlers.xkt.postMessage({cmd, args})，回傳 Promise
final class Web: NSObject, WKScriptMessageHandlerWithReply, WKNavigationDelegate, WKUIDelegate {
    static let shared = Web()
    let view: WKWebView
    private var saves: [String: (url: URL, handle: FileHandle, name: String)] = [:]

    override init() {
        let cfg = WKWebViewConfiguration()
        cfg.allowsInlineMediaPlayback = true
        cfg.mediaTypesRequiringUserActionForPlayback = []
        cfg.websiteDataStore = .default()
        // 讓網頁知道自己在 iPhone App 裡（網頁的 js/desktop.js 會改用 App 的存檔、開網址功能）
        let shim = WKUserScript(source: "window.XiaokeIOS = true;", injectionTime: .atDocumentStart, forMainFrameOnly: true)
        cfg.userContentController.addUserScript(shim)
        view = WKWebView(frame: .zero, configuration: cfg)
        super.init()
        cfg.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "xkt")
        view.navigationDelegate = self
        view.uiDelegate = self
        view.isOpaque = false
        view.backgroundColor = UIColor(red: 0.957, green: 0.965, blue: 0.961, alpha: 1)
        view.scrollView.backgroundColor = view.backgroundColor
        if #available(iOS 16.4, *) { view.isInspectable = true }
        view.load(URLRequest(url: LocalServer.shared.url))
    }

    // 外部連結（申請權杖、GitHub）用 Safari 開
    func webView(_ w: WKWebView, decidePolicyFor a: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let u = a.request.url, u.host != "127.0.0.1", u.scheme?.hasPrefix("http") == true, a.targetFrame?.isMainFrame != false {
            UIApplication.shared.open(u); decisionHandler(.cancel); return
        }
        decisionHandler(.allow)
    }
    func webView(_ w: WKWebView, createWebViewWith c: WKWebViewConfiguration, for a: WKNavigationAction, windowFeatures f: WKWindowFeatures) -> WKWebView? {
        if let u = a.request.url { UIApplication.shared.open(u) }
        return nil
    }

    // 麥克風（錄聲音範本）：系統會先問一次 App 的麥克風權限，網頁這邊直接允許
    func webView(_ w: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo,
                 type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(origin.host == "127.0.0.1" && type == .microphone ? .grant : .deny)
    }

    // 網頁的 alert / confirm / prompt（刪除確認、取名字）
    func webView(_ w: WKWebView, runJavaScriptAlertPanelWithMessage m: String, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = UIAlertController(title: nil, message: m, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "好", style: .default) { _ in completionHandler() })
        present(a) { completionHandler() }
    }
    func webView(_ w: WKWebView, runJavaScriptConfirmPanelWithMessage m: String, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = UIAlertController(title: nil, message: m, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "取消", style: .cancel) { _ in completionHandler(false) })
        a.addAction(UIAlertAction(title: "確定", style: .default) { _ in completionHandler(true) })
        present(a) { completionHandler(false) }
    }
    func webView(_ w: WKWebView, runJavaScriptTextInputPanelWithPrompt p: String, defaultText d: String?, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let a = UIAlertController(title: nil, message: p, preferredStyle: .alert)
        a.addTextField { $0.text = d }
        a.addAction(UIAlertAction(title: "取消", style: .cancel) { _ in completionHandler(nil) })
        a.addAction(UIAlertAction(title: "確定", style: .default) { _ in completionHandler(a.textFields?.first?.text) })
        present(a) { completionHandler(nil) }
    }

    // MARK: 網頁呼叫的功能
    func userContentController(_ u: WKUserContentController, didReceive m: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        guard let body = m.body as? [String: Any], let cmd = body["cmd"] as? String else { replyHandler(nil, "bad message"); return }
        let args = body["args"] as? [Any] ?? []
        let s = { (i: Int) -> String in args.count > i ? "\(args[i])" : "" }
        let ver = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0"
        switch cmd {
        case "app_info":
            replyHandler(["status": "ok", "name": "小柯語音", "version": ver, "platform": "ios", "model": UIDevice.current.model], nil)
        case "begin_save":
            let name = s(0).replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: ":", with: "_")
            let dir = FileManager.default.temporaryDirectory.appendingPathComponent("export", isDirectory: true)
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let url = dir.appendingPathComponent(name.isEmpty ? "xiaoke.mp3" : name)
            try? FileManager.default.removeItem(at: url)
            FileManager.default.createFile(atPath: url.path, contents: nil)
            guard let h = try? FileHandle(forWritingTo: url) else { replyHandler(["status": "error", "message": "無法建立檔案"], nil); return }
            let token = UUID().uuidString
            saves[token] = (url, h, url.lastPathComponent)
            replyHandler(["status": "ok", "token": token, "path": url.lastPathComponent], nil)
        case "write_chunk":
            guard let sv = saves[s(0)], let d = Data(base64Encoded: s(1)) else { replyHandler(["status": "error", "message": "no session"], nil); return }
            sv.handle.write(d)
            replyHandler(["status": "ok"], nil)
        case "end_save":
            guard let sv = saves.removeValue(forKey: s(0)) else { replyHandler(["status": "error", "message": "no session"], nil); return }
            try? sv.handle.close()
            // 打開分享選單：「儲存到檔案」、AirDrop、LINE…
            share(sv.url) { done in replyHandler(done ? ["status": "ok", "path": sv.name] : ["status": "declined"], nil) }
        case "read_clipboard":
            // 系統會問一次「允許貼上嗎？」
            replyHandler(["status": "ok", "text": UIPasteboard.general.string ?? ""], nil)
        case "open_url":
            if let u = URL(string: s(0)), ["achir1015.github.io", "github.com", "huggingface.co"].contains(u.host ?? "") { UIApplication.shared.open(u) }
            replyHandler(true, nil)
        case "check_update":
            // iPhone 版由 Xcode 安裝，App 內不能自己更新：回報已是最新版
            replyHandler(["status": "ok", "current": ver, "latest": ver, "url": ""], nil)
        case "update_status":
            replyHandler(["state": "idle", "pct": 0], nil)
        default:
            replyHandler(nil, "unknown command \(cmd)")
        }
    }

    private func share(_ url: URL, done: @escaping (Bool) -> Void) {
        let vc = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        vc.completionWithItemsHandler = { _, completed, _, _ in done(completed) }
        if let p = vc.popoverPresentationController {   // iPad：從畫面中央彈出
            p.sourceView = view
            p.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 1, height: 1)
            p.permittedArrowDirections = []
        }
        present(vc) { done(false) }
    }

    private func present(_ vc: UIViewController, fail: () -> Void) {
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        var top = scene?.windows.first(where: { $0.isKeyWindow })?.rootViewController
        while let p = top?.presentedViewController { top = p }
        if let top { top.present(vc, animated: true) } else { fail() }
    }
}

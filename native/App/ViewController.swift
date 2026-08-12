import UIKit
import WebKit

// Hosts app/Main.html — the feature overview and the enable steps. The page is
// one self-contained file (inline CSS, JS and icon) and makes no network
// requests, so the web view needs no navigation policy beyond loading it.
final class ViewController: UIViewController, WKNavigationDelegate, WKScriptMessageHandler {
    // The page's host contract, unchanged from Apple's template so the page
    // stays portable: a global show(platform, enabled, useSettingsInsteadOfPreferences),
    // and an "open-preferences" message on this handler name.
    private static let messageHandlerName = "controller"

    private var webView: WKWebView!

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground

        let configuration = WKWebViewConfiguration()
        configuration.userContentController.add(self, name: Self.messageHandlerName)

        let webView = WKWebView(frame: view.bounds, configuration: configuration)
        webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        webView.navigationDelegate = self

        // IMPORTANT: Apple's template sets this to false, because the page it
        // ships is one line of placeholder text. Ours is a full overview screen,
        // so with it disabled everything below the fold is simply unreachable
        // and the app looks truncated. app/Main.html additionally scrolls its
        // own <main> in an overflow:auto container, so the page stays usable
        // even if this line is ever lost; test/extension.test.js guards both.
        webView.scrollView.isScrollEnabled = true

        // The page paints its own light/dark background. Letting it show through
        // avoids a white flash before first paint in dark mode.
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear

        view.addSubview(webView)
        self.webView = webView

        guard let url = Bundle.main.url(forResource: "Main", withExtension: "html") else {
            // Unreachable in a correctly built app: verify_ipa fails the release
            // if Main.html is not in the .app. Leaving the plain background is a
            // better failure than a crash on a user's home screen.
            return
        }
        webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // `enabled` is passed as null, not false: iOS has no API to read whether
        // a Safari extension is turned on (SFSafariExtensionManager is
        // macOS-only), and the page leaves its status line alone unless it gets
        // an actual boolean. Claiming "off" would be worse than saying nothing.
        webView.evaluateJavaScript("show('ios', null, false)", completionHandler: nil)
    }

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        // "open-preferences" backs the macOS-only button, which app/Main.html
        // hides on iOS. The handler still has to be registered — postMessage to
        // an unregistered name throws in the page.
    }
}

import SafariServices

// The appex's NSExtensionPrincipalClass (see native/Extension/Info.plist).
//
// Keep Scrolling does no native messaging: the content scripts and the popup
// are the entire product, and the extension deliberately never talks to the
// container app. This class exists only because the Safari web-extension point
// requires a principal class, so it completes every request immediately with
// nothing.
//
// If native messaging is ever added, note that it also needs a
// `nativeMessaging` permission in manifest.json — a handler alone does nothing.
final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        context.completeRequest(returningItems: nil, completionHandler: nil)
    }
}

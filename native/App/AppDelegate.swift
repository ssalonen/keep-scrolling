import UIKit

// Deliberately window-based rather than scene-based: the app is a single
// screen showing one local HTML page, and a UISceneDelegate would add a second
// lifecycle object plus a UIApplicationSceneManifest entry for no gain. Keep
// Info.plist free of a scene manifest or this `window` is never used.
@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
    ) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = ViewController()
        window.makeKeyAndVisible()
        self.window = window
        return true
    }
}

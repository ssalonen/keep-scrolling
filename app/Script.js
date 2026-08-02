// Container-app UI glue. Two contracts with the generated Swift host, both of
// which come from Apple's Safari-web-extension app template — keep them:
//
//   1. a GLOBAL `show(platform, enabled, useSettingsInsteadOfPreferences)`,
//      which the ViewController calls via evaluateJavaScript once the web view
//      finishes loading (iOS passes only the platform; macOS also passes the
//      extension's enabled state);
//   2. `webkit.messageHandlers.controller.postMessage("open-preferences")`,
//      which the macOS host answers by opening Safari's extension settings.
//      iOS has no such affordance, so that button is macOS-only.
//
// Everything here is defensive: a missing element must never throw, because an
// exception in show() would leave the page stuck in its default state.

function show(platform, enabled, useSettingsInsteadOfPreferences) {
    document.body.classList.add(`platform-${platform}`);

    const status = document.getElementById('status');
    if (status && typeof enabled === 'boolean') {
        status.textContent = enabled ? 'Extension is on' : 'Extension is off';
    }

    if (useSettingsInsteadOfPreferences) {
        const button = document.querySelector('button.open-preferences');
        if (button) {
            button.textContent = 'Quit and Open Safari Settings…';
        }
    }
}

function openPreferences() {
    webkit.messageHandlers.controller.postMessage('open-preferences');
}

document.addEventListener('DOMContentLoaded', () => {
    const button = document.querySelector('button.open-preferences');
    if (button) {
        button.addEventListener('click', openPreferences);
    }

    // The Fastfile substitutes the real version into Main.html at build time.
    // If the placeholder survived (someone opened the file directly, or the
    // substitution was skipped), show nothing rather than a raw token.
    const version = document.getElementById('version');
    if (version && version.textContent.includes('__APP_VERSION__')) {
        version.remove();
    }
});

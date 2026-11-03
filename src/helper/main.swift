// DSH Attention beacon — the native half of the dsh-dock-attention plugin.
//
// DeepSeek Harness Desktop is an Electron app: the Dock tile and `app.dock.bounce()`
// belong to the Electron main process, and a Host plugin runs in a separate Node
// child process that cannot reach it. The only way a plugin can honestly make a
// Dock icon bounce on macOS is to own a Dock tile — so this tiny app does:
//
//   * it is a regular app (no LSUIElement) launched with `open -n -g`, so it owns
//     a normal Dock tile without becoming frontmost;
//   * it asks AppKit for user attention, so that tile bounces;
//   * it quits as soon as the target app comes to the front, when the tile is
//     clicked, or after the configured time budget — taking its tile with it.
//
// Do NOT start this app as a background agent (LSUIElement) and promote it to a
// regular app at runtime: such a promoted tile is a Dock item LaunchServices
// cannot reopen, so a click on it makes macOS reveal the bundle in Finder instead
// of activating the app — the click never reaches this delegate.
//
// The Host plugin writes runtime/request.json next to the plugin package and
// launches this app with `open -n -g`, so the beacon is configured out-of-band.

import Cocoa

/// The request written by the Host plugin before every launch.
struct AttentionRequest: Codable {
    var targetBundleId: String = "com.deepseek.dsh"
    var mode: String = "critical"           // "critical" | "informational"
    var timeoutSeconds: Double = 30
    var repeatCount: Int = 3                // informational mode: how many single bounces
    var openUrl: String? = nil              // fallback when the target app is not installed

    init() {}

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        targetBundleId = try container.decodeIfPresent(String.self, forKey: .targetBundleId) ?? targetBundleId
        mode = try container.decodeIfPresent(String.self, forKey: .mode) ?? mode
        timeoutSeconds = try container.decodeIfPresent(Double.self, forKey: .timeoutSeconds) ?? timeoutSeconds
        repeatCount = try container.decodeIfPresent(Int.self, forKey: .repeatCount) ?? repeatCount
        openUrl = try container.decodeIfPresent(String.self, forKey: .openUrl)
    }
}

enum BeaconMode: String {
    case informational
    case critical
}

// MARK: - Paths

/// `<plugin>/bin/DSH Attention.app` → `<plugin>`
func pluginRoot() -> URL? {
    let bundle = Bundle.main.bundleURL
    guard bundle.pathExtension == "app" else { return nil }
    return bundle.deletingLastPathComponent().deletingLastPathComponent()
}

func argumentValue(_ name: String) -> String? {
    let prefix = "--\(name)="
    for argument in CommandLine.arguments.dropFirst() where argument.hasPrefix(prefix) {
        return String(argument.dropFirst(prefix.count))
    }
    return nil
}

func resolveRequestPath() -> URL? {
    if let explicit = argumentValue("request") { return URL(fileURLWithPath: explicit) }
    guard let root = pluginRoot() else { return nil }
    return root.appendingPathComponent("runtime", isDirectory: true).appendingPathComponent("request.json")
}

func resolveLogPath() -> URL? {
    if let explicit = argumentValue("log") { return URL(fileURLWithPath: explicit) }
    guard let root = pluginRoot() else { return nil }
    return root.appendingPathComponent("runtime", isDirectory: true).appendingPathComponent("helper.log")
}

// MARK: - Logging

/// Best-effort diagnostics: the plugin runtime directory first, a temp file as fallback.
final class FileLog {
    private let urls: [URL]

    init() {
        var candidates: [URL] = []
        if let primary = resolveLogPath() { candidates.append(primary) }
        candidates.append(FileManager.default.temporaryDirectory.appendingPathComponent("dsh-dock-attention-helper.log"))
        urls = candidates
    }

    private func append(_ line: String, to url: URL) -> Bool {
        let manager = FileManager.default
        try? manager.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        if let attributes = try? manager.attributesOfItem(atPath: url.path),
           let size = attributes[.size] as? Int, size > 256 * 1024 {
            try? manager.removeItem(at: url)
        }
        if let handle = FileHandle(forWritingAtPath: url.path) {
            defer { try? handle.close() }
            handle.seekToEndOfFile()
            handle.write(Data(line.utf8))
            return true
        }
        return (try? Data(line.utf8).write(to: url)) != nil
    }

    func write(_ message: String) {
        let formatter = ISO8601DateFormatter()
        let line = "[\(formatter.string(from: Date()))] \(message)\n"
        FileHandle.standardError.write(Data(line.utf8))
        for url in urls where append(line, to: url) { return }
    }
}

let log = FileLog()

func loadRequest() -> AttentionRequest {
    guard let path = resolveRequestPath(), let data = try? Data(contentsOf: path) else {
        log.write("request file is missing at \(resolveRequestPath()?.path ?? "<unknown>"); using defaults")
        return AttentionRequest()
    }
    do {
        return try JSONDecoder().decode(AttentionRequest.self, from: data)
    } catch {
        log.write("request file is invalid (\(error.localizedDescription)); using defaults")
        return AttentionRequest()
    }
}

// MARK: - Application

final class AttentionDelegate: NSObject, NSApplicationDelegate {
    private let request = loadRequest()
    private var mode: BeaconMode { BeaconMode(rawValue: request.mode) ?? .critical }
    private var attentionId = 0
    private var finished = false
    private var launched = false
    private var switching = false
    /// How many times to re-try raising the target before quitting anyway.
    private let activationAttempts = 4

    func applicationDidFinishLaunching(_ notification: Notification) {
        guard admitSingleInstance() else { return }
        launched = true

        // The bundle is a regular app, so it already owns a Dock tile. Keep the
        // policy regular even if an older Info.plist (LSUIElement) is in use: a
        // background agent promoted here would produce a tile that LaunchServices
        // cannot reopen, and clicking it opens Finder instead of this app.
        if NSApp.activationPolicy() != .regular {
            _ = NSApp.setActivationPolicy(.regular)
        }

        log.write("launched pid=\(ProcessInfo.processInfo.processIdentifier) target=\(request.targetBundleId) mode=\(mode.rawValue) timeout=\(request.timeoutSeconds) repeat=\(request.repeatCount) policy=\(NSApp.activationPolicy().rawValue) active=\(NSApp.isActive)")

        // The Dock registers the fresh tile a moment after launch; request
        // attention once it exists, otherwise the request is silently dropped.
        Timer.scheduledTimer(withTimeInterval: 0.7, repeats: false) { [weak self] _ in
            self?.requestAttention()
            self?.scheduleRepeats()
        }
        Timer.scheduledTimer(withTimeInterval: 0.4, repeats: true) { [weak self] _ in
            self?.pollTargetActivation()
        }
        let deadline = max(2, request.timeoutSeconds)
        Timer.scheduledTimer(withTimeInterval: deadline, repeats: false) { [weak self] _ in
            self?.finish(reason: "timeout")
        }
    }

    private func admitSingleInstance() -> Bool {
        guard let bundleId = Bundle.main.bundleIdentifier else { return true }
        let peers = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId)
        if peers.count > 1 {
            log.write("another beacon instance is already running (peers=\(peers.count)); exiting")
            NSApp.terminate(nil)
            return false
        }
        return true
    }

    private func requestAttention() {
        guard launched, !finished else { return }
        let type: NSApplication.RequestUserAttentionType = mode == .informational ? .informationalRequest : .criticalRequest
        attentionId = NSApp.requestUserAttention(type)
        log.write("requestUserAttention(\(mode.rawValue)) -> id=\(attentionId)")
    }

    /// An informational request bounces once; repeat it so a user who is away still
    /// notices the motion instead of a single blink.
    private func scheduleRepeats() {
        guard mode == .informational, request.repeatCount > 1 else { return }
        var remaining = min(request.repeatCount, 20) - 1
        Timer.scheduledTimer(withTimeInterval: 1.15, repeats: true) { [weak self] timer in
            guard let self, !self.finished, remaining > 0 else {
                timer.invalidate()
                return
            }
            remaining -= 1
            self.requestAttention()
        }
    }

    private func pollTargetActivation() {
        guard launched, !finished else { return }
        guard let frontmost = NSWorkspace.shared.frontmostApplication?.bundleIdentifier else { return }
        if frontmost == request.targetBundleId {
            finish(reason: "target-active")
        }
    }

    /// Bring the target app to the front and disappear. This is the whole point of
    /// the Dock tile: a click on it must land the user in DeepSeek Harness, never in
    /// Finder or any other app.
    private func switchToTarget(reason: String, attempt: Int = 1) {
        guard launched, !finished else { return }

        if attempt == 1 {
            if switching { return }
            switching = true
            log.write("switching to target reason=\(reason)")
        }

        if let app = NSRunningApplication.runningApplications(withBundleIdentifier: request.targetBundleId).first {
            // `activateAllWindows` raises hidden or minimised target windows;
            // ignoring other apps keeps the focus request valid while the beacon
            // itself is the active app.
            let activated = app.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])
            log.write("activating target pid=\(app.processIdentifier) attempt=\(attempt) activated=\(activated)")
            if activated {
                finish(reason: "target-activated")
                return
            }
        } else if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: request.targetBundleId) {
            // The target is not running yet: let LaunchServices start it in front.
            log.write("opening target at \(url.path) attempt=\(attempt)")
            let configuration = NSWorkspace.OpenConfiguration()
            configuration.activates = true
            NSWorkspace.shared.openApplication(at: url, configuration: configuration) { [weak self] _, error in
                guard let self, !self.finished else { return }
                if let error {
                    log.write("opening target failed: \(error.localizedDescription)")
                    self.finish(reason: "target-open-failed")
                } else {
                    self.finish(reason: "target-opened")
                }
            }
            return
        } else if let raw = request.openUrl, let url = URL(string: raw) {
            log.write("opening url \(raw) attempt=\(attempt)")
            NSWorkspace.shared.open(url)
            finish(reason: "url-opened")
            return
        } else {
            log.write("target could not be located: \(request.targetBundleId)")
            finish(reason: "no-target")
            return
        }

        // LaunchServices can be slow to hand focus over; retry briefly before quitting.
        if attempt < activationAttempts {
            Timer.scheduledTimer(withTimeInterval: 0.35, repeats: false) { [weak self] _ in
                self?.switchToTarget(reason: reason, attempt: attempt + 1)
            }
        } else {
            finish(reason: "target-not-activated")
        }
    }

    private func finish(reason: String) {
        if finished { return }
        finished = true
        if attentionId != 0 {
            NSApp.cancelUserAttentionRequest(attentionId)
            attentionId = 0
        }
        log.write("finishing reason=\(reason)")
        NSApp.terminate(nil)
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        switchToTarget(reason: "dock-click")
        return true
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        // Activating the beacon — a click on its Dock tile while it is not
        // frontmost, a Cmd-Tab selection, or LaunchServices opening the app
        // directly — always means "take me back to Harness".
        guard launched, !finished else { return }
        switchToTarget(reason: "activated")
    }
}

let application = NSApplication.shared
let delegate = AttentionDelegate()
application.delegate = delegate
application.run()

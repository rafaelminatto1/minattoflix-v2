import AVKit
import Capacitor

class MinattoBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(NativePlayerPlugin())
    }
}

private class MovieViewController: AVPlayerViewController {
    var onClose: (() -> Void)?
    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        if isBeingDismissed || presentingViewController == nil { onClose?() }
    }
}

@objc(NativePlayerPlugin)
public class NativePlayerPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativePlayerPlugin"
    public let jsName = "NativePlayer"
    public let pluginMethods: [CAPPluginMethod] = [CAPPluginMethod(name: "play", returnType: CAPPluginReturnPromise)]
    private var activeCall: CAPPluginCall?
    private var controller: MovieViewController?
    private var player: AVPlayer?
    private var observer: NSKeyValueObservation?
    private var timeObserver: Any?
    private var backgroundObserver: NSObjectProtocol?
    private var errorObserver: NSObjectProtocol?
    private var startupTimer: Timer?
    private var prepared = false

    @objc func play(_ call: CAPPluginCall) {
        guard let value = call.getString("url"), let url = URL(string: value), url.scheme == "https" else {
            call.reject("Endereço de vídeo inválido."); return
        }
        DispatchQueue.main.async { [weak self] in
            guard let self = self, let host = self.bridge?.viewController else { call.reject("Player indisponível."); return }
            guard self.activeCall == nil else { call.reject("Já existe uma reprodução aberta."); return }
            do {
                try AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
                try AVAudioSession.sharedInstance().setActive(true)
            } catch { call.reject("Não foi possível iniciar o áudio."); return }
            self.activeCall = call
            self.prepared = false
            let item = AVPlayerItem(url: url)
            item.preferredForwardBufferDuration = 5
            let player = AVPlayer(playerItem: item)
            player.automaticallyWaitsToMinimizeStalling = true
            self.player = player
            let controller = MovieViewController()
            controller.player = player
            controller.videoGravity = .resizeAspect
            controller.showsPlaybackControls = true
            controller.allowsPictureInPicturePlayback = false
            controller.modalPresentationStyle = .fullScreen
            controller.onClose = { [weak self] in self?.finish() }
            self.controller = controller
            self.timeObserver = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 5, preferredTimescale: 600), queue: .main) { [weak self] _ in
                self?.emitProgress()
            }
            self.backgroundObserver = NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
                self?.player?.pause()
                self?.emitProgress()
            }
            self.errorObserver = NotificationCenter.default.addObserver(forName: .AVPlayerItemFailedToPlayToEndTime, object: item, queue: .main) { [weak self] _ in
                self?.fail("A conexão de vídeo foi interrompida. Tente novamente.")
            }
            self.startupTimer = Timer.scheduledTimer(withTimeInterval: 45, repeats: false) { [weak self] _ in
                self?.fail("O vídeo demorou para responder. Tente novamente ou use o player alternativo.")
            }
            let start = max(0, call.getDouble("position") ?? 0)
            self.observer = item.observe(\.status, options: [.initial, .new]) { [weak self] item, _ in
                DispatchQueue.main.async {
                    guard let self = self, self.activeCall != nil else { return }
                    if item.status == .failed { self.fail("Não foi possível abrir este vídeo no player nativo."); return }
                    guard item.status == .readyToPlay, !self.prepared else { return }
                    self.prepared = true
                    let audioLanguage = call.getString("audioLanguage") ?? "pt-BR"
                    if let group = item.asset.mediaSelectionGroup(forMediaCharacteristic: .audible),
                       let option = AVMediaSelectionGroup.mediaSelectionOptions(from: group.options, with: Locale(identifier: audioLanguage)).first {
                        item.select(option, in: group)
                    }
                    if let group = item.asset.mediaSelectionGroup(forMediaCharacteristic: .legible) {
                        let language = call.getString("subtitleLanguage") ?? "off"
                        let option = language == "off" ? nil : AVMediaSelectionGroup.mediaSelectionOptions(from: group.options, with: Locale(identifier: language)).first
                        item.select(option, in: group)
                    }
                    let duration = item.duration.seconds
                    let position = duration.isFinite ? min(start, max(0, duration - 1)) : start
                    player.seek(to: CMTime(seconds: position, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] completed in
                        guard completed, let self = self, self.activeCall != nil else { return }
                        player.preroll(atRate: 1) { [weak self] ready in
                            DispatchQueue.main.async {
                                guard let self = self, self.activeCall != nil else { return }
                                guard ready else { self.fail("Não foi possível preparar áudio e vídeo."); return }
                                self.startupTimer?.invalidate()
                                player.play()
                            }
                        }
                    }
                }
            }
            host.present(controller, animated: true)
        }
    }

    private func progress() -> [String: Any] {
        let position = player?.currentTime().seconds ?? 0
        let duration = player?.currentItem?.duration.seconds ?? 0
        return ["position": position.isFinite ? max(0, position) : 0, "duration": duration.isFinite ? max(0, duration) : 0]
    }
    private func emitProgress() { notifyListeners("progress", data: progress()) }
    private func finish() {
        guard let call = activeCall else { return }
        let result = progress()
        emitProgress()
        cleanup()
        call.resolve(result)
    }
    private func fail(_ message: String) {
        guard let call = activeCall else { return }
        emitProgress()
        let view = controller
        cleanup()
        view?.dismiss(animated: true)
        call.reject(message)
    }
    private func cleanup() {
        startupTimer?.invalidate(); startupTimer = nil
        observer?.invalidate(); observer = nil
        if let token = timeObserver { player?.removeTimeObserver(token) }; timeObserver = nil
        if let token = backgroundObserver { NotificationCenter.default.removeObserver(token) }; backgroundObserver = nil
        if let token = errorObserver { NotificationCenter.default.removeObserver(token) }; errorObserver = nil
        player?.pause(); player?.replaceCurrentItem(with: nil); player = nil
        controller?.onClose = nil; controller = nil; activeCall = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}

import AVKit
import Capacitor

class MinattoBridgeViewController: CAPBridgeViewController {
    var immersive = false {
        didSet {
            guard oldValue != immersive else { return }
            setNeedsStatusBarAppearanceUpdate(); setNeedsUpdateOfHomeIndicatorAutoHidden()
            if #available(iOS 16.0, *) {
                setNeedsUpdateOfSupportedInterfaceOrientations()
                view.window?.windowScene?.requestGeometryUpdate(.iOS(interfaceOrientations: immersive ? .landscapeRight : .portrait))
            } else {
                UIViewController.attemptRotationToDeviceOrientation()
            }
        }
    }
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { immersive ? .landscapeRight : .portrait }
    override var prefersStatusBarHidden: Bool { immersive }
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(NativePlayerPlugin())
    }
}

private class MovieViewController: AVPlayerViewController {
    var onClose: (() -> Void)?
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .landscapeRight }
    override var preferredInterfaceOrientationForPresentation: UIInterfaceOrientation { .landscapeRight }

    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }
    private let controls = UIStackView()
    private let centerControls = UIStackView()
    private let timeLabel = UILabel()
    private let seekBar = UISlider()
    private let playButton = UIButton(type: .system)
    private var hideTimer: Timer?
    private var progressTimer: Timer?
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        let tap = UITapGestureRecognizer(target: self, action: #selector(toggleControls))
        tap.cancelsTouchesInView = false
        isModalInPresentation = true
        view.addGestureRecognizer(tap)
        controls.axis = .vertical; controls.spacing = 16
        controls.backgroundColor = UIColor.black.withAlphaComponent(0.7)
        controls.isLayoutMarginsRelativeArrangement = true
        controls.directionalLayoutMargins = NSDirectionalEdgeInsets(top: 16, leading: 16, bottom: 16, trailing: 16)
        let row = UIStackView(); row.distribution = .fillEqually
        let close = button("Voltar", action: #selector(closeMovie))
        let back = button("−10 s", action: #selector(skipBack))
        playButton.setImage(UIImage(systemName: "pause.fill"), for: .normal)
        playButton.setPreferredSymbolConfiguration(UIImage.SymbolConfiguration(pointSize: 32), forImageIn: .normal)
        playButton.accessibilityLabel = "Pausar"
        playButton.addTarget(self, action: #selector(togglePlayback), for: .touchUpInside)
        [close, trackMenu()].forEach { row.addArrangedSubview($0) }
        centerControls.axis = .horizontal; centerControls.spacing = 28
        [back, playButton, button("+10 s", action: #selector(skipForward))].forEach {
            $0.backgroundColor = UIColor.black.withAlphaComponent(0.55)
            $0.tintColor = .white
            $0.layer.cornerRadius = 32
            $0.widthAnchor.constraint(equalToConstant: 72).isActive = true
            $0.heightAnchor.constraint(equalToConstant: 64).isActive = true
            centerControls.addArrangedSubview($0)
        }
        centerControls.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(centerControls)
        NSLayoutConstraint.activate([centerControls.centerXAnchor.constraint(equalTo: view.centerXAnchor), centerControls.centerYAnchor.constraint(equalTo: view.centerYAnchor)])
        seekBar.accessibilityLabel = "Posição do filme"
        timeLabel.textColor = .white; timeLabel.font = .preferredFont(forTextStyle: .caption1)
        seekBar.addTarget(self, action: #selector(seekChanged), for: [.touchUpInside, .touchUpOutside, .touchCancel])
        controls.addArrangedSubview(row); controls.addArrangedSubview(seekBar); controls.addArrangedSubview(timeLabel)
        controls.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(controls)
        NSLayoutConstraint.activate([
            controls.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 12),
            controls.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -12),
            controls.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -12),
            row.heightAnchor.constraint(greaterThanOrEqualToConstant: 44)
        ])
        controls.isHidden = true; centerControls.isHidden = true
        progressTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            guard let self = self, let player = self.player else { return }
            let duration = player.currentItem?.duration.seconds ?? 0
            if duration.isFinite && duration > 0 && !self.seekBar.isTracking {
                self.seekBar.value = Float(player.currentTime().seconds / duration)
                let remaining = max(0, Int((duration - player.currentTime().seconds) / 60))
                self.timeLabel.text = "\(remaining) min restantes"
            }
            self.playButton.setImage(UIImage(systemName: player.rate == 0 ? "play.fill" : "pause.fill"), for: .normal)
            self.playButton.accessibilityLabel = player.rate == 0 ? "Reproduzir" : "Pausar"
        }
    }
    private func button(_ title: String, action: Selector) -> UIButton {
        let button = UIButton(type: .system); button.setTitle(title, for: .normal)
        button.addTarget(self, action: action, for: .touchUpInside); return button
    }
    private func trackMenu() -> UIButton {
        let button = UIButton(type: .system); button.setTitle("Áudio/legendas", for: .normal)
        button.showsMenuAsPrimaryAction = true
        button.menu = UIMenu(children: [UIDeferredMenuElement.uncached { [weak self] completion in
            guard let item = self?.player?.currentItem else { completion([]); return }
            var menus: [UIMenuElement] = []
            for characteristic in [AVMediaCharacteristic.audible, .legible] {
                guard let group = item.asset.mediaSelectionGroup(forMediaCharacteristic: characteristic) else { continue }
                var actions = group.options.map { option in
                    UIAction(title: option.displayName) { _ in item.select(option, in: group) }
                }
                if characteristic == .legible { actions.insert(UIAction(title: "Desativar legendas") { _ in item.select(nil, in: group) }, at: 0) }
                menus.append(UIMenu(title: characteristic == .audible ? "Áudio" : "Legendas", children: actions))
            }
            completion(menus)
        }])
        return button
    }
    @objc private func toggleControls(_ gesture: UITapGestureRecognizer) {
        let point = gesture.location(in: view)
        guard view.bounds.insetBy(dx: 28, dy: 28).contains(point) else { return }
        if !controls.isHidden && (controls.bounds.contains(gesture.location(in: controls)) || centerControls.bounds.contains(gesture.location(in: centerControls))) { return }
        controls.isHidden.toggle(); hideTimer?.invalidate()
        centerControls.isHidden = controls.isHidden
        if !controls.isHidden { hideTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: false) { [weak self] _ in
            self?.controls.isHidden = true; self?.centerControls.isHidden = true
        } }
    }
    @objc private func closeMovie() { dismiss(animated: true) }
    @objc private func togglePlayback() {
        if player?.rate == 0 {
            do {
                try AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
                try AVAudioSession.sharedInstance().setActive(true)
                player?.play()
            } catch { timeLabel.text = "Não foi possível retomar o áudio. Toque Play para tentar novamente." }
        } else { player?.pause() }
    }
    @objc private func skipBack() { skip(-10) }
    @objc private func skipForward() { skip(10) }
    private func skip(_ seconds: Double) {
        guard let player = player else { return }
        let duration = player.currentItem?.duration.seconds ?? 0
        let target = max(0, player.currentTime().seconds + seconds)
        player.seek(to: CMTime(seconds: duration.isFinite && duration > 0 ? min(target, duration) : target, preferredTimescale: 600))
    }
    @objc private func seekChanged() {
        guard let duration = player?.currentItem?.duration.seconds, duration.isFinite else { return }
        player?.seek(to: CMTime(seconds: Double(seekBar.value) * duration, preferredTimescale: 600))
    }
    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        hideTimer?.invalidate(); progressTimer?.invalidate()
        if isBeingDismissed || presentingViewController == nil { onClose?() }
    }
}

@objc(NativePlayerPlugin)
public class NativePlayerPlugin: CAPPlugin, CAPBridgedPlugin {
    private var lifecycleObservers: [NSObjectProtocol] = []
    public override func load() {
        for name in [UIApplication.willResignActiveNotification, UIApplication.didEnterBackgroundNotification, Notification.Name("MinattoPlaybackInactive")] {
            lifecycleObservers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                self?.playbackInterrupted = true
                self?.player?.pause()
                self?.emitProgress()
                self?.notifyListeners("playbackInactive", data: [:])
            })
        }
    }
    deinit { lifecycleObservers.forEach { NotificationCenter.default.removeObserver($0) } }
    public let identifier = "NativePlayerPlugin"
    public let jsName = "NativePlayer"
    public let pluginMethods: [CAPPluginMethod] = [CAPPluginMethod(name: "play", returnType: CAPPluginReturnPromise), CAPPluginMethod(name: "setImmersive", returnType: CAPPluginReturnPromise), CAPPluginMethod(name: "activateAudio", returnType: CAPPluginReturnPromise)]
    @objc func activateAudio(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard UIApplication.shared.applicationState == .active else { call.reject("App inativo"); return }
            do {
                try AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
                try AVAudioSession.sharedInstance().setActive(true)
                call.resolve()
            } catch { call.reject("Não foi possível ativar o áudio.") }
        }
    }
    @objc func setImmersive(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            (self?.bridge?.viewController as? MinattoBridgeViewController)?.immersive = call.getBool("enabled") ?? false
            call.resolve()
        }
    }
    private var activeCall: CAPPluginCall?
    private var controller: MovieViewController?
    private var player: AVPlayer?
    private var observer: NSKeyValueObservation?
    private var timeObserver: Any?
    private var backgroundObserver: NSObjectProtocol?
    private var errorObserver: NSObjectProtocol?
    private var startupTimer: Timer?
    private var playbackInterrupted = false
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
            self.playbackInterrupted = false
            let item = AVPlayerItem(url: url)
            item.preferredForwardBufferDuration = 5
            let player = AVPlayer(playerItem: item)
            player.automaticallyWaitsToMinimizeStalling = true
            self.player = player
            let controller = MovieViewController()
            controller.player = player
            controller.videoGravity = .resizeAspect
            controller.showsPlaybackControls = false
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
                    player.appliesMediaSelectionCriteriaAutomatically = false
                    if let group = item.asset.mediaSelectionGroup(forMediaCharacteristic: .audible) {
                        let option = AVMediaSelectionGroup.mediaSelectionOptions(from: group.options, with: Locale(identifier: "pt-BR")).first
                            ?? group.options.first { option in
                                let code = (option.extendedLanguageTag ?? option.locale?.identifier ?? "").lowercased().replacingOccurrences(of: "_", with: "-")
                                return code == "pt" || code.hasPrefix("pt-") || code == "por" || code == "pob"
                            }
                        if let option = option { item.select(option, in: group) }
                    }
                    if let group = item.asset.mediaSelectionGroup(forMediaCharacteristic: .legible) {
                        item.select(nil, in: group)
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
                                // Preparing can finish after the user locks the phone.
                                if !self.playbackInterrupted && self.controller?.view.window?.windowScene?.activationState == .foregroundActive { player.play() }
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

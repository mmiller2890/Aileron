import Foundation
import AVFoundation
import FluidAudio
import Darwin

public typealias FluidAudioProgressCallback = @convention(c) (
    UnsafeMutableRawPointer?, Double, Int32, UnsafePointer<CChar>?
) -> Void

@_silgen_name("nemo_version")
private func nemoVersionLinkAnchor() -> UnsafePointer<CChar>?

@_silgen_name("nemo_normalize")
private func nemoNormalizeLinkAnchor(_ input: UnsafePointer<CChar>?) -> UnsafeMutablePointer<CChar>?

@_silgen_name("nemo_normalize_sentence")
private func nemoNormalizeSentenceLinkAnchor(_ input: UnsafePointer<CChar>?) -> UnsafeMutablePointer<CChar>?

@_silgen_name("nemo_free_string")
private func nemoFreeStringLinkAnchor(_ output: UnsafeMutablePointer<CChar>?)

private let nemoLinkAnchor: Void = {
    "".withCString { input in
        nemoFreeStringLinkAnchor(nemoNormalizeLinkAnchor(input))
        nemoFreeStringLinkAnchor(nemoNormalizeSentenceLinkAnchor(input))
    }
    _ = nemoVersionLinkAnchor()
}()

// MARK: - Bridge Class

/// Internal bridge class that wraps FluidAudio
/// Internal diarization segment used within the bridge.
struct BridgeDiarizationSegment {
    var speakerId: String
    var startTime: Float
    var endTime: Float
    var qualityScore: Float
}

class FluidAudioBridgeInternal {
    private var asrManager: AsrManager?
    private var asrModels: AsrModels?
    private var vadManager: VadManager?
    private var vadStreamState: VadStreamState?
    private var diarizerManager: OfflineDiarizerManager?
    private var lastErrorMessage: String?

    init() {
        _ = nemoLinkAnchor
    }

    func recordError(_ error: Error) {
        lastErrorMessage = String(describing: error)
    }

    func takeLastErrorMessage() -> String? {
        defer { lastErrorMessage = nil }
        return lastErrorMessage
    }

    func initializeAsr(
        progressCallback: FluidAudioProgressCallback? = nil,
        progressContext: UnsafeMutableRawPointer? = nil
    ) throws {
        let semaphore = DispatchSemaphore(value: 0)
        var initError: Error?

        Task {
            do {
                let progressHandler: ProgressHandler? = progressCallback.map { callback in
                    { progress in
                        let phaseCode: Int32
                        let modelName: String?
                        switch progress.phase {
                        case .listing:
                            phaseCode = 0
                            modelName = nil
                        case .downloading:
                            phaseCode = 1
                            modelName = nil
                        case .compiling(let name):
                            phaseCode = 2
                            modelName = name
                        }
                        if let modelName {
                            modelName.withCString {
                                callback(progressContext, progress.fractionCompleted, phaseCode, $0)
                            }
                        } else {
                            callback(progressContext, progress.fractionCompleted, phaseCode, nil)
                        }
                    }
                }
                let models = try await AsrModels.downloadAndLoad(
                    version: .v3,
                    progressHandler: progressHandler
                )
                self.asrModels = models

                let manager = AsrManager()
                try await manager.loadModels(models)
                self.asrManager = manager
            } catch {
                initError = error
            }
            semaphore.signal()
        }

        semaphore.wait()

        if let error = initError {
            throw error
        }
    }

    func transcribeFile(_ path: String) throws -> (String, Float, Double, Double, Float, [TokenTiming]) {
        // One-shot transcription: each call starts with a fresh decoder state so
        // results don't leak across utterances. The TDT decoder's LSTM hidden/cell
        // state and `lastToken` would otherwise persist, biasing the next call's
        // predictor (e.g. priming it with end-of-sentence punctuation, which
        // collapses subsequent transcripts to ".").
        guard let manager = asrManager else {
            throw BridgeError.notInitialized
        }
        var decoderState = try TdtDecoderState()

        let semaphore = DispatchSemaphore(value: 0)
        var result: ASRResult?
        var transcribeError: Error?

        Task {
            do {
                let url = URL(fileURLWithPath: path)
                result = try await manager.transcribe(
                    url,
                    decoderState: &decoderState,
                    language: .english
                )
            } catch {
                transcribeError = error
            }
            semaphore.signal()
        }

        semaphore.wait()

        if let error = transcribeError {
            throw error
        }

        guard let r = result else {
            throw BridgeError.noResult
        }

        return (r.text, r.confidence, r.duration, r.processingTime, r.rtfx, r.tokenTimings ?? [])
    }

    func transcribeSamples(_ samples: [Float]) throws -> (String, Float, Double, Double, Float, [TokenTiming]) {
        // See `transcribeFile` for the rationale: fresh decoder state per call.
        guard let manager = asrManager else {
            throw BridgeError.notInitialized
        }
        var decoderState = try TdtDecoderState()

        let semaphore = DispatchSemaphore(value: 0)
        var result: ASRResult?
        var transcribeError: Error?

        Task {
            do {
                result = try await manager.transcribe(
                    samples,
                    decoderState: &decoderState,
                    language: .english
                )
            } catch {
                transcribeError = error
            }
            semaphore.signal()
        }

        semaphore.wait()

        if let error = transcribeError {
            throw error
        }

        guard let r = result else {
            throw BridgeError.noResult
        }

        return (r.text, r.confidence, r.duration, r.processingTime, r.rtfx, r.tokenTimings ?? [])
    }

    func isAsrAvailable() -> Bool {
        return asrManager != nil
    }

    func initializeVad(_ threshold: Float) throws {
        let semaphore = DispatchSemaphore(value: 0)
        var initError: Error?

        Task {
            do {
                let config = VadConfig(defaultThreshold: threshold)
                let manager = try await VadManager(config: config)
                self.vadManager = manager
                self.vadStreamState = await manager.makeStreamState()
            } catch {
                initError = error
            }
            semaphore.signal()
        }

        semaphore.wait()

        if let error = initError {
            throw error
        }
    }

    func isVadAvailable() -> Bool {
        return vadManager != nil
    }

    func resetVadStream() throws {
        guard let manager = vadManager else {
            throw BridgeError.notInitialized
        }
        let semaphore = DispatchSemaphore(value: 0)
        Task {
            self.vadStreamState = await manager.makeStreamState()
            semaphore.signal()
        }
        semaphore.wait()
    }

    // MARK: - Diarization

    func initializeDiarization(_ threshold: Double) throws {
        let semaphore = DispatchSemaphore(value: 0)
        var initError: Error?

        Task {
            do {
                var config = OfflineDiarizerConfig()
                config.clustering.threshold = threshold
                let manager = OfflineDiarizerManager(config: config)
                try await manager.prepareModels()
                self.diarizerManager = manager
            } catch {
                initError = error
            }
            semaphore.signal()
        }

        semaphore.wait()

        if let error = initError {
            throw error
        }
    }

    func diarizeFile(_ path: String) throws -> [BridgeDiarizationSegment] {
        guard let manager = diarizerManager else {
            throw BridgeError.notInitialized
        }

        let semaphore = DispatchSemaphore(value: 0)
        var result: DiarizationResult?
        var diarizeError: Error?

        Task {
            do {
                let url = URL(fileURLWithPath: path)
                result = try await manager.process(url)
            } catch {
                diarizeError = error
            }
            semaphore.signal()
        }

        semaphore.wait()

        if let error = diarizeError {
            throw error
        }

        guard let r = result else {
            throw BridgeError.noResult
        }

        return r.segments.map { segment in
            BridgeDiarizationSegment(
                speakerId: segment.speakerId,
                startTime: segment.startTimeSeconds,
                endTime: segment.endTimeSeconds,
                qualityScore: segment.qualityScore
            )
        }
    }

    func isDiarizationAvailable() -> Bool {
        return diarizerManager != nil
    }

    // MARK: - VAD processing

    /// Returned per-chunk VAD frame data, suitable for flat C arrays.
    struct BridgeVadFrame {
        var probability: Float
        var isVoiceActive: Bool
        var processingTime: Double
    }

    func vadProcessFile(_ path: String) throws -> [BridgeVadFrame] {
        guard let manager = vadManager else {
            throw BridgeError.notInitialized
        }

        let semaphore = DispatchSemaphore(value: 0)
        var frames: [BridgeVadFrame] = []
        var processError: Error?

        Task {
            do {
                let url = URL(fileURLWithPath: path)
                let results = try await manager.process(url)
                frames = results.map {
                    BridgeVadFrame(
                        probability: $0.probability,
                        isVoiceActive: $0.isVoiceActive,
                        processingTime: $0.processingTime
                    )
                }
            } catch {
                processError = error
            }
            semaphore.signal()
        }

        semaphore.wait()

        if let error = processError {
            throw error
        }

        return frames
    }

    func vadProcessSamples(_ samples: [Float]) throws -> [BridgeVadFrame] {
        guard let manager = vadManager else {
            throw BridgeError.notInitialized
        }

        let semaphore = DispatchSemaphore(value: 0)
        var frames: [BridgeVadFrame] = []
        var processError: Error?

        Task {
            do {
                let results = try await manager.process(samples)
                frames = results.map {
                    BridgeVadFrame(
                        probability: $0.probability,
                        isVoiceActive: $0.isVoiceActive,
                        processingTime: $0.processingTime
                    )
                }
            } catch {
                processError = error
            }
            semaphore.signal()
        }

        semaphore.wait()

        if let error = processError {
            throw error
        }

        return frames
    }

    func vadProcessStreamingSamples(_ samples: [Float]) throws -> Float {
        guard let manager = vadManager, let state = vadStreamState else {
            throw BridgeError.notInitialized
        }

        let semaphore = DispatchSemaphore(value: 0)
        var probability: Float = 0
        var processError: Error?

        Task {
            do {
                let result = try await manager.processStreamingChunk(samples, state: state)
                self.vadStreamState = result.state
                probability = result.probability
            } catch {
                processError = error
            }
            semaphore.signal()
        }

        semaphore.wait()
        if let error = processError {
            throw error
        }
        return probability
    }

    // MARK: - ITN (Inverse Text Normalization)

    func itnNormalize(_ input: String) -> String {
        return TextNormalizer.shared.normalize(input)
    }

    func itnNormalizeSentence(_ input: String) -> String {
        return TextNormalizer.shared.normalizeSentence(input)
    }

    func itnNormalizeSentenceMaxSpan(_ input: String, maxSpanTokens: UInt32) -> String {
        return TextNormalizer.shared.normalizeSentence(input, maxSpanTokens: maxSpanTokens)
    }

    func itnIsNativeAvailable() -> Bool {
        return TextNormalizer.shared.isNativeAvailable
    }

    func cleanup() {
        asrManager = nil
        asrModels = nil
        vadManager = nil
        vadStreamState = nil
        diarizerManager = nil
        lastErrorMessage = nil
    }
}

enum BridgeError: Error {
    case notInitialized
    case noResult
    case unsupportedAsrVersion(Int32)
}

// MARK: - C FFI Functions

@_cdecl("fluidaudio_bridge_create")
public func fluidaudio_bridge_create() -> UnsafeMutableRawPointer? {
    let bridge = FluidAudioBridgeInternal()
    return Unmanaged.passRetained(bridge).toOpaque()
}

@_cdecl("fluidaudio_bridge_destroy")
public func fluidaudio_bridge_destroy(_ ptr: UnsafeMutableRawPointer?) {
    guard let ptr = ptr else { return }
    let bridge = Unmanaged<FluidAudioBridgeInternal>.fromOpaque(ptr).takeRetainedValue()
    bridge.cleanup()
}

@_cdecl("fluidaudio_bridge_take_last_error")
public func fluidaudio_bridge_take_last_error(_ ptr: UnsafeMutableRawPointer?) -> UnsafeMutablePointer<CChar>? {
    guard let ptr = ptr else { return nil }
    let bridge = Unmanaged<FluidAudioBridgeInternal>.fromOpaque(ptr).takeUnretainedValue()
    guard let message = bridge.takeLastErrorMessage() else { return nil }
    return strdup(message)
}

@_cdecl("fluidaudio_initialize_asr_version")
public func fluidaudio_initialize_asr_version(
    _ ptr: UnsafeMutableRawPointer?,
    _ versionCode: Int32,
    _ progressCallback: FluidAudioProgressCallback?,
    _ progressContext: UnsafeMutableRawPointer?
) -> Int32 {
    guard let ptr = ptr else { return -1 }
    let bridge = Unmanaged<FluidAudioBridgeInternal>.fromOpaque(ptr).takeUnretainedValue()
    guard versionCode == 3 else {
        bridge.recordError(BridgeError.unsupportedAsrVersion(versionCode))
        return -1
    }
    do {
        try bridge.initializeAsr(
            progressCallback: progressCallback,
            progressContext: progressContext
        )
        return 0
    } catch {
        bridge.recordError(error)
        print("ASR init error: \(error)")
        return -1
    }
}

@_cdecl("fluidaudio_transcribe_file")
public func fluidaudio_transcribe_file(
    _ ptr: UnsafeMutableRawPointer?,
    _ path: UnsafePointer<CChar>?,
    _ outText: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?,
    _ outConfidence: UnsafeMutablePointer<Float>?,
    _ outDuration: UnsafeMutablePointer<Double>?,
    _ outProcessingTime: UnsafeMutablePointer<Double>?,
    _ outRtfx: UnsafeMutablePointer<Float>?,
    _ outTokenTimingsJson: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
    guard let ptr = ptr, let path = path else { return -1 }
    let bridge = Unmanaged<FluidAudioBridgeInternal>.fromOpaque(ptr).takeUnretainedValue()

    let pathString = String(cString: path)

    do {
        let (text, confidence, duration, processingTime, rtfx, tokenTimings) = try bridge.transcribeFile(pathString)
        let timingData = try JSONEncoder().encode(tokenTimings)

        // Allocate and copy text
        if let outText = outText {
            let cString = strdup(text)
            outText.pointee = cString
        }

        outConfidence?.pointee = confidence
        outDuration?.pointee = duration
        outProcessingTime?.pointee = processingTime
        outRtfx?.pointee = rtfx
        outTokenTimingsJson?.pointee = strdup(String(decoding: timingData, as: UTF8.self))

        return 0
    } catch {
        bridge.recordError(error)
        print("Transcribe error: \(error)")
        return -1
    }
}

@_cdecl("fluidaudio_transcribe_samples")
public func fluidaudio_transcribe_samples(
    _ ptr: UnsafeMutableRawPointer?,
    _ samples: UnsafePointer<Float>?,
    _ sampleCount: UInt32,
    _ outText: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?,
    _ outConfidence: UnsafeMutablePointer<Float>?,
    _ outDuration: UnsafeMutablePointer<Double>?,
    _ outProcessingTime: UnsafeMutablePointer<Double>?,
    _ outRtfx: UnsafeMutablePointer<Float>?,
    _ outTokenTimingsJson: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
    guard let ptr = ptr, let samples = samples else { return -1 }
    let bridge = Unmanaged<FluidAudioBridgeInternal>.fromOpaque(ptr).takeUnretainedValue()

    let samplesArray = Array(UnsafeBufferPointer(start: samples, count: Int(sampleCount)))

    do {
        let (text, confidence, duration, processingTime, rtfx, tokenTimings) = try bridge.transcribeSamples(samplesArray)
        let timingData = try JSONEncoder().encode(tokenTimings)

        // Allocate and copy text
        if let outText = outText {
            let cString = strdup(text)
            outText.pointee = cString
        }

        outConfidence?.pointee = confidence
        outDuration?.pointee = duration
        outProcessingTime?.pointee = processingTime
        outRtfx?.pointee = rtfx
        outTokenTimingsJson?.pointee = strdup(String(decoding: timingData, as: UTF8.self))

        return 0
    } catch {
        bridge.recordError(error)
        print("Transcribe samples error: \(error)")
        return -1
    }
}

@_cdecl("fluidaudio_is_asr_available")
public func fluidaudio_is_asr_available(_ ptr: UnsafeMutableRawPointer?) -> Int32 {
    guard let ptr = ptr else { return 0 }
    let bridge = Unmanaged<FluidAudioBridgeInternal>.fromOpaque(ptr).takeUnretainedValue()
    return bridge.isAsrAvailable() ? 1 : 0
}

// MARK: - VAD FFI

@_cdecl("fluidaudio_initialize_vad")
public func fluidaudio_initialize_vad(_ ptr: UnsafeMutableRawPointer?, _ threshold: Float) -> Int32 {
    guard let ptr = ptr else { return -1 }
    let bridge = Unmanaged<FluidAudioBridgeInternal>.fromOpaque(ptr).takeUnretainedValue()
    do {
        try bridge.initializeVad(threshold)
        return 0
    } catch {
        bridge.recordError(error)
        print("VAD init error: \(error)")
        return -1
    }
}

@_cdecl("fluidaudio_is_vad_available")
public func fluidaudio_is_vad_available(_ ptr: UnsafeMutableRawPointer?) -> Int32 {
    guard let ptr = ptr else { return 0 }
    let bridge = Unmanaged<FluidAudioBridgeInternal>.fromOpaque(ptr).takeUnretainedValue()
    return bridge.isVadAvailable() ? 1 : 0
}

@_cdecl("fluidaudio_vad_reset_stream")
public func fluidaudio_vad_reset_stream(_ ptr: UnsafeMutableRawPointer?) -> Int32 {
    guard let ptr = ptr else { return -1 }
    let bridge = Unmanaged<FluidAudioBridgeInternal>.fromOpaque(ptr).takeUnretainedValue()
    do {
        try bridge.resetVadStream()
        return 0
    } catch {
        bridge.recordError(error)
        print("VAD reset error: \(error)")
        return -1
    }
}

// MARK: - Diarization FFI

@_cdecl("fluidaudio_initialize_diarization")
public func fluidaudio_initialize_diarization(_ ptr: UnsafeMutableRawPointer?, _ threshold: Double) -> Int32 {
    guard let ptr = ptr else { return -1 }
    let bridge = Unmanaged<FluidAudioBridgeInternal>.fromOpaque(ptr).takeUnretainedValue()
    do {
        try bridge.initializeDiarization(threshold)
        return 0
    } catch {
        bridge.recordError(error)
        print("Diarization init error: \(error)")
        return -1
    }
}

/// Diarize a file. Returns segment count via outCount.
/// Each segment is 4 consecutive values: speakerId (char*), startTime (float), endTime (float), qualityScore (float).
/// The flat arrays outSpeakerIds, outStartTimes, outEndTimes, outQualityScores must be freed by the caller.
@_cdecl("fluidaudio_diarize_file")
public func fluidaudio_diarize_file(
    _ ptr: UnsafeMutableRawPointer?,
    _ path: UnsafePointer<CChar>?,
    _ outSpeakerIds: UnsafeMutablePointer<UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?>?,
    _ outStartTimes: UnsafeMutablePointer<UnsafeMutablePointer<Float>?>?,
    _ outEndTimes: UnsafeMutablePointer<UnsafeMutablePointer<Float>?>?,
    _ outQualityScores: UnsafeMutablePointer<UnsafeMutablePointer<Float>?>?,
    _ outCount: UnsafeMutablePointer<UInt32>?
) -> Int32 {
    guard let ptr = ptr, let path = path else { return -1 }
    let bridge = Unmanaged<FluidAudioBridgeInternal>.fromOpaque(ptr).takeUnretainedValue()

    let pathString = String(cString: path)

    do {
        let segments = try bridge.diarizeFile(pathString)
        let count = segments.count

        outCount?.pointee = UInt32(count)

        if count == 0 {
            outSpeakerIds?.pointee = nil
            outStartTimes?.pointee = nil
            outEndTimes?.pointee = nil
            outQualityScores?.pointee = nil
        } else {
            let ids = UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>.allocate(capacity: count)
            let starts = UnsafeMutablePointer<Float>.allocate(capacity: count)
            let ends = UnsafeMutablePointer<Float>.allocate(capacity: count)
            let scores = UnsafeMutablePointer<Float>.allocate(capacity: count)

            for (i, seg) in segments.enumerated() {
                ids[i] = strdup(seg.speakerId)
                starts[i] = seg.startTime
                ends[i] = seg.endTime
                scores[i] = seg.qualityScore
            }

            outSpeakerIds?.pointee = ids
            outStartTimes?.pointee = starts
            outEndTimes?.pointee = ends
            outQualityScores?.pointee = scores
        }

        return 0
    } catch {
        bridge.recordError(error)
        print("Diarize error: \(error)")
        return -1
    }
}

@_cdecl("fluidaudio_is_diarization_available")
public func fluidaudio_is_diarization_available(_ ptr: UnsafeMutableRawPointer?) -> Int32 {
    guard let ptr = ptr else { return 0 }
    let bridge = Unmanaged<FluidAudioBridgeInternal>.fromOpaque(ptr).takeUnretainedValue()
    return bridge.isDiarizationAvailable() ? 1 : 0
}

@_cdecl("fluidaudio_free_diarization_result")
public func fluidaudio_free_diarization_result(
    _ speakerIds: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?,
    _ startTimes: UnsafeMutablePointer<Float>?,
    _ endTimes: UnsafeMutablePointer<Float>?,
    _ qualityScores: UnsafeMutablePointer<Float>?,
    _ count: UInt32
) {
    if let ids = speakerIds {
        for i in 0..<Int(count) {
            free(ids[i])
        }
        ids.deallocate()
    }
    startTimes?.deallocate()
    endTimes?.deallocate()
    qualityScores?.deallocate()
}

// MARK: - System Info FFI

@_cdecl("fluidaudio_get_platform")
public func fluidaudio_get_platform(_ out: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?) {
    #if os(macOS)
    let platform = "macOS"
    #elseif os(iOS)
    let platform = "iOS"
    #else
    let platform = "unknown"
    #endif

    out?.pointee = strdup(platform)
}

@_cdecl("fluidaudio_get_chip_name")
public func fluidaudio_get_chip_name(_ out: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?) {
    var size: size_t = 0
    var chipName = "Unknown"

    if sysctlbyname("machdep.cpu.brand_string", nil, &size, nil, 0) == 0, size > 0 {
        var buffer = [CChar](repeating: 0, count: Int(size))
        if sysctlbyname("machdep.cpu.brand_string", &buffer, &size, nil, 0) == 0 {
            chipName = String(cString: buffer)
        }
    }

    out?.pointee = strdup(chipName)
}

@_cdecl("fluidaudio_get_memory_gb")
public func fluidaudio_get_memory_gb() -> Double {
    return Double(ProcessInfo.processInfo.physicalMemory) / (1024 * 1024 * 1024)
}

@_cdecl("fluidaudio_is_apple_silicon")
public func fluidaudio_is_apple_silicon() -> Int32 {
    return SystemInfo.isAppleSilicon ? 1 : 0
}

@_cdecl("fluidaudio_cleanup")
public func fluidaudio_cleanup(_ ptr: UnsafeMutableRawPointer?) {
    guard let ptr = ptr else { return }
    let bridge = Unmanaged<FluidAudioBridgeInternal>.fromOpaque(ptr).takeUnretainedValue()
    bridge.cleanup()
}

@_cdecl("fluidaudio_free_string")
public func fluidaudio_free_string(_ s: UnsafeMutablePointer<CChar>?) {
    free(s)
}

@_cdecl("fluidaudio_resample_samples")
public func fluidaudio_resample_samples(
    _ samples: UnsafePointer<Float>?,
    _ count: UInt32,
    _ inputRate: Double,
    _ outSamples: UnsafeMutablePointer<UnsafeMutablePointer<Float>?>?,
    _ outCount: UnsafeMutablePointer<UInt32>?,
    _ outError: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
    outError?.pointee = nil
    guard let samples = samples, let outSamples = outSamples, let outCount = outCount else {
        outError?.pointee = strdup("Invalid audio resample arguments")
        return -1
    }
    guard inputRate.isFinite, inputRate > 0 else {
        outError?.pointee = strdup("Invalid audio input sample rate: \(inputRate)")
        return -1
    }
    do {
        let input = Array(UnsafeBufferPointer(start: samples, count: Int(count)))
        let output = try AudioConverter().resample(input, from: inputRate)
        let pointer = UnsafeMutablePointer<Float>.allocate(capacity: output.count)
        pointer.initialize(from: output, count: output.count)
        outSamples.pointee = pointer
        outCount.pointee = UInt32(output.count)
        return 0
    } catch {
        outError?.pointee = strdup(String(describing: error))
        return -1
    }
}

@_cdecl("fluidaudio_free_float_array")
public func fluidaudio_free_float_array(_ samples: UnsafeMutablePointer<Float>?) {
    samples?.deallocate()
}

// MARK: - System Info (extended)

@_cdecl("fluidaudio_is_intel_mac")
public func fluidaudio_is_intel_mac() -> Int32 {
    return SystemInfo.isIntelMac ? 1 : 0
}

// MARK: - VAD processing FFI

/// Process an audio file through VAD. Returns the number of frames via outCount.
/// Each frame contributes one entry to outProbabilities (Float), outIsVoiceActive (UInt8 0/1),
/// and outProcessingTimes (Double). Caller must free with fluidaudio_free_vad_result.
@_cdecl("fluidaudio_vad_process_file")
public func fluidaudio_vad_process_file(
    _ ptr: UnsafeMutableRawPointer?,
    _ path: UnsafePointer<CChar>?,
    _ outProbabilities: UnsafeMutablePointer<UnsafeMutablePointer<Float>?>?,
    _ outIsVoiceActive: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>?,
    _ outProcessingTimes: UnsafeMutablePointer<UnsafeMutablePointer<Double>?>?,
    _ outCount: UnsafeMutablePointer<UInt32>?
) -> Int32 {
    guard let ptr = ptr, let path = path else { return -1 }
    let bridge = Unmanaged<FluidAudioBridgeInternal>.fromOpaque(ptr).takeUnretainedValue()

    let pathString = String(cString: path)

    do {
        let frames = try bridge.vadProcessFile(pathString)
        emitVadFrames(
            frames,
            outProbabilities: outProbabilities,
            outIsVoiceActive: outIsVoiceActive,
            outProcessingTimes: outProcessingTimes,
            outCount: outCount
        )
        return 0
    } catch {
        bridge.recordError(error)
        print("VAD process file error: \(error)")
        return -1
    }
}

/// Process raw 16kHz mono Float32 samples through VAD. See fluidaudio_vad_process_file
/// for output array semantics.
@_cdecl("fluidaudio_vad_process_samples")
public func fluidaudio_vad_process_samples(
    _ ptr: UnsafeMutableRawPointer?,
    _ samples: UnsafePointer<Float>?,
    _ count: UInt32,
    _ outProbabilities: UnsafeMutablePointer<UnsafeMutablePointer<Float>?>?,
    _ outIsVoiceActive: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>?,
    _ outProcessingTimes: UnsafeMutablePointer<UnsafeMutablePointer<Double>?>?,
    _ outCount: UnsafeMutablePointer<UInt32>?
) -> Int32 {
    guard let ptr = ptr, let samples = samples else { return -1 }
    let bridge = Unmanaged<FluidAudioBridgeInternal>.fromOpaque(ptr).takeUnretainedValue()

    let samplesArray = Array(UnsafeBufferPointer(start: samples, count: Int(count)))

    do {
        let frames = try bridge.vadProcessSamples(samplesArray)
        emitVadFrames(
            frames,
            outProbabilities: outProbabilities,
            outIsVoiceActive: outIsVoiceActive,
            outProcessingTimes: outProcessingTimes,
            outCount: outCount
        )
        return 0
    } catch {
        bridge.recordError(error)
        print("VAD process samples error: \(error)")
        return -1
    }
}

@_cdecl("fluidaudio_vad_process_streaming_samples")
public func fluidaudio_vad_process_streaming_samples(
    _ ptr: UnsafeMutableRawPointer?,
    _ samples: UnsafePointer<Float>?,
    _ count: UInt32,
    _ outProbability: UnsafeMutablePointer<Float>?
) -> Int32 {
    guard let ptr = ptr, let samples = samples, let outProbability = outProbability else { return -1 }
    let bridge = Unmanaged<FluidAudioBridgeInternal>.fromOpaque(ptr).takeUnretainedValue()
    let samplesArray = Array(UnsafeBufferPointer(start: samples, count: Int(count)))
    do {
        outProbability.pointee = try bridge.vadProcessStreamingSamples(samplesArray)
        return 0
    } catch {
        bridge.recordError(error)
        print("VAD streaming process error: \(error)")
        return -1
    }
}

@_cdecl("fluidaudio_free_vad_result")
public func fluidaudio_free_vad_result(
    _ probabilities: UnsafeMutablePointer<Float>?,
    _ isVoiceActive: UnsafeMutablePointer<UInt8>?,
    _ processingTimes: UnsafeMutablePointer<Double>?,
    _ count: UInt32
) {
    _ = count // Reserved for future per-element cleanup (none currently needed).
    probabilities?.deallocate()
    isVoiceActive?.deallocate()
    processingTimes?.deallocate()
}

private func emitVadFrames(
    _ frames: [FluidAudioBridgeInternal.BridgeVadFrame],
    outProbabilities: UnsafeMutablePointer<UnsafeMutablePointer<Float>?>?,
    outIsVoiceActive: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>?,
    outProcessingTimes: UnsafeMutablePointer<UnsafeMutablePointer<Double>?>?,
    outCount: UnsafeMutablePointer<UInt32>?
) {
    let count = frames.count
    outCount?.pointee = UInt32(count)

    if count == 0 {
        outProbabilities?.pointee = nil
        outIsVoiceActive?.pointee = nil
        outProcessingTimes?.pointee = nil
        return
    }

    let probs = UnsafeMutablePointer<Float>.allocate(capacity: count)
    let voice = UnsafeMutablePointer<UInt8>.allocate(capacity: count)
    let times = UnsafeMutablePointer<Double>.allocate(capacity: count)

    for (i, frame) in frames.enumerated() {
        probs[i] = frame.probability
        voice[i] = frame.isVoiceActive ? 1 : 0
        times[i] = frame.processingTime
    }

    outProbabilities?.pointee = probs
    outIsVoiceActive?.pointee = voice
    outProcessingTimes?.pointee = times
}

// MARK: - ITN (Inverse Text Normalization) FFI

/// Normalize a short ASR expression (e.g. "two hundred thirty two" -> "232").
/// The returned string must be freed via fluidaudio_free_string.
@_cdecl("fluidaudio_itn_normalize")
public func fluidaudio_itn_normalize(
    _ ptr: UnsafeMutableRawPointer?,
    _ text: UnsafePointer<CChar>?,
    _ outText: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
    guard let ptr = ptr, let text = text else { return -1 }
    let bridge = Unmanaged<FluidAudioBridgeInternal>.fromOpaque(ptr).takeUnretainedValue()
    let normalized = bridge.itnNormalize(String(cString: text))
    outText?.pointee = strdup(normalized)
    return 0
}

@_cdecl("fluidaudio_itn_normalize_sentence")
public func fluidaudio_itn_normalize_sentence(
    _ ptr: UnsafeMutableRawPointer?,
    _ text: UnsafePointer<CChar>?,
    _ outText: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
    guard let ptr = ptr, let text = text else { return -1 }
    let bridge = Unmanaged<FluidAudioBridgeInternal>.fromOpaque(ptr).takeUnretainedValue()
    let normalized = bridge.itnNormalizeSentence(String(cString: text))
    outText?.pointee = strdup(normalized)
    return 0
}

@_cdecl("fluidaudio_itn_normalize_sentence_max_span")
public func fluidaudio_itn_normalize_sentence_max_span(
    _ ptr: UnsafeMutableRawPointer?,
    _ text: UnsafePointer<CChar>?,
    _ maxSpanTokens: UInt32,
    _ outText: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
    guard let ptr = ptr, let text = text else { return -1 }
    let bridge = Unmanaged<FluidAudioBridgeInternal>.fromOpaque(ptr).takeUnretainedValue()
    let normalized = bridge.itnNormalizeSentenceMaxSpan(String(cString: text), maxSpanTokens: maxSpanTokens)
    outText?.pointee = strdup(normalized)
    return 0
}

@_cdecl("fluidaudio_itn_is_native_available")
public func fluidaudio_itn_is_native_available(
    _ ptr: UnsafeMutableRawPointer?
) -> Int32 {
    guard let ptr = ptr else { return 0 }
    let bridge = Unmanaged<FluidAudioBridgeInternal>.fromOpaque(ptr).takeUnretainedValue()
    return bridge.itnIsNativeAvailable() ? 1 : 0
}

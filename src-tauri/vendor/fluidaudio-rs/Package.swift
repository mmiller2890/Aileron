// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "FluidAudioBridge",
    platforms: [
        .macOS(.v14),
        .iOS(.v17)
    ],
    products: [
        .library(
            name: "FluidAudioBridge",
            type: .static,
            targets: ["FluidAudioBridge"]
        ),
    ],
    dependencies: [
        .package(
            url: "https://github.com/FluidInference/FluidAudio.git",
            revision: "00a9aa771900ea09c485659663be31019e293e47"
        ),
    ],
    targets: [
        .target(
            name: "FluidAudioBridge",
            dependencies: [
                .product(name: "FluidAudio", package: "FluidAudio"),
            ],
            path: "swift"
        ),
    ],
    swiftLanguageModes: [.v5]
)

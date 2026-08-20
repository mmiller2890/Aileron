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
            revision: "8a2bf2c074a227b25baef2185a00faa3f6865d10"
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

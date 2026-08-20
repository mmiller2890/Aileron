use std::path::PathBuf;
use std::process::Command;

fn main() {
    // Tell Cargo to rerun if Swift files change
    println!("cargo:rerun-if-changed=swift/");
    println!("cargo:rerun-if-changed=Package.swift");

    let out_dir = PathBuf::from(std::env::var("OUT_DIR").unwrap());
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());

    // Build the Swift package first to get FluidAudio dependency
    println!("cargo:warning=Building Swift package...");

    let swift_build_dir = out_dir.join("swift-build");
    std::fs::create_dir_all(&swift_build_dir).expect("Failed to create swift-build directory");

    // Build Swift package in release mode
    let status = Command::new("swift")
        .args(&[
            "build",
            "-c",
            "release",
            "--build-path",
            swift_build_dir.to_str().unwrap(),
        ])
        .current_dir(&manifest_dir)
        .status()
        .expect("Failed to run swift build");

    if !status.success() {
        panic!("Swift package build failed");
    }

    // Find the built library
    let lib_path = swift_build_dir.join("release");
    let nemo_lib_path = swift_build_dir.join(
        "artifacts/fluidaudio/NemoTextProcessing/NemoTextProcessing.xcframework/macos-arm64_x86_64",
    );

    // Link the Swift library
    println!("cargo:rustc-link-search=native={}", lib_path.display());
    println!("cargo:rustc-link-search=native={}", nemo_lib_path.display());
    println!("cargo:rustc-link-lib=static=FluidAudioBridge");
    println!("cargo:rustc-link-lib=static=text_processing_rs");

    // Link Apple frameworks
    println!("cargo:rustc-link-lib=framework=Foundation");
    println!("cargo:rustc-link-lib=framework=AVFoundation");
    println!("cargo:rustc-link-lib=framework=CoreML");
    println!("cargo:rustc-link-lib=framework=Accelerate");
    println!("cargo:rustc-link-lib=framework=Metal");
    println!("cargo:rustc-link-lib=framework=MetalPerformanceShaders");

    // Link Swift runtime
    let sdk_output = Command::new("xcrun")
        .arg("--show-sdk-path")
        .output()
        .expect("Failed to locate the macOS SDK");
    if !sdk_output.status.success() {
        panic!("Failed to locate the macOS SDK");
    }
    let sdk_path = String::from_utf8(sdk_output.stdout)
        .expect("macOS SDK path was not UTF-8")
        .trim()
        .to_string();
    let sdk_swift_lib = PathBuf::from(sdk_path).join("usr/lib/swift");
    println!("cargo:rustc-link-search=native={}", sdk_swift_lib.display());
    println!("cargo:rustc-link-arg=-mmacosx-version-min=14.0");
    println!("cargo:rustc-link-lib=dylib=swiftCore");
    println!("cargo:rustc-link-lib=dylib=swift_Concurrency");

    // Link C++ standard library (needed for FastClusterWrapper.cpp in FluidAudio)
    println!("cargo:rustc-link-lib=c++");
}

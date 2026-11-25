fn main() {
    // FluidAudio's Swift code links the Swift runtime. Newer Rust toolchains
    // record `libswift_Concurrency` as `@rpath/...`, and with no rpath the
    // binary (the app and the test binaries alike) aborts at launch. The
    // runtime ships with macOS in /usr/lib/swift, which is where SwiftPM
    // points its own binaries.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
    }
    tauri_build::build()
}

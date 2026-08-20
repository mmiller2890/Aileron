#!/usr/bin/env node
// Environment preflight for building Assistant from source.
//
// Runs on `npm run setup` and automatically before every `npm run tauri ...`
// command. The goal is that a freshly-cloned checkout tells you exactly what's
// missing — with the fix — instead of failing with a cryptic error deep in the
// Rust/Swift build several minutes later.
//
// It only CHECKS and INSTRUCTS; it never installs anything on your machine.

import { execSync } from "node:child_process";
import process from "node:process";

// Escape hatch: `SKIP_ENV_CHECK=1` bypasses the preflight entirely (CI, or a
// setup the check doesn't recognize but that builds fine anyway).
if (process.env.SKIP_ENV_CHECK) {
  process.exit(0);
}

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s) => paint("1", s);
const dim = (s) => paint("2", s);
const red = (s) => paint("31", s);
const green = (s) => paint("32", s);
const yellow = (s) => paint("33", s);

let hasError = false;

function run(cmd) {
  try {
    return execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

function pass(label, detail) {
  console.log(`  ${green("✓")} ${label}${detail ? dim(`  ${detail}`) : ""}`);
}
function fail(label, detail, fix) {
  hasError = true;
  console.log(`  ${red("✗")} ${bold(label)}${detail ? `  ${detail}` : ""}`);
  if (fix) console.log(`      ${yellow(`→ ${fix}`)}`);
}
function warn(label, detail, fix) {
  console.log(`  ${yellow("!")} ${label}${detail ? `  ${detail}` : ""}`);
  if (fix) console.log(`      ${dim(`→ ${fix}`)}`);
}

console.log(`\n${bold("Assistant — environment check")}\n`);

// --- Node.js -----------------------------------------------------------------
const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
const supportedNode =
  (nodeMajor === 20 && nodeMinor >= 19) ||
  (nodeMajor === 22 && nodeMinor >= 12) ||
  nodeMajor >= 24;
if (supportedNode) {
  pass("Node.js", `v${process.versions.node}`);
} else {
  fail(
    "Node.js 20.19+, 22.12+, or 24+",
    `found v${process.versions.node}`,
    "https://nodejs.org"
  );
}

// --- Rust / cargo ------------------------------------------------------------
const cargo = run("cargo --version");
if (cargo) {
  pass("Rust (cargo)", cargo.replace(/^cargo /, "v"));
} else {
  fail(
    "Rust toolchain",
    "cargo not found",
    "Install rustup from https://rustup.rs (rust-toolchain.toml pins the version)"
  );
}

// --- Platform-specific: local speech engine ----------------------------------
if (process.platform === "darwin") {
  // FluidAudio builds a Swift package during the Rust build; it needs Swift 6.
  const swiftRaw = run("swift --version");
  const m = swiftRaw && swiftRaw.match(/Swift version (\d+)\.(\d+)/i);
  if (m && Number(m[1]) >= 6) {
    pass("Swift 6+ (Xcode 16)", `v${m[1]}.${m[2]}`);
  } else if (m) {
    fail(
      "Swift 6+ (Xcode 16)",
      `found v${m[1]}.${m[2]}`,
      "Install Xcode 16, then: sudo xcode-select -s /Applications/Xcode_16.app"
    );
  } else {
    fail(
      "Swift 6+ (Xcode 16)",
      "swift not found",
      "Install Xcode 16 from the App Store, then: sudo xcode-select -s /Applications/Xcode_16.app"
    );
  }

  if (process.arch !== "arm64") {
    warn(
      "Apple Silicon",
      `this Mac is ${process.arch}`,
      "The built-in FluidAudio STT is Apple-Silicon only; use a cloud or self-hosted STT provider."
    );
  }
} else {
  warn(
    "FluidAudio local STT",
    `unavailable on ${process.platform}`,
    "The built-in local speech engine needs macOS Apple Silicon; configure a cloud or self-hosted STT provider instead."
  );
}

// --- Ollama (optional) -------------------------------------------------------
const ollama = run("ollama --version");
if (ollama) {
  const ver = ollama.match(/(\d+\.\d+\.\d+)/);
  pass("Ollama (optional)", ver ? `v${ver[1]}` : "installed");
} else {
  warn(
    "Ollama (optional)",
    "not found",
    "Only needed for the free local-AI path — any cloud or curl provider works instead. https://ollama.com"
  );
}

console.log();
if (hasError) {
  console.log(
    red("  Missing required tools — install the items marked ✗ above, then re-run.")
  );
  console.log(
    dim("  See the Tauri system prerequisites too: https://tauri.app/start/prerequisites/\n")
  );
  process.exit(1);
}
console.log(green("  Looks good. Next: ") + bold("npm run tauri dev") + "\n");

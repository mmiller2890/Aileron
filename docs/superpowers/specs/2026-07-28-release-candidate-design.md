# Aileron 0.1.9 Release Candidate Design

## Goal

Freeze the successfully rehearsed Aileron application source as a reproducible
personal-use release candidate, then separately validate the packaged
application without changing behavior or adding polish.

## Release Identity

- Branch: `dev`
- Application source baseline: `9936663c7d9d4abc621ae551ac2615d64b44d3c9`
- Release candidate commit: the final `dev` HEAD containing this corrected design
- Version: `0.1.9`
- Annotated tag: `v0.1.9-rc.1`

The release candidate commit contains the tested application source plus its
release documentation. The tag will remain local unless the user separately
approves pushing or publishing it.

## Scope

The release process will not change source code, configuration, dependencies, UI, or runtime behavior. The unrelated untracked `artdeco-example.html` file will remain untouched and will not be included in the release commit, tag, or artifacts.

## Verification

Run the required gates against the final release-candidate source state. That
exact commit will be tagged after the packaged-application smoke test:

1. `git diff --check`
2. `npx tsc --noEmit`
3. `npx vitest run`
4. `npm run build`
5. `cargo test --manifest-path src-tauri/Cargo.toml`
6. `cargo check --manifest-path src-tauri/Cargo.toml`
7. `npm run tauri build`

The automated verification will not launch Aileron or compete with the
development instance on port 1420.

## Release-Artifact Smoke Test

The automated gates verify the source tree and bundle construction, but they do
not prove that the packaged application has usable runtime configuration or
macOS permission grants.

After the release build and before tagging, the user will:

1. Quit any running Aileron development instance.
2. Open the newly built `Aileron.app`.
3. Approve any required microphone, screen-recording, and system-audio prompts.
4. Configure the release profile through the UI for system audio, local
   Fluidaudio STT, and the preferred cloud AI provider.
5. Confirm the overlay opens, transcribes one question once, returns one answer,
   and stops cleanly.
6. Quit the packaged application and report the result.

The packaged application uses bundle identifier `com.assistant.local` and a
separate `tauri://localhost` WebKit profile. The active development build uses
an `http://localhost` profile under `~/Library/WebKit/Aileron`, so its provider,
model, prompt, audio-device, and VAD settings do not automatically carry into
the release bundle. No database or LocalStorage files will be copied between
profiles; the release profile will be configured once through the application
UI.

## Artifacts

The release build must produce:

- `src-tauri/target/release/bundle/macos/Aileron.app`
- `src-tauri/target/release/bundle/dmg/Aileron_0.1.9_aarch64.dmg`

Generate SHA-256 checksums for the DMG and the executable inside the application bundle. Report the absolute artifact paths, sizes, and checksums.

## Tagging and Rollback

Create the annotated tag only after every verification command, the release
build, and the packaged-application smoke test pass. The tag message will
identify the candidate as the verified Aileron 0.1.9 personal-use build.

Rollback remains explicit:

- The release candidate source is recoverable from `v0.1.9-rc.1`.
- The pre-release state is the same commit, so tagging does not modify application code.
- The tag can be deleted locally without changing the branch or working tree.

No branch merge, push, GitHub release, installer publication, or update-channel change is included.

The application is ad-hoc signed with no Apple Team ID. This is acceptable for
personal use on the build machine. If the DMG is transferred to another Mac,
Gatekeeper quarantine and fresh macOS permission prompts should be expected.

## Acceptance Criteria

- The tag resolves exactly to the final `dev` documentation HEAD used for verification.
- All required frontend and Rust gates pass.
- The macOS application and DMG rebuild successfully.
- The user confirms the packaged application launches with its release profile,
  required permissions are granted, and one complete question-and-answer cycle
  succeeds without duplicates.
- Artifact checksums are recorded in the handoff.
- No source or behavior changes are introduced.
- `artdeco-example.html` remains untouched and untracked.
- Nothing is pushed or published externally.

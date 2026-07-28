# Aileron 0.1.9 Release Candidate Design

## Goal

Freeze the successfully rehearsed Aileron build as a reproducible personal-use release candidate without changing application behavior or adding polish.

## Release Identity

- Branch: `dev`
- Commit: `9936663c7d9d4abc621ae551ac2615d64b44d3c9`
- Version: `0.1.9`
- Annotated tag: `v0.1.9-rc.1`

The tag will remain local unless the user separately approves pushing or publishing it.

## Scope

The release process will not change source code, configuration, dependencies, UI, or runtime behavior. The unrelated untracked `artdeco-example.html` file will remain untouched and will not be included in the release commit, tag, or artifacts.

## Verification

Run the required gates against the tagged source state:

1. `git diff --check`
2. `npx tsc --noEmit`
3. `npx vitest run`
4. `npm run build`
5. `cargo test --manifest-path src-tauri/Cargo.toml`
6. `cargo check --manifest-path src-tauri/Cargo.toml`
7. `npm run tauri build`

Aileron will not be launched during verification.

## Artifacts

The release build must produce:

- `src-tauri/target/release/bundle/macos/Aileron.app`
- `src-tauri/target/release/bundle/dmg/Aileron_0.1.9_aarch64.dmg`

Generate SHA-256 checksums for the DMG and the executable inside the application bundle. Report the absolute artifact paths, sizes, and checksums.

## Tagging and Rollback

Create the annotated tag only after every verification command and the release build pass. The tag message will identify the candidate as the successfully rehearsed Aileron 0.1.9 build.

Rollback remains explicit:

- The release candidate source is recoverable from `v0.1.9-rc.1`.
- The pre-release state is the same commit, so tagging does not modify application code.
- The tag can be deleted locally without changing the branch or working tree.

No branch merge, push, GitHub release, installer publication, or update-channel change is included.

## Acceptance Criteria

- The tag resolves exactly to commit `9936663c7d9d4abc621ae551ac2615d64b44d3c9`.
- All required frontend and Rust gates pass.
- The macOS application and DMG rebuild successfully.
- Artifact checksums are recorded in the handoff.
- No source or behavior changes are introduced.
- `artdeco-example.html` remains untouched and untracked.
- Nothing is pushed or published externally.

# Provider, Listener, and Attachment Stability Design

## Scope

Implement review findings 2, 4, and 6 and eliminate duplicate system-audio transcript entries in both the overlay and dashboard. Preserve the existing provider templates, six-file limit, React StrictMode, and the running-app constraint.

## Root Cause

The system-audio hook registers `speech-detected` through an awaited Tauri listener promise. React StrictMode can clean up the effect before that promise resolves. The cleanup sees no unlisten function, so the abandoned listener survives beside the replacement listener. Both callbacks append the same transcription and can launch duplicate AI requests. The same registration race exists in screenshot and auxiliary audio listeners.

Multi-file selection compares every candidate against the unchanged attachment count captured before asynchronous conversion starts. A ten-image selection from an empty list therefore schedules all ten.

AI variable validation treats `API_KEY` as optional only when the provider ID is exactly `ollama` or `lm-studio`. A custom provider pointing to a loopback service receives a generated ID and fails before the request.

## Listener Lifecycle

Add a small framework-independent listener scope that:

- wraps callbacks so disposed scopes ignore late events;
- tracks listener-registration promises;
- immediately unregisters listeners that resolve after disposal;
- unregisters already-resolved listeners exactly once.

Use the scope for asynchronous Tauri registrations in system audio and both completion hooks. System-audio event handling also records a short-lived fingerprint of the last `speech-detected` payload so an identical backend event cannot append or answer twice.

The fingerprint uses the audio payload plus its start/end timestamps and expires after the event-processing window. It does not compare transcript text, so genuinely repeated spoken questions remain valid.

## Provider Authentication

Parse the cURL URL before validating variables. `API_KEY` is optional for:

- the built-in Ollama and LM Studio providers;
- custom providers whose host is `localhost`, an IPv4 loopback address in `127.0.0.0/8`, or IPv6 loopback `::1`.

Remote custom and built-in cloud providers still fail early when their `API_KEY` is empty. When an optional key is empty, remove headers whose original template contains `{{API_KEY}}` instead of sending values such as `Authorization: Bearer `.

Malformed URLs do not receive the exemption.

## Attachment Limit

Add a shared pure selector that filters for images and returns only the remaining slots up to `MAX_FILES`. Both completion hooks use it for file-picker and paste input. Their functional state update enforces the same cap after asynchronous base64 conversion, covering rapid overlapping selections.

## Tests

Add focused Vitest coverage for:

- disposal before and after listener registration resolves;
- stale callbacks being inert after disposal;
- duplicate event fingerprints and expiry;
- loopback versus remote API-key requirements;
- omission of empty templated authentication headers;
- image filtering and remaining-capacity behavior.

Run `npx tsc --noEmit`, `npm run build`, `npx vitest run`, and `cargo check` without launching Aileron.

## Rollback

Commit these stability changes separately from `02cc5e7`. Reverting the new implementation commit restores the prior behavior without reverting #1, #3, or #5. The user-owned `artdeco-example.html` remains untracked and excluded.

# DEX POC — Distributed Execution

Proves: a command dispatched centrally (shell + Supabase) executes on a specific
**device's own browser session** on an API-less site (Dotgolf) and returns live —
**with no server-side browser**. Read-only. See `../poc-distributed-execution.md`.

Files:
- **`index.html`** — the **Tee Caddie PWA** (control surface): sign in, pick a device, set date/window/tee/holes, Find (dry) or Book (live), watch the routine stream live. Installable (manifest + service worker + icons).
- **`de-runner.user.js`** — the runner (the "hands"): installed via Tampermonkey on each device. v0.2 adds the `makeBooking` routine.
- **`manifest.webmanifest` / `sw.js` / `icon-*.png`** — PWA install assets.

## makeBooking routine (v0.2)

A `makeBooking` command (args: `date, from, to, tee, holes, mode`) runs a multi-page routine on the device, surviving page reloads via `sessionStorage` and streaming stages back to the shell:

`Opening the tee sheet → Reading the sheet → (dry: highlight & report) / (live: Reserve → Fill → Submit → Finalise → Booked)`.

It reuses the grabber's eligibility logic (`book_here_link` only, category rank, time window, holes filter), books **a single spot for you** (no friends), and defaults to **dry-run** — `mode:'live'` is the only thing that actually books. Design notes: the time-critical contested grab still belongs in the local grabber; this routine is for non-contested booking driven from the PWA.

Supabase: project `Photo-capture` (Sydney), tables `de_devices` + `de_commands`. Details in `../supabase-setup.md`.

---

## One-time setup

**1. Turn off email confirmation (POC only).**
Supabase dashboard → Authentication → Sign In / Providers → Email → disable **Confirm email**.
This lets "Sign in / up" create your account instantly on first use. (Otherwise sign-up waits on a confirmation email.)

**2. Deploy the shell + runner to Netlify (via GitHub).**
Push the `dex-poc/` folder to a repo and connect it to a new Netlify site (publish directory = `dex-poc`). You get:
- Shell at `https://<your-site>.netlify.app/`
- Runner at `https://<your-site>.netlify.app/de-runner.user.js`

**3. Point the runner's auto-update at your site.**
In `de-runner.user.js`, set `@updateURL` and `@downloadURL` to your real Netlify URL (currently the placeholder `https://dex-poc.netlify.app/...`).

**4. Install the runner on each device.**
- iPhone: Safari + Tampermonkey → open `…/de-runner.user.js` → Install.
- Android: Firefox + Tampermonkey → open `…/de-runner.user.js` → Install.

---

## Test run

1. Open the **shell** on your laptop/phone, sign in (same email+password you'll use on the runner).
2. On **device A**, open the Dotgolf tee-booking page (logged in). The blue **DEX Runner** panel appears — sign in with the same account. It registers and shows "Listening for commands…".
3. Back in the shell, device A shows **online**. Dispatch `ping` to it → result returns live. ✅ **Test 1 (single-device loop).**
4. Repeat on **device B**; dispatch to **All devices** → two independent results. ✅ **Test 2 (sharding).**
5. Open a day's tee sheet on a device, dispatch `readAvailability` → parsed slots return. (Optional `from`/`to` filter.)
6. Close the page on a device, dispatch a command to it (stays **queued**), reopen → it runs on reconnect. ✅ **Test 3 (offline queue).**

---

## Notes / known edges

- Runner runs supabase-js in page context (`@grant none`). If a global ever clashes on the Dotgolf page, switch to a grant + `unsafeWindow`.
- `readAvailability` reads the **currently open** tee sheet (no navigation yet). Date-driven navigation needs cross-reload command state (like the grabber's sessionStorage) — a later enhancement.
- Presence: a device shows "online" if it heartbeated within ~60s.
- This is read-only by design. No writes/bookings. The time-critical grab stays local (the grabber's job), not a dispatched command.

---

## Validation results — 2026-06-22 (ALL PASSED)

Setup: shell on laptop; runner on two phones (iPhone/Safari+Tampermonkey, Android/Firefox+Tampermonkey); target Remuera/Dotgolf; single account.

- **Test 1 — single-device loop:** `ping` dispatched from shell → executed in the phone's own Dotgolf session → result back, `done`. Round trip **262ms**.
- **readAvailability — real data:** parsed the full 22 Jun tee sheet — **53 tee times**, correctly identified **4 bookable slots** (`book_here_link` only: 14:17, 14:47, 15:02, 15:17), morning slots correctly 0-eligible. Round trip **679ms** (53-row payload).
- **Test 2 — sharding:** one "All devices" dispatch → two independent results: iPhone (SearchClubDay, 333ms) + Android (SearchSlots, 293ms), different page URLs confirming separate sessions, parallel.
- **Test 3 — offline queue:** `ping` to a device with its tab closed sat `queued` **10s**, then ran the instant the tab reopened (73ms in-page). Edge-reliability confirmed.

**Conclusion:** the architecture is proven end to end — central dispatch, on-device execution, no server-side browser, no stored credentials, scales by adding devices. Round trips 260–680ms, dominated by each device's own network hop, as predicted.

### Multi-user isolation (RLS) — verified 2026-06-22

Tested directly against the live policy by simulating two authenticated users:

- Acting as the owner: **2 devices, 5 commands** visible.
- Acting as a different user id: **0 devices, 0 commands** visible.

So multi-user works with **no extra code**: each member who signs up with their own email gets a distinct `user_id`, and RLS (`user_id = auth.uid()`) isolates their devices/commands automatically. Each member acts in their own logged-in session on their own device — **no club credentials are ever stored centrally** (this dissolves the credential-liability risk flagged in docs 06/09).

**Onboarding:** share the shell + runner URLs; each member signs up with their own email/password. No per-user setup beyond installing the runner.

**Hardening note:** the shared `Photo-capture` project currently has **"Allow anonymous sign-ins" ON**. RLS still isolates anonymous users (they'd see only their own rows), but for a real multi-member deployment consider turning it off so only invited email accounts can create data — verify first that the Photo-capture app doesn't rely on it.

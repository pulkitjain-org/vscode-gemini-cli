---
name: geminicode-real-app
description: "Test a change to extensions/gemini in the installed GeminiCode.app rather than only in unit tests: run the extension from source in a second, throwaway instance of the app, click into its webviews, read their state, and quit it cleanly. Use when a fix touches a webview (Home, chat, Changes, settings), the extension host's wiring, or anything the unit tests cannot reach."
---

# Testing in the real GeminiCode app

Unit tests (`npm run check` in `extensions/gemini`) cover the pure modules. A change to a webview, a command or the way the extension starts also needs a look in the app. These steps run your working copy of the extension inside the installed `GeminiCode.app`, in a second instance with its own profile, so the user's own window, settings and sign-ins are never touched.

## 1. Build what the dev host loads

The extension's `main` is `./out/extension`, not `dist/`. From the repository root:

```sh
npm run gulp compile-extension:gemini        # out/, which the dev host loads
(cd extensions/gemini && node esbuild.webview.mts)   # media/, the webviews' scripts and styles
```

Rebuild both after every change before reloading the window.

## 2. Start a second instance

```sh
/Applications/GeminiCode.app/Contents/MacOS/GeminiCode \
  --user-data-dir="$TMPDIR/gc/data" \
  --extensions-dir="$TMPDIR/gc/ext" \
  --inspect=9334 \
  --disable-workspace-trust \
  --extensionDevelopmentPath="$PWD/extensions/gemini" \
  <folder to open>
```

- Keep `--user-data-dir` short. The app's IPC socket lives under it, and macOS refuses socket paths of 104 characters or more, so a long temporary path makes the instance hand off to the user's running app instead.
- Without `--disable-workspace-trust` the window opens in Restricted Mode and the Gemini extension stays off.
- `--inspect` opens the main process to a Node inspector on that port; use a port nothing else uses.
- Use a fresh profile folder for each run, or the instance picks up the last run's agents and layout.

## 3. Drive it

- Clicks sent with `webContents.sendInputEvent` never reach a webview's iframe. From the main-process inspector, attach the debugger to the webview's `webContents` (`wc.debugger.attach('1.3')`) and send `Input.dispatchMouseEvent` with `mouseMoved`, `mousePressed` and `mouseReleased` at the element's coordinates.
- Read a webview's state the same way, with `Runtime.evaluate` in the webview's target, rather than from screenshots.
- Take screenshots for the record once the state is right, not to find out what the state is.

## 4. Quit it

Quit with `app.exit(0)` through the main-process inspector. `pkill` may leave the instance half alive, and the next launch then hands off to it instead of starting fresh. Remove the profile folders afterwards.

## Traps

- The installed app can be older than your source even when its build time is later than your change: compare its `extensions/gemini/media/*.js` with your build before deciding the source is wrong.
- A dev host runs the CLI the extension resolves (bundled, installed, `gemini.cliPath` or `PATH`). Run `npm run bundle-cli` in `extensions/gemini` to test against the version the app ships.
- Agents in the test instance run for real against the signed-in account of the CLI they find. Use a throwaway folder, and Default mode, so nothing the agent does lands in a real repository.

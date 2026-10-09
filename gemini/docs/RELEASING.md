# Releasing GeminiCode

GeminiCode ships as a Mac app for Apple silicon, from this repository's [GitHub Releases](https://github.com/pulkitjain-org/vscode-gemini-cli/releases), with a download page at <https://pulkitjain-org.github.io/vscode-gemini-cli/>. Share the page, not the release: it always points at the newest build. The first release, `v0.1.0`, was published on 3 Oct 2026. Windows, Linux and Intel Macs are not built yet.

## Versions

GeminiCode has its own version, starting at `0.1.0`, separate from upstream's `1.141` numbering. The release tag carries it (`v0.1.0`), and the build stamps it into `product.json` as `geminiCodeVersion`. **About** shows both, as `0.1.0 (Code - OSS 1.141.0)`. A build without a stamp, such as a dev build, shows only upstream's version.

There is one stable channel. A tag with a suffix, such as `v0.2.0-rc.1`, publishes a prerelease, which the download page and the update notice ignore.

## Cutting a release

1. Make sure `main` is green.
2. Tag it and push the tag:

   ```sh
   git tag v0.1.0
   git push origin v0.1.0
   ```

3. [`gemini-release.yml`](../../.github/workflows/gemini-release.yml) runs on a GitHub-hosted Apple silicon runner (`macos-15`). It takes about 40 to 60 minutes, and is free on a public repository.
4. When it finishes, the release holds `GeminiCode-<version>-arm64.dmg` and its SHA-256 checksum.

To try the pipeline without publishing, run **Gemini Release** by hand from the Actions tab with no tag. It builds `GeminiCode-0.0.0-dev.<run>-arm64.dmg` as a workflow artifact, kept for 14 days. Running it by hand with an existing tag, such as `v0.1.0`, builds and publishes that tag as a tag push would, for example to retry a failed release. Every run keeps the `.dmg` as an artifact.

If the release already exists, for example because it was made in GitHub's UI, the workflow uploads the `.dmg` and checksum to it (replacing any with the same name) and keeps its title and notes.

## What the workflow does

1. Stamps the version into `product.json`.
2. Installs dependencies, leaves out upstream's Copilot extension, bundles the pinned Gemini CLI (`npm run bundle-cli` in `extensions/gemini`), and builds the app with `npm run gulp vscode-darwin-arm64-min`.
3. Checks that the app holds the bundled CLI and the stamped version, and no Copilot extension.
4. Signs the app with the Developer ID, using upstream's `build/darwin/sign.ts`: hardened runtime and upstream's entitlements for the app and each helper.
5. Notarizes the app with `notarytool` and staples the ticket.
6. Packs a `.dmg` with upstream's `build/darwin/create-dmg.ts` (drag to Applications), then signs, notarizes and staples the `.dmg` too.
7. Publishes the GitHub Release with the `.dmg`, its checksum and release notes that name the upstream and bundled CLI versions, followed by GitHub's generated notes. A version with a suffix is marked as a prerelease.
8. Starts the download page build. A release made by the workflow's own token fires no release event, so the workflow starts the page build itself.

Without the Apple secrets, steps 4 to 6 are replaced by an ad hoc signature. The file is then named `GeminiCode-<version>-arm64-unsigned.dmg`, the release title ends in "(unsigned)", and the notes explain how to open it. Setting only some of the six secrets fails the build, so a typo cannot quietly produce an unsigned release.

## The download page

[`gemini-pages.yml`](../../.github/workflows/gemini-pages.yml) builds the page with [`gemini/site/build.mts`](../site/build.mts) and deploys it to GitHub Pages. It reads the latest release (drafts and prereleases are skipped) and writes:

- `index.html`: the landing page, with a **Download for Mac** button, the main features with screenshots, and the install steps. An unsigned build also gets the steps to open it. The feature text is fixed in `renderPage()` in `build.mts`, so update it when a release changes the main features. Its media are in `gemini/site/media/`, each in a `-dark` and a `-light` copy taken from the app at 1440 × 900 points in GeminiCode Dark and Light: the showcase's clips `showcase-<view>-<theme>.mp4` (2000 × 1250, H.264), each with its last frame as a `.webp`, for the views in `showcaseViews`; and the feature screenshots in `mediaFiles` (`look`, `plus` and `plan` at 1400 × 1000, `review`, `branch` and `helpers` at 1600 × 1000). A missing screenshot is left out, and the showcase is left out unless all its clips are there. When a release changes what they show, retake them.
- `notes.html`: the release notes from the GitHub release, with the download button and the checksum. Its `##` and `###` headings, and lines that are only bold text, become the side navigation. Images pasted into the notes are copied onto the site, because GitHub's links to them expire.
- `latest.json`: the version, download and release links. The app's update notice reads it; keep its `version`, `url` and `notesUrl` fields stable.

The Geist fonts in `gemini/site/fonts/` are served with the page, so it loads nothing from other sites.

A release published by hand has no .dmg until the release workflow uploads it, so until then the page keeps offering the newest release that has one; the upload rebuilds the page.

It runs when a release is published, edited, unpublished or deleted, when `gemini/site/` or `gemini/branding/icon.svg` changes on `main`, when the release workflow starts it, and by hand. It always deploys from `main`, because the `github-pages` environment accepts only the default branch. Turn Pages on once: **Settings → Pages → Source: GitHub Actions**.

To preview the page, run `node gemini/site/build.mts /tmp/site --sample` (or `--none`, for before the first release) and open `/tmp/site/index.html`. A real build needs network access to the GitHub API.

## Opening an unsigned build

Until the Developer ID is in place, macOS blocks GeminiCode on first launch. After dragging it to Applications:

1. Open GeminiCode once. macOS says it cannot verify it; choose **Done**.
2. Open **System Settings → Privacy & Security**, scroll to Security and choose **Open Anyway** next to GeminiCode.

Or, in Terminal: `xattr -dr com.apple.quarantine /Applications/GeminiCode.app`.

## Apple setup

Needs a paid Apple Developer Program membership. Do these once, as the account holder.

### Developer ID Application certificate

1. On a Mac, open **Keychain Access → Certificate Assistant → Request a Certificate From a Certificate Authority**. Enter your email, choose **Saved to disk**, and save the `.certSigningRequest`.
2. At [developer.apple.com → Certificates](https://developer.apple.com/account/resources/certificates/list), choose **+**, then **Developer ID Application** (the G2 Sub-CA), and upload the request.
3. Download the certificate and double-click it to add it to your login keychain.
4. In Keychain Access, under **My Certificates**, right-click **Developer ID Application: <name> (<team ID>)** and choose **Export**. Save it as a `.p12` with a strong password.
5. Encode it: `base64 -i DeveloperID.p12 | pbcopy`.

### App Store Connect API key

1. At [App Store Connect → Users and Access → Integrations → Team Keys](https://appstoreconnect.apple.com/access/integrations/api), create a key with the **Developer** role.
2. Download the `AuthKey_<key ID>.p8` file. Apple lets you download it only once.
3. Note the **Key ID** and the **Issuer ID** shown on that page.

Your **Team ID** is under [Membership details](https://developer.apple.com/account#MembershipDetailsCard).

### Repository secrets

In **Settings → Secrets and variables → Actions**, add:

| Secret | Value |
| --- | --- |
| `MACOS_CERTIFICATE` | The base64 of the `.p12`. |
| `MACOS_CERTIFICATE_PASSWORD` | The `.p12` password. |
| `APPLE_API_KEY` | The contents of the `.p8` file, as is or base64-encoded. |
| `APPLE_API_KEY_ID` | The key ID. |
| `APPLE_API_ISSUER_ID` | The issuer ID. |
| `APPLE_TEAM_ID` | The team ID; the workflow uses it to pick the right certificate. |

The next tag then publishes a signed and notarized build. To check the setup first, run **Gemini Release** by hand and open the artifact on a Mac: it should open without a warning.

## When notarization fails

The workflow prints Apple's log, which names each file Apple rejected. Upstream's signing script signs every binary VS Code ships; the bundled Gemini CLI is plain JavaScript and needs no signature. If something new with a native binary is added to the app, make sure `build/darwin/sign.ts` reaches it.

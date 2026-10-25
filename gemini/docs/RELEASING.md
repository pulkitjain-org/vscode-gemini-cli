# Releasing GeminiCode

GeminiCode ships as a Mac app for Apple silicon on macOS 26 or later, from this repository's [GitHub Releases](https://github.com/pulkitjain-org/vscode-gemini-cli/releases), with a download page at <https://pulkitjain-org.github.io/vscode-gemini-cli/>. Share the page, not the release: it always points at the newest build. Windows, Linux and Intel Macs are not built.

## Versions

GeminiCode has its own version, separate from upstream's numbering. The release tag carries it (`v1.1.0`), and the build stamps it into `product.json` as `geminiCodeVersion`. **About** shows both, as `1.1.0 (Code - OSS 1.142.0)`. A build without a stamp, such as a dev build, shows only upstream's version.

There is one stable channel. A tag with a suffix, such as `v1.2.0-rc.1`, publishes a prerelease, which the download page and the update notice ignore.

## Cutting a release

1. Make sure `main` is green.
2. Tag it and push the tag:

   ```sh
   git tag v1.2.0
   git push origin v1.2.0
   ```

3. [`gemini-release.yml`](../../.github/workflows/gemini-release.yml) runs on a GitHub-hosted Apple silicon runner (`macos-15`). It takes about 40 to 60 minutes, and is free on a public repository.
4. When it finishes, the release holds `GeminiCode-<version>-arm64.dmg` and its SHA-256 checksum.

### Running the workflow by hand

Run **Gemini Release** from the Actions tab:

- With no tag, it builds `GeminiCode-0.0.0-dev.<run>-arm64.dmg` and its `.sha256` as workflow artifacts, kept for 14 days, and publishes nothing. Use this to try the pipeline. The artifacts are uploaded unzipped, so the `.dmg` downloads as is: Chrome can block a `.dmg` inside a `.zip` as a dangerous download.
- With an existing tag, such as `v1.1.0`, it builds and publishes that tag as a tag push would, for example to retry a failed release.

Every run keeps the `.dmg` as an artifact.

If the release already exists, for example because it was made in GitHub's UI, the workflow uploads the `.dmg` and checksum to it, replacing any files with the same names, and keeps its title and notes.

## What the workflow does

1. Stamps the version into `product.json`.
2. Installs dependencies, leaves out upstream's Copilot extension, bundles the pinned Gemini CLI (`npm run bundle-cli` in `extensions/gemini`), and builds the app with `npm run gulp vscode-darwin-arm64-min`.
3. Checks that the app holds the bundled CLI and the stamped version, and no Copilot extension.
4. Sets the app's `LSMinimumSystemVersion` to macOS 26 (`GEMINI_MIN_MACOS`) and checks that its executable is arm64 only. Electron declares an older minimum, and its packager has no option for it. With this set, macOS refuses to open the app on an older release or an Intel Mac, and says why.
5. Copies the layered app icon, `resources/darwin/Assets.car` (compiled by `gemini/scripts/make-icons.sh`, see [branding/README.md](../branding/README.md)), into the app and names it in `Info.plist`, so the Dock and Finder use it.
6. Signs the app with the Developer ID, using upstream's `build/darwin/sign.ts`: hardened runtime and upstream's entitlements for the app and each helper.
7. Notarizes the app with `notarytool` and staples the ticket.
8. Packs a `.dmg` with upstream's `build/darwin/create-dmg.ts` (drag to Applications), then signs, notarizes and staples the `.dmg` too.
9. Publishes the GitHub Release with the `.dmg`, its checksum and release notes that name the upstream and bundled CLI versions, followed by GitHub's generated notes. A version with a suffix is marked as a prerelease.
10. Starts the download page build. A release made with the workflow's own token fires no release event, so the workflow starts the page build itself.
11. For a release that is not a prerelease, opens a `Benchmark <version>` issue as the reminder to run the benchmark ([bench/README.md](../bench/README.md)). If issues are off for the repository, it prints a warning instead.

Without the Apple secrets, steps 6 to 8 are replaced by an ad hoc signature. The file is then named `GeminiCode-<version>-arm64-unsigned.dmg`, the release title ends in "(unsigned)", and the notes explain how to open it. Setting only some of the six secrets fails the build, so a typo cannot quietly produce an unsigned release.

## The download page

[`gemini-pages.yml`](../../.github/workflows/gemini-pages.yml) builds the site with [`gemini/site/build.mts`](../site/build.mts) and deploys it to GitHub Pages. It reads the latest release (drafts and prereleases are skipped) and writes the pages below.

### `index.html`, the landing page

The landing page has, in order:

- The hero: the headline, **Download for Mac**, a line with the version, macOS 26 or later, Apple silicon, the download size and the licence (MIT). The eight capability tiles turn around it on two rings.
- A showcase card with the `showcase-work` screenshot, and a play button for its clip.
- A strip of things you can do.
- Sections on agents, review and safety, Projects, and the browser and team tools, which link to the feature pages.
- The install steps, with the steps to open an unsigned build when the release is unsigned.

All of its text is written out in `renderPage()` in `build.mts`, including the capability tiles (`capabilities`), the strip (`strip`) and the install steps (`steps`). Update it when a release changes the headline features, and keep every sentence true to the README and the guide.

Its screenshots are listed in `mediaFiles` in `build.mts` and kept in `gemini/site/media/`. See [Screenshots and clips](#screenshots-and-clips).

### `features/`

One page for each large part of GeminiCode: Agents, Chat and review, Projects, Browser, and Connected tools. They sit between the landing page and the docs, and are linked from the **Features** menu at the top of every page and from the footer. Each has a clip or screenshot, how it works in four steps, a few sections with a shot each, good-to-know notes, and links into the docs.

What they say is in [`gemini/site/features.mts`](../site/features.mts) (`featurePages`), and their media are named there. The build prints any that are still missing.

### `docs/`

The user docs: a page per Markdown file in [`gemini/docs/guide/`](guide/), rendered by [`gemini/site/docs.mts`](../site/docs.mts).

- The page list and its groups are in `docs.mts` (`docGroups`), and so is the docs home's **All features** list (`featureIndex`). Add a page there when you add a guide file, and a feature there when a release adds one.
- Each page is also written as `<page>.md` for **Copy as Markdown**, and `all.md` holds every page. `search.json` feeds the search box.
- The guide's images point at `gemini/site/media/` (docs-only ones are in `media/docs/`), so they show on GitHub too. An image whose title is `"clip"` plays that showcase clip on the site, and a `-dark.webp` image switches to its `-light.webp` copy on light pages when there is one.

Update the guide in the same pull request as the feature. The site always describes what is on `main`, and the Pages workflow publishes it as soon as it merges.

### `notes.html`

The release notes from the GitHub release, with the download button, **Copy as Markdown** (`notes.md`) and the checksum. Its `##` and `###` headings, and lines that are only bold text, become the side navigation. Images pasted into the notes are copied onto the site, because GitHub's links to them expire.

### `latest.json`

The version, download and release links. The app's update notice reads it, so keep its `version`, `url` and `notesUrl` fields stable.

### Search engines, link previews and AI tools

Every page's `<head>` has a canonical address, Open Graph and Twitter tags, and schema.org JSON-LD: a `SoftwareApplication` on the landing page, built from the latest release, and breadcrumbs on the other pages. `layout()` in `build.mts` writes them from each page's `PageMeta`. Descriptions are at most 160 characters: the feature pages' are in `featurePages` (`description`), the docs pages' in `docGroups`.

The build also writes:

- `sitemap.xml`, listing every page that may be indexed. Submit it once in Google Search Console.
- `llms.txt`, which says in a few lines what GeminiCode is and links each docs page's Markdown copy, for AI tools.
- `404.html`, which GitHub Pages serves for any address on the site that has no page.

Link previews use the 1200 × 630 JPEG crops in `media/og/`, one for the landing page and one per feature page. Remake one with `ffmpeg -i <shot>-light.webp -vf "crop=2000:1050:0:0,scale=1200:630:flags=lanczos" -q:v 3 og/<page>.jpg` when its screenshot is retaken.

### Screenshots and clips

The site's media are in `gemini/site/media/`, each in a `-dark` and a `-light` copy taken from the app at 1440 × 900 points in GeminiCode Dark and Light:

- Screenshots are `<name>-<theme>.webp`, 2000 × 1250. A `<name>-<theme>-1000.webp` copy beside one serves phones.
- Clips are `showcase-<id>-<theme>.mp4` (2000 × 1250, H.264), each with its last frame as `showcase-<id>-<theme>.webp`, used as the poster.

A missing screenshot or clip leaves a labelled placeholder frame. Take every screenshot and clip from the real app, never a mockup, and retake them when a release changes what they show. [MEDIA-TODO.md](../site/MEDIA-TODO.md) records when each was taken and what is still missing.

### Fonts

The Geist, Geist Mono and Newsreader fonts in `gemini/site/fonts/` are served with the site, so it loads nothing from other sites.

### Checks before deploying

Before the upload, `gemini/site/check-seo.mts` checks every page's title, description, canonical address, Open Graph tags and JSON-LD, and that `sitemap.xml`, `llms.txt` and `404.html` match the pages. `gemini/site/check-a11y.mts` runs axe-core on every page, with the screenshot viewer open on pages that have one, and `gemini/site/check-lighthouse.mts` runs Lighthouse on the landing and docs pages. A problem, a violation, or a score under its floor (accessibility 100, the rest 90), stops the deploy. Gemini CI runs the same checks on the sample build, so a pull request sees them first.

### When the page is rebuilt

The Pages workflow runs:

- when a release is published, edited, unpublished or deleted;
- when `gemini/site/`, `gemini/docs/guide/`, `gemini/branding/icon.svg` or the workflow itself changes on `main`;
- when the release workflow starts it;
- by hand.

It always deploys from `main`, because the `github-pages` environment accepts only the default branch. Turn Pages on once: **Settings → Pages → Source: GitHub Actions**.

A release published by hand has no `.dmg` until the release workflow uploads it. Until then the page keeps offering the newest release that has one, and the upload rebuilds the page.

### Previewing

Run `node gemini/site/build.mts /tmp/site --sample` (or `--none`, for the page before the first release) and open `/tmp/site/index.html`. A real build needs network access to the GitHub API.

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

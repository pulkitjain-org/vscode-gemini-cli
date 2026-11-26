# GeminiCode icons

The mark is the Aperture: a rounded-square frame, a ring and a four-point star, in one ink colour on a paper tile (ink `#16150F` on paper `#F4F2EC`), or ivory `#F1EEE6` on charcoal `#1C1B18` for dark surfaces. No gradient, no glow and no accent colour: the Gemini colours stay inside the app for Gemini's own moments. The design and its rules are on the Identity artboard of the site redesign canvas.

The files:

| File | What it is |
| --- | --- |
| `GeminiCode.icon` | The macOS app icon, as an Icon Composer document. Open it with Xcode's Icon Composer. |
| `icon-macos.svg` | The classic icon: the same mark on Apple's 824/1024 tile with continuous corners, a light rim and a soft shadow. It becomes `resources/darwin/code.icns`, which is the `CFBundleIconFile` and is used by the `.dmg` window and anything else that reads `.icns`. |
| `dmg-background.svg` | The `.dmg` window's 480×320 background. |
| `icon.svg` | The flat 256 icon for the web, and `code-icon.svg` in the workbench. |

Windows and Linux are not built, so their rasters are not regenerated.

## `GeminiCode.icon`

- `icon.json` sets the paper fill, with a charcoal specialization for the dark appearance, and one group of three vector layers on the 1024 canvas: `Assets/frame.svg`, `ring.svg` and `star.svg`.
- Each layer's fill is specialized per appearance: ink by default, ivory for `dark` and `tinted`. Every specialization list starts with its base entry, which has no `appearance`. Without that entry the list is ignored.
- The layers are flat (`glass` off). Liquid Glass stays on the tile only, so the strokes keep their contrast in Dark, and the Clear and Tinted Dock styles show the mark instead of a faint glass relief.
- The layers are filled outline paths with explicit holes, never SVG strokes. The system's icon renderer fills a stroked shape's interior when it applies a layer fill, which turns the frame into a solid block even though Icon Composer's own preview looks right.
- `preview/` holds the six macOS renditions (Default and Dark, and Tinted and Clear in light and dark) as the script last rendered them.

Because the two renderers differ, look at both after a change: `preview/` (Icon Composer's renderer) and the icon a built app shows in Finder and the Dock (the system's, from `Assets.car`).

## The `.dmg` background

`dmg-background.svg` is a light paper colour (`#F7F5F0`) with a faint dot grid and an ink arrow from the app to Applications. The dots stop around the two icons and their labels. Finder draws the icons at (120, 160) and (360, 160), set in `build/darwin/dmg-settings.py.template`, so the arrow and the clear areas are drawn for those positions.

## Rebuilding the icons

Run `gemini/scripts/make-icons.sh` on macOS 26 with Xcode 26 after changing any of these files. It:

1. compiles `GeminiCode.icon` with `actool` into `resources/darwin/Assets.car`;
2. renders `icon-macos.svg` at each size into `resources/darwin/code.icns`, never scaling down from one large image;
3. copies `icon.svg` into the workbench as `src/vs/workbench/browser/media/code-icon.svg`;
4. renders the `.dmg` background into `resources/darwin/dmg-background.tiff`, at 1x and 2x;
5. renders `preview/` with Icon Composer's `ictool`, when Xcode has it.

The release workflow copies `Assets.car` into the app and sets `CFBundleIconName`; see [`gemini-release.yml`](../../.github/workflows/gemini-release.yml).

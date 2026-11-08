# Custom Island

An iOS-style Dynamic Island for the GNOME Shell top bar.

- **Media**: album art, live equalizer, and a full player on hover (title, artist, progress bar, controls). Works with any MPRIS player: Spotify, browsers, VLC and others.
- **Notifications**: incoming notifications appear in the island, optionally replacing GNOME's own pop-ups. Respects Do Not Disturb.
- **Volume and brightness**: shown in the island instead of GNOME's on-screen pop-up.
- **Charging**: a short message when you plug in the charger.
- **Clock**: click the idle island to open the calendar, like the normal clock.

## Where it sits

Choose under **Settings → Look → Position**:

| Position | What it does |
|---|---|
| Float below the top bar | A floating pill centred under the bar. It hides when there's nothing to show. |
| Next to the date and time | Inside the top bar, to the left or right of the clock. |
| In place of the date and time | Inside the top bar, covering the clock. |

Size, corner roundness, animation speed, hover delays and how long each activity stays on screen can all be changed in the settings window.

## Requirements

GNOME Shell 46, 47 or 48.

## Install

```sh
git clone https://github.com/<you>/custom-island.git
cd custom-island
./install.sh
```

Then log out and back in (Wayland), or press `Alt+F2`, type `r` and press Enter (X11).

Open the settings with `gnome-extensions prefs custom-island@hemanth`. To turn the extension off, run `gnome-extensions disable custom-island@hemanth`.

## Build a zip

```sh
gnome-extensions pack --force \
  --extra-source=island.js --extra-source=keys.js --extra-source=mpris.js
```

This creates `custom-island@hemanth.shell-extension.zip`. Install it with `gnome-extensions install`, or upload it to extensions.gnome.org.

## Files

| File | Purpose |
|---|---|
| `extension.js` | Enables and disables the extension and rebuilds the island when layout settings change |
| `island.js` | The island: views, spring animation, media, notifications, OSD, charging |
| `mpris.js` | Watches media players on the session bus |
| `keys.js` | Maps the GSettings keys used by the extension and the settings window |
| `prefs.js` | Settings window |
| `schemas/` | GSettings schema |
| `stylesheet.css` | Styles |
| `install.sh` | Copies the extension into `~/.local/share/gnome-shell/extensions` and enables it |

## License

GPL-2.0-or-later. See [LICENSE](LICENSE).

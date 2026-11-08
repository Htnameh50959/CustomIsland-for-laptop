# Custom Island

A Dynamic-Island-style pill for the GNOME Shell top bar. Music, notifications, volume, charging and things you copy pop out of it, then it shrinks back out of the way.

Works on GNOME Shell 46, 47 and 48 (Ubuntu 24.04 and newer, Fedora 40 and newer).

## What it does

| When… | The island… |
|---|---|
| Music is playing (Spotify, a browser, VLC, any MPRIS player) | shows the album art and a moving equalizer. Hover to open a full player with title, progress bar and play / pause / next / previous. Scroll on it to change track. |
| A notification arrives | shows it with the app icon. Click to open it. The newest notification always takes over at once; a "· 3 NEW" label shows when several came in a row. Older ones stay in GNOME's notification list. |
| A notification contains a link | adds a blue link chip under the text. Click it to open the link. |
| You copy something | offers what to do with it: **Open** a link, **Write** to an email address, or **Search** / **Translate** any other text. Text that looks like a password is shown as dots. |
| You change the volume or brightness | shows the level instead of GNOME's pop-up. |
| You plug in the charger | shows "Charging" and the battery level. |

Every pop-out has a **✕** button to close it.

### Where it sits

Pick in **Settings → Look → Position**:

| Position | What it does |
|---|---|
| Float below the top bar | A floating pill centred under the bar. It hides when there's nothing to show. |
| Next to the date and time | Inside the top bar, left or right of the clock (your choice, with adjustable spacing). |
| In place of the date and time | Inside the top bar, covering the clock. Click it to open the calendar. |

Size, roundness, animation speed, hover delays, how long each pop-out stays, Do Not Disturb behaviour and more are all in the settings window.

## Install

You need `git` and GNOME's `glib-compile-schemas` (installed with GNOME).

```sh
git clone https://github.com/GITHUB_USER/custom-island.git
cd custom-island
./install.sh
```

`install.sh` copies the extension to `~/.local/share/gnome-shell/extensions/custom-island@hemanth`, compiles its settings and enables it.

Then **log out and back in**. On Wayland (the default on Ubuntu and Fedora) GNOME only loads new or updated extensions at login. On X11 you can instead press `Alt+F2`, type `r` and press Enter.

### Open the settings

```sh
gnome-extensions prefs custom-island@hemanth
```

or use the **Extensions** app.

### Update

```sh
cd custom-island
git pull
./install.sh
```

Then log out and back in.

### Uninstall

```sh
gnome-extensions disable custom-island@hemanth
rm -rf ~/.local/share/gnome-shell/extensions/custom-island@hemanth
```

## If it isn't working

**Nothing shows up after installing.** GNOME hasn't loaded it yet: log out and back in. Then check:

```sh
gnome-extensions info custom-island@hemanth
```

`State` should be `ACTIVE`. If it says `INITIALIZED` or `DISABLED`, run `gnome-extensions enable custom-island@hemanth`.

**"Extension not found".** It isn't installed in the right place. Run `./install.sh` again from the cloned folder.

**State is `ERROR`.** See what went wrong:

```sh
journalctl --user -b | grep -i custom-island
```

Most often this is an unsupported GNOME version. Check yours with `gnome-shell --version`; it must be 46, 47 or 48.

**The island is there but I don't see it.** With "Float below the top bar" and "Hide when there's nothing to show" on, it only appears when something happens. Play some music or copy a link to test it.

**Notifications don't show.** Check that Do Not Disturb is off, or turn off "Respect Do Not Disturb" in the settings.

**Copy suggestions don't show.** They're skipped while a fullscreen app is in front. Make sure "Copy suggestions" is on in **Settings → Volume & more**.

**I changed something and nothing happened.** Most settings apply at once. Position and size settings rebuild the island, which takes a moment.

## How it works

- `extension.js` adds the island to the shell when the extension is enabled and rebuilds it when a layout setting changes.
- `island.js` is the island: a black pill that springs between "views" (clock, compact media, full player, volume, notification, charging, copy card).
- Media comes from MPRIS over D-Bus (`mpris.js`). Notifications come from GNOME's message tray, whose own banners are hidden while the island is running (optional).
- Copy suggestions watch the clipboard through GNOME Shell's selection API. Copied text is only kept in memory long enough to show the card; nothing is saved or sent anywhere.

| File | Purpose |
|---|---|
| `extension.js` | Enables and disables the extension; rebuilds the island when layout settings change |
| `island.js` | The island: views, spring animation, media, notifications, copy suggestions, OSD, charging |
| `mpris.js` | Watches media players on the session bus |
| `keys.js` | Maps the settings keys used by the extension and the settings window |
| `prefs.js` | Settings window |
| `schemas/` | Settings schema |
| `stylesheet.css` | Styles |
| `install.sh` | Copies the extension into place, compiles the schema and enables it |

## Build a zip (for extensions.gnome.org)

```sh
gnome-extensions pack --force \
  --extra-source=island.js --extra-source=keys.js --extra-source=mpris.js
```

This creates `custom-island@hemanth.shell-extension.zip`. Install it with `gnome-extensions install --force <zip>`, or upload it to extensions.gnome.org.

## Related

- [Notify Bridge](https://github.com/GITHUB_USER/notify-bridge): your Android phone's notifications on the PC over Bluetooth. They appear in the island like any other notification.
- [Island for Android](https://github.com/GITHUB_USER/island-app): the same idea on your phone, around the front camera.

## License

GPL-2.0-or-later. See [LICENSE](LICENSE).

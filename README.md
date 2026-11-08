# Custom Island

An iOS-style Dynamic Island for the GNOME top bar.

- **Idle**: a small empty black pill floating just below the top bar (the bar keeps its own clock).
- **Media**: album art and an animated equalizer for whatever is playing (any MPRIS player: Spotify, browsers, VLC…). Hover to expand into a full player with controls.
- **Activities**: volume/brightness changes, notifications and charging appear as island pop-outs.

Supports GNOME Shell 46, 47 and 48.

## Install
    git clone <this repo> CustomIsland
    cd CustomIsland
    ./install.sh

Then log out and back in (Wayland), or press `Alt+F2`, type `r`, Enter (X11).

To turn it off: `gnome-extensions disable custom-island@hemanth`

## Files
| File | Role |
|---|---|
| `extension.js` | Entry point: adds/removes the island on enable/disable |
| `island.js` | The island widget, layouts, animations and activities |
| `mpris.js` | Media player tracking over D-Bus (MPRIS) |
| `stylesheet.css` | Styling |
| `metadata.json` | Extension name, UUID and supported shell versions |

## Settings
Edit `CONFIG` at the top of `island.js`, then run `./install.sh` and log out/in.
Set `BELOW_PANEL: false` to put the pill inside the top bar instead (it then replaces the clock).

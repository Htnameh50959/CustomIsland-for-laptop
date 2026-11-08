#!/usr/bin/env bash
# Copy the extension into GNOME Shell's extensions folder and enable it.
set -e
cd "$(dirname "$0")"
UUID="custom-island@hemanth"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"
mkdir -p "$DEST/schemas"
cp extension.js island.js keys.js mpris.js prefs.js metadata.json stylesheet.css "$DEST"/
cp schemas/*.gschema.xml "$DEST/schemas/"
glib-compile-schemas "$DEST/schemas"
gnome-extensions enable "$UUID" 2>/dev/null || true
echo "Installed to $DEST"
echo "Log out and back in (Wayland) or press Alt+F2, type r, Enter (X11) to load changes."

#!/usr/bin/env bash
# Copy the extension into GNOME Shell's extensions folder and enable it.
set -e
UUID="custom-island@hemanth"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"
mkdir -p "$DEST"
cp extension.js island.js mpris.js metadata.json stylesheet.css "$DEST"/
gnome-extensions enable "$UUID" 2>/dev/null || true
echo "Installed to $DEST"
echo "Log out and back in (Wayland) or press Alt+F2, type r, Enter (X11) to load changes."

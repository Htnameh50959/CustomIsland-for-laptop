import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Island, CONFIG} from './island.js';
import {SCHEMA, KEYS, readKey, migrateSettings} from './keys.js';

export default class CustomIslandExtension extends Extension {
    enable() {
        this._settings = this.getSettings(SCHEMA);
        migrateSettings(this._settings);
        for (const key of Object.keys(KEYS))
            CONFIG[KEYS[key].config] = readKey(this._settings, key);

        // Most settings are read live; layout ones need the island rebuilt.
        this._settings.connectObject('changed', (_s, key) => {
            const k = KEYS[key];
            if (!k)
                return;
            CONFIG[k.config] = readKey(this._settings, key);
            if (k.rebuild && this._island)
                this._scheduleRebuild();
            else
                this._island?.relayout();
        }, this);

        if (Main.layoutManager._startingUp) {
            this._startupId = Main.layoutManager.connect('startup-complete', () => {
                Main.layoutManager.disconnect(this._startupId);
                this._startupId = 0;
                this._create();
            });
        } else {
            this._create();
        }
    }

    _create() {
        this._island = new Island(GLib.build_filenamev([GLib.get_user_cache_dir(), 'custom-island']));
        Main.layoutManager.addChrome(this._island, {affectsInputRegion: true, trackFullscreen: true});
        // sit just above the top bar, but below popup menus
        Main.layoutManager.uiGroup.set_child_above_sibling(this._island, Main.layoutManager.panelBox);
        this._island.start();
    }

    _destroyIsland() {
        if (this._island) {
            Main.layoutManager.removeChrome(this._island);
            this._island.destroy();
            this._island = null;
        }
    }

    // wait for slider drags to settle before rebuilding
    _scheduleRebuild() {
        if (this._rebuildId)
            GLib.source_remove(this._rebuildId);
        this._rebuildId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, () => {
            this._rebuildId = 0;
            this._destroyIsland();
            this._create();
            return GLib.SOURCE_REMOVE;
        });
    }

    disable() {
        if (this._startupId) {
            Main.layoutManager.disconnect(this._startupId);
            this._startupId = 0;
        }
        if (this._rebuildId) {
            GLib.source_remove(this._rebuildId);
            this._rebuildId = 0;
        }
        this._settings?.disconnectObject(this);
        this._settings = null;
        this._destroyIsland();
    }
}

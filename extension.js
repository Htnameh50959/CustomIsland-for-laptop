import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Island} from './island.js';

export default class CustomIslandExtension extends Extension {
    enable() {
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

    disable() {
        if (this._startupId) {
            Main.layoutManager.disconnect(this._startupId);
            this._startupId = 0;
        }
        if (this._island) {
            Main.layoutManager.removeChrome(this._island);
            this._island.destroy();
            this._island = null;
        }
    }
}

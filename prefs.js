import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gdk from 'gi://Gdk';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {SCHEMA, KEYS} from './keys.js';

export default class CustomIslandPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings(SCHEMA);
        const handlerIds = [];
        window._settings = settings; // keep alive with the window
        window.set_default_size(620, 760);
        window.search_enabled = true;

        // ---------------------------------------------------------- helpers --
        const toggle = (key, title, subtitle = '') => {
            const row = new Adw.SwitchRow({title, subtitle});
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            return row;
        };

        // Number row. `scale` shows ms as seconds (1000) or leaves pixels as-is (1).
        const number = (key, title, subtitle, {min, max, step, scale = 1, digits = 0}) => {
            const row = new Adw.SpinRow({
                title, subtitle, digits,
                adjustment: new Gtk.Adjustment({
                    lower: min, upper: max, step_increment: step, page_increment: step * 10,
                }),
            });
            const load = () => {
                row.value = settings.get_int(key) / scale;
            };
            load();
            row.connect('notify::value', () => {
                const v = Math.round(row.value * scale);
                if (v !== settings.get_int(key))
                    settings.set_int(key, v);
            });
            handlerIds.push(settings.connect(`changed::${key}`, load));
            return row;
        };

        const seconds = (key, title, subtitle, min, max, step = 0.1, digits = 1) =>
            number(key, title, subtitle, {min, max, step, scale: 1000, digits});
        const pixels = (key, title, subtitle, min, max, step = 2) =>
            number(key, title, subtitle, {min, max, step});

        const group = (page, title, description, rows) => {
            const g = new Adw.PreferencesGroup({title, description});
            rows.forEach(r => g.add(r));
            page.add(g);
            return g;
        };

        const dependsOn = (row, key) =>
            settings.bind(key, row, 'sensitive', Gio.SettingsBindFlags.GET);

        // Drop-down for a string key with fixed choices: [[value, label], ...]
        const choice = (key, title, subtitle, options) => {
            const row = new Adw.ComboRow({
                title, subtitle,
                model: Gtk.StringList.new(options.map(([, label]) => label)),
            });
            const load = () => {
                const i = options.findIndex(([v]) => v === settings.get_string(key));
                if (i >= 0 && row.selected !== i)
                    row.selected = i;
            };
            load();
            row.connect('notify::selected', () => {
                const v = options[row.selected]?.[0];
                if (v && v !== settings.get_string(key))
                    settings.set_string(key, v);
            });
            handlerIds.push(settings.connect(`changed::${key}`, load));
            return row;
        };

        // Enable a row only for some positions.
        const forPositions = (row, positions) => {
            const sync = () => {
                row.sensitive = positions.includes(settings.get_string('position'));
            };
            sync();
            handlerIds.push(settings.connect('changed::position', sync));
        };

        // ------------------------------------------------------ page: Look --
        const look = new Adw.PreferencesPage({
            title: 'Look', icon_name: 'preferences-desktop-appearance-symbolic',
        });

        const hideIdle = toggle('hide-when-idle', 'Hide when there’s nothing to show',
            'The island disappears until music, a notification or volume needs it');
        const height = pixels('pill-height', 'Height', 'Pixels, when floating below the top bar', 22, 56);
        const idleWidth = pixels('idle-width', 'Idle width',
            'Pixels, when there’s nothing to show and it isn’t hidden', 60, 320, 4);
        const side = choice('clock-side', 'Side', 'Which side of the date and time', [
            ['right', 'Right of the date and time'],
            ['left', 'Left of the date and time'],
        ]);
        const besideGap = pixels('beside-gap', 'Space from the date and time', 'Pixels', 0, 40, 1);
        forPositions(hideIdle, ['below', 'beside-clock']);
        forPositions(idleWidth, ['below', 'beside-clock']);
        forPositions(height, ['below']);
        forPositions(side, ['beside-clock']);
        forPositions(besideGap, ['beside-clock']);

        group(look, 'Position', null, [
            choice('position', 'Where the island sits', null, [
                ['below', 'Float below the top bar'],
                ['beside-clock', 'Next to the date and time'],
                ['replace-clock', 'In place of the date and time'],
            ]),
            side,
            besideGap,
            hideIdle,
            pixels('top-gap', 'Gap above', 'Pixels', 0, 40, 1),
        ]);
        group(look, 'Size', null, [
            height,
            idleWidth,
            pixels('expanded-width', 'Media player width', 'Pixels, when hovering over music', 300, 640, 10),
            pixels('notif-width', 'Notification width', 'Pixels', 260, 640, 10),
            pixels('max-radius', 'Corner roundness', '0 is square, 30 is fully round', 0, 40, 1),
        ]);
        group(look, 'Motion', null, [
            seconds('spring-ms', 'Animation length', 'Seconds — lower is snappier', 0.15, 1.5, 0.05, 2),
            seconds('hover-expand-ms', 'Open player after hovering for', 'Seconds', 0, 2, 0.05, 2),
            seconds('hover-collapse-ms', 'Close player after leaving for', 'Seconds', 0, 3, 0.05, 2),
        ]);
        window.add(look);

        // --------------------------------------------- page: Notifications --
        const notif = new Adw.PreferencesPage({
            title: 'Notifications', icon_name: 'preferences-system-notifications-symbolic',
        });
        group(notif, 'Where they appear', null, [
            toggle('suppress-gnome-banners', 'Only in the island',
                'Hide GNOME’s own notification pop-ups while the island is on'),
        ]);
        group(notif, 'Which ones', 'Phone notifications from Notify Bridge count as normal notifications', [
            toggle('notif-respect-dnd', 'Respect Do Not Disturb',
                'Off: show everything even in Do Not Disturb. Urgent ones always show'),
            toggle('notif-respect-app-settings', 'Respect per-app settings',
                'Skip apps whose pop-ups are off in Settings → Notifications'),
            toggle('notif-show-low-urgency', 'Show low-priority notifications',
                'Apps mark some notifications as unimportant'),
        ]);
        group(notif, 'Timing', null, [
            seconds('notif-ms', 'Show each one for',
                'Seconds. Stays while the pointer is on it. A newer one takes over at once', 1, 30, 0.5, 1),
        ]);
        window.add(notif);

        // --------------------------------------------- page: Volume & more --
        const more = new Adw.PreferencesPage({
            title: 'Volume & more', icon_name: 'audio-volume-high-symbolic',
        });
        group(more, 'Volume and brightness', null, [
            toggle('suppress-gnome-osd', 'Show in the island',
                'Replace GNOME’s volume/brightness pop-up. In fullscreen GNOME’s is used'),
            seconds('osd-ms', 'Show for', 'Seconds', 0.5, 10),
        ]);
        const chargeFor = seconds('charge-ms', 'Show for', 'Seconds', 0.5, 15);
        dependsOn(chargeFor, 'show-charging');
        group(more, 'Charging', null, [
            toggle('show-charging', 'Show when the charger is plugged in'),
            chargeFor,
        ]);

        const linkFor = seconds('link-ms', 'Show for', 'Seconds', 1, 15, 0.5, 1);
        dependsOn(linkFor, 'copied-links');
        group(more, 'Links', 'Links inside notifications always get an Open button', [
            toggle('copied-links', 'Offer to open copied links',
                'Copy a link or email address and the island pops out with an Open button'),
            linkFor,
        ]);

        const reset = new Gtk.Button({
            label: 'Reset all settings', halign: Gtk.Align.CENTER, margin_top: 12,
            css_classes: ['destructive-action', 'pill'],
        });
        reset.connect('clicked', () => {
            const dialog = new Adw.AlertDialog({
                heading: 'Reset all settings?',
                body: 'Every Custom Island option goes back to its default.',
            });
            dialog.add_response('cancel', 'Cancel');
            dialog.add_response('reset', 'Reset');
            dialog.set_response_appearance('reset', Adw.ResponseAppearance.DESTRUCTIVE);
            dialog.connect('response', (_d, response) => {
                if (response === 'reset')
                    Object.keys(KEYS).forEach(k => settings.reset(k));
            });
            dialog.present(window);
        });
        // ------------------------------------------------------- about --
        const openUri = uri => {
            try {
                new Gtk.UriLauncher({uri}).launch(window, null, null);
            } catch {
                Gtk.show_uri(window, uri, Gdk.CURRENT_TIME);
            }
        };
        const linkRow = (title, subtitle, uri) => {
            const row = new Adw.ActionRow({title, subtitle, activatable: true, tooltip_text: uri});
            row.add_suffix(new Gtk.Image({icon_name: 'adw-external-link-symbolic'}));
            row.connect('activated', () => openUri(uri));
            return row;
        };
        const url = this.metadata.url;
        const version = this.metadata['version-name'] ?? String(this.metadata.version ?? '');
        if (url) {
            group(more, 'About', `Custom Island ${version}`.trim(), [
                linkRow('Project page', 'Source code, updates and how to install', url),
                linkRow('Report a problem', 'Open an issue on GitHub', `${url}/issues`),
            ]);
        }

        const resetGroup = new Adw.PreferencesGroup();
        resetGroup.add(reset);
        more.add(resetGroup);
        window.add(more);

        window.connect('close-request', () => {
            handlerIds.forEach(id => settings.disconnect(id));
            return false;
        });
    }
}

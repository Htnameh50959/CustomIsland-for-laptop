// The island itself: one black pill that springs between "views".
//
//   idle      – the clock (click opens the calendar, like the normal clock)
//   compact   – album art · time · equalizer, while media is playing/paused
//   expanded  – full player on hover (art, title, progress, controls)
//   osd       – volume / brightness / caps-lock etc. (replaces GNOME's OSD)
//   notif     – incoming notification (replaces GNOME's banner)
//   charge    – charger plugged in
//   link      – something was just copied: Open / Write / Search / Translate it
//
// Activities (osd/notif/charge) temporarily take over, then it falls back.

import Clutter from 'gi://Clutter';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import GnomeDesktop from 'gi://GnomeDesktop';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Soup from 'gi://Soup?version=3.0';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {MprisWatcher} from './mpris.js';

// ---------------------------------------------------------------- settings --
// Defaults only: extension.js fills these from GSettings (see keys.js / prefs.js).
export const CONFIG = {
    SUPPRESS_GNOME_OSD: true,     // show volume/brightness only in the island
    SUPPRESS_GNOME_BANNERS: true, // show notifications only in the island
    NOTIF_SHOW_LOW_URGENCY: true, // also show apps' "low priority" notifications
    NOTIF_QUEUE_MAX: 20,          // held back while a fullscreen app is in front
    NOTIF_RESPECT_DND: true,      // Do Not Disturb holds back non-critical ones
    NOTIF_RESPECT_APP_SETTINGS: false, // honour per-app "pop-ups off" in Settings
    SHOW_CHARGING: true,
    COPIED_LINKS: true,           // offer to open a link/email right after it's copied
    LINK_MS: 5000,
    HOVER_EXPAND_MS: 180,
    HOVER_COLLAPSE_MS: 380,
    OSD_MS: 1600,
    NOTIF_MS: 4500,
    CHARGE_MS: 3000,
    SPRING_MS: 620,
    // 'below'         – float under the top bar, centred
    // 'beside-clock'  – inside the top bar, next to the date & time
    // 'replace-clock' – inside the top bar, in place of the date & time
    POSITION: 'below',
    CLOCK_SIDE: 'right',          // beside-clock: 'left' or 'right' of the date & time
    BESIDE_GAP: 8,                // beside-clock: px between the date & time and the pill
    TOP_GAP: 6,                   // px between the top bar (or screen top) and the pill
    PILL_HEIGHT: 32,              // pill height when it floats under the top bar
    IDLE_WIDTH: 120,              // empty idle pill width (when the idle pill shows no clock)
    HIDE_WHEN_IDLE: true,         // vanish when there's nothing to show (not in replace-clock)
    MAX_RADIUS: 30,
    EXPANDED_WIDTH: 400,
    NOTIF_WIDTH: 380,
    OSD_TRACK_WIDTH: 150,
};

const Urgency = {LOW: 0, CRITICAL: 3};

// Damped spring, 0 → 1 with a small (~6%) iOS-like overshoot.
function spring(t) {
    if (t >= 1)
        return 1;
    return 1 - Math.exp(-6.5 * t) * Math.cos(2.4 * Math.PI * t);
}

function fmtTime(us) {
    if (!us || us < 0)
        return '0:00';
    const s = Math.floor(us / 1e6);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function themed(name) {
    return new Gio.ThemedIcon({name});
}

// Average colour of an image, biased toward saturated pixels, lifted so it is
// readable on black. Returns a CSS colour or null.
function accentFromImage(path) {
    try {
        const pb = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, 16, 16, false);
        const px = pb.get_pixels();
        const n = pb.get_n_channels();
        const rs = pb.get_rowstride();
        let r = 0, g = 0, b = 0, wsum = 0;
        for (let y = 0; y < pb.get_height(); y++) {
            for (let x = 0; x < pb.get_width(); x++) {
                const i = y * rs + x * n;
                const [pr, pg, pbl] = [px[i], px[i + 1], px[i + 2]];
                const mx = Math.max(pr, pg, pbl), mn = Math.min(pr, pg, pbl);
                const sat = mx === 0 ? 0 : (mx - mn) / mx;
                const w = sat * sat * (mx / 255) + 0.02;
                r += pr * w; g += pg * w; b += pbl * w; wsum += w;
            }
        }
        [r, g, b] = [r / wsum, g / wsum, b / wsum];
        const mx = Math.max(r, g, b, 1);
        if (mx < 210) {
            const k = 210 / mx;
            [r, g, b] = [r * k, g * k, b * k];
        }
        const c = v => Math.min(255, Math.round(v));
        return `rgb(${c(r)},${c(g)},${c(b)})`;
    } catch {
        return null;
    }
}

// ------------------------------------------------------------ equalizer --
class Bars {
    constructor(count, maxH) {
        this._maxH = maxH;
        this.actor = new St.BoxLayout({
            style_class: 'ci-bars',
            y_align: Clutter.ActorAlign.CENTER,
            height: maxH,
        });
        this._bars = [];
        for (let i = 0; i < count; i++) {
            const bar = new St.Widget({
                style_class: 'ci-bar',
                y_align: Clutter.ActorAlign.CENTER,
                height: 3,
            });
            this._bars.push(bar);
            this.actor.add_child(bar);
        }
    }

    setColor(css) {
        for (const b of this._bars)
            b.set_style(css ? `background-color: ${css};` : null);
    }

    tick(playing) {
        for (const b of this._bars) {
            const h = playing ? 3 + Math.random() * (this._maxH - 3) : 3;
            b.ease({height: Math.round(h), duration: 300, mode: Clutter.AnimationMode.EASE_IN_OUT_SINE});
        }
    }
}

// ------------------------------------------------------------- the pill --
export const Island = GObject.registerClass(
class Island extends St.Widget {
    _init(cacheDir) {
        super._init({
            style_class: 'ci-island',
            reactive: true,
            track_hover: true,
            clip_to_allocation: true,
        });

        this._cacheDir = cacheDir;
        this._below = CONFIG.POSITION !== 'beside-clock' && CONFIG.POSITION !== 'replace-clock';
        this._beside = CONFIG.POSITION === 'beside-clock';
        this._replace = CONFIG.POSITION === 'replace-clock';
        this._H = this._below
            ? CONFIG.PILL_HEIGHT
            : Math.max(24, (Main.panel.height || 32) - 2 * CONFIG.TOP_GAP);
        this._ids = new Set();
        this._current = null;
        this._target = null;
        this._player = null;
        this._expanded = false;
        this._activity = null;
        this._notifQueue = [];
        this._burst = 0; // notifications in the current run, shown as "· 3 NEW"
        this._artUrl = null;
        this._cancellable = new Gio.Cancellable();
        this._soup = new Soup.Session({timeout: 10});
        this._ifaceSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        // 'show-banners' here is the global switch that Do Not Disturb turns off
        this._notifSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});

        this._views = {
            idle: this._buildIdle(),
            compact: this._buildCompact(),
            expanded: this._buildExpanded(),
            osd: this._buildOsd(),
            notif: this._buildNotif(),
            charge: this._buildCharge(),
            link: this._buildLink(),
        };
        for (const v of Object.values(this._views)) {
            v.opacity = 0;
            v.hide();
            v.set_pivot_point(0.5, 0.5);
            this.add_child(v);
        }

        // clock
        this._clock = new GnomeDesktop.WallClock();
        this._clock.connectObject('notify::clock', () => this._updateClock(), this);
        this._updateClock();

        // the real clock stays in the panel (so its calendar menu still
        // anchors there); replace-clock hides it under the island
        this._dateMenu = Main.panel.statusArea.dateMenu;
        if (this._replace)
            this._dateMenu.container.opacity = 0;
        // beside-clock follows the clock as its width changes (e.g. 9:59 → 10:00)
        if (this._beside) {
            this._dateMenu.container.connectObject('notify::allocation',
                () => this._queueRelayout(), this);
        }
        this._dateMenu.container.connectObject('destroy', () => (this._dateMenu = null), this);
        this._dateMenu.menu.connectObject('open-state-changed', (_m, open) => {
            if (open)
                this._setExpanded(false);
        }, this);

        this._setupInput();
        this._setupOsd();
        this._setupNotifications();
        this._setupBattery();
        this._setupClipboard();
        this._mpris = new MprisWatcher(() => this._onPlayersChanged());

        Main.layoutManager.connectObject('monitors-changed', () => {
            if (this.width)
                this._applySize(this.width, this.height);
        }, this);

        this.connect('destroy', () => this._onDestroy());
    }

    // call once the island is on stage (needs theme nodes to measure)
    start() {
        this._render();
    }

    // ---------------------------------------------------------- helpers --
    _after(ms, fn) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._ids.delete(id);
            fn();
            return GLib.SOURCE_REMOVE;
        });
        this._ids.add(id);
        return id;
    }

    _cancel(id) {
        if (id && this._ids.has(id)) {
            GLib.source_remove(id);
            this._ids.delete(id);
        }
        return 0;
    }

    _label(styleClass, props = {}) {
        const l = new St.Label({style_class: styleClass, y_align: Clutter.ActorAlign.CENTER, ...props});
        l.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        return l;
    }

    _art(size, big) {
        const bin = new St.Bin({
            style_class: big ? 'ci-art ci-art-big' : 'ci-art',
            width: size,
            height: size,
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({
                icon_name: 'audio-x-generic-symbolic',
                icon_size: Math.round(size * 0.5),
            }),
        });
        return bin;
    }

    // ------------------------------------------------------------ views --
    _buildIdle() {
        const v = new St.BoxLayout({style_class: 'ci-view', height: this._H, style: 'padding: 0 18px;'});
        this._idleClock = this._label('ci-clock');
        v.add_child(this._idleClock);
        if (!this._replace) {
            // the panel already shows the time: idle is an empty pill, like iPhone
            this._idleClock.hide();
            v.width = CONFIG.IDLE_WIDTH;
        }
        return v;
    }

    _buildCompact() {
        const H = this._H;
        const v = new St.BoxLayout({style_class: 'ci-view', height: H, style: 'padding: 0 10px 0 4px; spacing: 14px;'});
        this._artSmall = this._art(H - 8, false);
        this._compactClock = this._label('ci-clock', {x_expand: true, x_align: Clutter.ActorAlign.CENTER});
        this._barsSmall = new Bars(4, Math.round(H * 0.55));
        v.add_child(this._artSmall);
        v.add_child(this._compactClock);
        v.add_child(this._barsSmall.actor);
        if (this._beside) {
            // the date & time is right next to the pill: don't show it twice
            this._compactClock.hide();
            v.width = Math.max(H * 3, 96);
            this._artSmall.x_expand = true;
            this._artSmall.x_align = Clutter.ActorAlign.START;
        }
        return v;
    }

    _buildExpanded() {
        const W = CONFIG.EXPANDED_WIDTH;
        const v = new St.BoxLayout({
            style_class: 'ci-view', vertical: true, width: W,
            style: 'padding: 16px 20px 12px 20px; spacing: 12px;',
        });

        // header: art + text + bars
        const top = new St.BoxLayout({style: 'spacing: 14px;'});
        this._artBig = this._art(64, true);
        const text = new St.BoxLayout({vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._playerName = this._label('ci-player-name');
        this._title = this._label('ci-title');
        this._artist = this._label('ci-artist');
        text.add_child(this._playerName);
        text.add_child(this._title);
        text.add_child(this._artist);
        this._barsBig = new Bars(5, 24);
        top.add_child(this._artBig);
        top.add_child(text);
        top.add_child(this._barsBig.actor);

        // progress
        const prog = new St.BoxLayout({style: 'spacing: 10px;'});
        // fixed widths: resizing the fill from an allocation handler would
        // force a second layout pass every frame
        const TIME_W = 44;
        this._trackW = W - 40 - 2 * TIME_W - 2 * 10;
        this._elapsed = this._label('ci-time', {width: TIME_W});
        this._remaining = this._label('ci-time', {width: TIME_W});
        this._remaining.clutter_text.line_alignment = Pango.Alignment.RIGHT;
        this._track = new St.Widget({style_class: 'ci-track', width: this._trackW, y_align: Clutter.ActorAlign.CENTER});
        this._fill = new St.Widget({style_class: 'ci-fill', width: 0});
        this._track.add_child(this._fill);
        prog.add_child(this._elapsed);
        prog.add_child(this._track);
        prog.add_child(this._remaining);

        // controls
        const ctl = new St.BoxLayout({style_class: 'ci-controls', x_align: Clutter.ActorAlign.CENTER});
        const mk = (icon, size, cb) => {
            const b = new St.Button({
                style_class: 'ci-btn', can_focus: true,
                child: new St.Icon({icon_name: icon, icon_size: size}),
            });
            b.connect('clicked', () => {
                cb();
                return Clutter.EVENT_STOP;
            });
            ctl.add_child(b);
            return b;
        };
        this._prevBtn = mk('media-skip-backward-symbolic', 20, () => this._player?.previous());
        this._playBtn = mk('media-playback-start-symbolic', 28, () => this._player?.playPause());
        this._nextBtn = mk('media-skip-forward-symbolic', 20, () => this._player?.next());

        v.add_child(top);
        v.add_child(prog);
        v.add_child(ctl);
        return v;
    }

    _buildOsd() {
        const v = new St.BoxLayout({style_class: 'ci-view', height: this._H + 8, style: 'padding: 0 16px; spacing: 12px;'});
        this._osdIcon = new St.Icon({icon_size: 16, y_align: Clutter.ActorAlign.CENTER});
        this._osdLabel = this._label('ci-osd-label');
        this._osdTrack = new St.Widget({
            style_class: 'ci-track', width: CONFIG.OSD_TRACK_WIDTH,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._osdFill = new St.Widget({style_class: 'ci-fill', width: 0});
        this._osdTrack.add_child(this._osdFill);
        this._osdPercent = this._label('ci-percent', {x_align: Clutter.ActorAlign.END});
        this._osdPercent.clutter_text.line_alignment = Pango.Alignment.RIGHT;
        v.add_child(this._osdIcon);
        v.add_child(this._osdLabel);
        v.add_child(this._osdTrack);
        v.add_child(this._osdPercent);
        return v;
    }

    _buildNotif() {
        const v = new St.BoxLayout({
            style_class: 'ci-view', width: CONFIG.NOTIF_WIDTH,
            style: 'padding: 14px 18px; spacing: 14px;',
        });
        this._notifIcon = new St.Icon({icon_size: 36, y_align: Clutter.ActorAlign.CENTER});
        const text = new St.BoxLayout({vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._notifApp = this._label('ci-notif-app');
        this._notifTitle = this._label('ci-notif-title');
        this._notifBody = this._label('ci-notif-body');
        text.add_child(this._notifApp);
        text.add_child(this._notifTitle);
        text.add_child(this._notifBody);
        // a link found in the notification, as a button that opens it
        this._notifLinkLabel = this._label('ci-link-label');
        this._notifLink = new St.Button({
            style_class: 'ci-link', x_align: Clutter.ActorAlign.START, can_focus: true,
            child: this._linkChip(this._notifLinkLabel),
        });
        this._notifLink.connect('clicked', () => {
            if (this._notifUrl)
                this._openUri(this._notifUrl);
            this._endActivity();
        });
        text.add_child(this._notifLink);
        v.add_child(this._notifIcon);
        v.add_child(text);
        const close = this._closeButton();
        close.y_align = Clutter.ActorAlign.START;
        v.add_child(close);
        return v;
    }

    _linkChip(label) {
        const box = new St.BoxLayout({style: 'spacing: 6px;'});
        box.add_child(new St.Icon({icon_name: 'web-browser-symbolic', icon_size: 12, y_align: Clutter.ActorAlign.CENTER}));
        box.add_child(label);
        box.add_child(new St.Icon({icon_name: 'adw-external-link-symbolic', icon_size: 11, y_align: Clutter.ActorAlign.CENTER, style: 'color: #8e8e93;'}));
        return box;
    }

    _buildLink() {
        const v = new St.BoxLayout({
            style_class: 'ci-view', width: CONFIG.NOTIF_WIDTH,
            style: 'padding: 12px 14px 12px 18px; spacing: 12px;',
        });
        this._linkIcon = new St.Icon({style_class: 'ci-link-icon', icon_size: 22, y_align: Clutter.ActorAlign.CENTER});
        const text = new St.BoxLayout({vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._linkKind = this._label('ci-notif-app');
        this._linkText = this._label('ci-link-text');
        text.add_child(this._linkKind);
        text.add_child(this._linkText);
        // suggestion buttons (filled in per copy), then the close button
        this._linkActions = new St.BoxLayout({style: 'spacing: 6px;', y_align: Clutter.ActorAlign.CENTER});
        v.add_child(this._linkIcon);
        v.add_child(text);
        v.add_child(this._linkActions);
        v.add_child(this._closeButton());
        return v;
    }

    // ✕ in the corner: closes whatever the island is showing
    _closeButton() {
        const b = new St.Button({
            style_class: 'ci-close', can_focus: true, y_align: Clutter.ActorAlign.CENTER,
            accessible_name: 'Close',
            child: new St.Icon({icon_name: 'window-close-symbolic', icon_size: 12}),
        });
        b.connect('clicked', () => this._endActivity());
        return b;
    }

    _buildCharge() {
        const v = new St.BoxLayout({style_class: 'ci-view', height: this._H + 8, width: 280, style: 'padding: 0 18px; spacing: 10px;'});
        this._chargeIcon = new St.Icon({
            style_class: 'ci-charge-icon', icon_size: 18,
            icon_name: 'battery-full-charging-symbolic', y_align: Clutter.ActorAlign.CENTER,
        });
        this._chargeText = this._label('ci-charge-text', {x_expand: true});
        this._chargePercent = this._label('ci-charge-percent');
        v.add_child(this._chargeIcon);
        v.add_child(this._chargeText);
        v.add_child(this._chargePercent);
        return v;
    }

    // ------------------------------------------------------------ state --
    _desiredView() {
        if (this._activity)
            return this._activity.kind;
        if (this._player)
            return this._expanded ? 'expanded' : 'compact';
        return 'idle';
    }

    _sizeOf(kind) {
        const v = this._views[kind];
        const [, w] = v.get_preferred_width(-1);
        const [, h] = v.get_preferred_height(w);
        return [Math.ceil(w), Math.ceil(h)];
    }

    _render() {
        const kind = this._desiredView();
        const hide = CONFIG.HIDE_WHEN_IDLE && !this._replace && kind === 'idle';
        if (kind !== this._current)
            this._switchView(kind);
        // hidden = shrink to a dot and fade out; it springs back open from there
        const [w, h] = hide ? [2, 2] : this._sizeOf(kind);
        this._setShown(!hide);
        this._morphTo(w, h);
        this._updateLoops();
    }

    _setShown(on) {
        if (this._shown === on)
            return;
        const first = this._shown === undefined;
        this._shown = on;
        this.reactive = on; // no hover/clicks on the hidden dot
        this.remove_transition('opacity');
        if (first) {
            this.opacity = on ? 255 : 0;
            return;
        }
        this.ease({
            opacity: on ? 255 : 0,
            duration: on ? 120 : 360,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _switchView(kind) {
        const old = this._current ? this._views[this._current] : null;
        const neu = this._views[kind];
        this._current = kind;

        if (old) {
            old.remove_all_transitions();
            old.ease({
                opacity: 0, scale_x: 0.9, scale_y: 0.9,
                duration: 140, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => {
                    if (this._views[this._current] !== old)
                        old.hide();
                },
            });
        }
        neu.remove_all_transitions();
        neu.show();
        neu.opacity = 0;
        neu.set_scale(0.9, 0.9);
        neu.ease({
            opacity: 255, scale_x: 1, scale_y: 1,
            delay: old ? 110 : 0,
            duration: 280, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        this._layoutViews();
    }

    _morphTo(w, h) {
        if (this._target && this._target[0] === w && this._target[1] === h)
            return;
        this._target = [w, h];

        if (this._timeline) {
            this._timeline.stop();
            this._timeline = null;
        }
        const [fw, fh] = [this.width, this.height];
        if (!fw || !fh) {
            this._applySize(w, h);
            return;
        }
        const tl = new Clutter.Timeline({actor: Main.layoutManager.uiGroup, duration: CONFIG.SPRING_MS});
        tl.connect('new-frame', () => {
            const s = spring(tl.get_progress());
            this._applySize(fw + (w - fw) * s, fh + (h - fh) * s);
        });
        tl.connect('completed', () => {
            this._applySize(w, h);
            if (this._timeline === tl)
                this._timeline = null;
        });
        this._timeline = tl;
        tl.start();
    }

    _applySize(w, h) {
        w = Math.max(2, Math.round(w));
        h = Math.max(2, Math.round(h));
        this.set_size(w, h);
        this.set_style(`border-radius: ${Math.round(Math.min(h / 2, CONFIG.MAX_RADIUS))}px;`);
        const mon = Main.layoutManager.primaryMonitor;
        if (mon)
            this.set_position(this._left(mon, w), this._top(mon));
        this._layoutViews();
    }

    // re-place without resizing (clock moved, or side/gap setting changed)
    relayout() {
        if (this.width)
            this._applySize(this.width, this.height);
    }

    _queueRelayout() {
        if (this._relayoutId)
            return;
        // not from inside the panel's allocation pass
        this._relayoutId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._relayoutId = 0;
            this.relayout();
            return GLib.SOURCE_REMOVE;
        });
    }

    _left(mon, w) {
        const centred = Math.round(mon.x + (mon.width - w) / 2);
        const clock = this._dateMenu?.container;
        if (!this._beside || !clock?.mapped)
            return centred;
        const [cx] = clock.get_transformed_position();
        const [cw] = clock.get_transformed_size();
        if (!cw)
            return centred;
        // grow outward from the clock's edge
        const x = CONFIG.CLOCK_SIDE === 'left'
            ? cx - CONFIG.BESIDE_GAP - w
            : cx + cw + CONFIG.BESIDE_GAP;
        return Math.round(Math.max(mon.x, Math.min(x, mon.x + mon.width - w)));
    }

    _top(mon) {
        const panel = this._below ? (Main.panel.height || 0) : 0;
        return mon.y + panel + CONFIG.TOP_GAP;
    }

    // views keep their natural size and stay centred; the pill clips them,
    // so content "reveals" as the pill springs open
    _layoutViews() {
        for (const [kind, v] of Object.entries(this._views)) {
            if (!v.visible)
                continue;
            const [vw, vh] = this._sizeOf(kind);
            v.set_position(Math.round((this.width - vw) / 2), Math.round((this.height - vh) / 2));
        }
    }

    _setExpanded(on) {
        on = on && !!this._player;
        if (on === this._expanded)
            return;
        this._expanded = on;
        this._render();
        if (on)
            this._pollPosition();
    }

    _showActivity(kind, ms) {
        if (kind !== 'notif' && this._activity?.kind === 'notif' && this._notification)
            this._queueNotification(this._notification); // show it again afterwards
        this._activityTimer = this._cancel(this._activityTimer);
        this._activity = {kind};
        const expire = () => {
            // keep a notification while the pointer is on it
            if (this.hover && kind === 'notif') {
                this._activityTimer = this._after(800, expire);
                return;
            }
            this._activityTimer = 0;
            this._activity = null;
            this._notification = null;
            this._render();
            this._nextNotification();
        };
        this._activityTimer = this._after(ms, expire);
        this._render();
    }

    _endActivity() {
        this._activityTimer = this._cancel(this._activityTimer);
        this._activity = null;
        this._notification = null;
        this._render();
        this._nextNotification();
    }

    // equalizer + progress loops only run while visible & playing
    _updateLoops() {
        const playing = this._player?.status === 'Playing';
        const bars = this._current === 'compact' ? this._barsSmall
            : this._current === 'expanded' ? this._barsBig : null;

        if (playing && bars) {
            this._activeBars = bars;
            if (!this._tickId) {
                this._tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 320, () => {
                    this._activeBars?.tick(true);
                    return GLib.SOURCE_CONTINUE;
                });
            }
        } else if (this._tickId) {
            GLib.source_remove(this._tickId);
            this._tickId = 0;
            this._barsSmall.tick(false);
            this._barsBig.tick(false);
        }

        const wantPos = this._current === 'expanded' && playing;
        if (wantPos && !this._posId) {
            this._posId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
                this._pollPosition();
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!wantPos && this._posId) {
            GLib.source_remove(this._posId);
            this._posId = 0;
        }
    }

    // ------------------------------------------------------------ input --
    _setupInput() {
        this.connect('notify::hover', () => {
            this._hoverTimer = this._cancel(this._hoverTimer);
            const want = this.hover;
            this._hoverTimer = this._after(
                want ? CONFIG.HOVER_EXPAND_MS : CONFIG.HOVER_COLLAPSE_MS,
                () => {
                    this._hoverTimer = 0;
                    if (!this._dateMenu?.menu.isOpen)
                        this._setExpanded(want);
                });
        });

        this.connect('button-release-event', (_a, event) => {
            const button = event.get_button();
            switch (this._current) {
            case 'idle':
                this._dateMenu?.menu.toggle();
                break;
            case 'compact':
                if (button === 1)
                    this._setExpanded(true);
                else
                    this._player?.playPause();
                break;
            case 'expanded':
                if (button === 1) {
                    this._player?.raise();
                    this._setExpanded(false);
                } else {
                    this._player?.playPause();
                }
                break;
            case 'link':
                this._openCopied();
                break;
            case 'notif':
                try {
                    this._notification?.activate();
                } catch (e) {
                    console.warn(`[custom-island] activate: ${e.message}`);
                }
                this._endActivity();
                break;
            default:
                this._endActivity();
            }
            return Clutter.EVENT_STOP;
        });

        this.connect('scroll-event', (_a, event) => {
            if (!this._player || this._activity)
                return Clutter.EVENT_PROPAGATE;
            const dir = event.get_scroll_direction();
            if (dir === Clutter.ScrollDirection.UP || dir === Clutter.ScrollDirection.LEFT)
                this._player.previous();
            else if (dir === Clutter.ScrollDirection.DOWN || dir === Clutter.ScrollDirection.RIGHT)
                this._player.next();
            return Clutter.EVENT_STOP;
        });
    }

    // ------------------------------------------------------------ clock --
    _updateClock() {
        this._idleClock.text = this._clock.clock;
        const fmt = this._ifaceSettings.get_string('clock-format') === '24h' ? '%H:%M' : '%l:%M';
        this._compactClock.text = GLib.DateTime.new_now_local().format(fmt).trim();
        if (this._current === 'idle' || this._current === 'compact')
            this._render();
    }

    // ------------------------------------------------------------ media --
    _onPlayersChanged() {
        const p = this._mpris.active;
        this._player = p;
        if (!p) {
            this._expanded = false;
            this._render();
            return;
        }
        this._playerName.text = (p.identity || '').toUpperCase();
        this._title.text = p.title;
        this._artist.text = p.artist;
        this._playBtn.child.icon_name = p.status === 'Playing'
            ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        this._prevBtn.reactive = p.canGoPrevious;
        this._prevBtn.opacity = p.canGoPrevious ? 255 : 90;
        this._nextBtn.reactive = p.canGoNext;
        this._nextBtn.opacity = p.canGoNext ? 255 : 90;
        this._loadArt(p.artUrl);
        if (!p.length)
            this._setProgress(0, 0);
        this._render();
    }

    _pollPosition() {
        const p = this._player;
        if (!p)
            return;
        p.getPosition(pos => {
            if (p === this._player && pos !== null)
                this._setProgress(pos, p.length);
        });
    }

    _setProgress(pos, len) {
        const frac = len > 0 ? Math.min(1, Math.max(0, pos / len)) : 0;
        this._fill.ease({
            width: Math.round(this._trackW * frac),
            duration: 250, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        this._elapsed.text = fmtTime(pos);
        this._remaining.text = len > 0 ? `-${fmtTime(len - pos)}` : '';
    }

    _loadArt(url) {
        if (url === this._artUrl)
            return;
        this._artUrl = url;
        if (!url) {
            this._applyArt(null);
            return;
        }
        if (url.startsWith('file://')) {
            this._applyArt(url);
            return;
        }
        if (!/^https?:\/\//.test(url))
            return;

        const name = GLib.compute_checksum_for_string(GLib.ChecksumType.MD5, url, -1);
        const file = Gio.File.new_for_path(GLib.build_filenamev([this._cacheDir, name]));
        if (file.query_exists(null)) {
            this._applyArt(file.get_uri());
            return;
        }
        const msg = Soup.Message.new('GET', url);
        if (!msg)
            return;
        this._soup.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, this._cancellable, (s, res) => {
            try {
                const bytes = s.send_and_read_finish(res);
                if (msg.get_status() !== Soup.Status.OK)
                    return;
                GLib.mkdir_with_parents(this._cacheDir, 0o755);
                file.replace_contents(bytes.toArray(), null, false,
                    Gio.FileCreateFlags.REPLACE_DESTINATION, null);
                if (this._artUrl === url)
                    this._applyArt(file.get_uri());
            } catch (e) {
                if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    console.warn(`[custom-island] art: ${e.message}`);
            }
        });
    }

    _applyArt(uri) {
        const css = uri ? `background-image: url("${uri.replace(/"/g, '%22')}");` : null;
        for (const art of [this._artSmall, this._artBig]) {
            art.set_style(css);
            art.child.visible = !uri;
        }
        const accent = uri ? accentFromImage(Gio.File.new_for_uri(uri).get_path()) : null;
        this._barsSmall.setColor(accent);
        this._barsBig.setColor(accent);
        this._fill.set_style(accent ? `background-color: ${accent};` : null);
    }

    // -------------------------------------------- volume / brightness OSD --
    _setupOsd() {
        const mgr = Main.osdWindowManager;
        this._osdMgr = mgr;
        this._osdPatched = [];
        if (!CONFIG.SUPPRESS_GNOME_OSD)
            return;

        // GNOME 46: show(monitor, icon, label, level, max)
        // GNOME 47+: showAll(icon, label, level, max), showOne(monitor, ...)
        const patch = (name, argOffset) => {
            if (typeof mgr[name] !== 'function')
                return;
            const orig = mgr[name];
            const island = this;
            mgr[name] = function (...args) {
                const [icon, label, level, maxLevel] = args.slice(argOffset);
                // the island is hidden in fullscreen, so let GNOME handle it
                if (Main.layoutManager.primaryMonitor?.inFullscreen)
                    return orig.apply(this, args);
                island.showOsd(icon, label, level, maxLevel);
                return undefined;
            };
            this._osdPatched.push(name);
        };
        patch('show', 1);
        patch('showAll', 0);
        patch('showOne', 1);
    }

    showOsd(icon, label, level, maxLevel) {
        this._osdIcon.gicon = icon ?? themed('audio-volume-high-symbolic');
        const hasLevel = typeof level === 'number' && level >= 0;
        this._osdTrack.visible = hasLevel;
        this._osdPercent.visible = hasLevel;
        this._osdLabel.visible = !hasLevel && !!label;
        this._osdLabel.text = label ?? '';
        if (hasLevel) {
            const max = maxLevel > 0 ? maxLevel : 1;
            const frac = Math.min(1, Math.max(0, level / max));
            this._osdPercent.text = `${Math.round(level * 100)}%`;
            const w = Math.round(CONFIG.OSD_TRACK_WIDTH * frac);
            if (this._current === 'osd')
                this._osdFill.ease({width: w, duration: 120, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            else
                this._osdFill.width = w;
        }
        this._showActivity('osd', CONFIG.OSD_MS);
    }

    // ---------------------------------------------------- notifications --
    _setupNotifications() {
        const tray = Main.messageTray;
        const watch = source => {
            source.connectObject('notification-request-banner',
                (_s, n) => this._onNotification(n), this);
        };
        tray.getSources().forEach(watch);
        tray.connectObject('source-added', (_t, s) => watch(s), this);
        // show what queued up while a fullscreen app was in front
        global.display.connectObject('in-fullscreen-changed', () => this._nextNotification(), this);
        if (CONFIG.SUPPRESS_GNOME_BANNERS) {
            this._bannersSuppressed = true;
            tray.bannerBlocked = true;
            // GNOME resets bannerBlocked to false whenever a top-bar menu (e.g. the
            // clock/calendar) closes, which brings its banners back. Pin it to true
            // on this instance while the island is running; removed in _onDestroy.
            Object.defineProperty(tray, 'bannerBlocked', {
                configurable: true,
                get: () => true,
                set: () => {},
            });
        }
    }

    _onNotification(n) {
        if (n.acknowledged)
            return;
        if (n.urgency === Urgency.LOW && !CONFIG.NOTIF_SHOW_LOW_URGENCY)
            return;
        if (n.urgency !== Urgency.CRITICAL) {
            // 'show-banners' is the global switch that Do Not Disturb turns off
            if (CONFIG.NOTIF_RESPECT_DND && !this._notifSettings.get_boolean('show-banners'))
                return;
            if (CONFIG.NOTIF_RESPECT_APP_SETTINGS && !n.source?.policy?.showBanners)
                return;
        }

        // hidden by a fullscreen app: hold it until the island is visible again
        if (this._isFullscreen() && n.urgency !== Urgency.CRITICAL) {
            this._queueNotification(n);
            return;
        }
        // Like iOS, the newest notification always takes over at once. The one
        // it replaces is still in GNOME's notification list (the clock menu).
        const replacing = this._activity?.kind === 'notif' && !!this._notification && this._notification !== n;
        this._burst = replacing ? this._burst + 1 : 1;
        this._presentNotification(n, replacing);
    }

    _isFullscreen() {
        return !!Main.layoutManager.primaryMonitor?.inFullscreen;
    }

    _queueNotification(n) {
        if (this._notifQueue.includes(n))
            return;
        this._notifQueue.push(n);
        n.connectObject('destroy', () => {
            this._notifQueue = this._notifQueue.filter(q => q !== n);
        }, this);
        while (this._notifQueue.length > CONFIG.NOTIF_QUEUE_MAX)
            this._notifQueue.shift().disconnectObject?.(this);
    }

    // Show only the newest of what was held back; the count says how many came.
    _nextNotification() {
        if (this._activity || this._isFullscreen())
            return;
        const held = this._notifQueue.filter(n => !n.acknowledged && n.source);
        this._notifQueue.forEach(n => n.disconnectObject?.(this));
        this._notifQueue = [];
        if (!held.length)
            return;
        this._burst = held.length;
        this._presentNotification(held[held.length - 1], false);
    }

    _fillNotification(n) {
        const strip = s => (s ?? '').replace(/<[^>]*>/g, '').replace(/\s*\n\s*/g, ' ').trim();
        this._notifIcon.gicon = n.gicon ?? n.source?.icon ?? themed('preferences-system-notifications-symbolic');
        const app = (n.source?.title ?? '').toUpperCase();
        const more = this._burst > 1 ? `${this._burst} NEW` : '';
        this._notifApp.text = [app, more].filter(Boolean).join('  ·  ');
        this._notifApp.visible = !!this._notifApp.text;
        this._notifTitle.text = strip(n.title);
        this._notifBody.text = strip(n.body);
        this._notifBody.visible = !!this._notifBody.text;
        this._notifUrl = this._findUrl(n.body, n.title);
        this._notifLinkLabel.text = this._notifUrl ? this._prettyUrl(this._notifUrl) : '';
        this._notifLink.visible = !!this._notifUrl;
    }

    _presentNotification(n, replacing) {
        const v = this._views.notif;
        if (replacing && this._current === 'notif') {
            // old text fades out, new text fades in, and the island gives a little bounce
            v.remove_all_transitions();
            v.ease({
                opacity: 0, scale_x: 0.96, scale_y: 0.96,
                duration: 90, mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onComplete: () => {
                    if (this._notification !== n)
                        return; // an even newer one took over
                    this._fillNotification(n);
                    this._render(); // the new text may need a different height
                    v.ease({
                        opacity: 255, scale_x: 1, scale_y: 1,
                        duration: 240, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    });
                },
            });
            this._kick();
        } else {
            this._fillNotification(n);
        }
        this._notification = n;
        // the app may close it while it's on screen; forget it so a click can't touch a dead object
        n.connectObject('destroy', () => {
            if (this._notification === n)
                this._notification = null;
        }, this);
        this._showActivity('notif', CONFIG.NOTIF_MS);
    }

    // a quick swell-and-settle, like the island reacting to something new
    _kick() {
        this.set_pivot_point(0.5, 0.5);
        this.remove_transition('scale-x');
        this.remove_transition('scale-y');
        this.ease({
            scale_x: 1.045, scale_y: 1.045,
            duration: 110, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => this.ease({
                scale_x: 1, scale_y: 1,
                duration: 460, mode: Clutter.AnimationMode.EASE_OUT_BACK,
            }),
        });
    }

    // ------------------------------------------------------------ links --
    // Links in a notification: <a href> markup first, then plain URLs.
    _findUrl(...texts) {
        for (const t of texts) {
            const href = /<a\s[^>]*href=["']([^"']+)["']/i.exec(t ?? '');
            if (href && /^(https?|mailto):/i.test(href[1]))
                return href[1];
        }
        for (const t of texts) {
            const m = /\b(?:https?:\/\/|www\.)[^\s<>"']+/i.exec((t ?? '').replace(/<[^>]*>/g, ' '));
            if (m)
                return this._normaliseUrl(m[0].replace(/[.,;:!?)\]}>]+$/, ''));
        }
        return null;
    }

    _normaliseUrl(u) {
        return /^www\./i.test(u) ? `https://${u}` : u;
    }

    // "https://www.example.com/some/long/path?x=1" → "example.com/some/long/path"
    _prettyUrl(u) {
        if (u.startsWith('mailto:'))
            return u.slice(7);
        return u.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/[?#].*$/, '').replace(/\/$/, '');
    }

    _openUri(uri) {
        try {
            Gio.AppInfo.launch_default_for_uri(uri, global.create_app_launch_context(0, -1));
        } catch (e) {
            console.warn(`[custom-island] open ${uri}: ${e.message}`);
        }
    }

    // Like OriginOS: copy a link or an email address and the island offers to open it.
    _setupClipboard() {
        global.display.get_selection().connectObject('owner-changed', (_sel, type) => {
            if (type !== Meta.SelectionType.SELECTION_CLIPBOARD || !CONFIG.COPIED_LINKS)
                return;
            St.Clipboard.get_default().get_text(St.ClipboardType.CLIPBOARD, (_c, text) => this._onCopied(text));
        }, this);
    }

    // Like OriginOS: whatever you copy, the island offers what to do with it.
    _onCopied(text) {
        const t = (text ?? '').trim();
        if (!t || t.length > 20000 || this._isFullscreen())
            return;
        // the same thing copied again a moment later isn't news
        const now = GLib.get_monotonic_time();
        if (t === this._copiedText && now - (this._copiedAt ?? 0) < 30e6)
            return;
        this._copiedText = t;
        this._copiedAt = now;

        const single = !/\s/.test(t);
        let icon, kind, shown, actions;
        if (single && /^(https?:\/\/|www\.)[^\s]+\.[^\s]+/i.test(t)) {
            const url = this._normaliseUrl(t);
            [icon, kind, shown] = ['web-browser-symbolic', 'LINK COPIED', this._prettyUrl(url)];
            actions = [['Open', true, () => this._openUri(url)]];
        } else if (single && /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(t)) {
            [icon, kind, shown] = ['mail-unread-symbolic', 'EMAIL ADDRESS COPIED', t];
            actions = [['Write', true, () => this._openUri(`mailto:${t}`)]];
        } else {
            const q = encodeURIComponent(t.slice(0, 1000));
            [icon, kind] = ['edit-copy-symbolic', 'TEXT COPIED'];
            // looks like a password: never put it on screen
            shown = this._looksSecret(t) ? '••••••••' : t.replace(/\s+/g, ' ').slice(0, 200);
            actions = [
                ['Search', true, () => this._openUri(`https://www.google.com/search?q=${q}`)],
                ['Translate', false, () => this._openUri(`https://translate.google.com/?sl=auto&op=translate&text=${q}`)],
            ];
        }
        this._linkIcon.icon_name = icon;
        this._linkKind.text = kind;
        this._linkText.text = shown;
        this._linkActions.destroy_all_children();
        for (const [label, primary, run] of actions) {
            const b = new St.Button({
                style_class: primary ? 'ci-open' : 'ci-open ci-open-secondary',
                label, can_focus: true, y_align: Clutter.ActorAlign.CENTER,
            });
            b.connect('clicked', () => {
                run();
                this._endActivity();
            });
            this._linkActions.add_child(b);
        }
        this._linkPrimary = actions[0][2];
        this._showActivity('link', CONFIG.LINK_MS);
    }

    // one word, 8–64 characters, mixing letters and digits, and not a web address
    _looksSecret(t) {
        return !/\s/.test(t) && t.length >= 8 && t.length <= 64 &&
            /[a-z]/i.test(t) && /[0-9]/.test(t) && !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(t);
    }

    _openCopied() {
        this._linkPrimary?.();
        this._endActivity();
    }

    // ---------------------------------------------------------- battery --
    _setupBattery() {
        Gio.DBusProxy.new(
            Gio.DBus.system, Gio.DBusProxyFlags.NONE, null,
            'org.freedesktop.UPower', '/org/freedesktop/UPower/devices/DisplayDevice',
            'org.freedesktop.UPower.Device', this._cancellable,
            (_o, res) => {
                let proxy;
                try {
                    proxy = Gio.DBusProxy.new_finish(res);
                } catch {
                    return;
                }
                const get = k => proxy.get_cached_property(k)?.unpack();
                if (!get('IsPresent'))
                    return;
                this._upower = proxy;
                let lastState = get('State');
                proxy.connectObject('g-properties-changed', () => {
                    const state = get('State'); // 1 charging, 2 discharging, 4 full
                    const pct = Math.round(get('Percentage') ?? 0);
                    const wasOnBattery = lastState === 2 || lastState === 6;
                    lastState = state;
                    if (!wasOnBattery || (state !== 1 && state !== 4) || !CONFIG.SHOW_CHARGING)
                        return;
                    this._chargeText.text = state === 4 ? 'Fully charged' : 'Charging';
                    this._chargePercent.text = `${pct}%`;
                    this._showActivity('charge', CONFIG.CHARGE_MS);
                }, this);
            });
    }

    // ---------------------------------------------------------- cleanup --
    _onDestroy() {
        this._cancellable.cancel();
        for (const id of this._ids)
            GLib.source_remove(id);
        this._ids.clear();
        if (this._tickId)
            GLib.source_remove(this._tickId);
        if (this._posId)
            GLib.source_remove(this._posId);
        if (this._relayoutId)
            GLib.source_remove(this._relayoutId);
        this._timeline?.stop();
        this._timeline = null;
        this._mpris?.destroy();
        this._soup.abort();

        for (const name of this._osdPatched)
            delete this._osdMgr[name]; // falls back to the prototype method

        if (this._bannersSuppressed) {
            // drop banners queued while blocked so they don't all pop up now
            const tray = Main.messageTray;
            delete tray.bannerBlocked; // back to GNOME's own getter/setter
            if (Array.isArray(tray._notificationQueue))
                tray._notificationQueue = [];
            tray.bannerBlocked = false;
        }

        if (this._dateMenu)
            this._dateMenu.container.opacity = 255;
        this._clock = null;
    }
});

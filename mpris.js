// MPRIS (media player) watcher: tracks every org.mpris.MediaPlayer2.* on the
// session bus and picks the most relevant one (playing > most recently active).

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const ROOT_IFACE = 'org.mpris.MediaPlayer2';
const PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';
// playerctld mirrors other players; showing it would duplicate them.
const IGNORED = ['playerctld'];

class Player {
    constructor(busName, onChange) {
        this.busName = busName;
        this.lastActivity = Date.now();
        this._onChange = onChange;
        this._cancellable = new Gio.Cancellable();
        this._proxy = null;
        this.identity = busName.slice(MPRIS_PREFIX.length).split('.')[0];

        Gio.DBusProxy.new(
            Gio.DBus.session, Gio.DBusProxyFlags.GET_INVALIDATED_PROPERTIES, null,
            busName, MPRIS_PATH, PLAYER_IFACE, this._cancellable,
            (_o, res) => {
                try {
                    this._proxy = Gio.DBusProxy.new_finish(res);
                } catch (e) {
                    if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        console.warn(`[custom-island] ${busName}: ${e.message}`);
                    return;
                }
                this._propsId = this._proxy.connect('g-properties-changed', () => {
                    this.lastActivity = Date.now();
                    this._onChange(this);
                });
                this._onChange(this);
            });

        // Human readable name ("Spotify", "Firefox", ...)
        this._dbusGet(ROOT_IFACE, 'Identity', v => {
            if (typeof v === 'string' && v)
                this.identity = v;
        });
    }

    get ready() {
        return this._proxy !== null;
    }

    _get(name) {
        const v = this._proxy?.get_cached_property(name);
        return v ? v.recursiveUnpack() : null;
    }

    get status() {
        return this._get('PlaybackStatus') ?? 'Stopped';
    }

    get metadata() {
        return this._get('Metadata') ?? {};
    }

    get title() {
        return this.metadata['xesam:title'] ?? '';
    }

    get artist() {
        const a = this.metadata['xesam:artist'];
        return Array.isArray(a) ? a.join(', ') : (a ?? '');
    }

    get artUrl() {
        return this.metadata['mpris:artUrl'] ?? '';
    }

    get length() {
        // microseconds
        return Number(this.metadata['mpris:length'] ?? 0);
    }

    get canGoNext() {
        return this._get('CanGoNext') ?? true;
    }

    get canGoPrevious() {
        return this._get('CanGoPrevious') ?? true;
    }

    _call(method) {
        this._proxy?.call(method, null, Gio.DBusCallFlags.NONE, -1, null, null);
    }

    playPause() {
        this._call('PlayPause');
    }

    next() {
        this._call('Next');
    }

    previous() {
        this._call('Previous');
    }

    raise() {
        Gio.DBus.session.call(this.busName, MPRIS_PATH, ROOT_IFACE, 'Raise',
            null, null, Gio.DBusCallFlags.NONE, -1, null, null);
    }

    _dbusGet(iface, prop, cb) {
        Gio.DBus.session.call(this.busName, MPRIS_PATH,
            'org.freedesktop.DBus.Properties', 'Get',
            new GLib.Variant('(ss)', [iface, prop]), new GLib.VariantType('(v)'),
            Gio.DBusCallFlags.NONE, 1000, this._cancellable,
            (conn, res) => {
                try {
                    const [v] = conn.call_finish(res).deepUnpack();
                    cb(v.recursiveUnpack());
                } catch {
                    cb(null);
                }
            });
    }

    // Position is never signalled by MPRIS, it has to be polled. µs → cb
    getPosition(cb) {
        this._dbusGet(PLAYER_IFACE, 'Position', v => cb(v === null ? null : Number(v)));
    }

    destroy() {
        this._cancellable.cancel();
        if (this._proxy && this._propsId)
            this._proxy.disconnect(this._propsId);
        this._proxy = null;
    }
}

export class MprisWatcher {
    constructor(onUpdate) {
        this._onUpdate = onUpdate;
        this._players = new Map();
        this._cancellable = new Gio.Cancellable();

        this._nameSub = Gio.DBus.session.signal_subscribe(
            'org.freedesktop.DBus', 'org.freedesktop.DBus', 'NameOwnerChanged',
            '/org/freedesktop/DBus', null, Gio.DBusSignalFlags.NONE,
            (_c, _s, _p, _i, _sig, params) => {
                const [name, oldOwner, newOwner] = params.deepUnpack();
                if (!name.startsWith(MPRIS_PREFIX))
                    return;
                if (oldOwner)
                    this._remove(name);
                if (newOwner)
                    this._add(name);
            });

        Gio.DBus.session.call('org.freedesktop.DBus', '/org/freedesktop/DBus',
            'org.freedesktop.DBus', 'ListNames', null, new GLib.VariantType('(as)'),
            Gio.DBusCallFlags.NONE, -1, this._cancellable,
            (conn, res) => {
                try {
                    const [names] = conn.call_finish(res).deepUnpack();
                    names.filter(n => n.startsWith(MPRIS_PREFIX)).forEach(n => this._add(n));
                } catch (e) {
                    if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        console.warn(`[custom-island] ListNames: ${e.message}`);
                }
            });
    }

    _add(name) {
        const short = name.slice(MPRIS_PREFIX.length);
        if (this._players.has(name) || IGNORED.some(i => short.startsWith(i)))
            return;
        this._players.set(name, new Player(name, () => this._onUpdate()));
    }

    _remove(name) {
        const p = this._players.get(name);
        if (!p)
            return;
        p.destroy();
        this._players.delete(name);
        this._onUpdate();
    }

    // The player the island should show, or null.
    get active() {
        const candidates = [...this._players.values()]
            .filter(p => p.ready && p.status !== 'Stopped' && p.title);
        if (!candidates.length)
            return null;
        const playing = candidates.filter(p => p.status === 'Playing');
        const pool = playing.length ? playing : candidates;
        return pool.reduce((a, b) => (b.lastActivity > a.lastActivity ? b : a));
    }

    destroy() {
        this._cancellable.cancel();
        Gio.DBus.session.signal_unsubscribe(this._nameSub);
        for (const p of this._players.values())
            p.destroy();
        this._players.clear();
    }
}

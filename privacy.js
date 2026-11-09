// Mic / camera / Wi-Fi hotspot watchers for sticky island pills.
//
// Mic:     `pactl list short source-outputs` (PipeWire/Pulse — any recorder).
// Camera:  `wpctl status` Video → Streams (WirePlumber).
// Hotspot: NetworkManager Wi-Fi device in AP mode + `iw … station dump`.
//
// Privacy signals are debounced (two hits in a row) so a flaky probe cannot
// pin the island open forever.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import NM from 'gi://NM';

export class PrivacyMonitor {
    constructor(onChange) {
        this._onChange = onChange;
        this.micActive = false;
        this.cameraActive = false;
        this.hotspotOn = false;
        this.hotspotClients = 0;

        this._nm = null;
        this._pollId = 0;
        this._busy = false;
        this._micHits = 0;
        this._camHits = 0;
    }

    start() {
        this._setupHotspot();
        this._pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
            this._poll();
            return GLib.SOURCE_CONTINUE;
        });
        this._poll();
    }

    destroy() {
        if (this._pollId) {
            GLib.source_remove(this._pollId);
            this._pollId = 0;
        }
        this._nm = null;
    }

    _poll() {
        if (this._busy)
            return;
        this._busy = true;
        let pending = 2;
        const done = () => {
            pending -= 1;
            if (pending <= 0)
                this._busy = false;
        };
        this._run(['pactl', 'list', 'short', 'source-outputs'], out => {
            // Ignore blank / "Failure:" lines from a missing server.
            const lines = out.split('\n').map(s => s.trim()).filter(s => s && !/^Failure/i.test(s));
            this._setDebounced('mic', lines.length > 0);
            done();
        }, () => {
            this._setDebounced('mic', false);
            done();
        });
        this._run(['wpctl', 'status'], out => {
            this._setDebounced('cam', this._videoStreamActive(out));
            done();
        }, () => {
            this._setDebounced('cam', false);
            done();
        });
        this._refreshHotspotClients();
    }

    // Require two consecutive positives to turn on; clear on the first negative.
    _setDebounced(which, raw) {
        const hitsKey = which === 'mic' ? '_micHits' : '_camHits';
        const prop = which === 'mic' ? 'micActive' : 'cameraActive';
        if (raw) {
            this[hitsKey] = Math.min(2, this[hitsKey] + 1);
        } else {
            this[hitsKey] = 0;
        }
        const next = this[hitsKey] >= 2;
        if (next === this[prop])
            return;
        this[prop] = next;
        this._onChange();
    }

    _run(argv, ok, fail) {
        let proc;
        try {
            proc = Gio.Subprocess.new(
                argv,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch {
            fail();
            return;
        }
        proc.communicate_utf8_async(null, null, (_p, res) => {
            try {
                const [, stdout] = proc.communicate_utf8_finish(res);
                ok(stdout ?? '');
            } catch {
                fail();
            }
        });
    }

    // True only when WirePlumber lists a real client under Video → Streams.
    _videoStreamActive(text) {
        const lines = text.split('\n');
        let inVideo = false;
        let inStreams = false;
        for (const raw of lines) {
            // Top-level section headers are unindented words.
            if (/^(Audio|Video|Settings)\b/.test(raw.trim()) && !/^\s/.test(raw.replace(/^[│|*\s└├─┐┘┤┬┴┼]+/, ''))) {
                // Fall through to the simpler checks below.
            }
            if (/^Video\b/.test(raw.trim()) && !raw.trim().startsWith('Video/')) {
                // Only the main "Video" block (not a property name).
                if (/^\s*Video\s*$/.test(raw) || /^Video\s*$/.test(raw.trim())) {
                    inVideo = true;
                    inStreams = false;
                    continue;
                }
            }
            if (/^\s*Video\s*$/.test(raw)) {
                inVideo = true;
                inStreams = false;
                continue;
            }
            if (inVideo && (/^\s*Audio\s*$/.test(raw) || /^\s*Settings\s*$/.test(raw)))
                break;
            if (inVideo && /Streams:\s*$/.test(raw)) {
                inStreams = true;
                continue;
            }
            if (inVideo && inStreams) {
                // Left streams for another Video subsection.
                if (/Devices:|Sources:|Sinks:|endpoints:/i.test(raw)) {
                    inStreams = false;
                    continue;
                }
                // Client stream: "72. Firefox" / "  *   72. Firefox"
                if (/\d+\.\s+\S+/.test(raw))
                    return true;
            }
        }
        return false;
    }

    // ---------------------------------------------------------- hotspot --
    _setupHotspot() {
        try {
            this._nm = NM.Client.new(null);
        } catch (e) {
            console.warn(`[custom-island] hotspot monitor: ${e.message}`);
            return;
        }
        this._nm.connect('device-added', () => this._refreshHotspot());
        this._nm.connect('device-removed', () => this._refreshHotspot());
        this._nm.connect('active-connection-added', () => this._refreshHotspot());
        this._nm.connect('active-connection-removed', () => this._refreshHotspot());
        for (const d of this._nm.get_devices()) {
            if (d.get_device_type() !== NM.DeviceType.WIFI)
                continue;
            d.connect('notify::mode', () => this._refreshHotspot());
            d.connect('state-changed', () => this._refreshHotspot());
        }
        this._refreshHotspot();
    }

    _wifiDevices() {
        if (!this._nm)
            return [];
        return this._nm.get_devices().filter(d => d.get_device_type() === NM.DeviceType.WIFI);
    }

    _isAp(d) {
        try {
            const mode = typeof d.get_mode === 'function' ? d.get_mode() : d.mode;
            // NM.80211Mode.AP === 3
            return mode === 3;
        } catch {
            return false;
        }
    }

    _refreshHotspot() {
        const on = this._wifiDevices().some(d => this._isAp(d));
        if (on === this.hotspotOn) {
            if (!on && this.hotspotClients !== 0) {
                this.hotspotClients = 0;
                this._onChange();
            }
            return;
        }
        this.hotspotOn = on;
        if (!on)
            this.hotspotClients = 0;
        this._onChange();
        if (on)
            this._refreshHotspotClients();
    }

    _refreshHotspotClients() {
        if (!this.hotspotOn)
            return;
        const iface = this._wifiDevices().find(d => this._isAp(d))?.get_iface();
        if (!iface)
            return;
        this._run(['iw', 'dev', iface, 'station', 'dump'], out => {
            const count = (out.match(/^Station /gm) || []).length;
            if (count === this.hotspotClients)
                return;
            this.hotspotClients = count;
            this._onChange();
        }, () => {});
    }
}

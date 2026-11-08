// Settings shared by the extension (extension.js) and the settings window (prefs.js).
// Each GSettings key maps onto a CONFIG field in island.js.
//   rebuild: the island reads it only while being built, so a change rebuilds the island.
//   scale:   prefs shows the value divided by this (ms → seconds).

export const SCHEMA = 'org.gnome.shell.extensions.custom-island';

export const KEYS = {
    // look & position
    'position':              {config: 'POSITION', type: 's', rebuild: true},
    'clock-side':            {config: 'CLOCK_SIDE', type: 's'},
    'beside-gap':            {config: 'BESIDE_GAP', type: 'i'},
    'hide-when-idle':        {config: 'HIDE_WHEN_IDLE', type: 'b'},
    'top-gap':               {config: 'TOP_GAP', type: 'i', rebuild: true},
    'pill-height':           {config: 'PILL_HEIGHT', type: 'i', rebuild: true},
    'idle-width':            {config: 'IDLE_WIDTH', type: 'i', rebuild: true},
    'expanded-width':        {config: 'EXPANDED_WIDTH', type: 'i', rebuild: true},
    'notif-width':           {config: 'NOTIF_WIDTH', type: 'i', rebuild: true},
    'max-radius':            {config: 'MAX_RADIUS', type: 'i'},
    'spring-ms':             {config: 'SPRING_MS', type: 'i'},
    'hover-expand-ms':       {config: 'HOVER_EXPAND_MS', type: 'i'},
    'hover-collapse-ms':     {config: 'HOVER_COLLAPSE_MS', type: 'i'},

    // notifications
    'suppress-gnome-banners': {config: 'SUPPRESS_GNOME_BANNERS', type: 'b', rebuild: true},
    'notif-ms':               {config: 'NOTIF_MS', type: 'i'},
    'notif-queue-max':        {config: 'NOTIF_QUEUE_MAX', type: 'i'},
    'notif-show-low-urgency': {config: 'NOTIF_SHOW_LOW_URGENCY', type: 'b'},
    'notif-respect-dnd':      {config: 'NOTIF_RESPECT_DND', type: 'b'},
    'notif-respect-app-settings': {config: 'NOTIF_RESPECT_APP_SETTINGS', type: 'b'},

    // volume / brightness / charging
    'suppress-gnome-osd':    {config: 'SUPPRESS_GNOME_OSD', type: 'b', rebuild: true},
    'osd-ms':                {config: 'OSD_MS', type: 'i'},
    'show-charging':         {config: 'SHOW_CHARGING', type: 'b'},
    'charge-ms':             {config: 'CHARGE_MS', type: 'i'},

    // links
    'copied-links':          {config: 'COPIED_LINKS', type: 'b'},
    'link-ms':               {config: 'LINK_MS', type: 'i'},
};

export function readKey(settings, key) {
    switch (KEYS[key].type) {
    case 'b': return settings.get_boolean(key);
    case 's': return settings.get_string(key);
    default: return settings.get_int(key);
    }
}

// Older versions had a single on/off "below-panel" switch. Carry an "off"
// (inside the top bar) over to the new position setting, once.
export function migrateSettings(settings) {
    if (settings.get_user_value('below-panel') === null)
        return;
    if (!settings.get_boolean('below-panel') && settings.get_user_value('position') === null)
        settings.set_string('position', 'replace-clock');
    settings.reset('below-panel');
}

// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const GnomeDesktop = imports.gi.GnomeDesktop;
const GObject = imports.gi.GObject;
const GWeather = imports.gi.GWeather;
const Lang = imports.lang;
const Mainloop = imports.mainloop;
const Cairo = imports.cairo;
const Clutter = imports.gi.Clutter;
const Shell = imports.gi.Shell;
const St = imports.gi.St;
const Atk = imports.gi.Atk;

const Params = imports.misc.params;
const Util = imports.misc.util;
const Main = imports.ui.main;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;
const Calendar = imports.ui.calendar;

function _isToday(date) {
    let now = new Date();
    return now.getYear() == date.getYear() &&
           now.getMonth() == date.getMonth() &&
           now.getDate() == date.getDate();
}

const TodayButton = new Lang.Class({
    Name: 'TodayButton',

    _init: function(calendar) {
        // Having the ability to go to the current date if the user is already
        // on the current date can be confusing. So don't make the button reactive
        // until the selected date changes.
        this.actor = new St.Button({ style_class: 'datemenu-today-button',
                                     reactive: false
                                   });
        this.actor.connect('clicked', Lang.bind(this,
            function() {
                this._calendar.setDate(new Date(), false);
            }));

        let hbox = new St.BoxLayout({ vertical: true });
        this.actor.add_actor(hbox);

        this._dayLabel = new St.Label({ style_class: 'day-label',
                                        x_align: Clutter.ActorAlign.START });
        hbox.add_actor(this._dayLabel);

        this._dateLabel = new St.Label({ style_class: 'date-label' });
        hbox.add_actor(this._dateLabel);

        this._calendar = calendar;
        this._calendar.connect('selected-date-changed', Lang.bind(this,
            function(calendar, date) {
                // Make the button reactive only if the selected date is not the
                // current date.
                this.actor.can_focus = this.actor.reactive = !_isToday(date)
            }));
    },

    setDate: function(date) {
        this._dayLabel.set_text(date.toLocaleFormat('%A'));

        /* Translators: This is the date format to use when the calendar popup is
         * shown - it is shown just below the time in the shell (e.g. "Tue 9:29 AM").
         */
        let dateFormat = Shell.util_translate_time_string (N_("%B %e %Y"));
        this._dateLabel.set_text(date.toLocaleFormat(dateFormat));
    }
});

const WorldClocksSection = new Lang.Class({
    Name: 'WorldClocksSection',

    _init: function() {
        this._clock = new GnomeDesktop.WallClock();
        this._settings = null;
        this._clockNotifyId = 0;
        this._changedId = 0;

        this._locations = [];

        this.actor = new St.Button({ style_class: 'world-clocks-button',
                                     x_fill: true,
                                     can_focus: true });
        this.actor.connect('clicked', Lang.bind(this,
            function() {
                let app = this._getClockApp();
                app.activate();
            }));

        let layout = new Clutter.GridLayout({ orientation: Clutter.Orientation.VERTICAL });
        this._grid = new St.Widget({ style_class: 'world-clocks-grid',
                                     layout_manager: layout });
        layout.hookup_style(this._grid);

        this.actor.child = this._grid;

        Shell.AppSystem.get_default().connect('installed-changed',
                                              Lang.bind(this, this._sync));
        this._sync();
    },

    _getClockApp: function() {
        return Shell.AppSystem.get_default().lookup_app('org.gnome.clocks.desktop');
    },

    _sync: function() {
        this.actor.visible = (this._getClockApp() != null);

        if (this.actor.visible) {
            if (!this._settings) {
                this._settings = new Gio.Settings({ schema_id: 'org.gnome.clocks' });
                this._changedId =
                    this._settings.connect('changed::world-clocks',
                                           Lang.bind(this, this._clocksChanged));
                this._clocksChanged();
            }
        } else {
            if (this._settings)
                this._settings.disconnect(this._changedId);
            this._settings = null;
            this._changedId = 0;
        }
    },

    _clocksChanged: function() {
        this._grid.destroy_all_children();
        this._locations = [];

        let world = GWeather.Location.get_world();
        let clocks = this._settings.get_value('world-clocks').deep_unpack();
        for (let i = 0; i < clocks.length; i++) {
            let l = world.deserialize(clocks[i].location);
            this._locations.push({ location: l });
        }

        this._locations.sort(function(a, b) {
            let aCity = a.location.get_city_name();
            let bCity = b.location.get_city_name();
            return aCity.localeCompare(bCity);
        });

        let layout = this._grid.layout_manager;
        let title = (this._locations.length == 0) ? _("Add world clocks...")
                                                  : _("World clocks");
        let header = new St.Label({ style_class: 'world-clocks-header',
                                    text: title });
        layout.attach(header, 0, 0, 2, 1);

        for (let i = 0; i < this._locations.length; i++) {
            let l = this._locations[i].location;

            let label = new St.Label({ style_class: 'world-clocks-city',
                                       text: l.get_city_name(),
                                       x_align: Clutter.ActorAlign.START,
                                       x_expand: true });
            layout.attach(label, 0, i + 1, 1, 1);

            let time = new St.Label({ style_class: 'world-clocks-time',
                                      x_align: Clutter.ActorAlign.END,
                                      x_expand: true });
            layout.attach(time, 1, i + 1, 1, 1);

            this._locations[i].actor = time;
        }

        if (this._grid.get_n_children() > 1) {
            if (!this._clockNotifyId)
                this._clockNotifyId =
                    this._clock.connect('notify::clock', Lang.bind(this, this._updateLabels));
            this._updateLabels();
        } else {
            if (this._clockNotifyId)
                this._clock.disconnect(this._clockNotifyId);
            this._clockNotifyId = 0;
        }
    },

    _updateLabels: function() {
        let desktopSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
        let clockFormat = desktopSettings.get_string('clock-format');
        let hasAmPm = new Date().toLocaleFormat('%p') != '';

        let format;
        if (clockFormat == '24h' || !hasAmPm)
            /* Translators: Time in 24h format */
            format = N_("%H\u2236%M");
        else
            /* Translators: Time in 12h format */
            format = N_("%l\u2236%M %p");

        for (let i = 0; i < this._locations.length; i++) {
            let l = this._locations[i];
            let tz = GLib.TimeZone.new(l.location.get_timezone().get_tzid());
            let now = GLib.DateTime.new_now(tz);
            l.actor.text = now.format(format);
        }
    }
});

const FreezableBinLayout = new Lang.Class({
    Name: 'FreezableBinLayout',
    Extends: Clutter.BinLayout,

    _init: function() {
        this.parent();

        this._frozen = false;
        this._savedWidth = [NaN, NaN];
        this._savedHeight = [NaN, NaN];
    },

    set frozen(v) {
        if (this._frozen == v)
            return;

        this._frozen = v;
        if (!this._frozen)
            this.layout_changed();
    },

    vfunc_get_preferred_width: function(container, forHeight) {
        if (!this._frozen || this._savedWidth.some(isNaN))
            this._savedWidth = this.parent(container, forHeight);
        return this._savedWidth;
    },

    vfunc_get_preferred_height: function(container, forWidth) {
        if (!this._frozen || this._savedHeight.some(isNaN))
            this._savedHeight = this.parent(container, forWidth);
        return this._savedHeight;
    }
});

const DateMenuButton = new Lang.Class({
    Name: 'DateMenuButton',
    Extends: PanelMenu.Button,

    _init: function() {
        let item;
        let hbox;
        let vbox;

        let menuAlignment = 0.25;
        if (Clutter.get_default_text_direction() == Clutter.TextDirection.RTL)
            menuAlignment = 1.0 - menuAlignment;
        this.parent(menuAlignment);

        this._clockDisplay = new St.Label({ y_align: Clutter.ActorAlign.CENTER });
        this.actor.label_actor = this._clockDisplay;
        this.actor.add_actor(this._clockDisplay);
        this.actor.add_style_class_name ('clock-display');

        let layout = new FreezableBinLayout();
        let bin = new St.Widget({ layout_manager: layout });
        this.menu.box.add_child(bin);

        hbox = new St.BoxLayout({ name: 'calendarArea' });
        bin.add_actor(hbox);

        // Fill up the first column
        this._messageList = new Calendar.MessageList();
        hbox.add(this._messageList.actor, { expand: true, y_fill: false, y_align: St.Align.START });

        // Whenever the menu is opened, select today
        this.menu.connect('open-state-changed', Lang.bind(this, function(menu, isOpen) {
            if (isOpen) {
                let now = new Date();
                layout.frozen = false;
                this._calendar.setDate(now);
                this._date.setDate(now);
            }
        }));

        // Fill up the second column
        vbox = new St.BoxLayout({vertical: true});
        hbox.add(vbox);

        this._calendar = new Calendar.Calendar();

        // Date
        this._date = new TodayButton(this._calendar);
        vbox.add(this._date.actor, { x_fill: false  });

        this._calendar.connect('selected-date-changed',
                               Lang.bind(this, function(calendar, date) {
                                  layout.frozen = !_isToday(date);
                                  // we know this._messageList is defined here, because selected-data-changed
                                  // only gets emitted when the user clicks a date in the calendar,
                                  // and the calender makes those dates unclickable when instantiated with
                                  // a null event source
                                   this._messageList.setDate(date);
                               }));
        vbox.add(this._calendar.actor);

        this._clocksItem = new WorldClocksSection();
        vbox.add(this._clocksItem.actor);


        // Done with hbox for calendar and event list

        this._clock = new GnomeDesktop.WallClock();
        this._clock.bind_property('clock', this._clockDisplay, 'text', GObject.BindingFlags.SYNC_CREATE);

        Main.sessionMode.connect('updated', Lang.bind(this, this._sessionUpdated));
        this._sessionUpdated();
    },

    _getEventSource: function() {
        return new Calendar.DBusEventSource();
    },

    _setEventSource: function(eventSource) {
        if (this._eventSource)
            this._eventSource.destroy();

        this._calendar.setEventSource(eventSource);
        this._messageList.setEventSource(eventSource);

        this._eventSource = eventSource;
    },

    _sessionUpdated: function() {
        let eventSource;
        let showEvents = Main.sessionMode.showCalendarEvents;
        if (showEvents) {
            eventSource = this._getEventSource();
        } else {
            eventSource = new Calendar.EmptyEventSource();
        }
        this._setEventSource(eventSource);
    }
});

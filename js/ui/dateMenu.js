// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const GnomeDesktop = imports.gi.GnomeDesktop;
const GObject = imports.gi.GObject;
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

function _onVertSepRepaint(area) {
    let cr = area.get_context();
    let themeNode = area.get_theme_node();
    let [width, height] = area.get_surface_size();
    let stippleColor = themeNode.get_color('-stipple-color');
    let stippleWidth = themeNode.get_length('-stipple-width');
    let x = Math.floor(width/2) + 0.5;
    cr.moveTo(x, 0);
    cr.lineTo(x, height);
    Clutter.cairo_set_source_color(cr, stippleColor);
    cr.setDash([1, 3], 1); // Hard-code for now
    cr.setLineWidth(stippleWidth);
    cr.stroke();
    cr.$dispose();
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
                this.actor.can_focus = this.actor.reactive = !this._isToday(date)
            }));
    },

    setDate: function(date) {
        this._dayLabel.set_text(date.toLocaleFormat('%A'));

        /* Translators: This is the date format to use when the calendar popup is
         * shown - it is shown just below the time in the shell (e.g. "Tue 9:29 AM").
         */
        let dateFormat = Shell.util_translate_time_string (N_("%B %e %Y"));
        this._dateLabel.set_text(date.toLocaleFormat(dateFormat));
    },

    _isToday: function(date) {
        let now = new Date();
        return now.getYear() == date.getYear() &&
               now.getMonth() == date.getMonth() &&
               now.getDate() == date.getDate();
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

        hbox = new St.BoxLayout({ name: 'calendarArea' });
        this.menu.box.add_child(hbox);

        // Fill up the first column
        this._messageList = new Calendar.MessageList();
        hbox.add(this._messageList.actor, { expand: true, y_fill: false, y_align: St.Align.START });

        // Whenever the menu is opened, select today
        this.menu.connect('open-state-changed', Lang.bind(this, function(menu, isOpen) {
            if (isOpen) {
                let now = new Date();
                this._calendar.setDate(now);
                this._date.setDate(now);
            }
        }));

        this._separator = new St.DrawingArea({ style_class: 'calendar-vertical-separator',
                                               pseudo_class: 'highlighted' });
        this._separator.connect('repaint', Lang.bind(this, _onVertSepRepaint));
        hbox.add(this._separator);

        // Fill up the second column
        vbox = new St.BoxLayout({vertical: true});
        hbox.add(vbox);

        this._calendar = new Calendar.Calendar();

        // Date
        this._date = new TodayButton(this._calendar);
        vbox.add(this._date.actor, { x_fill: false  });

        this._calendar.connect('selected-date-changed',
                               Lang.bind(this, function(calendar, date) {
                                  // we know this._messageList is defined here, because selected-data-changed
                                  // only gets emitted when the user clicks a date in the calendar,
                                  // and the calender makes those dates unclickable when instantiated with
                                  // a null event source
                                   this._messageList.setDate(date);
                               }));
        vbox.add(this._calendar.actor);

        let separator = new PopupMenu.PopupSeparatorMenuItem();
        vbox.add(separator.actor, { y_align: St.Align.END, expand: true, y_fill: false });

        this._openCalendarItem = new PopupMenu.PopupMenuItem(_("Open Calendar"));
        this._openCalendarItem.connect('activate', Lang.bind(this, this._onOpenCalendarActivate));
        vbox.add(this._openCalendarItem.actor, {y_align: St.Align.END, expand: true, y_fill: false});

        this._openClocksItem = new PopupMenu.PopupMenuItem(_("Open Clocks"));
        this._openClocksItem.connect('activate', Lang.bind(this, this._onOpenClocksActivate));
        vbox.add(this._openClocksItem.actor, {y_align: St.Align.END, expand: true, y_fill: false});

        Shell.AppSystem.get_default().connect('installed-changed',
                                              Lang.bind(this, this._appInstalledChanged));

        item = this.menu.addSettingsAction(_("Date & Time Settings"), 'gnome-datetime-panel.desktop');
        if (item) {
            item.actor.show_on_set_parent = false;
            item.actor.reparent(vbox);
            this._dateAndTimeSeparator = separator;
        }


        // Done with hbox for calendar and event list

        this._clock = new GnomeDesktop.WallClock();
        this._clock.bind_property('clock', this._clockDisplay, 'text', GObject.BindingFlags.SYNC_CREATE);

        Main.sessionMode.connect('updated', Lang.bind(this, this._sessionUpdated));
        this._sessionUpdated();
    },

    _appInstalledChanged: function() {
        this._calendarApp = undefined;
        this._updateEventsVisibility();
    },

    _updateEventsVisibility: function() {
        this._openCalendarItem.actor.visible =
            (this._getCalendarApp() != null);
        this._openClocksItem.actor.visible =
            (this._getClockApp() != null);
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
        this._eventSource.connect('notify::has-calendars', Lang.bind(this, function() {
            this._updateEventsVisibility();
        }));
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
        this._updateEventsVisibility();

        // This needs to be handled manually, as the code to
        // autohide separators doesn't work across the vbox
        this._dateAndTimeSeparator.actor.visible = Main.sessionMode.allowSettings;
    },

    _getCalendarApp: function() {
        if (this._calendarApp !== undefined)
            return this._calendarApp;

        let apps = Gio.AppInfo.get_recommended_for_type('text/calendar');
        if (apps && (apps.length > 0)) {
            let app = Gio.AppInfo.get_default_for_type('text/calendar', false);
            let defaultInRecommended = apps.some(function(a) { return a.equal(app); });
            this._calendarApp = defaultInRecommended ? app : apps[0];
        } else {
            this._calendarApp = null;
        }
        return this._calendarApp;
    },

    _getClockApp: function() {
        return Shell.AppSystem.get_default().lookup_app('org.gnome.clocks.desktop');
    },

    _onOpenCalendarActivate: function() {
        this.menu.close();

        let app = this._getCalendarApp();
        if (app.get_id() == 'evolution.desktop')
            app = Gio.DesktopAppInfo.new('evolution-calendar.desktop');
        app.launch([], global.create_app_launch_context(0, -1));
    },

    _onOpenClocksActivate: function() {
        this.menu.close();
        let app = this._getClockApp();
        app.activate();
    }
});

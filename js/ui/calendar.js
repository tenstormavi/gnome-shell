// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const Atk = imports.gi.Atk;
const Clutter = imports.gi.Clutter;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Gtk = imports.gi.Gtk;
const Lang = imports.lang;
const St = imports.gi.St;
const Signals = imports.signals;
const Pango = imports.gi.Pango;
const Gettext_gtk30 = imports.gettext.domain('gtk30');
const Mainloop = imports.mainloop;
const Meta = imports.gi.Meta;
const Shell = imports.gi.Shell;

const Layout = imports.ui.layout;
const Main = imports.ui.main;
const MessageTray = imports.ui.messageTray;
const Params = imports.misc.params;
const Tweener = imports.ui.tweener;
const Util = imports.misc.util;

const MSECS_IN_DAY = 24 * 60 * 60 * 1000;
const SHOW_WEEKDATE_KEY = 'show-weekdate';
const ELLIPSIS_CHAR = '\u2026';

const MAX_NOTIFICATION_BUTTONS = 3;

const MESSAGE_ANIMATION_TIME = 0.1;

// alias to prevent xgettext from picking up strings translated in GTK+
const gtk30_ = Gettext_gtk30.gettext;
const NC_ = function(context, str) { return str; };

// in org.gnome.desktop.interface
const CLOCK_FORMAT_KEY        = 'clock-format';

function _sameYear(dateA, dateB) {
    return (dateA.getYear() == dateB.getYear());
}

function _sameMonth(dateA, dateB) {
    return _sameYear(dateA, dateB) && (dateA.getMonth() == dateB.getMonth());
}

function _sameDay(dateA, dateB) {
    return _sameMonth(dateA, dateB) && (dateA.getDate() == dateB.getDate());
}

function _isWorkDay(date) {
    /* Translators: Enter 0-6 (Sunday-Saturday) for non-work days. Examples: "0" (Sunday) "6" (Saturday) "06" (Sunday and Saturday). */
    let days = C_('calendar-no-work', "06");
    return days.indexOf(date.getDay().toString()) == -1;
}

function _getBeginningOfDay(date) {
    let ret = new Date(date.getTime());
    ret.setHours(0);
    ret.setMinutes(0);
    ret.setSeconds(0);
    ret.setMilliseconds(0);
    return ret;
}

function _getEndOfDay(date) {
    let ret = new Date(date.getTime());
    ret.setHours(23);
    ret.setMinutes(59);
    ret.setSeconds(59);
    ret.setMilliseconds(999);
    return ret;
}

function _formatEventTime(event, clockFormat, periodBegin, periodEnd) {
    let ret;
    let allDay = (event.allDay || (event.date <= periodBegin && event.end >= periodEnd));
    if (allDay) {
        /* Translators: Shown in calendar event list for all day events
         * Keep it short, best if you can use less then 10 characters
         */
        ret = C_("event list time", "All Day");
    } else {
        let date = event.date >= periodBegin ? event.date : event.end;
        switch (clockFormat) {
        case '24h':
            /* Translators: Shown in calendar event list, if 24h format,
               \u2236 is a ratio character, similar to : */
            ret = date.toLocaleFormat(C_("event list time", "%H\u2236%M"));
            break;

        default:
            /* explicit fall-through */
        case '12h':
            /* Translators: Shown in calendar event list, if 12h format,
               \u2236 is a ratio character, similar to : and \u2009 is
               a thin space */
            ret = date.toLocaleFormat(C_("event list time", "%l\u2236%M\u2009%p"));
            break;
        }
    }
    return ret;
}

function _getCalendarDayAbbreviation(dayNumber) {
    let abbreviations = [
        /* Translators: Calendar grid abbreviation for Sunday.
         *
         * NOTE: These grid abbreviations are always shown together
         * and in order, e.g. "S M T W T F S".
         */
        C_("grid sunday", "S"),
        /* Translators: Calendar grid abbreviation for Monday */
        C_("grid monday", "M"),
        /* Translators: Calendar grid abbreviation for Tuesday */
        C_("grid tuesday", "T"),
        /* Translators: Calendar grid abbreviation for Wednesday */
        C_("grid wednesday", "W"),
        /* Translators: Calendar grid abbreviation for Thursday */
        C_("grid thursday", "T"),
        /* Translators: Calendar grid abbreviation for Friday */
        C_("grid friday", "F"),
        /* Translators: Calendar grid abbreviation for Saturday */
        C_("grid saturday", "S")
    ];
    return abbreviations[dayNumber];
}

// Abstraction for an appointment/event in a calendar

const CalendarEvent = new Lang.Class({
    Name: 'CalendarEvent',

    _init: function(date, end, summary, allDay) {
        this.date = date;
        this.end = end;
        this.summary = summary;
        this.allDay = allDay;
    }
});

// Interface for appointments/events - e.g. the contents of a calendar
//

// First, an implementation with no events
const EmptyEventSource = new Lang.Class({
    Name: 'EmptyEventSource',

    _init: function() {
        this.isLoading = false;
        this.isDummy = true;
        this.hasCalendars = false;
    },

    destroy: function() {
    },

    requestRange: function(begin, end) {
    },

    getEvents: function(begin, end) {
        let result = [];
        return result;
    },

    hasEvents: function(day) {
        return false;
    }
});
Signals.addSignalMethods(EmptyEventSource.prototype);

const CalendarServerIface = '<node> \
<interface name="org.gnome.Shell.CalendarServer"> \
<method name="GetEvents"> \
    <arg type="x" direction="in" /> \
    <arg type="x" direction="in" /> \
    <arg type="b" direction="in" /> \
    <arg type="a(sssbxxa{sv})" direction="out" /> \
</method> \
<property name="HasCalendars" type="b" access="read" /> \
<signal name="Changed" /> \
</interface> \
</node>';

const CalendarServerInfo  = Gio.DBusInterfaceInfo.new_for_xml(CalendarServerIface);

function CalendarServer() {
    return new Gio.DBusProxy({ g_connection: Gio.DBus.session,
                               g_interface_name: CalendarServerInfo.name,
                               g_interface_info: CalendarServerInfo,
                               g_name: 'org.gnome.Shell.CalendarServer',
                               g_object_path: '/org/gnome/Shell/CalendarServer' });
}

function _datesEqual(a, b) {
    if (a < b)
        return false;
    else if (a > b)
        return false;
    return true;
}

function _dateIntervalsOverlap(a0, a1, b0, b1)
{
    if (a1 <= b0)
        return false;
    else if (b1 <= a0)
        return false;
    else
        return true;
}

// an implementation that reads data from a session bus service
const DBusEventSource = new Lang.Class({
    Name: 'DBusEventSource',

    _init: function() {
        this._resetCache();
        this.isLoading = false;
        this.isDummy = false;

        this._initialized = false;
        this._dbusProxy = new CalendarServer();
        this._dbusProxy.init_async(GLib.PRIORITY_DEFAULT, null, Lang.bind(this, function(object, result) {
            let loaded = false;

            try {
                this._dbusProxy.init_finish(result);
                loaded = true;
            } catch(e) {
                if (e.matches(Gio.DBusError, Gio.DBusError.TIMED_OUT)) {
                    // Ignore timeouts and install signals as normal, because with high
                    // probability the service will appear later on, and we will get a
                    // NameOwnerChanged which will finish loading
                    //
                    // (But still _initialized to false, because the proxy does not know
                    // about the HasCalendars property and would cause an exception trying
                    // to read it)
                } else {
                    log('Error loading calendars: ' + e.message);
                    return;
                }
            }

            this._dbusProxy.connectSignal('Changed', Lang.bind(this, this._onChanged));

            this._dbusProxy.connect('notify::g-name-owner', Lang.bind(this, function() {
                if (this._dbusProxy.g_name_owner)
                    this._onNameAppeared();
                else
                    this._onNameVanished();
            }));

            this._dbusProxy.connect('g-properties-changed', Lang.bind(this, function() {
                this.emit('notify::has-calendars');
            }));

            this._initialized = loaded;
            if (loaded) {
                this.emit('notify::has-calendars');
                this._onNameAppeared();
            }
        }));
    },

    destroy: function() {
        this._dbusProxy.run_dispose();
    },

    get hasCalendars() {
        if (this._initialized)
            return this._dbusProxy.HasCalendars;
        else
            return false;
    },

    _resetCache: function() {
        this._events = [];
        this._lastRequestBegin = null;
        this._lastRequestEnd = null;
    },

    _onNameAppeared: function(owner) {
        this._initialized = true;
        this._resetCache();
        this._loadEvents(true);
    },

    _onNameVanished: function(oldOwner) {
        this._resetCache();
        this.emit('changed');
    },

    _onChanged: function() {
        this._loadEvents(false);
    },

    _onEventsReceived: function(results, error) {
        let newEvents = [];
        let appointments = results ? results[0] : null;
        if (appointments != null) {
            for (let n = 0; n < appointments.length; n++) {
                let a = appointments[n];
                let date = new Date(a[4] * 1000);
                let end = new Date(a[5] * 1000);
                let summary = a[1];
                let allDay = a[3];
                let event = new CalendarEvent(date, end, summary, allDay);
                newEvents.push(event);
            }
            newEvents.sort(function(event1, event2) {
                return event1.date.getTime() - event2.date.getTime();
            });
        }

        this._events = newEvents;
        this.isLoading = false;
        this.emit('changed');
    },

    _loadEvents: function(forceReload) {
        // Ignore while loading
        if (!this._initialized)
            return;

        if (this._curRequestBegin && this._curRequestEnd){
            this._dbusProxy.GetEventsRemote(this._curRequestBegin.getTime() / 1000,
                                            this._curRequestEnd.getTime() / 1000,
                                            forceReload,
                                            Lang.bind(this, this._onEventsReceived),
                                            Gio.DBusCallFlags.NONE);
        }
    },

    requestRange: function(begin, end) {
        if (!(_datesEqual(begin, this._lastRequestBegin) && _datesEqual(end, this._lastRequestEnd))) {
            this.isLoading = true;
            this._lastRequestBegin = begin;
            this._lastRequestEnd = end;
            this._curRequestBegin = begin;
            this._curRequestEnd = end;
            this._loadEvents(false);
        }
    },

    getEvents: function(begin, end) {
        let result = [];
        for(let n = 0; n < this._events.length; n++) {
            let event = this._events[n];
            if (_dateIntervalsOverlap (event.date, event.end, begin, end)) {
                result.push(event);
            }
        }
        result.sort(function(event1, event2) {
            // sort events by end time on ending day
            let d1 = event1.date < begin && event1.end <= end ? event1.end : event1.date;
            let d2 = event2.date < begin && event2.end <= end ? event2.end : event2.date;
            return d1.getTime() - d2.getTime();
        });
        return result;
    },

    hasEvents: function(day) {
        let dayBegin = _getBeginningOfDay(day);
        let dayEnd = _getEndOfDay(day);

        let events = this.getEvents(dayBegin, dayEnd);

        if (events.length == 0)
            return false;

        return true;
    }
});
Signals.addSignalMethods(DBusEventSource.prototype);

const Calendar = new Lang.Class({
    Name: 'Calendar',

    _init: function() {
        this._weekStart = Shell.util_get_week_start();
        this._settings = new Gio.Settings({ schema_id: 'org.gnome.shell.calendar' });

        this._settings.connect('changed::' + SHOW_WEEKDATE_KEY, Lang.bind(this, this._onSettingsChange));
        this._useWeekdate = this._settings.get_boolean(SHOW_WEEKDATE_KEY);

        // Find the ordering for month/year in the calendar heading
        this._headerFormatWithoutYear = '%B';
        switch (gtk30_('calendar:MY')) {
        case 'calendar:MY':
            this._headerFormat = '%B %Y';
            break;
        case 'calendar:YM':
            this._headerFormat = '%Y %B';
            break;
        default:
            log('Translation of "calendar:MY" in GTK+ is not correct');
            this._headerFormat = '%B %Y';
            break;
        }

        // Start off with the current date
        this._selectedDate = new Date();

        this._shouldDateGrabFocus = false;

        this.actor = new St.Widget({ style_class: 'calendar',
                                     layout_manager: new Clutter.TableLayout(),
                                     reactive: true });

        this.actor.connect('scroll-event',
                           Lang.bind(this, this._onScroll));

        this._buildHeader ();
    },

    // @eventSource: is an object implementing the EventSource API, e.g. the
    // requestRange(), getEvents(), hasEvents() methods and the ::changed signal.
    setEventSource: function(eventSource) {
        this._eventSource = eventSource;
        this._eventSource.connect('changed', Lang.bind(this, function() {
            this._rebuildCalendar();
            this._update();
        }));
        this._rebuildCalendar();
        this._update();
    },

    // Sets the calendar to show a specific date
    setDate: function(date) {
        if (_sameDay(date, this._selectedDate))
            return;

        this._selectedDate = date;
        this._update();
        this.emit('selected-date-changed', new Date(this._selectedDate));
    },

    _buildHeader: function() {
        let layout = this.actor.layout_manager;
        let offsetCols = this._useWeekdate ? 1 : 0;
        this.actor.destroy_all_children();

        // Top line of the calendar '<| September 2009 |>'
        this._topBox = new St.BoxLayout();
        layout.pack(this._topBox, 0, 0);
        layout.set_span(this._topBox, offsetCols + 7, 1);

        this._backButton = new St.Button({ style_class: 'calendar-change-month-back pager-button',
                                           accessible_name: _("Previous month"),
                                           can_focus: true });
        this._topBox.add(this._backButton);
        this._backButton.connect('clicked', Lang.bind(this, this._onPrevMonthButtonClicked));

        this._monthLabel = new St.Label({style_class: 'calendar-month-label',
                                         can_focus: true });
        this._topBox.add(this._monthLabel, { expand: true, x_fill: false, x_align: St.Align.MIDDLE });

        this._forwardButton = new St.Button({ style_class: 'calendar-change-month-forward pager-button',
                                              accessible_name: _("Next month"),
                                              can_focus: true });
        this._topBox.add(this._forwardButton);
        this._forwardButton.connect('clicked', Lang.bind(this, this._onNextMonthButtonClicked));

        // Add weekday labels...
        //
        // We need to figure out the abbreviated localized names for the days of the week;
        // we do this by just getting the next 7 days starting from right now and then putting
        // them in the right cell in the table. It doesn't matter if we add them in order
        let iter = new Date(this._selectedDate);
        iter.setSeconds(0); // Leap second protection. Hah!
        iter.setHours(12);
        for (let i = 0; i < 7; i++) {
            // Could use iter.toLocaleFormat('%a') but that normally gives three characters
            // and we want, ideally, a single character for e.g. S M T W T F S
            let customDayAbbrev = _getCalendarDayAbbreviation(iter.getDay());
            let label = new St.Label({ style_class: 'calendar-day-base calendar-day-heading',
                                       text: customDayAbbrev });
            let col;
            if (this.actor.get_text_direction() == Clutter.TextDirection.RTL)
                col = 6 - (7 + iter.getDay() - this._weekStart) % 7;
            else
                col = offsetCols + (7 + iter.getDay() - this._weekStart) % 7;
            layout.pack(label, col, 1);
            iter.setTime(iter.getTime() + MSECS_IN_DAY);
        }

        // All the children after this are days, and get removed when we update the calendar
        this._firstDayIndex = this.actor.get_n_children();
    },

    _onScroll : function(actor, event) {
        switch (event.get_scroll_direction()) {
        case Clutter.ScrollDirection.UP:
        case Clutter.ScrollDirection.LEFT:
            this._onPrevMonthButtonClicked();
            break;
        case Clutter.ScrollDirection.DOWN:
        case Clutter.ScrollDirection.RIGHT:
            this._onNextMonthButtonClicked();
            break;
        }
        return Clutter.EVENT_PROPAGATE;
    },

    _onPrevMonthButtonClicked: function() {
        let newDate = new Date(this._selectedDate);
        let oldMonth = newDate.getMonth();
        if (oldMonth == 0) {
            newDate.setMonth(11);
            newDate.setFullYear(newDate.getFullYear() - 1);
            if (newDate.getMonth() != 11) {
                let day = 32 - new Date(newDate.getFullYear() - 1, 11, 32).getDate();
                newDate = new Date(newDate.getFullYear() - 1, 11, day);
            }
        }
        else {
            newDate.setMonth(oldMonth - 1);
            if (newDate.getMonth() != oldMonth - 1) {
                let day = 32 - new Date(newDate.getFullYear(), oldMonth - 1, 32).getDate();
                newDate = new Date(newDate.getFullYear(), oldMonth - 1, day);
            }
        }

        this._backButton.grab_key_focus();

        this.setDate(newDate);
    },

    _onNextMonthButtonClicked: function() {
        let newDate = new Date(this._selectedDate);
        let oldMonth = newDate.getMonth();
        if (oldMonth == 11) {
            newDate.setMonth(0);
            newDate.setFullYear(newDate.getFullYear() + 1);
            if (newDate.getMonth() != 0) {
                let day = 32 - new Date(newDate.getFullYear() + 1, 0, 32).getDate();
                newDate = new Date(newDate.getFullYear() + 1, 0, day);
            }
        }
        else {
            newDate.setMonth(oldMonth + 1);
            if (newDate.getMonth() != oldMonth + 1) {
                let day = 32 - new Date(newDate.getFullYear(), oldMonth + 1, 32).getDate();
                newDate = new Date(newDate.getFullYear(), oldMonth + 1, day);
            }
        }

        this._forwardButton.grab_key_focus();

        this.setDate(newDate);
    },

    _onSettingsChange: function() {
        this._useWeekdate = this._settings.get_boolean(SHOW_WEEKDATE_KEY);
        this._buildHeader();
        this._rebuildCalendar();
        this._update();
    },

    _rebuildCalendar: function() {
        let now = new Date();

        // Remove everything but the topBox and the weekday labels
        let children = this.actor.get_children();
        for (let i = this._firstDayIndex; i < children.length; i++)
            children[i].destroy();

        this._buttons = [];

        // Start at the beginning of the week before the start of the month
        //
        // We want to show always 6 weeks (to keep the calendar menu at the same
        // height if there are no events), so we pad it according to the following
        // policy:
        //
        // 1 - If a month has 6 weeks, we place no padding (example: Dec 2012)
        // 2 - If a month has 5 weeks and it starts on week start, we pad one week
        //     before it (example: Apr 2012)
        // 3 - If a month has 5 weeks and it starts on any other day, we pad one week
        //     after it (example: Nov 2012)
        // 4 - If a month has 4 weeks, we pad one week before and one after it
        //     (example: Feb 2010)
        //
        // Actually computing the number of weeks is complex, but we know that the
        // problematic categories (2 and 4) always start on week start, and that
        // all months at the end have 6 weeks.
        let beginDate = new Date(this._selectedDate);
        beginDate.setDate(1);
        beginDate.setSeconds(0);
        beginDate.setHours(12);

        this._calendarBegin = new Date(beginDate);
        this._markedAsToday = now;

        let year = beginDate.getYear();

        let daysToWeekStart = (7 + beginDate.getDay() - this._weekStart) % 7;
        let startsOnWeekStart = daysToWeekStart == 0;
        let weekPadding = startsOnWeekStart ? 7 : 0;

        beginDate.setTime(beginDate.getTime() - (weekPadding + daysToWeekStart) * MSECS_IN_DAY);

        let layout = this.actor.layout_manager;
        let iter = new Date(beginDate);
        let row = 2;
        // nRows here means 6 weeks + one header + one navbar
        let nRows = 8;
        while (row < 8) {
            let button = new St.Button({ label: iter.getDate().toString(),
                                         can_focus: true });
            let rtl = button.get_text_direction() == Clutter.TextDirection.RTL;

            if (this._eventSource.isDummy)
                button.reactive = false;

            button._date = new Date(iter);
            button.connect('clicked', Lang.bind(this, function() {
                this._shouldDateGrabFocus = true;
                this.setDate(button._date);
                this._shouldDateGrabFocus = false;
            }));

            let hasEvents = this._eventSource.hasEvents(iter);
            let styleClass = 'calendar-day-base calendar-day';

            if (_isWorkDay(iter))
                styleClass += ' calendar-work-day';
            else
                styleClass += ' calendar-nonwork-day';

            // Hack used in lieu of border-collapse - see gnome-shell.css
            if (row == 2)
                styleClass = 'calendar-day-top ' + styleClass;

            let leftMost = rtl ? iter.getDay() == (this._weekStart + 6) % 7
                               : iter.getDay() == this._weekStart;
            if (leftMost)
                styleClass = 'calendar-day-left ' + styleClass;

            if (_sameDay(now, iter))
                styleClass += ' calendar-today';
            else if (iter.getMonth() != this._selectedDate.getMonth())
                styleClass += ' calendar-other-month-day';

            if (hasEvents)
                styleClass += ' calendar-day-with-events';

            button.style_class = styleClass;

            let offsetCols = this._useWeekdate ? 1 : 0;
            let col;
            if (rtl)
                col = 6 - (7 + iter.getDay() - this._weekStart) % 7;
            else
                col = offsetCols + (7 + iter.getDay() - this._weekStart) % 7;
            layout.pack(button, col, row);

            this._buttons.push(button);

            if (this._useWeekdate && iter.getDay() == 4) {
                let label = new St.Label({ text: iter.toLocaleFormat('%V'),
                                           style_class: 'calendar-day-base calendar-week-number'});
                layout.pack(label, rtl ? 7 : 0, row);
            }

            iter.setTime(iter.getTime() + MSECS_IN_DAY);

            if (iter.getDay() == this._weekStart)
                row++;
        }

        // Signal to the event source that we are interested in events
        // only from this date range
        this._eventSource.requestRange(beginDate, iter);
    },

    _update: function() {
        let now = new Date();

        if (_sameYear(this._selectedDate, now))
            this._monthLabel.text = this._selectedDate.toLocaleFormat(this._headerFormatWithoutYear);
        else
            this._monthLabel.text = this._selectedDate.toLocaleFormat(this._headerFormat);

        if (!this._calendarBegin || !_sameMonth(this._selectedDate, this._calendarBegin) || !_sameDay(now, this._markedAsToday))
            this._rebuildCalendar();

        this._buttons.forEach(Lang.bind(this, function(button) {
            if (_sameDay(button._date, this._selectedDate)) {
                button.add_style_pseudo_class('active');
                if (this._shouldDateGrabFocus)
                    button.grab_key_focus();
            }
            else
                button.remove_style_pseudo_class('active');
        }));
    }
});

Signals.addSignalMethods(Calendar.prototype);

const Source = new Lang.Class({
    Name: 'MessageListSource',

    _init: function(title, iconName) {
        this.title = title;
        this.iconName = iconName;

        this.policy = this._createPolicy();
    },

    _createPolicy: function() {
        return new NotificationPolicy();
    },

    setTitle: function(newTitle) {
        this.title = newTitle;
        this.emit('title-changed');
    },

    // Called to create a new icon actor.
    // Provides a sane default implementation, override if you need
    // something more fancy.
    getIcon: function() {
        return new Gio.ThemedIcon({ name: this.iconName });
    },

    destroy: function(reason) {
        this.policy.destroy();
        this.emit('destroy');
    },

    //// Protected methods ////
    // To be overridden by subclasses
    open: function() {
    }
});
Signals.addSignalMethods(Source.prototype);

// Notification:
// @source: the notification's Source
// @title: the title
// @banner: the banner text
// @params: optional additional params
//
// Creates a notification. In the banner mode, the notification
// will show an icon, @title (in bold) and @banner, all on a single
// line (with @banner ellipsized if necessary).
//
// By default, the icon shown is the same as the source's.
// However, if @params contains a 'gicon' parameter, the passed in gicon
// will be used.
//
// If @params contains 'bannerMarkup', with the value %true, then
// the corresponding element is assumed to use pango markup. If the
// parameter is not present for an element, then anything that looks
// like markup in that element will appear literally in the output.
//
// If @params contains a 'clear' parameter with the value %true, then
// the content and the action area of the notification will be cleared.
// The content area is also always cleared if 'customContent' is false
// because it might contain the @banner that didn't fit in the banner mode.
//
// If @params contains 'soundName' or 'soundFile', the corresponding
// event sound is played when the notification is shown (if the policy for
// @source allows playing sounds).
const Notification = new Lang.Class({
    Name: 'Notification',

    _init: function(source, title, body, params) {
        this.source = source;
        this.icon = null;
        this.priority = Gio.NotificationPriority.NORMAL;
        this.resident = false;
        // 'transient' is a reserved keyword in JS, so we have to use an alternate variable name
        this.isTransient = false;
        this.forFeedback = false;
        this.acknowledged = false;
        this.buttons = [];
        this._soundName = null;
        this._soundFile = null;
        this._soundPlayed = false;
        this._defaultAction = null;

        this._updateProperties(title, body, params);
    },

    _updateProperties: function(title, body, params) {
        this.title = title;
        this.body = body;

        params = Params.parse(params, { gicon: null,
                                        soundName: null,
                                        soundFile: null });

        if (params.gicon)
            this.icon = params.gicon;

        if (this._soundName != params.soundName ||
            this._soundFile != params.soundFile) {
            this._soundName = params.soundName;
            this._soundFile = params.soundFile;
            this._soundPlayed = false;
        }
    },

    // update:
    // @title: the new title
    // @banner: the new banner
    // @params: as in the Notification constructor
    update: function(title, body, params) {
        this._updateProperties(title, body, params);
        this.emit('updated');
    },

    addButton: function(button, callback) {
        this.buttons.push({ label: button, callback: callback });
    },

    setDefaultAction: function(callback) {
        this.defaultAction = callback;
    },

    setPriority: function(priority) {
        this.priority = priority;
    },

    setResident: function(resident) {
        this.resident = resident;
    },

    setTransient: function(isTransient) {
        this.isTransient = isTransient;
    },

    setForFeedback: function(forFeedback) {
        this.forFeedback = forFeedback;
    },

    playSound: function() {
        if (this._soundPlayed)
            return;

        if (!this.source.policy.enableSound) {
            this._soundPlayed = true;
            return;
        }

        if (this._soundName) {
            if (this.source.app) {
                let app = this.source.app;

                global.play_theme_sound_full(0, this._soundName,
                                             this.title, null,
                                             app.get_id(), app.get_name());
            } else {
                global.play_theme_sound(0, this._soundName, this.title, null);
            }
        } else if (this._soundFile) {
            if (this.source.app) {
                let app = this.source.app;

                global.play_sound_file_full(0, this._soundFile,
                                            this.title, null,
                                            app.get_id(), app.get_name());
            } else {
                global.play_sound_file(0, this._soundFile, this.title, null);
            }
        }
    },

    destroy: function(reason) {
        this.emit('destroy', reason);
    }
});
Signals.addSignalMethods(Notification.prototype);

function _fixMarkup(text, allowMarkup) {
    if (allowMarkup) {
        // Support &amp;, &quot;, &apos;, &lt; and &gt;, escape all other
        // occurrences of '&'.
        let _text = text.replace(/&(?!amp;|quot;|apos;|lt;|gt;)/g, '&amp;');

        // Support <b>, <i>, and <u>, escape anything else
        // so it displays as raw markup.
        _text = _text.replace(/<(?!\/?[biu]>)/g, '&lt;');

        try {
            Pango.parse_markup(_text, -1, '');
            return _text;
        } catch (e) {}
    }

    // !allowMarkup, or invalid markup
    return GLib.markup_escape_text(text, -1);
}

const URLHighlighter = new Lang.Class({
    Name: 'URLHighlighter',

    _init: function(text, lineWrap, allowMarkup) {
        if (!text)
            text = '';
        this.actor = new St.Label({ reactive: true, style_class: 'url-highlighter' });
        this._linkColor = '#ccccff';
        this.actor.connect('style-changed', Lang.bind(this, function() {
            let [hasColor, color] = this.actor.get_theme_node().lookup_color('link-color', false);
            if (hasColor) {
                let linkColor = color.to_string().substr(0, 7);
                if (linkColor != this._linkColor) {
                    this._linkColor = linkColor;
                    this._highlightUrls();
                }
            }
        }));
        this.actor.clutter_text.line_wrap = lineWrap;
        this.actor.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;

        this.setMarkup(text, allowMarkup);
        this.actor.connect('button-press-event', Lang.bind(this, function(actor, event) {
            // Don't try to URL highlight when invisible.
            // The MessageTray doesn't actually hide us, so
            // we need to check for paint opacities as well.
            if (!actor.visible || actor.get_paint_opacity() == 0)
                return Clutter.EVENT_PROPAGATE;

            // Keep Notification.actor from seeing this and taking
            // a pointer grab, which would block our button-release-event
            // handler, if an URL is clicked
            return this._findUrlAtPos(event) != -1;
        }));
        this.actor.connect('button-release-event', Lang.bind(this, function (actor, event) {
            if (!actor.visible || actor.get_paint_opacity() == 0)
                return Clutter.EVENT_PROPAGATE;

            let urlId = this._findUrlAtPos(event);
            if (urlId != -1) {
                let url = this._urls[urlId].url;
                if (url.indexOf(':') == -1)
                    url = 'http://' + url;

                Gio.app_info_launch_default_for_uri(url, global.create_app_launch_context(0, -1));
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        }));
        this.actor.connect('motion-event', Lang.bind(this, function(actor, event) {
            if (!actor.visible || actor.get_paint_opacity() == 0)
                return Clutter.EVENT_PROPAGATE;

            let urlId = this._findUrlAtPos(event);
            if (urlId != -1 && !this._cursorChanged) {
                global.screen.set_cursor(Meta.Cursor.POINTING_HAND);
                this._cursorChanged = true;
            } else if (urlId == -1) {
                global.screen.set_cursor(Meta.Cursor.DEFAULT);
                this._cursorChanged = false;
            }
            return Clutter.EVENT_PROPAGATE;
        }));
        this.actor.connect('leave-event', Lang.bind(this, function() {
            if (!this.actor.visible || this.actor.get_paint_opacity() == 0)
                return Clutter.EVENT_PROPAGATE;

            if (this._cursorChanged) {
                this._cursorChanged = false;
                global.screen.set_cursor(Meta.Cursor.DEFAULT);
            }
            return Clutter.EVENT_PROPAGATE;
        }));
    },

    setMarkup: function(text, allowMarkup) {
        text = text ? _fixMarkup(text, allowMarkup) : '';
        this._text = text;

        this.actor.clutter_text.set_markup(text);
        /* clutter_text.text contain text without markup */
        this._urls = Util.findUrls(this.actor.clutter_text.text);
        this._highlightUrls();
    },

    _highlightUrls: function() {
        // text here contain markup
        let urls = Util.findUrls(this._text);
        let markup = '';
        let pos = 0;
        for (let i = 0; i < urls.length; i++) {
            let url = urls[i];
            let str = this._text.substr(pos, url.pos - pos);
            markup += str + '<span foreground="' + this._linkColor + '"><u>' + url.url + '</u></span>';
            pos = url.pos + url.url.length;
        }
        markup += this._text.substr(pos);
        this.actor.clutter_text.set_markup(markup);
    },

    _findUrlAtPos: function(event) {
        let success;
        let [x, y] = event.get_coords();
        [success, x, y] = this.actor.transform_stage_point(x, y);
        let find_pos = -1;
        for (let i = 0; i < this.actor.clutter_text.text.length; i++) {
            let [success, px, py, line_height] = this.actor.clutter_text.position_to_coords(i);
            if (py > y || py + line_height < y || x < px)
                continue;
            find_pos = i;
        }
        if (find_pos != -1) {
            for (let i = 0; i < this._urls.length; i++)
            if (find_pos >= this._urls[i].pos &&
                this._urls[i].pos + this._urls[i].url.length > find_pos)
                return i;
        }
        return -1;
    }
});

const Message = new Lang.Class({
    Name: 'Message',

    _init: function(title, body) {
        this.actor = new St.Button({ style_class: 'message',
                                     accessible_role: Atk.Role.NOTIFICATION,
                                     x_expand: true, x_fill: true });

        let hbox = new St.BoxLayout();
        this.actor.set_child(hbox);

        this._iconBin = new St.Bin({ style_class: 'message-icon-bin',
                                     y_expand: true,
                                     visible: false });
        this._iconBin.set_y_align(Clutter.ActorAlign.START);
        hbox.add_actor(this._iconBin);

        let contentBox = new St.BoxLayout({ style_class: 'message-content',
                                            vertical: true, x_expand: true });
        hbox.add_actor(contentBox);

        let titleBox = new St.BoxLayout();
        contentBox.add_actor(titleBox);

        this.titleLabel = new St.Label({ style_class: 'message-title',
                                         text: title, x_expand: true,
                                         x_align: Clutter.ActorAlign.START });
        titleBox.add_actor(this.titleLabel);

        this._secondaryBin = new St.Bin({ style_class: 'message-secondary-bin' });
        titleBox.add_actor(this._secondaryBin);

        let closeIcon = new St.Icon({ icon_name: 'window-close-symbolic',
                                      icon_size: 16 });
        this._closeButton = new St.Button({ child: closeIcon, visible: false });
        titleBox.add_actor(this._closeButton);

        this.bodyLabel = new URLHighlighter(body, false, this._useBodyMarkup);
        this.bodyLabel.actor.add_style_class_name('message-body');
        contentBox.add_actor(this.bodyLabel.actor);

        this._closeButton.connect('clicked', Lang.bind(this,
            function() {
                this.emit('close');
            }));
        this.actor.connect('notify::hover', Lang.bind(this, this._sync));
        this.actor.connect('clicked', Lang.bind(this, this._onClicked));
        this._sync();
    },

    setIcon: function(actor) {
        this._iconBin.child = actor;
        this._iconBin.visible = (actor != null);
    },

    setSecondaryActor: function(actor) {
        this._secondaryBin.child = actor;
    },

    setUseBodyMarkup: function(enable) {
        if (this._useBodyMarkup === enable)
            return;
        this._useBodyMarkup = enable;
        if (this.bodyLabel)
            this.bodyLabel.setMarkup(this.bodyLabel.actor.text, enable);
    },

    canClear: function() {
        return true;
    },

    _sync: function() {
        let hovered = this.actor.hover;
        this._closeButton.visible = hovered;
        this._secondaryBin.visible = !hovered;
    },

    _onClicked: function() {
    }
});
Signals.addSignalMethods(Message.prototype);

const MessageListSection = new Lang.Class({
    Name: 'MessageListSection',

    _init: function(title) {
        this.actor = new St.BoxLayout({ style_class: 'message-list-section',
                                        clip_to_allocation: true,
                                        x_expand: true, vertical: true });
        let titleBox = new St.BoxLayout({ style_class: 'message-list-section-title-box' });
        this.actor.add_actor(titleBox);

        let hasCallback = typeof callback == 'function';
        this._title = new St.Button({ style_class: 'message-list-section-title',
                                      label: title,
                                      x_expand: true,
                                      x_align: St.Align.START });
        titleBox.add_actor(this._title);

        let closeIcon = new St.Icon({ icon_name: 'window-close-symbolic' });
        this._closeButton = new St.Button({ style_class: 'message-list-section-close',
                                            child: closeIcon });
        this._closeButton.set_x_align(Clutter.ActorAlign.END);
        titleBox.add_actor(this._closeButton);

        this._list = new St.BoxLayout({ style_class: 'message-list-section-list',
                                        vertical: true });
        this.actor.add_actor(this._list);

        this._title.connect('clicked', Lang.bind(this, this._onTitleClicked));
        this._closeButton.connect('clicked', Lang.bind(this, this.clear));
        this._list.connect('actor-added', Lang.bind(this, this._sync));
        this._list.connect('actor-removed', Lang.bind(this, this._sync));
        this._date = new Date();
        this._sync();
    },

    _onTitleClicked: function() {
        Main.overview.hide();
        Main.panel.closeCalendar();
    },

    setDate: function(date) {
        if (!_sameDay(date, this._date)) {
            this._date = date;
            this._sync();
        }
    },

    addMessage: function(message, animate) {
        this.addMessageAtIndex(message, 0, animate);
    },

    addMessageAtIndex: function(message, index, animate) {
        let bin = new St.Widget({ layout_manager: new ScaleLayout(),
                                  pivot_point: new Clutter.Point({ x: 0.5, y: 0.5 }) });
        bin._delegate = message;
        message.actor.connect('destroy', function() { bin.destroy(); });
        message.connect('close', Lang.bind(this, this.removeMessage, true));

        bin.add_actor(message.actor);
        this._list.insert_child_at_index(bin, index);

        if (animate) {
            bin.scale_y = bin.scale_x = 0;
            Tweener.addTween(bin, { scale_x: 1,
                                    scale_y: 1,
                                    time: MESSAGE_ANIMATION_TIME,
                                    transition: 'easeOutQuad' });
        }
    },

    removeMessage: function(message, animate) {
        let bin = message.actor.get_parent();

        if (animate)
            Tweener.addTween(bin, { scale_x: 0,
                                    scale_y: 0,
                                    time: MESSAGE_ANIMATION_TIME,
                                    transition: 'easeOutQuad',
                                    onComplete: function() { bin.destroy(); } });
        else
            bin.destroy();
    },

    get _messages() {
        return this._list.get_children().map(function(a) { return a._delegate; });
    },

    _tweenMessages: function(messages, params, onComplete) {
        if (Array.isArray(messages)) {
            let delay = params.time / messages.length;
            for (let i = 0; i < messages.length; i++) {
                if (i == messages.length - 1)
                    params.onComplete = onComplete;
                params.delay = i * delay;
                Tweener.addTween(messages[i].actor.get_parent(), params);
            }
        } else {
            params.onComplete = onComplete;
            Tweener.addTween(messages.actor.get_parent(), params);
        }
    },

    clear: function() {
        let messages = this._messages.filter(function(m) { return m.canClear(); });
        if (messages.length < 2)
            messages.forEach(Lang.bind(this, function(m) { this.removeMessage(m, true); }));
        else
            this._tweenMessages(messages,
                                { anchor_x: this._list.width,
                                  opacity: 0,
                                  time: MESSAGE_ANIMATION_TIME,
                                  transition: 'easeOutQuad' },
                                Lang.bind(this, function() {
                                    messages.forEach(Lang.bind(this, this.removeMessage, true));
                                }));
    },

    _canClear: function() {
        return this._messages.some(function(m) { return m.canClear(); });
    },

    isEmpty: function() {
        return this._list.get_n_children() == 0;
    },

    _isToday: function() {
        let today = new Date();
        return _sameDay(this._date, today);
    },

    _sync: function() {
        this.actor.visible = !this.isEmpty() && this._isToday();
        this._closeButton.visible = this._canClear();
    }
});

const ScaleLayout = new Lang.Class({
    Name: 'ScaleLayout',
    Extends: Clutter.BinLayout,

    _connectContainer: function(container) {
        if (this._container == container)
            return;

        if (this._container)
            for (let id of this._signals)
                this._container.disconnect(id);

        this._container = container;
        this._signals = [];

        if (this._container)
            for (let signal of ['notify::scale-x', 'notify::scale-y']) {
                let id = this._container.connect(signal, Lang.bind(this,
                    function() {
                        this.layout_changed();
                    }));
                this._signals.push(id);
            }
    },

    vfunc_get_preferred_width: function(container, forHeight) {
        this._connectContainer(container);

        let [min, nat] = this.parent(container, forHeight);
        return [Math.floor(min * container.scale_x),
                Math.floor(nat * container.scale_x)];
    },

    vfunc_get_preferred_height: function(container, forWidth) {
        this._connectContainer(container);

        let [min, nat] = this.parent(container, forWidth);
        return [Math.floor(min * container.scale_y),
                Math.floor(nat * container.scale_y)];
    }
});

const NotificationMessage = new Lang.Class({
    Name: 'NotificationMessage',
    Extends: Message,

    _init: function(notification) {
        let body = '';
        if (notification.bannerBodyText)
            body = notification.bannerBodyMarkup ? notification.bannerBodyText
                                                 : GLib.markup_escape_text(notification.bannerBodyText, -1);
        this.parent(notification.title, body);

        let gicon = null;
        if (notification._iconBin.child)
            gicon = notification._iconBin.child.gicon;
        let icon;
        if (gicon)
            icon = new St.Icon({ gicon: gicon, icon_size: 48 });
        else
            icon = source.createIcon(48);

        this.setIcon(icon);

        this.notification = notification;

        this.actor.connect('clicked', Lang.bind(this,
            function() {
                notification._onClicked();
            }));
        this.connect('close', Lang.bind(this,
            function() {
                this.notification.destroy(MessageTray.NotificationDestroyedReason.DISMISSED);
            }));
        this.notification.connect('destroy', Lang.bind(this,
            function() {
                this.emit('close');
            }));
    },

    canClear: function() {
        return !this.notification.resident;
    }
});

const NotificationBanner = new Lang.Class({
    Name: 'NotificationBanner',
    Extends: NotificationMessage,

    _init: function(notification) {
        this._noDate = true;

        this.parent(notification);

        this.actor.add_style_class_name('notification-banner');

        this.actor.set_x_expand(false);
        this.actor.set_y_expand(true);
        this.actor.set_y_align(Clutter.ActorAlign.START);

        this._expanded = false;
        this.bodyLabel.clutter_text.line_wrap = true;

        this._actionBin = new St.Widget({ layout_manager: new ScaleLayout(),
                                          visible: false });
        this._grid.layout_manager.attach_next_to(this._actionBin, null,
                                                 Clutter.GridPosition.BOTTOM, 4, 1);

        for (let button of notification.buttons)
            this._addButton(button.label, button.callback);
    },

    _sync: function() {
        this.parent();

        if (this._expanded !== undefined)
            this.expanded = this.actor.hover;
    },

    _addButton: function(label, callback) {
        let buttonBox = this._actionBin.get_first_child();
        if (!buttonBox) {
            buttonBox = new St.BoxLayout({ style_class: 'notification-button-box',
                                           x_expand: true });
            this._actionBin.add_actor(buttonBox);
        }

        if (buttonBox.get_n_children() >= MAX_NOTIFICATION_BUTTONS)
            return;

        let button = new St.Button({ label: label,
                                     style_class: 'notification-button',
                                     x_expand: true });
        button.connect('clicked', Lang.bind(this,
            function() {
                callback();

                this.actor.destroy();
            }));
        buttonBox.add_actor(button);
    },

    set expanded(v) {
        if (this._expanded === v)
            return;

        this._expanded = v;

        let forWidth = this.bodyLabel.clutter_text.width;
        let [, lineHeight] = 
            this.bodyLabel.clutter_text.get_preferred_height (-1);

        let height, scale;
        if (this._expanded) {
            let [, natHeight] =
                this.bodyLabel.clutter_text.get_preferred_height (forWidth);
            height = Math.min(6 * lineHeight, natHeight);

            this._actionBin.scale_y = 0;
            scale = 1.0;
        } else {
            height = lineHeight;
            this._actionBin.scale_y = 1;
            scale = 0.0;
        }

        this._actionBin.show();
        Tweener.addTween(this.bodyLabel, { height: height, time: 0.2, transition: 'easeOutQuad' });
        Tweener.addTween(this._actionBin, { scale_y: scale, time: 0.2, transition: 'easeOutQuad',
                                            onComplete: Lang.bind(this, function() { if (!this._expanded) this._actionBin.hide(); }) });
    }
});

const NotificationSection = new Lang.Class({
    Name: 'NotificationSection',
    Extends: MessageListSection,

    _init: function() {
        this.parent('Notifications');

        this._notificationQueue = [];

        this._sources = new Map();
        Main.messageTray.connect('source-added', Lang.bind(this, this._sourceAdded));
        Main.messageTray.getSources().forEach(Lang.bind(this, function(source) {
            this._sourceAdded(Main.messageTray, source);
        }));

        this.actor.connect('notify::mapped', Lang.bind(this, this._onMapped));

        Main.sessionMode.connect('updated', Lang.bind(this, this._sessionUpdated));
        this._sessionUpdated();
    },

    _sourceAdded: function(tray, source) {
        let obj = {
            destroyId: 0,
            notificationAddedId: 0,
        };

        obj.destroyId = source.connect('destroy', Lang.bind(this, function(source) {
            this._onSourceDestroy(source, obj);
        }));
        obj.notificationAddedId = source.connect('notification-added',
                                                 Lang.bind(this, this._onNotificationAdded));

        this._sources.set(source, obj);
    },

    _onNotificationAdded: function(source, notification) {
        let message = new NotificationMessage(notification);

        let time = new Date().toLocaleFormat(C_("event list time", "%H\u2236%M"));
        message.setSecondaryActor(new St.Label({ style_class: 'event-time',
                                                   x_align: Clutter.ActorAlign.END,
                                                   text: time }));

        if (this.mapped && !notification.urgency != MessageTray.Urgency.CRITICAL)
            notification.acknowledged = true;

        let children = this._list.get_children();
        let index;
        for (index = 0; index < children.length; index++)
            if (children[index]._delegate.notification.urgency <= notification.urgency)
                break;

        this.addMessageAtIndex(message, index, this.actor.mapped);
    },

    _onSourceDestroy: function(source, obj) {
        source.disconnect(obj.destroyId);
        source.disconnect(obj.notificationAddedId);

        this._sources.delete(source);
    },

    _onMapped: function() {
        if (!this.actor.mapped)
            return;
        this._messages.forEach(function(m) {
            if (m.notification.urgency != MessageTray.Urgency.CRITICAL)
                m.notification.acknowledged = true;
        });
    },

    _onTitleClicked: function() {
        this.parent();

        let app = Shell.AppSystem.get_default().lookup_app('gnome-notifications-panel.desktop');

        if (!app) {
            log('Settings panel for desktop file ' + desktopFile + ' could not be loaded!');
            return;
        }

        app.activate();
    },

    _sessionUpdated: function() {
        this._title.reactive = Main.sessionMode.allowSettings;
    }
});

const EventsSection = new Lang.Class({
    Name: 'EventsSection',
    Extends: MessageListSection,

    _init: function() {
        this._desktopSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
        this._desktopSettings.connect('changed', Lang.bind(this, this._reloadEvents));
        this._eventSource = new EmptyEventSource();

        this.parent('');

        Shell.AppSystem.get_default().connect('installed-changed',
                                              Lang.bind(this, this._appInstalledChanged));
        this._appInstalledChanged();
    },

    setEventSource: function(eventSource) {
        this._eventSource = eventSource;
        this._eventSource.connect('changed', Lang.bind(this, this._reloadEvents));
    },

    _updateTitle: function() {
        let now = new Date();
        if (_sameDay(this._date, now)) {
            this._title.label = _("Events");
            return;
        }

        let dayFormat;
        if (_sameYear(this._date, now))
            /* Translators: Shown on calendar heading when selected day occurs on current year */
            dayFormat = Shell.util_translate_time_string(NC_("calendar heading",
                                                             "%A, %B %d"));
        else
            /* Translators: Shown on calendar heading when selected day occurs on different year */
            dayFormat = Shell.util_translate_time_string(NC_("calendar heading",
                                                             "%A, %B %d, %Y"));
        this._title.label = this._date.toLocaleFormat(dayFormat);
    },

    _reloadEvents: function() {
        if (this._eventSource.isLoading)
            return;

        this._reloading = true;

        this._list.destroy_all_children();

        let periodBegin = _getBeginningOfDay(this._date);
        let periodEnd = _getEndOfDay(this._date);
        let events = this._eventSource.getEvents(periodBegin, periodEnd);

        let clockFormat = this._desktopSettings.get_string(CLOCK_FORMAT_KEY);
        for (let i = 0; i < events.length; i++) {
            let event = events[i];
            let title = _formatEventTime(event, clockFormat, periodBegin, periodEnd);

            let rtl = this.actor.get_text_direction() == Clutter.TextDirection.RTL;
            if (event.date < periodBegin && !event.allDay) {
                if (rtl)
                    title = title + ELLIPSIS_CHAR;
                else
                    title = ELLIPSIS_CHAR + title;
            }
            if (event.end > periodEnd && !event.allDay) {
                if (rtl)
                    title = ELLIPSIS_CHAR + title;
                else
                    title = title + ELLIPSIS_CHAR;
            }
            this.addMessage(new Message(title, event.summary), false);
        }

        this._reloading = false;
        this._sync();
    },

    _appInstalledChanged: function() {
        this._calendarApp = undefined;
        this._title.reactive = (this._getCalendarApp() != null);
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

    _onTitleClicked: function() {
        this.parent();

        let app = this._getCalendarApp();
        if (app.get_id() == 'evolution.desktop')
            app = Gio.DesktopAppInfo.new('evolution-calendar.desktop');
        app.launch([], global.create_app_launch_context(0, -1));
    },

    setDate: function(date) {
        this.parent(date);
        this._reloadEvents();
    },

    _sync: function() {
        if (this._reloading)
            return;

        this.actor.visible = !this.isEmpty() || !this._isToday();
        this._closeButton.visible = !this.isEmpty();
        this._updateTitle();
    }
});

const Placeholder = new Lang.Class({
    Name: 'Placeholder',

    _init: function() {
        this.actor = new St.BoxLayout({ style_class: 'events-placeholder',
                                        vertical: true });

        this._date = new Date();

        let todayFile = Gio.File.new_for_uri('resource:///org/gnome/shell/theme/no-notifications.svg');
        let otherFile = Gio.File.new_for_uri('resource:///org/gnome/shell/theme/no-events.svg');
        this._todayIcon = new Gio.FileIcon({ file: todayFile });
        this._otherIcon = new Gio.FileIcon({ file: otherFile });

        this._icon = new St.Icon();
        this.actor.add_actor(this._icon);

        this._label = new St.Label();
        this.actor.add_actor(this._label);

        this._sync();
    },

    setDate: function(date) {
        if (!_sameDay(this._date, date)) {
            this._date = date;
            this._sync();
        }
    },

    _sync: function() {
        let isToday = _sameDay(this._date, new Date());
        if (isToday && this._icon.gicon == this._todayIcon)
            return;
        if (!isToday && this._icon.gicon == this._otherIcon)
            return;

        if (isToday) {
            this._icon.gicon = this._todayIcon;
            this._label.text = _("No Notifications");
        } else {
            this._icon.gicon = this._otherIcon;
            this._label.text = _("No Events");
        }
    }
});

const MessageList = new Lang.Class({
    Name: 'MessageList',

    _init: function() {
        this.actor = new St.Widget({ style_class: 'message-list',
                                     layout_manager: new Clutter.BinLayout(),
                                     x_expand: true, y_expand: true });

        this._placeholder = new Placeholder();
        this.actor.add_actor(this._placeholder.actor);

        this._scrollView = new St.ScrollView({ style_class: 'vfade',
                                               overlay_scrollbars: true,
                                               x_expand: true, y_expand: true,
                                               x_fill: true, y_fill: true });
        this._scrollView.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC);
        this.actor.add_actor(this._scrollView);

        this._sectionList = new St.BoxLayout({ style_class: 'message-list-sections',
                                               vertical: true,
                                               y_expand: true,
                                               y_align: Clutter.ActorAlign.START });
        this._scrollView.add_actor(this._sectionList);
        this._sections = [];

        this._notificationSection = new NotificationSection();
        this._addSection(this._notificationSection);

        this._eventsSection = new EventsSection();
        this._addSection(this._eventsSection);

        this._sync();
    },

    _addSection: function(section) {
        let id = section.actor.connect('notify::visible', Lang.bind(this, this._sync));
        section.actor.connect('destroy', function(a) { a.disconnect(id); });
        this._sectionList.add_actor(section.actor);
        this._sections.push(section);
    },

    _sync: function() {
        let showPlaceholder = this._sections.every(function(s) { return s.isEmpty() || !s.actor.visible });
        this._placeholder.actor.visible = showPlaceholder;
    },

    setEventSource: function(eventSource) {
        this._eventsSection.setEventSource(eventSource);
    },

    setDate: function(date) {
        this._sections.forEach(function(s) { s.setDate(date); });
        this._placeholder.setDate(date);
    }
});

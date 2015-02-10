// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const Clutter = imports.gi.Clutter;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Lang = imports.lang;
const St = imports.gi.St;
const Signals = imports.signals;
const Pango = imports.gi.Pango;
const Gettext_gtk30 = imports.gettext.domain('gtk30');
const Mainloop = imports.mainloop;
const Shell = imports.gi.Shell;

const Params = imports.misc.params;

const MSECS_IN_DAY = 24 * 60 * 60 * 1000;
const SHOW_WEEKDATE_KEY = 'show-weekdate';
const ELLIPSIS_CHAR = '\u2026';

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
                                     layout_manager: new Clutter.GridLayout(),
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
        layout.attach(this._topBox, 0, 0, offsetCols + 7, 1);

        this._backButton = new St.Button({ style_class: 'calendar-change-month-back',
                                           accessible_name: _("Previous month"),
                                           can_focus: true });
        this._topBox.add(this._backButton);
        this._backButton.connect('clicked', Lang.bind(this, this._onPrevMonthButtonClicked));

        this._monthLabel = new St.Label({style_class: 'calendar-month-label',
                                         can_focus: true });
        this._topBox.add(this._monthLabel, { expand: true, x_fill: false, x_align: St.Align.MIDDLE });

        this._forwardButton = new St.Button({ style_class: 'calendar-change-month-forward',
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
            layout.attach(label, col, 1, 1, 1);
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
            layout.attach(button, col, row, 1, 1);

            this._buttons.push(button);

            if (this._useWeekdate && iter.getDay() == 4) {
                let label = new St.Label({ text: iter.toLocaleFormat('%V'),
                                           style_class: 'calendar-day-base calendar-week-number'});
                layout.attach(label, rtl ? 7 : 0, row, 1, 1);
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
// The notification will be expandable if either it has additional
// elements that were added to it or if the @banner text did not
// fit fully in the banner mode. When the notification is expanded,
// the @banner text from the top line is always removed. The complete
// @banner text is added as the first element in the content section,
// unless 'customContent' parameter with the value 'true' is specified
// in @params.
//
// Additional notification content can be added with addActor() and
// addBody() methods. The notification content is put inside a
// scrollview, so if it gets too tall, the notification will scroll
// rather than continue to grow. In addition to this main content
// area, there is also a single-row action area, which is not
// scrolled and can contain a single actor. The action area can
// be set by calling setActionArea() method. There is also a
// convenience method addButton() for adding a button to the action
// area.
//
// If @params contains a 'customContent' parameter with the value %true,
// then @banner will not be shown in the body of the notification when the
// notification is expanded and calls to update() will not clear the content
// unless 'clear' parameter with value %true is explicitly specified.
//
// By default, the icon shown is the same as the source's.
// However, if @params contains a 'gicon' parameter, the passed in gicon
// will be used.
//
// You can add a secondary icon to the banner with 'secondaryGIcon'. There
// is no fallback for this icon.
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

    ICON_SIZE: 24,

    IMAGE_SIZE: 125,

    _init: function(source, title, banner, params) {
        this.source = source;
        this.title = title;
        this.urgency = Urgency.NORMAL;
        this.resident = false;
        // 'transient' is a reserved keyword in JS, so we have to use an alternate variable name
        this.isTransient = false;
        this.isMusic = false;
        this.forFeedback = false;
        this.expanded = false;
        this.focused = false;
        this.acknowledged = false;
        this._destroyed = false;
        this._customContent = false;
        this.bannerBodyText = null;
        this.bannerBodyMarkup = false;
        this._bannerBodyAdded = false;
        this._titleFitsInBannerMode = true;
        this._spacing = 0;
        this._scrollPolicy = Gtk.PolicyType.AUTOMATIC;
        this._imageBin = null;
        this._soundName = null;
        this._soundFile = null;
        this._soundPlayed = false;

        this.actor = new St.Button({ accessible_role: Atk.Role.NOTIFICATION });
        this.actor.add_style_class_name('notification-unexpanded');
        this.actor._delegate = this;
        this.actor.connect('clicked', Lang.bind(this, this._onClicked));
        this.actor.connect('destroy', Lang.bind(this, this._onDestroy));

        this._table = new St.Table({ style_class: 'notification',
                                     reactive: true });
        this._table.connect('style-changed', Lang.bind(this, this._styleChanged));
        this.actor.set_child(this._table);

        // The first line should have the title, followed by the
        // banner text, but ellipsized if they won't both fit. We can't
        // make St.Table or St.BoxLayout do this the way we want (don't
        // show banner at all if title needs to be ellipsized), so we
        // use Shell.GenericContainer.
        this._bannerBox = new Shell.GenericContainer();
        this._bannerBox.connect('get-preferred-width', Lang.bind(this, this._bannerBoxGetPreferredWidth));
        this._bannerBox.connect('get-preferred-height', Lang.bind(this, this._bannerBoxGetPreferredHeight));
        this._bannerBox.connect('allocate', Lang.bind(this, this._bannerBoxAllocate));
        this._table.add(this._bannerBox, { row: 0,
                                           col: 1,
                                           col_span: 2,
                                           x_expand: false,
                                           y_expand: false,
                                           y_fill: false });

        // This is an empty cell that overlaps with this._bannerBox cell to ensure
        // that this._bannerBox cell expands horizontally, while not forcing the
        // this._imageBin that is also in col: 2 to expand horizontally.
        this._table.add(new St.Bin(), { row: 0,
                                        col: 2,
                                        y_expand: false,
                                        y_fill: false });

        this._titleLabel = new St.Label();
        this._bannerBox.add_actor(this._titleLabel);
        this._bannerUrlHighlighter = new URLHighlighter();
        this._bannerLabel = this._bannerUrlHighlighter.actor;
        this._bannerBox.add_actor(this._bannerLabel);

        // If called with only one argument we assume the caller
        // will call .update() later on. This is the case of
        // NotificationDaemon, which wants to use the same code
        // for new and updated notifications
        if (arguments.length != 1)
            this.update(title, banner, params);
    },

    // update:
    // @title: the new title
    // @banner: the new banner
    // @params: as in the Notification constructor
    //
    // Updates the notification by regenerating its icon and updating
    // the title/banner. If @params.clear is %true, it will also
    // remove any additional actors/action buttons previously added.
    update: function(title, banner, params) {
        params = Params.parse(params, { customContent: false,
                                        gicon: null,
                                        secondaryGIcon: null,
                                        bannerMarkup: false,
                                        clear: false,
                                        soundName: null,
                                        soundFile: null });

        this._customContent = params.customContent;

        let oldFocus = global.stage.key_focus;

        if (this._icon && (params.gicon || params.clear)) {
            this._icon.destroy();
            this._icon = null;
        }

        if (this._secondaryIcon && (params.secondaryGIcon || params.clear)) {
            this._secondaryIcon.destroy();
            this._secondaryIcon = null;
        }

        // We always clear the content area if we don't have custom
        // content because it might contain the @banner that didn't
        // fit in the banner mode.
        if (this._scrollArea && (!this._customContent || params.clear)) {
            if (oldFocus && this._scrollArea.contains(oldFocus))
                this.actor.grab_key_focus();

            this._scrollArea.destroy();
            this._scrollArea = null;
            this._contentArea = null;
        }
        if (this._actionArea && params.clear) {
            if (oldFocus && this._actionArea.contains(oldFocus))
                this.actor.grab_key_focus();

            this._actionArea.destroy();
            this._actionArea = null;
            this._buttonBox = null;
        }
        if (params.clear)
            this.unsetImage();

        if (!this._scrollArea && !this._actionArea && !this._imageBin)
            this._table.remove_style_class_name('multi-line-notification');

        if (params.gicon) {
            this._icon = new St.Icon({ gicon: params.gicon,
                                       icon_size: this.ICON_SIZE });
        } else {
            this._icon = this.source.createIcon(this.ICON_SIZE);
        }

        if (this._icon) {
            this._table.add(this._icon, { row: 0,
                                          col: 0,
                                          x_expand: false,
                                          y_expand: false,
                                          y_fill: false,
                                          y_align: St.Align.START });
        }

        if (params.secondaryGIcon) {
            this._secondaryIcon = new St.Icon({ gicon: params.secondaryGIcon,
                                                style_class: 'secondary-icon' });
            this._bannerBox.add_actor(this._secondaryIcon);
        }

        this.title = title;
        title = title ? _fixMarkup(title.replace(/\n/g, ' '), false) : '';
        this._titleLabel.clutter_text.set_markup('<b>' + title + '</b>');

        let titleDirection;
        if (Pango.find_base_dir(title, -1) == Pango.Direction.RTL)
            titleDirection = Clutter.TextDirection.RTL;
        else
            titleDirection = Clutter.TextDirection.LTR;

        // Let the title's text direction control the overall direction
        // of the notification - in case where different scripts are used
        // in the notification, this is the right thing for the icon, and
        // arguably for action buttons as well. Labels other than the title
        // will be allocated at the available width, so that their alignment
        // is done correctly automatically.
        this._table.set_text_direction(titleDirection);

        // Unless the notification has custom content, we save this.bannerBodyText
        // to add it to the content of the notification if the notification is
        // expandable due to other elements in its content area or due to the banner
        // not fitting fully in the single-line mode.
        this.bannerBodyText = this._customContent ? null : banner;
        this.bannerBodyMarkup = params.bannerMarkup;
        this._bannerBodyAdded = false;

        banner = banner ? banner.replace(/\n/g, '  ') : '';

        this._bannerUrlHighlighter.setMarkup(banner, params.bannerMarkup);
        this._bannerLabel.queue_relayout();

        // Add the bannerBody now if we know for sure we'll need it
        if (this.bannerBodyText && this.bannerBodyText.indexOf('\n') > -1)
            this._addBannerBody();

        if (this._soundName != params.soundName ||
            this._soundFile != params.soundFile) {
            this._soundName = params.soundName;
            this._soundFile = params.soundFile;
            this._soundPlayed = false;
        }

        this.updated();
    },

    setIconVisible: function(visible) {
        this._icon.visible = visible;
    },

    enableScrolling: function(enableScrolling) {
        this._scrollPolicy = enableScrolling ? Gtk.PolicyType.AUTOMATIC : Gtk.PolicyType.NEVER;
        if (this._scrollArea) {
            this._scrollArea.vscrollbar_policy = this._scrollPolicy;
            this._scrollArea.enable_mouse_scrolling = enableScrolling;
        }
    },

    _createScrollArea: function() {
        this._table.add_style_class_name('multi-line-notification');
        this._scrollArea = new St.ScrollView({ style_class: 'notification-scrollview',
                                               vscrollbar_policy: this._scrollPolicy,
                                               hscrollbar_policy: Gtk.PolicyType.NEVER,
                                               visible: this.expanded });
        this._table.add(this._scrollArea, { row: 1,
                                            col: 2 });
        this._updateLastColumnSettings();
        this._contentArea = new St.BoxLayout({ style_class: 'notification-body',
                                               vertical: true });
        this._scrollArea.add_actor(this._contentArea);
        // If we know the notification will be expandable, we need to add
        // the banner text to the body as the first element.
        this._addBannerBody();
    },

    // addActor:
    // @actor: actor to add to the body of the notification
    //
    // Appends @actor to the notification's body
    addActor: function(actor, style) {
        if (!this._scrollArea) {
            this._createScrollArea();
        }

        this._contentArea.add(actor, style ? style : {});
        this.updated();
    },

    // addBody:
    // @text: the text
    // @markup: %true if @text contains pango markup
    // @style: style to use when adding the actor containing the text
    //
    // Adds a multi-line label containing @text to the notification.
    //
    // Return value: the newly-added label
    addBody: function(text, markup, style) {
        let label = new URLHighlighter(text, true, markup);

        this.addActor(label.actor, style);
        return label.actor;
    },

    _addBannerBody: function() {
        if (this.bannerBodyText && !this._bannerBodyAdded) {
            this._bannerBodyAdded = true;
            this.addBody(this.bannerBodyText, this.bannerBodyMarkup);
        }
    },

    // scrollTo:
    // @side: St.Side.TOP or St.Side.BOTTOM
    //
    // Scrolls the content area (if scrollable) to the indicated edge
    scrollTo: function(side) {
        let adjustment = this._scrollArea.vscroll.adjustment;
        if (side == St.Side.TOP)
            adjustment.value = adjustment.lower;
        else if (side == St.Side.BOTTOM)
            adjustment.value = adjustment.upper;
    },

    // setActionArea:
    // @actor: the actor
    // @props: (option) St.Table child properties
    //
    // Puts @actor into the action area of the notification, replacing
    // the previous contents
    setActionArea: function(actor, props) {
        if (this._actionArea) {
            this._actionArea.destroy();
            this._actionArea = null;
            if (this._buttonBox)
                this._buttonBox = null;
        } else {
            this._addBannerBody();
        }
        this._actionArea = actor;
        this._actionArea.visible = this.expanded;

        if (!props)
            props = {};
        props.row = 2;
        props.col = 2;

        this._table.add_style_class_name('multi-line-notification');
        this._table.add(this._actionArea, props);
        this._updateLastColumnSettings();
        this.updated();
    },

    _updateLastColumnSettings: function() {
        if (this._scrollArea)
            this._table.child_set(this._scrollArea, { col: this._imageBin ? 2 : 1,
                                                      col_span: this._imageBin ? 1 : 2 });
        if (this._actionArea)
            this._table.child_set(this._actionArea, { col: this._imageBin ? 2 : 1,
                                                      col_span: this._imageBin ? 1 : 2 });
    },

    setImage: function(image) {
        this.unsetImage();

        if (!image)
            return;

        this._imageBin = new St.Bin({ opacity: 230,
                                      child: image,
                                      visible: this.expanded });

        this._table.add_style_class_name('multi-line-notification');
        this._table.add_style_class_name('notification-with-image');
        this._addBannerBody();
        this._updateLastColumnSettings();
        this._table.add(this._imageBin, { row: 1,
                                          col: 1,
                                          row_span: 2,
                                          x_expand: false,
                                          y_expand: false,
                                          x_fill: false,
                                          y_fill: false });
    },

    unsetImage: function() {
        if (this._imageBin) {
            this._table.remove_style_class_name('notification-with-image');
            this._table.remove_actor(this._imageBin);
            this._imageBin = null;
            this._updateLastColumnSettings();
            if (!this._scrollArea && !this._actionArea)
                this._table.remove_style_class_name('multi-line-notification');
        }
    },

    addButton: function(button, callback) {
        if (!this._buttonBox) {
            let box = new St.BoxLayout({ style_class: 'notification-actions' });
            this.setActionArea(box, { x_expand: false,
                                      y_expand: false,
                                      x_fill: false,
                                      y_fill: false,
                                      x_align: St.Align.END });
            this._buttonBox = box;
            global.focus_manager.add_group(this._buttonBox);
        }

        this._buttonBox.add(button);
        button.connect('clicked', Lang.bind(this, function() {
            callback();

            if (!this.resident) {
                // We don't hide a resident notification when the user invokes one of its actions,
                // because it is common for such notifications to update themselves with new
                // information based on the action. We'd like to display the updated information
                // in place, rather than pop-up a new notification.
                this.emit('done-displaying');
                this.destroy();
            }
        }));

        this.updated();
        return button;
    },

    // addAction:
    // @label: the label for the action's button
    // @callback: the callback for the action
    //
    // Adds a button with the given @label to the notification. All
    // action buttons will appear in a single row at the bottom of
    // the notification.
    addAction: function(label, callback) {
        let button = new St.Button({ style_class: 'notification-button',
                                     label: label,
                                     can_focus: true });

        return this.addButton(button, callback);
    },

    setUrgency: function(urgency) {
        this.urgency = urgency;
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

    _styleChanged: function() {
        this._spacing = this._table.get_theme_node().get_length('spacing-columns');
    },

    _bannerBoxGetPreferredWidth: function(actor, forHeight, alloc) {
        let [titleMin, titleNat] = this._titleLabel.get_preferred_width(forHeight);
        let [bannerMin, bannerNat] = this._bannerLabel.get_preferred_width(forHeight);

        if (this._secondaryIcon) {
            let [secondaryIconMin, secondaryIconNat] = this._secondaryIcon.get_preferred_width(forHeight);

            alloc.min_size = secondaryIconMin + this._spacing + titleMin;
            alloc.natural_size = secondaryIconNat + this._spacing + titleNat + this._spacing + bannerNat;
        } else {
            alloc.min_size = titleMin;
            alloc.natural_size = titleNat + this._spacing + bannerNat;
        }
    },

    _bannerBoxGetPreferredHeight: function(actor, forWidth, alloc) {
        [alloc.min_size, alloc.natural_size] =
            this._titleLabel.get_preferred_height(forWidth);
    },

    _bannerBoxAllocate: function(actor, box, flags) {
        let availWidth = box.x2 - box.x1;

        let [titleMinW, titleNatW] = this._titleLabel.get_preferred_width(-1);
        let [titleMinH, titleNatH] = this._titleLabel.get_preferred_height(availWidth);
        let [bannerMinW, bannerNatW] = this._bannerLabel.get_preferred_width(availWidth);

        let rtl = (this._table.text_direction == Clutter.TextDirection.RTL);
        let x = rtl ? availWidth : 0;

        if (this._secondaryIcon) {
            let [iconMinW, iconNatW] = this._secondaryIcon.get_preferred_width(-1);
            let [iconMinH, iconNatH] = this._secondaryIcon.get_preferred_height(availWidth);

            let secondaryIconBox = new Clutter.ActorBox();
            let secondaryIconBoxW = Math.min(iconNatW, availWidth);

            // allocate secondary icon box
            if (rtl) {
                secondaryIconBox.x1 = x - secondaryIconBoxW;
                secondaryIconBox.x2 = x;
                x = x - (secondaryIconBoxW + this._spacing);
            } else {
                secondaryIconBox.x1 = x;
                secondaryIconBox.x2 = x + secondaryIconBoxW;
                x = x + secondaryIconBoxW + this._spacing;
            }
            secondaryIconBox.y1 = 0;
            // Using titleNatH ensures that the secondary icon is centered vertically
            secondaryIconBox.y2 = titleNatH;

            availWidth = availWidth - (secondaryIconBoxW + this._spacing);
            this._secondaryIcon.allocate(secondaryIconBox, flags);
        }

        let titleBox = new Clutter.ActorBox();
        let titleBoxW = Math.min(titleNatW, availWidth);
        if (rtl) {
            titleBox.x1 = availWidth - titleBoxW;
            titleBox.x2 = availWidth;
        } else {
            titleBox.x1 = x;
            titleBox.x2 = titleBox.x1 + titleBoxW;
        }
        titleBox.y1 = 0;
        titleBox.y2 = titleNatH;
        this._titleLabel.allocate(titleBox, flags);
        this._titleFitsInBannerMode = (titleNatW <= availWidth);

        let bannerFits = true;
        if (titleBoxW + this._spacing > availWidth) {
            this._bannerLabel.opacity = 0;
            bannerFits = false;
        } else {
            let bannerBox = new Clutter.ActorBox();

            if (rtl) {
                bannerBox.x1 = 0;
                bannerBox.x2 = titleBox.x1 - this._spacing;

                bannerFits = (bannerBox.x2 - bannerNatW >= 0);
            } else {
                bannerBox.x1 = titleBox.x2 + this._spacing;
                bannerBox.x2 = availWidth;

                bannerFits = (bannerBox.x1 + bannerNatW <= availWidth);
            }
            bannerBox.y1 = 0;
            bannerBox.y2 = titleNatH;
            this._bannerLabel.allocate(bannerBox, flags);

            // Make _bannerLabel visible if the entire notification
            // fits on one line, or if the notification is currently
            // unexpanded and only showing one line anyway.
            if (!this.expanded || (bannerFits && this._table.row_count == 1))
                this._bannerLabel.opacity = 255;
        }

        // If the banner doesn't fully fit in the banner box, we possibly need to add the
        // banner to the body. We can't do that from here though since that will force a
        // relayout, so we add it to the main loop.
        if (!bannerFits && this._canExpandContent())
            Meta.later_add(Meta.LaterType.BEFORE_REDRAW,
                           Lang.bind(this,
                                     function() {
                                         if (this._destroyed)
                                             return false;

                                        if (this._canExpandContent()) {
                                            this._addBannerBody();
                                            this._table.add_style_class_name('multi-line-notification');
                                            this.updated();
                                        }
                                        return false;
                                     }));
    },

    _canExpandContent: function() {
        return (this.bannerBodyText && !this._bannerBodyAdded) ||
               (!this._titleFitsInBannerMode && !this._table.has_style_class_name('multi-line-notification'));
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

    updated: function() {
        if (this.expanded)
            this.expand(false);
    },

    expand: function(animate) {
        this.expanded = true;
        this.actor.remove_style_class_name('notification-unexpanded');

        // Show additional content that we keep hidden in banner mode
        if (this._imageBin)
            this._imageBin.show();
        if (this._actionArea)
            this._actionArea.show();
        if (this._scrollArea)
            this._scrollArea.show();

        // The banner is never shown when the title did not fit, so this
        // can be an if-else statement.
        if (!this._titleFitsInBannerMode) {
            // Remove ellipsization from the title label and make it wrap so that
            // we show the full title when the notification is expanded.
            this._titleLabel.clutter_text.line_wrap = true;
            this._titleLabel.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
            this._titleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        } else if (this._table.row_count > 1 && this._bannerLabel.opacity != 0) {
            // We always hide the banner if the notification has additional content.
            //
            // We don't need to wrap the banner that doesn't fit the way we wrap the
            // title that doesn't fit because we won't have a notification with
            // row_count=1 that has a banner that doesn't fully fit. We'll either add
            // that banner to the content of the notification in _bannerBoxAllocate()
            // or the notification will have custom content.
            if (animate)
                Tweener.addTween(this._bannerLabel,
                                 { opacity: 0,
                                   time: ANIMATION_TIME,
                                   transition: 'easeOutQuad' });
            else
                this._bannerLabel.opacity = 0;
        }
        this.emit('expanded');
    },

    collapseCompleted: function() {
        if (this._destroyed)
            return;
        this.expanded = false;

        // Hide additional content that we keep hidden in banner mode
        if (this._imageBin)
            this._imageBin.hide();
        if (this._actionArea)
            this._actionArea.hide();
        if (this._scrollArea)
            this._scrollArea.hide();

        // Make sure we don't line wrap the title, and ellipsize it instead.
        this._titleLabel.clutter_text.line_wrap = false;
        this._titleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;

        // Restore banner opacity in case the notification is shown in the
        // banner mode again on update.
        this._bannerLabel.opacity = 255;

        // Restore height requisition
        this.actor.add_style_class_name('notification-unexpanded');
    },

    _onClicked: function() {
        this.emit('clicked');
        // We hide all types of notifications once the user clicks on them because the common
        // outcome of clicking should be the relevant window being brought forward and the user's
        // attention switching to the window.
        this.emit('done-displaying');
        if (!this.resident)
            this.destroy();
    },

    _onDestroy: function() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        if (!this._destroyedReason)
            this._destroyedReason = NotificationDestroyedReason.DISMISSED;
        this.emit('destroy', this._destroyedReason);
    },

    destroy: function(reason) {
        this._destroyedReason = reason;
        this.actor.destroy();
        this.actor._delegate = null;
    }
});
Signals.addSignalMethods(Notification.prototype);
const MessageListEntry = new Lang.Class({
    Name: 'MessageListEntry',

    _init: function(title, body, params) {
        params = Params.parse(params, { gicon: null,
                                        time: null });

        let layout = new Clutter.GridLayout({ orientation: Clutter.Orientation.VERTICAL });
        this.actor = new St.Button({ child: new St.Widget({ style_class: 'event-grid',
                                                            layout_manager: layout }),
                                     style_class: 'event-button',
                                     x_expand: true, x_fill: true });
        layout.hookup_style(this.actor.child);

        this._icon = new St.Icon({ gicon: params.gicon,
                                   y_align: Clutter.ActorAlign.START });
        layout.attach(this._icon, 0, 0, 1, 2);

        this._title = new St.Label({ style_class: 'event-title',
                                     text: title,
                                     x_expand: true });
        this._title.clutter_text.line_wrap = false;
        this._title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        layout.attach(this._title, 1, 0, 1, 1);

        this._time = new St.Label({ style_class: 'event-time',
                                    x_align: Clutter.ActorAlign.END });
        if (params.time)
            this._time.text = params.time.toLocaleFormat(C_("event list time", "%H\u2236%M"));
        layout.attach(this._time, 2, 0, 1, 1);

        let closeIcon = new St.Icon({ icon_name: 'window-close-symbolic',
                                      icon_size: 16 });
        this._closeButton = new St.Button({ child: closeIcon });
        layout.attach(this._closeButton, 3, 0, 1, 1);

        this._body = new St.Label({ style_class: 'event-body', text: body,
                                    x_expand: true });
        this._body.clutter_text.line_wrap = false;
        this._body.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        layout.attach(this._body, 1, 1, 3, 1);

        this._closeButton.connect('clicked', Lang.bind(this,
            function() {
                this.actor.destroy();
            }));
        this.actor.connect('notify::hover', Lang.bind(this, this._sync));
        this._sync();
    },

    _sync: function() {
        let hovered = this.actor.hover;
        this._closeButton.visible = hovered;
        this._time.visible = !hovered;
    }
});

const MessageListSection = new Lang.Class({
    Name: 'MessageListSection',

    _init: function(title, callback) {
        this.actor = new St.BoxLayout({ style_class: 'message-list-section',
                                        x_expand: true, vertical: true });
        let titleBox = new St.BoxLayout();
        this.actor.add_actor(titleBox);

        let hasCallback = typeof callback == 'function';
        this._title = new St.Button({ style_class: 'message-list-section-title',
                                      reactive: hasCallback,
                                      x_expand: true });
        this._title.set_x_align(Clutter.ActorAlign.START);
        titleBox.add_actor(this._title);

        let closeIcon = new St.Icon({ icon_name: 'window-close-symbolic' });
        this._closeButton = new St.Button({ style_class: 'message-list-section-close',
                                            child: closeIcon });
        this._closeButton.set_x_align(Clutter.ActorAlign.END);
        titleBox.add_actor(this._closeButton);

        this._list = new St.BoxLayout({ style_class: 'message-list-section-list',
                                        vertical: true });
        this.actor.add_actor(this._list);

        this._title.connect('clicked', Lang.bind(this,
            function() {
                if (hasCallback)
                    callback();
            }));
        this._closeButton.connect('clicked', Lang.bind(this, this.clear));
        this._list.connect('actor-added', Lang.bind(this, this._sync));
        this._list.connect('actor-removed', Lang.bind(this, this._sync));
        this._date = new Date();
        this._sync();
    },

    setDate: function(date) {
        if (!_sameDay(date, this._date)) {
            this._date = date;
            this._sync();
        }
    },

    clear: function() {
        this._list.destroy_all_children();
    },

    _shouldShowForDate: function() {
        let today = new Date();
        return _sameDay(this._date, today);
    },

    _sync: function() {
        this.actor.visible = this._list.get_n_children() > 0 &&
                             this._shouldShowForDate();
    }
});

const EventsSection = new Lang.Class({
    Name: 'EventsSection',
    Extends: MessageListSection,

    _init: function() {
        this._desktopSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
        this._desktopSettings.connect('changed', Lang.bind(this, this._reloadEvents));
        this._eventSource = new EmptyEventSource();

        this.parent('', Lang.bind(this, this._openCalendar));

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

        this.clear();

        let periodBegin = _getBeginningOfDay(this._date);
        let periodEnd = _getEndOfDay(this._date);
        let events = this._eventSource.getEvents(periodBegin, periodEnd);

        if (events.length == 0)
            return;

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
            let eventEntry = new MessageListEntry(title, event.summary);
            this._list.add(eventEntry.actor);
        }
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

    _openCalendar: function() {
        let app = this._getCalendarApp();
        if (app.get_id() == 'evolution.desktop')
            app = Gio.DesktopAppInfo.new('evolution-calendar.desktop');
        app.launch([], global.create_app_launch_context(0, -1));
    },

    setDate: function(date) {
        this.parent(date);
        this._updateTitle();
        this._reloadEvents();
    },

    _sync: function() {
        this.parent();
    },

    _shouldShowForDate: function() {
        return true;
    }
});

const MessageList = new Lang.Class({
    Name: 'MessageList',

    _init: function() {
        this.actor = new St.Widget({ style_class: 'events-table',
                                     layout_manager: new Clutter.BinLayout(),
                                     x_expand: true, y_expand: true });

        this._placeholder = new St.Icon({ icon_name: 'window-close-symbolic' });
        this.actor.add_actor(this._placeholder);

        this._scrollView = new St.ScrollView({ x_expand: true, y_expand: true,
                                               y_align: Clutter.ActorAlign.START });
        this.actor.add_actor(this._scrollView);

        this._sectionList = new St.BoxLayout({ vertical: true });
        this._scrollView.add_actor(this._sectionList);

        this._eventsSection = new EventsSection();
        this._addSection(this._eventsSection);

        this._sync();
    },

    _addSection: function(section) {
        let id = section.actor.connect('notify::visible', Lang.bind(this, this._sync));
        section.actor.connect('destroy', function(a) { a.disconnect(id); });
        this._sectionList.add_actor(section.actor);
    },

    _sync: function() {
        let visible = this._sectionList.get_children().some(function(a) { return a.visible });
        this._scrollView.visible = visible;
        this._placeholder.visible = !visible;
    },

    setEventSource: function(eventSource) {
        this._eventsSection.setEventSource(eventSource);
    },

    setDate: function(date) {
        this._eventsSection.setDate(date);
    }
});

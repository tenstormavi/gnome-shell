// -*- mode: js2; indent-tabs-mode: nil; js2-basic-offset: 4 -*-
const ByteArray = imports.byteArray;
const DBus = imports.dbus;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Lang = imports.lang;
const Mainloop = imports.mainloop;
const NetworkManager = imports.gi.NetworkManager;
const NMClient = imports.gi.NMClient;
const Shell = imports.gi.Shell;
const Signals = imports.signals;
const St = imports.gi.St;

const Main = imports.ui.main;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;
const MessageTray = imports.ui.messageTray;
const ModemManager = imports.misc.modemManager;
const Util = imports.misc.util;

const Gettext = imports.gettext.domain('gnome-shell');
const _ = Gettext.gettext;

const NMConnectionCategory = {
    WIRED: 'wired',
    WIRELESS: 'wireless',
    WWAN: 'wwan',
    VPN: 'vpn'
};

const NMAccessPointSecurity = {
    UNKNOWN: 0,
    NONE: 1,
    WEP: 2,
    WPA: 3,
    WPA2: 4
};

// small optimization, to avoid using [] all the time
const NM80211Mode = NetworkManager['80211Mode'];
const NM80211ApFlags = NetworkManager['80211ApFlags'];
const NM80211ApSecurityFlags = NetworkManager['80211ApSecurityFlags'];

function macToArray(string) {
    return string.split(':').map(function(el) {
        return parseInt(el, 16);
    });
}

function macCompare(one, two) {
    for (let i = 0; i < 6; i++) {
        if (one[i] != two[i])
            return false;
    }
    return true;
}

function ssidCompare(one, two) {
    if (!one || !two)
        return false;
    if (one.length != two.length)
        return false;
    for (let i = 0; i < one.length; i++) {
        if (one[i] != two[i])
            return false;
    }
    return true;
}

// shared between NMNetworkMenuItem and NMDeviceWWAN
function signalToIcon(value) {
    if (value > 80)
        return 'excellent';
    if (value > 55)
        return 'good';
    if (value > 30)
        return 'ok';
    if (value > 5)
        return 'weak';
    return 'none';
}

// shared between NMNetworkMenuItem and NMDeviceWireless
function sortAccessPoints(accessPoints) {
    return accessPoints.sort(function (one, two) {
        return two.strength - one.strength;
    });
}

function NMNetworkMenuItem() {
    this._init.apply(this, arguments);
}

NMNetworkMenuItem.prototype = {
    __proto__: PopupMenu.PopupBaseMenuItem.prototype,

    _init: function(accessPoints, title, params) {
        PopupMenu.PopupBaseMenuItem.prototype._init.call(this, params);

        accessPoints = sortAccessPoints(accessPoints);
        this.bestAP = accessPoints[0];

        let ssid = this.bestAP.get_ssid();
        title = title || NetworkManager.utils_ssid_to_utf8(ssid) || _("<unknown>");

        this._label = new St.Label({ text: title });
        this.addActor(this._label);
        this._icons = new St.BoxLayout({ style_class: 'nm-menu-item-icons' });
        this.addActor(this._icons, { align: St.Align.END });

        this._signalIcon = new St.Icon({ icon_name: this._getIcon(),
                                         style_class: 'popup-menu-icon' });
        this._icons.add_actor(this._signalIcon);

        if (this.bestAP._secType != NMAccessPointSecurity.UNKNOWN &&
            this.bestAP._secType != NMAccessPointSecurity.NONE) {
            this._secureIcon = new St.Icon({ icon_name: 'network-wireless-encrypted',
                                             style_class: 'popup-menu-icon' });
            this._icons.add_actor(this._secureIcon);
        }

        this._accessPoints = [ ];
        for (let i = 0; i < accessPoints.length; i++) {
            let ap = accessPoints[i];
            // need a wrapper object here, because the access points can be shared
            // between many NMNetworkMenuItems
            let apObj = {
                ap: ap,
                updateId: ap.connect('notify::strength', Lang.bind(this, this._updated))
            };
            this._accessPoints.push(apObj);
        }
    },

    _updated: function(ap, strength) {
        if (strength > this.bestAP.strength)
            this.bestAP = ap;

        this._signalIcon.icon_name = this._getIcon();
    },

    _getIcon: function() {
        return 'network-wireless-signal-' + signalToIcon(this.bestAP.strength);
    },

    updateAccessPoints: function(accessPoints) {
        for (let i = 0; i < this._accessPoints.length; i++) {
            let apObj = this._accessPoints[i];
            apObj.ap.disconnect(apObj.updateId);
            apObj.updateId = 0;
        }

        accessPoints = sortAccessPoints(accessPoints);
        this.bestAP = accessPoints[0];
        this._accessPoints = [ ];
        for (let i = 0; i < accessPoints; i++) {
            let ap = accessPoints[i];
            let apObj = {
                ap: ap,
                updateId: ap.connect('notify::strength', Lang.bind(this, this._updated))
            };
            this._accessPoints.push(apObj);
        }
    },

    destroy: function() {
        for (let i = 0; i < this._accessPoints.length; i++) {
            let apObj = this._accessPoints[i];
            apObj.ap.disconnect(apObj.updateId);
            apObj.updateId = 0;
        }

        PopupMenu.PopupImageMenuItem.prototype.destroy.call(this);
    }
};

function NMDeviceTitleMenuItem() {
    this._init.apply(this, arguments);
}

NMDeviceTitleMenuItem.prototype = {
    __proto__: PopupMenu.PopupBaseMenuItem.prototype,

    _init: function(description, params) {
        PopupMenu.PopupBaseMenuItem.prototype._init.call(this, params);

        this._descriptionLabel = new St.Label({ text: description,
                                                style_class: 'popup-subtitle-menu-item'
                                              });
        this.addActor(this._descriptionLabel);

        this._statusBin = new St.Bin({ x_align: St.Align.END });
        this.addActor(this._statusBin, { align: St.Align.END });

        this._statusLabel = new St.Label({ text: '',
                                           style_class: 'popup-inactive-menu-item'
                                         });
        this._switch = new PopupMenu.Switch(false);
        this._statusBin.child = this._switch.actor;
    },

    setStatus: function(text) {
        if (text) {
            this._statusLabel.text = text;
            this._statusBin.child = this._statusLabel;
            this.actor.reactive = false;
            this.actor.can_focus = false;
        } else {
            this._statusBin.child = this._switch.actor;
            this.actor.reactive = true;
            this.actor.can_focus = true;
        }
    },

    activate: function(event) {
        if (this._switch.actor.mapped) {
            this._switch.toggle();
            this.emit('toggled', this._switch.state);
        }

        PopupMenu.PopupBaseMenuItem.prototype.activate.call(this, event);
    },

    get state() {
        return this._switch.state;
    },

    setToggleState: function(newval) {
        this._switch.setToggleState(newval);
    }
};

function NMWiredSectionTitleMenuItem() {
    this._init.apply(this, arguments);
}

NMWiredSectionTitleMenuItem.prototype = {
    __proto__: NMDeviceTitleMenuItem.prototype,

    updateForDevice: function(device) {
        if (device) {
            this._device = device;
            this.setStatus(device.getStatusLabel());
            this.setToggleState(device.connected);
        } else
            this.setStatus('');
    },

    activate: function(event) {
        NMDeviceTitleMenuItem.prototype.activate.call(this, event);

        if (!this._device) {
            log('Section title activated when there is more than one device, should be non reactive');
            return;
        }

        let newState = this._switch.state;

        // Immediately reset the switch to false, it will be updated appropriately
        // by state-changed signals in devices (but fixes the VPN not being in sync
        // if the ActiveConnection object is never seen by libnm-glib)
        this._switch.setToggleState(false);

        if (newState)
            this._device.activate();
        else
            this._device.deactivate();
    }
};

function NMWirelessSectionTitleMenuItem() {
    this._init.apply(this, arguments);
}

NMWirelessSectionTitleMenuItem.prototype = {
    __proto__: NMDeviceTitleMenuItem.prototype,

    _init: function(client, property, title, params) {
        NMDeviceTitleMenuItem.prototype._init.call(this, title, params);

        this._client = client;
        this._property = property + '_enabled';
        this._propertyHardware = property + '_hardware_enabled';
        this._setEnabledFunc = property + '_set_enabled';

        this._client.connect('notify::' + property + '-enabled', Lang.bind(this, this._propertyChanged));
        this._client.connect('notify::' + property + '-hardware-enabled', Lang.bind(this, this._propertyChanged));

        this._propertyChanged();
    },

    updateForDevice: function(device) {
        // we show the switch
        // - if there not just one device
        // - if the switch is off
        // - if the device is activated or disconnected
        if (device && this._softwareEnabled && this._hardwareEnabled) {
            let text = device.getStatusLabel();
            this.setStatus(text);
        } else
            this.setStatus(null);
    },

    activate: function(event) {
        NMDeviceTitleMenuItem.prototype.activate.call(this, event);

        this._client[this._setEnabledFunc](this._switch.state);
    },

    _propertyChanged: function() {
        this._softwareEnabled = this._client[this._property];
        this._hardwareEnabled = this._client[this._propertyHardware];

        let enabled = this._softwareEnabled && this._hardwareEnabled;
        this.setToggleState(enabled);
        if (!this._hardwareEnabled)
            /* Translators: this indicates that wireless or wwan is disabled by hardware killswitch */
            this.setStatus(_("disabled"));

        this.emit('enabled-changed', enabled);
    }
};

function NMDevice() {
    throw new TypeError('Instantanting abstract class NMDevice');
}

NMDevice.prototype = {
    _init: function(client, device, connections) {
        this.device = device;
        if (device) {
            this.device._delegate = this;
            this._stateChangedId = this.device.connect('state-changed', Lang.bind(this, this._deviceStateChanged));
        } else
            this._stateChangedId = 0;

        // protected
        this._client = client;
        this._connections = [ ];
        for (let i = 0; i < connections.length; i++) {
            if (!connections[i]._uuid)
                continue;
            if (!this.connectionValid(connections[i]))
                continue;
            // record the connection
            let obj = {
                connection: connections[i],
                name: connections[i]._name,
                uuid: connections[i]._uuid,
                timestamp: connections[i]._timestamp,
            };
            this._connections.push(obj);
        }
        this._connections.sort(function(one, two) {
            return two.timestamp - one.timestamp;
        });
        this._activeConnection = null;
        this._activeConnectionItem = null;
        this._autoConnectionItem = null;

        if (this.device) {
            this.statusItem = new NMDeviceTitleMenuItem(this._getDescription());
            this._statusChanged = this.statusItem.connect('toggled', Lang.bind(this, function(item, state) {
                if (state)
                    this.activate();
                else
                    this.deactivate();
                this.emit('enabled-changed');
            }));
        }
        this.section = new PopupMenu.PopupMenuSection();

        this._createSection();
    },

    destroy: function() {
        if (this.device)
            this.device._delegate = null;

        if (this._stateChangedId) {
            // Need to go through GObject.Object.prototype because
            // nm_device_disconnect conflicts with g_signal_disconnect
            GObject.Object.prototype.disconnect.call(this.device, this._stateChangedId);
            this._stateChangedId = 0;
        }

        this._clearSection();
        if (this.titleItem)
            this.titleItem.destroy();
        this.section.destroy();
    },

    deactivate: function() {
        this.device.disconnect(null);
    },

    activate: function() {
        if (this._activeConnection)
            // nothing to do
            return;

        // pick the most recently used connection and connect to that
        // or if no connections ever set, create an automatic one
        if (this._connections.length > 0) {
            this._client.activate_connection(this._connections[0].connection, this.device, null, null);
        } else if (this._autoConnectionName) {
            let connection = this._createAutomaticConnection();
            this._client.add_and_activate_connection(connection, this.device, null, null);
        }
    },

    get connected() {
        return this.device.state == NetworkManager.DeviceState.ACTIVATED;
    },

    setActiveConnection: function(activeConnection) {
        if (activeConnection == this._activeConnection)
            // nothing to do
            return;

        // remove any UI
        if (this._activeConnectionItem) {
            this._activeConnectionItem.destroy();
            this._activeConnectionItem = null;
        }

        this._activeConnection = activeConnection;

        this._clearSection();
        this._createSection();
    },

    checkConnection: function(connection) {
        let exists = this._findConnection(connection._uuid) != -1;
        let valid = this.connectionValid(connection);
        if (exists && !valid)
            this.removeConnection(connection);
        else if (!exists && valid)
            this.addConnection(connection);
    },

    addConnection: function(connection) {
        // record the connection
        let obj = {
            connection: connection,
            name: connection._name,
            uuid: connection._uuid,
            timestamp: connection._timestamp,
        };
        this._connections.push(obj);
        this._connections.sort(function(one, two) {
            return two.timestamp - one.timestamp;
        });

        this._clearSection();
        this._createSection();
    },

    removeConnection: function(connection) {
        if (!connection._uuid) {
            log('Cannot remove a connection without an UUID');
            return;
        }
        let pos = this._findConnection(connection._uuid);
        if (pos == -1) {
            // this connection was never added, nothing to do here
            return;
        }

        let obj = this._connections[pos];
        if (obj.item)
            obj.item.destroy();
        this._connections.splice(pos, 1);

        if (this._connections.length <= 1) {
            // We need to show the automatic connection again
            // (or in the case of NMDeviceWired, we want to hide
            // the only explicit connection)
            this._clearSection();
            this._createSection();
        }
    },

    connectionValid: function(connection) {
        throw new TypeError('Invoking pure virtual function NMDevice.connectionValid');
    },

    setEnabled: function(enabled) {
        // do nothing by default, we want to keep the conneciton list visible
        // in the majority of cases (wired, wwan, vpn)
    },

    getStatusLabel: function() {
        switch(this.device.state) {
        case NetworkManager.DeviceState.DISCONNECTED:
        case NetworkManager.DeviceState.ACTIVATED:
            return null;
        case NetworkManager.DeviceState.PREPARE:
        case NetworkManager.DeviceState.CONFIG:
        case NetworkManager.DeviceState.IP_CONFIG:
            return _("connecting...");
        case NetworkManager.DeviceState.NEED_AUTH:
            /* Translators: this is for network connections that require some kind of key or password */
            return _("authentication required");
        case NetworkManager.DeviceState.UNAVAILABLE:
            // This state is actually a compound of various states (generically unavailable,
            // firmware missing, carrier not available), that are exposed by different properties
            // (whose state may or may not updated when we receive state-changed).
            if (!this._firmwareMissingId)
                this._firmwareMissingId = this.device.connect('notify::firmware-missing', Lang.bind(this, this._substateChanged));
            if (this.device.firmware_missing) {
                /* Translators: this is for devices that require some kind of firmware or kernel
                   module, which is missing */
                return _("firmware missing");
            }
            if (this.device.capabilities & NetworkManager.DeviceCapabilities.CARRIER_DETECT) {
                if (!this._carrierChangedId)
                    this._carrierChangedId = this.device.connect('notify::carrier', Lang.bind(this, this._substateChanged));
                if (!this.carrier) {
                    /* Translators: this is for wired network devices that are physically disconnected */
                    return _("cable unplugged");
                }
            }
            /* Translators: this is for a network device that cannot be activated (for example it
               is disabled by rfkill, or it has no coverage */
            return _("unavailable");
        case NetworkManager.DeviceState.FAILED:
            return _("connection failed");
        default:
            log('Device state invalid, is %d'.format(this.device.state));
            return 'invalid';
        }
    },

    // protected
    _createAutomaticConnection: function() {
        throw new TypeError('Invoking pure virtual function NMDevice.createAutomaticConnection');
    },

    _findConnection: function(uuid) {
        for (let i = 0; i < this._connections.length; i++) {
            let obj = this._connections[i];
            if (obj.uuid == uuid)
                return i;
        }
        return -1;
    },

    _clearSection: function() {
        // Clear everything
        this.section.removeAll();
        this._autoConnectionItem = null;
        this._activeConnectionItem = null;
        for (let i = 0; i < this._connections.length; i++) {
            this._connections[i].item = null;
        }
    },

    _shouldShowConnectionList: function() {
        return (this.device.state >= NetworkManager.DeviceState.DISCONNECTED);
    },

    _createSection: function() {
        if (!this._shouldShowConnectionList())
            return;

        if (this._activeConnection) {
            this._createActiveConnectionItem();
            this.section.addMenuItem(this._activeConnectionItem);
        }
        if (this._connections.length > 0) {
            for(let j = 0; j < this._connections.length; ++j) {
                let obj = this._connections[j];
                if (this._activeConnection &&
                    obj.connection == this._activeConnection._connection)
                    continue;
                obj.item = this._createConnectionItem(obj);
                this.section.addMenuItem(obj.item);
            }
        } else if (this._autoConnectionName) {
            this._autoConnectionItem = new PopupMenu.PopupMenuItem(this._autoConnectionName);
            this._autoConnectionItem.connect('activate', Lang.bind(this, function() {
                let connection = this._createAutomaticConnection();
                this._client.add_and_activate_connection(connection, this.device, null, null);
            }));
            this.section.addMenuItem(this._autoConnectionItem);
        }
    },

    _createConnectionItem: function(obj) {
        let connection = obj.connection;
        let item = new PopupMenu.PopupMenuItem(obj.name);

        item.connect('activate', Lang.bind(this, function() {
            this._client.activate_connection(connection, this.device, null, null);
        }));
        return item;
    },

    _createActiveConnectionItem: function() {
        let title;
        let active = this._activeConnection._connection;
        if (active) {
            title = active._name;
        } else {
            /* TRANSLATORS: this is the indication that a connection for another logged in user is active,
               and we cannot access its settings (including the name) */
            title = _("Connected (private)");
        }
        this._activeConnectionItem = new PopupMenu.PopupMenuItem(title, { reactive: false });
        this._activeConnectionItem.setShowDot(true);
    },

    _deviceStateChanged: function(device, newstate, oldstate, reason) {
        if (newstate == oldstate) {
            log('device emitted state-changed without actually changing state');
            return;
        }

        if (oldstate == NetworkManager.DeviceState.ACTIVATED) {
            this.emit('network-lost');
        }

        switch(newstate) {
        case NetworkManager.DeviceState.NEED_AUTH:
            // FIXME: make this have a real effect
            // (currently we rely on a running nm-applet)
            this.emit('need-auth');
            break;
        case NetworkManager.DeviceState.FAILED:
            this.emit('activation-failed', reason);
            break;
        }

        if (this._carrierChangedId) {
            // see above for why this is needed
            GObject.Object.prototype.disconnect.call(this.device, this._carrierChangedId);
            this._carrierChangedId = 0;
        }
        if (this._firmwareChangedId) {
            GObject.Object.prototype.disconnect.call(this.device, this._firmwareChangedId);
            this._firmwareChangedId = 0;
        }

        this.statusItem.setStatus(this.getStatusLabel());
        this.statusItem.setToggleState(this.connected);

        this._clearSection();
        this._createSection();
        this.emit('state-changed');
    },

    _substateChanged: function() {
        this.statusItem.setStatus(this.getStatusLabel());

        this.emit('state-changed');
    },

    _getDescription: function() {
        let dev_product = this.device.get_product();
        let dev_vendor = this.device.get_vendor();
        if (!dev_product || !dev_vendor)
	    return null;

        let product = Util.fixupPCIDescription(dev_product);
        let vendor = Util.fixupPCIDescription(dev_vendor);
        let out = '';

        // Another quick hack; if all of the fixed up vendor string
        // is found in product, ignore the vendor.
        if (product.indexOf(vendor) == -1)
            out += vendor + ' ';
        out += product;

        return out;
    }
};
Signals.addSignalMethods(NMDevice.prototype);


function NMDeviceWired() {
    this._init.apply(this, arguments);
}

NMDeviceWired.prototype = {
    __proto__: NMDevice.prototype,

    _init: function(client, device, connections) {
        this._autoConnectionName = _("Auto Ethernet");
        this.category = NMConnectionCategory.WIRED;

        NMDevice.prototype._init.call(this, client, device, connections);
    },

    connectionValid: function(connection) {
        if (connection._type != NetworkManager.SETTING_WIRED_SETTING_NAME)
            return false;

        let ethernetSettings = connection.get_setting_by_name(NetworkManager.SETTING_WIRED_SETTING_NAME);
        let fixedMac = ethernetSettings.get_mac_address();
        if (fixedMac)
            return macCompare(fixedMac, macToArray(this.device.perm_hw_address));
        return true;
    },

    _createSection: function() {
        NMDevice.prototype._createSection.call(this);

        // if we have only one connection (normal or automatic)
        // we hide the connection list, and use the switch to control
        // the device
        // we can do it here because addConnection and removeConnection
        // both call _createSection at some point
        if (this._connections.length <= 1)
            this.section.actor.hide();
        else
            this.section.actor.show();
    },

    _createAutomaticConnection: function() {
        let connection = new NetworkManager.Connection();
        connection._uuid = NetworkManager.utils_uuid_generate();
        connection.add_setting(new NetworkManager.SettingWired());
        connection.add_setting(new NetworkManager.SettingConnection({
            uuid: connection._uuid,
            id: this._autoConnectionName,
            type: NetworkManager.SETTING_WIRED_SETTING_NAME,
            autoconnect: true
        }));
        return connection;
    }
};

function NMDeviceModem() {
    this._init.apply(this, arguments);
}

NMDeviceModem.prototype = {
    __proto__: NMDevice.prototype,

    _init: function(client, device, connections) {
        let is_wwan = false;

        this._enabled = true;
        this.mobileDevice = null;
        this._connectionType = 'ppp';

        this._capabilities = device.current_capabilities;
        if (this._capabilities & NetworkManager.DeviceModemCapabilities.GSM_UMTS) {
            is_wwan = true;
            this.mobileDevice = new ModemManager.ModemGsm(device.udi);
            this._connectionType = NetworkManager.SETTING_GSM_SETTING_NAME;
        } else if (this._capabilities & NetworkManager.DeviceModemCapabilities.CDMA_EVDO) {
            is_wwan = true;
            this.mobileDevice = new ModemManager.ModemCdma(device.udi);
            this._connectionType = NetworkManager.SETTING_CDMA_SETTING_NAME;
        } else if (this._capabilities & NetworkManager.DeviceModemCapabilities.LTE) {
            is_wwan = true;
            // FIXME: support signal quality
        }

        if (is_wwan) {
            this.category = NMConnectionCategory.WWAN;
            this._autoConnectionName = _("Auto broadband");
        } else {
            this.category = NMConnectionCategory.WIRED;
            this._autoConnectionName = _("Auto dial-up");
        }

        if (this.mobileDevice) {
            this._operatorNameId = this.mobileDevice.connect('notify::operator-name', Lang.bind(this, function() {
                if (this._operatorItem) {
                    let name = this.mobileDevice.operator_name;
                    if (name) {
                        this._operatorItem.label.text = name;
                        this._operatorItem.actor.show();
                    } else
                        this._operatorItem.actor.hide();
                }
            }));
            this._signalQualityId = this.mobileDevice.connect('notify::signal-quality', Lang.bind(this, function() {
                if (this._operatorItem) {
                    this._operatorItem.setIcon(this._getSignalIcon());
                }
            }));
        }

        NMDevice.prototype._init.call(this, client, device, connections, 1);
    },

    setEnabled: function(enabled) {
        this._enabled = enabled;
        if (this.category == NMConnectionCategory.WWAN) {
            if (enabled) {
                // prevent "network unavailable" statuses
                this.statusItem.setStatus(null);
            } else
                this.statusItem.setStatus(this.getStatusLabel());
        }

        NMDevice.prototype.setEnabled.call(this, enabled);
    },

    get connected() {
        return this._enabled && this.device.state == NetworkManager.DeviceState.CONNECTED;
    },

    destroy: function() {
        if (this._operatorNameId) {
            this.mobileDevice.disconnect(this._operatorNameId);
            this._operatorNameId = 0;
        }
        if (this._signalQualityId) {
            this.mobileDevice.disconnect(this._signalQualityId);
            this._signalQualityId = 0;
        }

        NMDevice.prototype.destroy.call(this);
    },

    _getSignalIcon: function() {
        return 'network-cellular-signal-' + signalToIcon(this.mobileDevice.signal_quality);
    },

    _createSection: function() {
        if (this.mobileDevice) {
            // If operator_name is null, just pass the empty string, as the item is hidden anyway
            this._operatorItem = new PopupMenu.PopupImageMenuItem(this.mobileDevice.operator_name || '',
                                                                  this._getSignalIcon(),
                                                                  { reactive: false });
            if (this.mobileDevice.operator_name)
                this._operatorItem.actor.hide();
            this.section.addMenuItem(this._operatorItem);
        }

        NMDevice.prototype._createSection.call(this);
    },

    clearSection: function() {
        this._operatorItem = null;

        NMDevice.prototype._clearSection.call(this);
    },

    connectionValid: function(connection) {
        return connection._type == this._connectionType;
    },

    _createAutomaticConnection: function() {
        // FIXME: we need to summon the mobile wizard here
        // or NM will not have the necessary parameters to complete the connection
        // pending a DBus method on nm-applet

        let connection = new NetworkManager.Connection;
        connection._uuid = NetworkManager.utils_uuid_generate();
        connection.add_setting(new NetworkManager.SettingConnection({
            uuid: connection._uuid,
            id: this._autoConnectionName,
            type: this._connectionType,
            autoconnect: false
        }));
        return connection;
    }
};

function NMDeviceBluetooth() {
    this._init.apply(this, arguments);
}

NMDeviceBluetooth.prototype = {
    __proto__: NMDevice.prototype,

    _init: function(client, device, connections) {
        this._autoConnectionName = this._makeConnectionName(device);
        device.connect('notify::name', Lang.bind(this, this._updateAutoConnectionName));

        this.category = NMConnectionCategory.WWAN;

        NMDevice.prototype._init.call(this, client, device, connections);
    },

    connectionValid: function(connection) {
        if (connection._type != NetworkManager.SETTING_BLUETOOTH_SETTING_NAME)
            return false;

        let bluetoothSettings = connection.get_setting_by_name(NetworkManager.SETTING_BLUETOOTH_SETTING_NAME);
        let fixedBdaddr = bluetoothSettings.get_bdaddr();
        if (fixedBdaddr)
            return macCompare(fixedBdaddr, macToArray(this.device.hw_address));

        return true;
    },

    _createAutomaticConnection: function() {
        let connection = new NetworkManager.Connection;
        connection._uuid = NetworkManager.utils_uuid_generate();
        connection.add_setting(new NetworkManager.SettingBluetooth);
        connection.add_setting(new NetworkManager.SettingConnection({
            uuid: connection._uuid,
            id: this._autoConnectionName,
            type: NetworkManager.SETTING_BLUETOOTH_SETTING_NAME,
            autoconnect: false
        }));
        return connection;
    },

    _makeConnectionName: function(device) {
        let name = device.name;
        if (name)
            return _("Auto %s").format(name);
        else
            return _("Auto bluetooth");
    },

    _updateAutoConnectionName: function() {
        this._autoConnectionName = this._makeConnectioName(this.device);

        this._clearSection();
        this._createSection();
    }
};


// Not a real device, but I save a lot code this way
function NMDeviceVPN() {
    this._init.apply(this, arguments);
}

NMDeviceVPN.prototype = {
    __proto__: NMDevice.prototype,

    _init: function(client) {
        // Disable autoconnections
        this._autoConnectionName = null;
        this.category = NMConnectionCategory.VPN;

        NMDevice.prototype._init.call(this, client, null, [ ]);
    },

    connectionValid: function(connection) {
        return connection._type == NetworkManager.SETTING_VPN_SETTING_NAME;
    },

    get empty() {
        return this._connections.length == 0;
    },

    get connected() {
        return !!this._activeConnection;
    },

    setActiveConnection: function(activeConnection) {
        NMDevice.prototype.setActiveConnection.call(this, activeConnection);

        this.emit('active-connection-changed');
    },

    _shouldShowConnectionList: function() {
        return true;
    },

    deactivate: function() {
        if (this._activeConnection)
            this._client.deactivate_connection(this._activeConnection);
    },

    getStatusLabel: function() {
        return null;
    }
};

function NMDeviceWireless() {
    this._init.apply(this, arguments);
}

NMDeviceWireless.prototype = {
    __proto__: NMDevice.prototype,

    _init: function(client, device, connections) {
        this.category = NMConnectionCategory.WIRELESS;

        this._overflowItem = null;
        this._networks = [ ];

        // breaking the layers with this, but cannot call
        // this.connectionValid until I have a device
        this.device = device;

        let validConnections = connections.filter(Lang.bind(this, function(connection) {
            return this.connectionValid(connection);
        }));
        let accessPoints = device.get_access_points() || [ ];
        for (let i = 0; i < accessPoints.length; i++) {
            // Access points are grouped by network
            let ap = accessPoints[i];
            let pos = this._findNetwork(ap);
            let obj;
            if (pos != -1) {
                obj = this._networks[pos];
                obj.accessPoints.push(ap);
            } else {
                obj = { ssid: ap.get_ssid(),
                        mode: ap.mode,
                        security: this._getApSecurityType(ap),
                        connections: [ ],
                        item: null,
                        accessPoints: [ ap ]
                      };
                this._networks.push(obj);
            }

            // Check if some connection is valid for this AP
            for (let j = 0; j < validConnections.length; j++) {
                let connection = validConnections[j];
                if (this._connectionValidForAP(connection, ap) &&
                    obj.connections.indexOf(connection) == -1) {
                    obj.connections.push(connection);
                }
            }
        }
        this._apAddedId = device.connect('access-point-added', Lang.bind(this, this._accessPointAdded));
        this._apRemovedId = device.connect('access-point-removed', Lang.bind(this, this._accessPointRemoved));

        NMDevice.prototype._init.call(this, client, device, validConnections);
    },

    destroy: function() {
        if (this._apAddedId) {
            // see above for this HACK
            GObject.Object.prototype.disconnect.call(this.device, this._apAddedId);
            this._apAddedId = 0;
        }

        if (this._apRemovedId) {
            GObject.Object.prototype.disconnect.call(this.device, this._apRemovedId);
            this._apRemovedId = 0;
        }

        NMDevice.prototype.destroy.call(this);
    },

    setEnabled: function(enabled) {
        if (enabled) {
            this.statusItem.actor.show();
            this.section.actor.show();
        } else {
            this.statusItem.actor.hide();
            this.section.actor.hide();
        }
    },

    activate: function() {
        if (this._activeConnection)
            // nothing to do
            return;

        // among all visible networks, pick the last recently used connection
        let best = null;
        let bestApObj = null;
        let bestTime = 0;
        for (let i = 0; i < this._networks.length; i++) {
            let apObj = this._networks[i];
            for (let j = 0; j < apObj.connections.length; j++) {
                let connection = apObj.connections[j];
                if (connection._timestamp > bestTime) {
                    best = connection;
                    bestTime = connection._timestamp;
                    bestApObj = apObj;
                }
            }
        }

        if (best) {
            for (let i = 0; i < bestApObj.accessPoints.length; i++) {
                let ap = bestApObj.accessPoints[i];
                if (this._connectionValidForAP(best, ap)) {
                    this._client.activate_connection(best, this.device, ap.dbus_path, null);
                    break;
                }
            }
            return;
        }

        // XXX: what else to do?
        // for now, just pick a random network
        // (this function is called in a corner case anyway, that is, only when
        // the user toggles the switch and has more than one wireless device)
        if (this._networks.length > 0) {
            let connection = this._createAutomaticConnection(this._networks[0]);
            let accessPoints = sortAccessPoints(this._networks[0].accessPoints);
            this._client.add_and_activate_connection(connection, this.device, accessPoints[0].dbus_path, null);
        }
    },

    _getApSecurityType: function(accessPoint) {
        if (accessPoint._secType)
            return accessPoint._secType;
        // XXX: have this checked by someone familiar with IEEE 802.1x

        let flags = accessPoint.flags;
        let wpa_flags = accessPoint.wpa_flags;
        let rsn_flags = accessPoint.rsn_flags;
        let type;
        if (  !(flags & NM80211ApFlags.PRIVACY)
	      && (wpa_flags == NM80211ApSecurityFlags.NONE)
	      && (rsn_flags == NM80211ApSecurityFlags.NONE))
	    type = NMAccessPointSecurity.NONE;
        else if (   (flags & NM80211ApFlags.PRIVACY)
	            && (wpa_flags == NM80211ApSecurityFlags.NONE)
	            && (rsn_flags == NM80211ApSecurityFlags.NONE))
	    type = NMAccessPointSecurity.WEP;
        else if (   !(flags & NM80211ApFlags.PRIVACY)
	        &&  (wpa_flags != NM80211ApSecurity.NONE)
	        &&  (rsn_flags != NM80211ApSecurity.NONE))
	    type = NMAccessPointSecurity.WPA;
        else
            type = NMAccessPointSecurity.WPA2;

        // cache the found value to avoid checking flags all the time
        accessPoint._secType = type;
        return type;
    },

    _networkCompare: function(network, accessPoint) {
        if (!ssidCompare(network.ssid, accessPoint.get_ssid()))
            return false;
        if (network.mode != accessPoint.mode)
            return false;
        if (network.security != this._getApSecurityType(accessPoint))
            return false;

        return true;
    },

    _findNetwork: function(accessPoint) {
        for (let i = 0; i < this._networks.length; i++) {
            if (this._networkCompare(this._networks[i], accessPoint))
                return i;
        }
        return -1;
    },

    _accessPointAdded: function(device, accessPoint) {
        let pos = this._findNetwork(accessPoint);
        let apObj;
        if (pos != -1) {
            apObj = this._networks[pos];
            if (apObj.accessPoints.indexOf(accessPoint) != -1) {
                log('Access point was already seen, not adding again');
                return;
            }

            apObj.accessPoints.push(accessPoint);
        } else {
            apObj = { ssid: accessPoint.get_ssid(),
                      mode: accessPoint.mode,
                      security: this._getApSecurityType(accessPoint),
                      connections: [ ],
                      item: null,
                      accessPoints: [ accessPoint ]
                    };
            this._networks.push(apObj);
        }

        // check if this enables new connections for this group
        for (let i = 0; i < this._connections.length; i++) {
            let connection = this._connections[i].connection;
            if (this._connectionValidForAP(connection, accessPoint) &&
                apObj.connections.indexOf(connection) == -1) {
                apObj.connections.push(connection);
            }
        }

        // update everything
        this._clearSection();
        this._createSection();
    },

    _accessPointRemoved: function(device, accessPoint) {
        let pos = this._findNetwork(accessPoint);

        if (pos == -1) {
            log('Removing an access point that was never added');
            return;
        }

        let apObj = this._networks[pos];
        let i = apObj.accessPoints.indexOf(accessPoint);

        if (i == -1) {
            log('Removing an access point that was never added');
            return;
        }

        apObj.accessPoints.splice(i, 1);

        if (apObj.accessPoints.length == 0) {
            if (apObj.item)
                apObj.item.destroy();
            this._networks.splice(pos, 1);
        } else if (apObj.item)
            apObj.item.updateAccessPoints(apObj.accessPoints);
    },

    _createAPItem: function(connection, accessPointObj, useConnectionName) {
        let item = new NMNetworkMenuItem(accessPointObj.accessPoints, useConnectionName ? connection._name : undefined);
        item._connection = connection;
        item.connect('activate', Lang.bind(this, function() {
            let accessPoints = sortAccessPoints(accessPointObj.accessPoints);
            for (let i = 0; i < accessPoints.length; i++) {
                if (this._connectionValidForAP(connection, accessPoints[i])) {
                    this._client.activate_connection(connection, this.device, accessPoints[i].dbus_path, null);
                    break;
                }
            }
        }));
        return item;
    },

    connectionValid: function(connection) {
        if (connection._type != NetworkManager.SETTING_WIRELESS_SETTING_NAME)
            return false;

        let wirelessSettings = connection.get_setting_by_name(NetworkManager.SETTING_WIRELESS_SETTING_NAME);
        let wirelessSecuritySettings = connection.get_setting_by_name(NetworkManager.SETTING_WIRELESS_SECURITY_SETTING_NAME);

        let fixedMac = wirelessSettings.get_mac_address();
        if (fixedMac && !macCompare(fixedMac, macToArray(this.device.perm_hw_address)))
            return false;

        if (wirelessSecuritySettings &&
            wirelessSecuritySettings.key_mgmt != 'none' &&
            wirelessSecuritySettings.key_mgmt != 'ieee8021x') {
            let capabilities = this.device.wireless_capabilities;
            if (!(capabilities & NetworkManager.DeviceWifiCapabilities.WPA) ||
                !(capabilities & NetworkManager.DeviceWifiCapabilities.CIPHER_TKIP))
                return false;
            if (wirelessSecuritySettings.get_num_protos() == 1 &&
                wirelessSecuritySettings.get_proto(0) == 'rsn' &&
                !(capabilities & NetworkManager.DeviceWifiCapabilities.RSN))
                return false;
            if (wirelessSecuritySettings.get_num_pairwise() == 1 &&
                wirelessSecuritySettings.get_pairwise(0) == 'ccmp' &&
                !(capabilities & NetworkManager.DeviceWifiCapabilities.CIPHER_CCMP))
                return false;
            if (wirelessSecuritySettings.get_num_groups() == 1 &&
                wirelessSecuritySettings.get_group(0) == 'ccmp' &&
                !(capabilities & NetworkManager.DeviceWifiCapabilities.CIPHER_CCMP))
                return false;
        }
        return true;
    },

    _clearSection: function() {
        NMDevice.prototype._clearSection.call(this);

        for (let i = 0; i < this._networks.length; i++)
            this._networks[i].item = null;
        this._overflowItem = null;
    },

    removeConnection: function(connection) {
        if (!connection._uuid)
            return;
        let pos = this._findConnection(connection._uuid);
        if (pos == -1) {
            // removing connection that was never added
            return;
        }

        let obj = this._connections[pos];
        this._connections.splice(pos, 1);

        let anyauto = false, forceupdate = false;
        for (let i = 0; i < this._networks.length; i++) {
            let apObj = this._networks[i];
            let connections = apObj.connections;
            for (let k = 0; k < connections.length; k++) {
                if (connections[k]._uuid == connection._uuid) {
                    // remove the connection from the access point group
                    connections.splice(k);
                    anyauto = connections.length == 0;
                    if (apObj.item) {
                        if (apObj.item instanceof PopupMenu.PopupSubMenuMenuItem) {
                            let items = apObj.item.menu.getMenuItems();
                            if (items.length == 2) {
                                // we need to update the connection list to convert this to a normal item
                                forceupdate = true;
                            } else {
                                for (let j = 0; j < items.length; j++) {
                                    if (items[j]._connection._uuid == connection._uuid) {
                                        items[j].destroy();
                                        break;
                                    }
                                }
                            }
                        } else {
                            apObj.item.destroy();
                            apObj.item = null;
                        }
                    }
                    break;
                }
            }
        }

        if (forceupdate || anyauto) {
            this._clearSection();
            this._createSection();
        }
    },

    addConnection: function(connection) {
        // record the connection
        let obj = {
            connection: connection,
            name: connection._name,
            uuid: connection._uuid,
        };
        this._connections.push(obj);

        // find an appropriate access point
        let any = false, forceupdate = false;
        for (let i = 0; i < this._networks.length; i++) {
            let apObj = this._networks[i];

            // Check if connection is valid for any of these access points
            let any = false;
            for (let k = 0; k < apObj.accessPoints.length; k++) {
                let ap = apObj.accessPoints[k];
                if (this._connectionValidForAP(connection, ap)) {
                    apObj.connections.push(connection);
                    any = true;
                    break;
                }
            }

            if (any && this._shouldShowConnectionList()) {
                // we need to show this connection
                if (apObj.item && apObj.item.menu) {
                    // We're already showing the submenu for this access point
                    apObj.item.menu.addMenuItem(this._createAPItem(connection, apObj, true));
                } else {
                    if (apObj.item)
                        apObj.item.destroy();
                    if (apObj.connections.length == 1) {
                        apObj.item = this._createAPItem(connection, apObj, false);
                        this.section.addMenuItem(apObj.item);
                    } else {
                        apObj.item = null;
                        // we need to force an update to create the submenu
                        forceupdate = true;
                    }
                }
            }
        }

        if (forceupdate) {
            this._clearSection();
            this._createSection();
        }
    },

    _connectionValidForAP: function(connection, ap) {
        // copied and adapted from nm-applet
        let wirelessSettings = connection.get_setting_by_name(NetworkManager.SETTING_WIRELESS_SETTING_NAME);
        if (!ssidCompare(wirelessSettings.get_ssid(), ap.get_ssid()))
            return false;

        let wirelessSecuritySettings = connection.get_setting_by_name(NetworkManager.SETTING_WIRELESS_SECURITY_SETTING_NAME);

        let fixedBssid = wirelessSettings.get_bssid();
        if (fixedBssid && !macCompare(fixedBssid, macToArray(ap.hw_address)))
            return false;

        let fixedBand = wirelessSettings.band;
        if (fixedBand) {
            let freq = ap.frequency;
            if (fixedBand == 'a' && (freq < 4915 || freq > 5825))
                return false;
            if (fixedBand == 'bg' && (freq < 2412 || freq > 2484))
                return false;
        }

        let fixedChannel = wirelessSettings.channel;
        if (fixedChannel && fixedChannel != NetworkManager.utils_wifi_freq_to_channel(ap.frequency))
            return false;

        if (!wirelessSecuritySettings)
            return true;

        return wirelessSettings.ap_security_compatible(wirelessSecuritySettings, ap.flags, ap.wpa_flags, ap.rsn_flags, ap.mode);
    },

    _createActiveConnectionItem: function() {
        let activeAp = this.device.active_access_point;
        let icon, title;
        if (this._activeConnection._connection) {
            let connection = this._activeConnection._connection;
            if (activeAp)
                this._activeConnectionItem = new NMNetworkMenuItem([ activeAp ], undefined,
                                                                       { reactive: false });
            else
                this._activeConnectionItem = new PopupMenu.PopupImageMenuItem(connection._name,
                                                                              'network-wireless-connected',
                                                                              { reactive: false });
        } else {
            // We cannot read the connection (due to ACL, or API incompatibility), but we still show signal if we have it
            let menuItem;
            if (activeAp)
                this._activeConnectionItem = new NMNetworkMenuItem([ activeAp ], undefined,
                                                                       { reactive: false });
            else
                this._activeConnectionItem = new PopupMenu.PopupImageMenuItem(_("Connected (private)"),
                                                                              'network-wireless-connected',
                                                                              { reactive: false });
        }
        this._activeConnectionItem.setShowDot(true);
    },

    _createAutomaticConnection: function(apObj) {
        let name;
        let ssid = NetworkManager.utils_ssid_to_utf8(apObj.ssid);
        if (ssid) {
            /* TRANSLATORS: this the automatic wireless connection name (including the network name) */
            name = _("Auto %s").format(ssid);
        } else
            name = _("Auto wireless");

        let connection = new NetworkManager.Connection();
        connection.add_setting(new NetworkManager.SettingWireless());
        connection.add_setting(new NetworkManager.SettingConnection({
            id: name,
            autoconnect: true, // NetworkManager will know to ignore this if appropriate
            uuid: NetworkManager.utils_uuid_generate(),
            type: NetworkManager.SETTING_WIRELESS_SETTING_NAME
        }));
        return connection;
    },

    _createSection: function() {
        if (!this._shouldShowConnectionList())
            return;

        if(this._activeConnection) {
            this._createActiveConnectionItem();
            this.section.addMenuItem(this._activeConnectionItem);
        }

        let activeAp = this.device.active_access_point;
        let activeApSsid = activeAp ? activeAp.get_ssid() : null;

        // we want five access points in the menu, including the active one
        let numItems = this._activeConnection ? 4 : 5;

        for(let j = 0; j < this._networks.length; j++) {
            let apObj = this._networks[j];
            if(activeAp && ssidCompare(apObj.ssid, activeApSsid))
                continue;

            let menuItem;
            if(apObj.connections.length > 0) {
                if (apObj.connections.length == 1)
                    apObj.item = this._createAPItem(apObj.connections[0], apObj, false);
                else {
                    let title = NetworkManager.utils_ssid_to_utf8(apObj.ssid) || _("<unknown>");
                    apObj.item = new PopupMenu.PopupSubMenuMenuItem(title);
                    apObj.item._apObj = apObj;
                    for (let i = 0; i < apObj.connections.length; i++)
                        apObj.item.menu.addMenuItem(this._createAPItem(apObj.connections[i], apObj, true));
                }
            } else {
                apObj.item = new NMNetworkMenuItem(apObj.accessPoints);
                apObj.item._apObj = apObj;
                apObj.item.connect('activate', Lang.bind(this, function() {
                    let connection = this._createAutomaticConnection(apObj);
                    let accessPoints = sortAccessPoints(apObj.accessPoints);
                    this._client.add_and_activate_connection(connection, this.device, accessPoints[0].dbus_path, null)
                }));
            }

            if (j < numItems)
                this.section.addMenuItem(apObj.item);
            else {
                if (!this._overflowItem) {
                    this._overflowItem = new PopupMenu.PopupSubMenuMenuItem(_("More..."));
                    this.section.addMenuItem(this._overflowItem);
                }
                this._overflowItem.menu.addMenuItem(apObj.item);
            }
        }
    },
};

function NMApplet() {
    this._init.apply(this, arguments);
}
NMApplet.prototype = {
    __proto__: PanelMenu.SystemStatusButton.prototype,

    _init: function() {
        PanelMenu.SystemStatusButton.prototype._init.call(this, 'network-error');

        this._client = NMClient.Client.new();

        this._statusSection = new PopupMenu.PopupMenuSection();
        this._statusItem = new PopupMenu.PopupMenuItem('', { style_class: 'popup-inactive-menu-item', reactive: false });
        this._statusSection.addMenuItem(this._statusItem);
        this._statusSection.addAction(_("Enable networking"), Lang.bind(this, function() {
            this._client.networking_enabled = true;
        }));
        this._statusSection.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._statusSection.actor.hide();
        this.menu.addMenuItem(this._statusSection);

        this._devices = { };

        this._devices.wired = {
            section: new PopupMenu.PopupMenuSection(),
            devices: [ ],
            item: new NMWiredSectionTitleMenuItem(_("Wired"))
        };

        this._devices.wired.section.addMenuItem(this._devices.wired.item);
        this._devices.wired.section.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._devices.wired.section.actor.hide();
        this.menu.addMenuItem(this._devices.wired.section);

        this._devices.wireless = {
            section: new PopupMenu.PopupMenuSection(),
            devices: [ ],
            item: this._makeToggleItem('wireless', _("Wireless"))
        };
        this._devices.wireless.section.addMenuItem(this._devices.wireless.item);
        this._devices.wireless.section.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._devices.wireless.section.actor.hide();
        this.menu.addMenuItem(this._devices.wireless.section);

        this._devices.wwan = {
            section: new PopupMenu.PopupMenuSection(),
            devices: [ ],
            item: this._makeToggleItem('wwan', _("Mobile broadband"))
        };
        this._devices.wwan.section.addMenuItem(this._devices.wwan.item);
        this._devices.wwan.section.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._devices.wwan.section.actor.hide();
        this.menu.addMenuItem(this._devices.wwan.section);

        this._devices.vpn = {
            section: new PopupMenu.PopupMenuSection(),
            device: new NMDeviceVPN(this._client),
            item: new NMWiredSectionTitleMenuItem(_("VPN Connections"))
        };
        this._devices.vpn.device.connect('active-connection-changed', Lang.bind(this, function() {
            this._devices.vpn.item.updateForDevice(this._devices.vpn.device);
        }));
        this._devices.vpn.item.updateForDevice(this._devices.vpn.device);
        this._devices.vpn.section.addMenuItem(this._devices.vpn.item);
        this._devices.vpn.section.addMenuItem(this._devices.vpn.device.section);
        this._devices.vpn.section.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._devices.vpn.section.actor.hide();
        this.menu.addMenuItem(this._devices.vpn.section);

        this.menu.addAction(_("Network Settings"), function() {
            let app = Shell.AppSystem.get_default().get_app('gnome-network-panel.desktop');
            app.activate(-1);
        });

        this._activeConnections = [ ];
        this._connections = [ ];

        this._mainConnection = null;
        this._activeAccessPointUpdateId = 0;
        this._activeAccessPoint = null;
        this._mobileUpdateId = 0;
        this._mobileUpdateDevice = null;

        // Device types
        this._dtypes = { };
        this._dtypes[NetworkManager.DeviceType.ETHERNET] = NMDeviceWired;
        this._dtypes[NetworkManager.DeviceType.WIFI] = NMDeviceWireless;
        this._dtypes[NetworkManager.DeviceType.MODEM] = NMDeviceModem;
        this._dtypes[NetworkManager.DeviceType.BT] = NMDeviceBluetooth;
        // TODO: WiMax support

        // Connection types
        this._ctypes = { };
        this._ctypes[NetworkManager.SETTING_WIRELESS_SETTING_NAME] = NMConnectionCategory.WIRELESS;
        this._ctypes[NetworkManager.SETTING_WIRED_SETTING_NAME] = NMConnectionCategory.WIRED;
        this._ctypes[NetworkManager.SETTING_PPPOE_SETTING_NAME] = NMConnectionCategory.WIRED;
        this._ctypes[NetworkManager.SETTING_PPP_SETTING_NAME] = NMConnectionCategory.WIRED;
        this._ctypes[NetworkManager.SETTING_BLUETOOTH_SETTING_NAME] = NMConnectionCategory.WWAN;
        this._ctypes[NetworkManager.SETTING_CDMA_SETTING_NAME] = NMConnectionCategory.WWAN;
        this._ctypes[NetworkManager.SETTING_GSM_SETTING_NAME] = NMConnectionCategory.WWAN;
        this._ctypes[NetworkManager.SETTING_VPN_SETTING_NAME] = NMConnectionCategory.VPN;

        this._settings = NMClient.RemoteSettings.new(null);
        this._connectionsReadId = this._settings.connect('connections-read', Lang.bind(this, function() {
            this._readConnections();
            this._readDevices();
            this._syncNMState();

            // Connect to signals late so that early signals don't find in inconsistent state
            // and connect only once (this signal handler can be called again if NetworkManager goes up and down)
            if (!this._inited) {
                this._inited = true;
                this._client.connect('notify::manager-running', Lang.bind(this, this._syncNMState));
                this._client.connect('notify::networking-enabled', Lang.bind(this, this._syncNMState));
                this._client.connect('notify::state', Lang.bind(this, this._syncNMState));
                this._client.connect('notify::active-connections', Lang.bind(this, this._updateIcon));
                this._client.connect('device-added', Lang.bind(this, this._deviceAdded));
                this._client.connect('device-removed', Lang.bind(this, this._deviceRemoved));
                this._settings.connect('new-connection', Lang.bind(this, this._newConnection));
            }
        }));
    },

    _ensureSource: function() {
        if (!this._source) {
            this._source = new NMMessageTraySource();
            this._source._destroyId = this._source.connect('destroy', Lang.bind(this, function() {
                this._source._destroyId = 0;
                this._source = null;
            }));
            Main.messageTray.add(this._source);
        }
    },

    _makeToggleItem: function(type, title) {
        let item = new NMWirelessSectionTitleMenuItem(this._client, type, title);
        item.connect('enabled-changed', Lang.bind(this, function(item, enabled) {
            let devices = this._devices[type].devices;
            devices.forEach(function(dev) {
                dev.setEnabled(enabled);
            });
            this._syncSectionTitle(type);
        }));
        return item;
    },

    _syncSectionTitle: function(category) {
        let devices = this._devices[category].devices;
        let managedDevices = devices.filter(function(dev) {
            return dev.device.state != NetworkManager.DeviceState.UNMANAGED;
        });
        let item = this._devices[category].item;
        let section = this._devices[category].section;
        if (managedDevices.length == 0)
            section.actor.hide();
        else {
            section.actor.show();
            if (managedDevices.length == 1) {
                let dev = managedDevices[0];
                dev.statusItem.actor.hide();
                item.updateForDevice(dev);
            } else {
                managedDevices.forEach(function(dev) {
                    dev.statusItem.actor.show();
                });
            }
        }
    },

    _readDevices: function() {
        let devices = this._client.get_devices() || [ ];
        for (let i = 0; i < devices.length; ++i) {
            this._deviceAdded(this._client, devices[i]);
        }
    },

    _deviceAdded: function(client, device) {
        if (device._delegate) {
            // already seen, not adding again
            return;
        }
        let wrapperClass = this._dtypes[device.get_device_type()];
        if (wrapperClass) {
            let wrapper = new wrapperClass(this._client, device, this._connections);

            // FIXME: these notifications are duplicate with those exposed by nm-applet
            // uncomment this code in 3.2, when we'll conflict with and kill nm-applet
            /* wrapper._networkLostId = wrapper.connect('network-lost', Lang.bind(this, function(emitter) {
                this._ensureSource();
                let icon = new St.Icon({ icon_name: 'network-offline',
                                         icon_type: St.IconType.SYMBOLIC,
                                         icon_size: this._source.ICON_SIZE
                                       });
                let notification = new MessageTray.Notification(this._source,
                                                                _("Connectivity lost"),
                                                                _("You're no longer connected to the network"),
                                                                { icon: icon });
                this._source.notify(notification);
            }));
            wrapper._activationFailedId = wrapper.connect('activation-failed', Lang.bind(this, function(wrapper, reason) {
                this._ensureSource();
                let icon = new St.Icon({ icon_name: 'network-error',
                                         icon_type: St.IconType.SYMBOLIC,
                                         icon_size: this._source.ICON_SIZE,
                                       });
                let banner;
                // XXX: nm-applet has no special text depending on reason
                // but I'm not sure of this generic message
                let notification = new MessageTray.Notification(this._source,
                                                                _("Connection failed"),
                                                                _("Activation of network connection failed"),
                                                                { icon: icon });
                this._source.notify(notification);
            })); */
            wrapper._stateChangedId = wrapper.connect('state-changed', Lang.bind(this, function(dev) {
                this._syncSectionTitle(dev.category);
            }));
            wrapper._destroyId = wrapper.connect('destroy', function(wrapper) {
                //wrapper.disconnect(wrapper._networkLostId);
                //wrapper.disconnect(wrapper._activationFailedId);
                wrapper.disconnect(wrapper._stateChangedId);
            });
            let section = this._devices[wrapper.category].section;
            let devices = this._devices[wrapper.category].devices;

            section.addMenuItem(wrapper.section, 1);
            section.addMenuItem(wrapper.statusItem, 1);
            devices.push(wrapper);

            this._syncSectionTitle(wrapper.category);
        } else
            log('Invalid network device type, is ' + device.get_device_type());
    },

    _deviceRemoved: function(client, device) {
        if (!device._delegate) {
            log('Removing a network device that was not added');
            return;
        }

        let wrapper = device._delegate;
        wrapper.destroy();

        let devices = this._devices[wrapper.category].devices;
        let pos = devices.indexOf(wrapper);
        devices.splice(pos, 1);

        this._syncSectionTitle(wrapper.category)
    },

    _syncActiveConnections: function() {
        let closedConnections = [ ];
        let newActiveConnections = this._client.get_active_connections() || [ ];
        for (let i = 0; i < this._activeConnections.length; i++) {
            let a = this._activeConnections[i];
            if (newActiveConnections.indexOf(a) == -1) // connection is removed
                closedConnections.push(a);
        }

        for (let i = 0; i < closedConnections.length; i++) {
            let active = closedConnections[i];
            if (active._primaryDevice)
                active._primaryDevice.setActiveConnection(null);
            if (active._notifyStateId) {
                active.disconnect(active._notifyStateId);
                active._notifyStateId = 0;
            }
            if (active._inited) {
                active.disconnect(active._notifyDefaultId);
                active.disconnect(active._notifyDefault6Id);
                active._inited = false;
            }
        }

        this._activeConnections = newActiveConnections;
        this._mainConnection = null;
        let activating = null;
        let default_ip4 = null;
        let default_ip6 = null;
        for (let i = 0; i < this._activeConnections.length; i++) {
            let a = this._activeConnections[i];

            if (!a._inited) {
                a._notifyDefaultId = a.connect('notify::default', Lang.bind(this, this._updateIcon));
                a._notifyDefault6Id = a.connect('notify::default6', Lang.bind(this, this._updateIcon));
                if (a.state == NetworkManager.ActiveConnectionState.ACTIVATING) // prepare to notify to the user
                    a._notifyStateId = a.connect('notify::state', Lang.bind(this, this._notifyActiveConnection));
                else {
                    // notify as soon as possible
                    Mainloop.idle_add(Lang.bind(this, function() {
                        this._notifyActiveConnection(a);
                    }));
                }

                a._inited = true;
            }

            if (!a._connection) {
                a._connection = this._settings.get_connection_by_path(a.connection);

                if (a._connection) {
                    a._type = a._connection._type;
                    a._section = this._ctypes[a._type];
                } else {
                    a._connection = null;
                    a._type = null;
                    a._section = null;
                    log('Cannot find connection for active (or connection cannot be read)');
                }
            }

            if (a['default'])
                default_ip4 = a;
            if (a.default6)
                default_ip6 = a;

            if (a.state == NetworkManager.ActiveConnectionState.ACTIVATING)
                activating = a;

            if (!a._primaryDevice) {
                if (a._type != NetworkManager.SETTING_VPN_SETTING_NAME) {
                    // find a good device to be considered primary
                    a._primaryDevice = null;
                    let devices = a.get_devices();
                    for (let j = 0; j < devices.length; j++) {
                        let d = devices[j];
                        if (d._delegate) {
                            a._primaryDevice = d._delegate;
                            break;
                        }
                    }
                } else
                    a._primaryDevice = this._devices.vpn.device

                if (a._primaryDevice)
                    a._primaryDevice.setActiveConnection(a);
            }
        }

        this._mainConnection = activating || default_ip4 || default_ip6 || this._activeConnections[0] || null;
    },

    _notifyActiveConnection: function(active) {
        // FIXME: duplicate notifications when nm-applet is running
        // This code will come back when nm-applet is killed
        this._syncNMState();
        return;

        if (active.state == NetworkManager.ActiveConnectionState.ACTIVATED) {

            // notify only connections that are visible
            if (active._connection) {
                this._ensureSource();

                let icon;
                let banner;
                switch (active._section) {
                case NMConnectionCategory.WWAN:
                    icon = 'network-cellular-signal-excellent';
                    banner = _("You're now connected to mobile broadband connection '%s'").format(active._connection._name);
                    break;
                case NMConnectionCategory.WIRELESS:
                    icon = 'network-wireless-signal-excellent';
                    banner = _("You're now connected to wireless network '%s'").format(active._connection._name);
                    break;
                case NMConnectionCategory.WIRED:
                    icon = 'network-wired';
                    banner = _("You're now connected to wired network '%s'").format(active._connection._name);
                    break;
                case NMConnectionCategory.VPN:
                    icon = 'network-vpn';
                    banner = _("You're now connected to VPN network '%s'").format(active._connection._name);
                    break;
                default:
                    // a fallback for a generic 'connected' icon
                    icon = 'network-transmit-receive';
                    banner = _("You're now connected to '%s'").format(active._connection._name);
                }

                let iconActor = new St.Icon({ icon_name: icon,
                                              icon_type: St.IconType.SYMBOLIC,
                                              icon_size: this._source.ICON_SIZE
                                            });
                let notification = new MessageTray.Notification(this._source,
                                                                _("Connection established"),
                                                                banner,
                                                                { icon: iconActor });
                this._source.notify(notification);
            }

            if (active._stateChangeId) {
                active.disconnect(active._stateChangeId);
                active._stateChangeId = 0;
            }
        }

        this._syncNMState();
    },

    _readConnections: function() {
        let connections = this._settings.list_connections();
        for (let i = 0; i < connections.length; i++) {
            let connection = connections[i];
            if (connection._uuid) {
                // connection was already seen (for example because NetworkManager was restarted)
                continue;
            }
            connection._removedId = connection.connect('removed', Lang.bind(this, this._connectionRemoved));
            connection._updatedId = connection.connect('updated', Lang.bind(this, this._updateConnection));

            this._updateConnection(connection);
            this._connections.push(connection);
        }
    },

    _newConnection: function(settings, connection) {
        if (connection._uuid) {
            // connection was already seen
            return;
        }

        connection._removedId = connection.connect('removed', Lang.bind(this, this._connectionRemoved));
        connection._updatedId = connection.connect('updated', Lang.bind(this, this._updateConnection));

        this._updateConnection(connection);
        this._connections.push(connection);

        this._updateIcon();
    },

    _connectionRemoved: function(connection) {
        let pos = this._connections.indexOf(connection);
        if (pos != -1)
            this._connections.splice(connection);

        let section = connection._section;
        if (section == NMConnectionCategory.VPN) {
            this._devices.vpn.device.removeConnection(connection);
            if (this._devices.vpn.device.empty)
                this._devices.vpn.section.actor.hide();
        } else {
            let devices = this._devices[section].devices;
            for (let i = 0; i < devices.length; i++)
                devices[i].removeConnection(connection);
        }

        connection._uuid = null;
        connection.disconnect(connection._removedId);
        connection.disconnect(connection._updatedId);
    },

    _updateConnection: function(connection) {
        let connectionSettings = connection.get_setting_by_name(NetworkManager.SETTING_CONNECTION_SETTING_NAME);
        connection._type = connectionSettings.type;
        connection._section = this._ctypes[connection._type];
        connection._name = connectionSettings.id;
        connection._uuid = connectionSettings.uuid;
        connection._timestamp = connectionSettings.timestamp;

        let section = connection._section;
        if (section == NMConnectionCategory.VPN) {
            this._devices.vpn.device.checkConnection(connection);
            this._devices.vpn.section.actor.show();
            connection._everAdded = true;
        } else {
            let devices = this._devices[section].devices;
            for (let i = 0; i < devices.length; i++) {
                devices[i].checkConnection(connection);
            }
        }
    },

    _hideDevices: function() {
        this._devicesHidden = true;

        for (let category in this._devices)
            this._devices[category].section.actor.hide();
    },

    _showNormal: function() {
        if (!this._devicesHidden) // nothing to do
            return;
        this._devicesHidden = false;

        this._statusSection.actor.hide();

        this._syncSectionTitle('wired');
        this._syncSectionTitle('wireless');
        this._syncSectionTitle('wwan');

        if (!this._devices.vpn.device.empty)
            this._devices.vpn.section.actor.show();
    },

    _syncNMState: function() {
        if (!this._client.manager_running) {
            log('NetworkManager is not running, hiding...');
            this.menu.close();
            this.actor.hide();
            return;
        } else
            this.actor.show();

        if (!this._client.networking_enabled) {
            this.setIcon('network-offline');
            this._hideDevices();
            this._statusItem.label.text = _("Networking is disabled");
            this._statusSection.actor.show();
            return;
        }

        this._showNormal();
        this._updateIcon();
    },

    _updateIcon: function() {
        this._syncActiveConnections();
        let mc = this._mainConnection;
        let hasApIcon = false;
        let hasMobileIcon = false;

        if (!mc) {
            this.setIcon('network-offline');
        } else if (mc.state == NetworkManager.ActiveConnectionState.ACTIVATING) {
            switch (mc._section) {
            case NMConnectionCategory.WWAN:
                this.setIcon('network-cellular-acquiring');
                break;
            case NMConnectionCategory.WIRELESS:
                this.setIcon('network-wireless-acquiring');
                break;
            case NMConnectionCategory.WIRED:
                this.setIcon('network-wired-acquiring');
                break;
            case NMConnectionCategory.VPN:
                this.setIcon('network-vpn-acquiring');
                break;
            default:
                // fallback to a generic connected icon
                // (it could be a private connection of some other user)
                this.setIcon('network-wired-acquiring');
            }
        } else {
            let dev;
            switch (mc._section) {
            case NMConnectionCategory.WIRELESS:
                dev = mc._primaryDevice;
                if (dev) {
                    let ap = dev.device.active_access_point;
                    let mode = dev.device.mode;
                    if (!ap) {
                        if (mode != NetworkManager['80211Mode'].ADHOC) {
                            log('An active wireless connection, in infrastructure mode, involves no access point?');
                            break;
                        }
                        this.setIcon('network-wireless-connected');
                    } else {
                        if (this._accessPointUpdateId && this._activeAccessPoint != ap) {
                            this._activeAccessPoint.disconnect(this._accessPointUpdateId);
                            this._activeAccessPoint = ap;
                            this._activeAccessPointUpdateId = ap.connect('notify::strength', Lang.bind(function() {
                                this.setIcon('network-wireless-signal-' + signalToIcon(ap.strength));
                            }));
                        }
                        this.setIcon('network-wireless-signal-' + signalToIcon(ap.strength));
                        hasApIcon = true;
                    }
                    break;
                } else {
                    log('Active connection with no primary device?');
                    break;
                }
            case NMConnectionCategory.WIRED:
                this.setIcon('network-wired');
                break;
            case NMConnectionCategory.WWAN:
                dev = mc._primaryDevice;
                if (!dev) {
                    log('Active connection with no primary device?');
                    break;
                }
                if (!dev.mobileDevice) {
                    // this can happen for bluetooth in PAN mode
                    this.setIcon('network-cellular-connected');
                    break;
                }

                if (this._mobileUpdateId && this._mobileUpdateDevice != dev) {
                    this._mobileUpdateDevice.disconnect(this._mobileUpdateId);
                    this._mobileUpdateDevice = dev.mobileDevice;
                    this._mobileUpdateId = dev.mobileDevice.connect('notify::signal-quality', Lang.bind(this, function() {
                        this.setIcon('network-cellular-signal-' + signalToIcon(dev.mobileDevice.signal_quality));
                    }));
                }
                this.setIcon('network-cellular-signal-' + signalToIcon(dev.mobileDevice.signal_quality));
                hasMobileIcon = true;
                break;
            case NMConnectionCategory.VPN:
                this.setIcon('network-vpn');
                break;
            default:
                // fallback to a generic connected icon
                // (it could be a private connection of some other user)
                this.setIcon('network-wired');
                break;
            }
        }

        // cleanup stale signal connections

        if (!hasApIcon && this._activeAccessPointUpdateId) {
            this._activeAccessPoint.disconnect(this._activeAccessPointUpdateId);
            this._activeAccessPoint = null;
            this._activeAccessPointUpdateId = 0;
        }
        if (!hasMobileIcon && this._mobileUpdateId) {
            this._mobileUpdateDevice.disconnect(this._mobileUpdateId);
            this._mobileUpdateDevice = null;
            this._mobileUpdateId = 0;
        }
    }
};

function NMMessageTraySource() {
    this._init();
}

NMMessageTraySource.prototype = {
    __proto__: MessageTray.Source.prototype,

    _init: function() {
        MessageTray.Source.prototype._init.call(this, _("Network Manager"));

        let icon = new St.Icon({ icon_name: 'network-transmit-receive',
                                 icon_type: St.IconType.SYMBOLIC,
                                 icon_size: this.ICON_SIZE
                               });
        this._setSummaryIcon(icon);
    }
};

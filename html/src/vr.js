// Copyright(c) 2019-2021 pypy and individual contributors.
// All rights reserved.
//
// This work is licensed under the terms of the MIT license.
// For a copy, see <https://opensource.org/licenses/MIT>.

import Noty from 'noty';
import Vue from 'vue';
import ElementUI from 'element-ui';
import locale from 'element-ui/lib/locale/lang/en';

import {appVersion} from './constants.js';
import sharedRepository from './repository/shared.js';
import configRepository from './repository/config.js';

speechSynthesis.getVoices();

(async function() {
    var $app = null;

    await CefSharp.BindObjectAsync(
        'AppApi',
        'WebApi',
        'SharedVariable',
        'SQLite'
    );

    await configRepository.init();

    Noty.overrideDefaults({
        animation: {
            open: 'animate__animated animate__fadeIn',
            close: 'animate__animated animate__zoomOut'
        },
        layout: 'topCenter',
        theme: 'relax',
        timeout: 3000
    });

    Vue.use(ElementUI, {
        locale
    });

    var escapeTag = (s) =>
        String(s).replace(/["&'<>]/gu, (c) => `&#${c.charCodeAt(0)};`);
    Vue.filter('escapeTag', escapeTag);

    var commaNumber = (n) =>
        String(Number(n) || 0).replace(/(\d)(?=(\d{3})+(?!\d))/gu, '$1,');
    Vue.filter('commaNumber', commaNumber);

    var formatDate = (s, format) => {
        var dt = new Date(s);
        if (isNaN(dt)) {
            return escapeTag(s);
        }
        var hours = dt.getHours();
        var map = {
            YYYY: String(10000 + dt.getFullYear()).substr(-4),
            MM: String(101 + dt.getMonth()).substr(-2),
            DD: String(100 + dt.getDate()).substr(-2),
            HH24: String(100 + hours).substr(-2),
            HH: String(100 + (hours > 12 ? hours - 12 : hours)).substr(-2),
            MI: String(100 + dt.getMinutes()).substr(-2),
            SS: String(100 + dt.getSeconds()).substr(-2),
            AMPM: hours >= 12 ? 'PM' : 'AM'
        };
        return format.replace(
            /YYYY|MM|DD|HH24|HH|MI|SS|AMPM/gu,
            (c) => map[c] || c
        );
    };
    Vue.filter('formatDate', formatDate);

    var textToHex = (s) =>
        String(s)
            .split('')
            .map((c) => c.charCodeAt(0).toString(16))
            .join(' ');
    Vue.filter('textToHex', textToHex);

    var timeToText = (t) => {
        var sec = Number(t);
        if (isNaN(sec)) {
            return escapeTag(t);
        }
        sec = Math.floor(sec / 1000);
        var arr = [];
        if (sec < 0) {
            sec = -sec;
        }
        if (sec >= 86400) {
            arr.push(`${Math.floor(sec / 86400)}d`);
            sec %= 86400;
        }
        if (sec >= 3600) {
            arr.push(`${Math.floor(sec / 3600)}h`);
            sec %= 3600;
        }
        if (sec >= 60) {
            arr.push(`${Math.floor(sec / 60)}m`);
            sec %= 60;
        }
        if (sec || !arr.length) {
            arr.push(`${sec}s`);
        }
        return arr.join(' ');
    };
    Vue.filter('timeToText', timeToText);

    //
    // API
    //

    var API = {};

    API.eventHandlers = new Map();

    API.$emit = function(name, ...args) {
        // console.log(name, ...args);
        var handlers = this.eventHandlers.get(name);
        if (typeof handlers === 'undefined') {
            return;
        }
        try {
            for (var handler of handlers) {
                handler.apply(this, args);
            }
        } catch (err) {
            console.error(err);
        }
    };

    API.$on = function(name, handler) {
        var handlers = this.eventHandlers.get(name);
        if (typeof handlers === 'undefined') {
            handlers = [];
            this.eventHandlers.set(name, handlers);
        }
        handlers.push(handler);
    };

    API.$off = function(name, handler) {
        var handlers = this.eventHandlers.get(name);
        if (typeof handlers === 'undefined') {
            return;
        }
        var {length} = handlers;
        for (var i = 0; i < length; ++i) {
            if (handlers[i] === handler) {
                if (length > 1) {
                    handlers.splice(i, 1);
                } else {
                    this.eventHandlers.delete(name);
                }
                break;
            }
        }
    };

    API.pendingGetRequests = new Map();

    API.call = function(endpoint, options) {
        var init = {
            url: `https://api.vrchat.cloud/api/1/${endpoint}`,
            method: 'GET',
            ...options
        };
        var {params} = init;
        var isGetRequest = init.method === 'GET';
        if (isGetRequest === true) {
            // transform body to url
            if (params === Object(params)) {
                var url = new URL(init.url);
                var {searchParams} = url;
                for (var key in params) {
                    searchParams.set(key, params[key]);
                }
                init.url = url.toString();
            }
            // merge requests
            var req = this.pendingGetRequests.get(init.url);
            if (typeof req !== 'undefined') {
                return req;
            }
        } else {
            init.headers = {
                'Content-Type': 'application/json;charset=utf-8',
                ...init.headers
            };
            init.body =
                params === Object(params) ? JSON.stringify(params) : '{}';
        }
        init.headers = {
            'User-Agent': appVersion,
            ...init.headers
        };
        var req = webApiService
            .execute(init)
            .catch((err) => {
                this.$throw(0, err);
            })
            .then((response) => {
                try {
                    response.data = JSON.parse(response.data);
                    return response;
                } catch (e) {}
                if (response.status === 200) {
                    this.$throw(0, 'Invalid JSON response');
                }
                this.$throw(response.status);
                return {};
            })
            .then(({data, status}) => {
                if (data === Object(data)) {
                    if (status === 200) {
                        if (data.success === Object(data.success)) {
                            new Noty({
                                type: 'success',
                                text: escapeTag(data.success.message)
                            }).show();
                        }
                        return data;
                    }
                    if (data.error === Object(data.error)) {
                        this.$throw(
                            data.error.status_code || status,
                            data.error.message,
                            data.error.data
                        );
                    } else if (typeof data.error === 'string') {
                        this.$throw(data.status_code || status, data.error);
                    }
                }
                this.$throw(status, data);
                return data;
            });
        if (isGetRequest === true) {
            req.finally(() => {
                this.pendingGetRequests.delete(init.url);
            });
            this.pendingGetRequests.set(init.url, req);
        }
        return req;
    };

    API.statusCodes = {
        100: 'Continue',
        101: 'Switching Protocols',
        102: 'Processing',
        103: 'Early Hints',
        200: 'OK',
        201: 'Created',
        202: 'Accepted',
        203: 'Non-Authoritative Information',
        204: 'No Content',
        205: 'Reset Content',
        206: 'Partial Content',
        207: 'Multi-Status',
        208: 'Already Reported',
        226: 'IM Used',
        300: 'Multiple Choices',
        301: 'Moved Permanently',
        302: 'Found',
        303: 'See Other',
        304: 'Not Modified',
        305: 'Use Proxy',
        306: 'Switch Proxy',
        307: 'Temporary Redirect',
        308: 'Permanent Redirect',
        400: 'Bad Request',
        401: 'Unauthorized',
        402: 'Payment Required',
        403: 'Forbidden',
        404: 'Not Found',
        405: 'Method Not Allowed',
        406: 'Not Acceptable',
        407: 'Proxy Authentication Required',
        408: 'Request Timeout',
        409: 'Conflict',
        410: 'Gone',
        411: 'Length Required',
        412: 'Precondition Failed',
        413: 'Payload Too Large',
        414: 'URI Too Long',
        415: 'Unsupported Media Type',
        416: 'Range Not Satisfiable',
        417: 'Expectation Failed',
        418: "I'm a teapot",
        421: 'Misdirected Request',
        422: 'Unprocessable Entity',
        423: 'Locked',
        424: 'Failed Dependency',
        425: 'Too Early',
        426: 'Upgrade Required',
        428: 'Precondition Required',
        429: 'Too Many Requests',
        431: 'Request Header Fields Too Large',
        451: 'Unavailable For Legal Reasons',
        500: 'Internal Server Error',
        501: 'Not Implemented',
        502: 'Bad Gateway',
        503: 'Service Unavailable',
        504: 'Gateway Timeout',
        505: 'HTTP Version Not Supported',
        506: 'Variant Also Negotiates',
        507: 'Insufficient Storage',
        508: 'Loop Detected',
        510: 'Not Extended',
        511: 'Network Authentication Required',
        // CloudFlare Error
        520: 'Web server returns an unknown error',
        521: 'Web server is down',
        522: 'Connection timed out',
        523: 'Origin is unreachable',
        524: 'A timeout occurred',
        525: 'SSL handshake failed',
        526: 'Invalid SSL certificate',
        527: 'Railgun Listener to origin error'
    };

    API.$throw = function(code, error) {
        var text = [];
        if (code > 0) {
            var status = this.statusCodes[code];
            if (typeof status === 'undefined') {
                text.push(`${code}`);
            } else {
                text.push(`${code} ${status}`);
            }
        }
        if (typeof error !== 'undefined') {
            text.push(JSON.stringify(error));
        }
        text = text.map((s) => escapeTag(s)).join('<br>');
        if (text.length) {
            new Noty({
                type: 'error',
                text
            }).show();
        }
        throw new Error(text);
    };

    // API: Config

    API.cachedConfig = {};

    API.$on('CONFIG', function(args) {
        args.ref = this.applyConfig(args.json);
    });

    API.applyConfig = function(json) {
        var ref = {
            clientApiKey: '',
            ...json
        };
        this.cachedConfig = ref;
        return ref;
    };

    API.getConfig = function() {
        return this.call('config', {
            method: 'GET'
        }).then((json) => {
            var args = {
                ref: null,
                json
            };
            this.$emit('CONFIG', args);
            return args;
        });
    };

    // API: Location

    API.parseLocation = function(tag) {
        tag = String(tag || '');
        var ctx = {
            tag,
            isOffline: false,
            isPrivate: false,
            worldId: '',
            instanceId: '',
            instanceName: '',
            accessType: '',
            userId: null,
            hiddenId: null,
            privateId: null,
            friendsId: null,
            canRequestInvite: false
        };
        if (tag === 'offline') {
            ctx.isOffline = true;
        } else if (tag === 'private') {
            ctx.isPrivate = true;
        } else if (tag.startsWith('local') === false) {
            var sep = tag.indexOf(':');
            if (sep >= 0) {
                ctx.worldId = tag.substr(0, sep);
                ctx.instanceId = tag.substr(sep + 1);
                ctx.instanceId.split('~').forEach((s, i) => {
                    if (i) {
                        var A = s.indexOf('(');
                        var Z = A >= 0 ? s.lastIndexOf(')') : -1;
                        var key = Z >= 0 ? s.substr(0, A) : s;
                        var value = A < Z ? s.substr(A + 1, Z - A - 1) : '';
                        if (key === 'hidden') {
                            ctx.hiddenId = value;
                        } else if (key === 'private') {
                            ctx.privateId = value;
                        } else if (key === 'friends') {
                            ctx.friendsId = value;
                        } else if (key === 'canRequestInvite') {
                            ctx.canRequestInvite = true;
                        }
                    } else {
                        ctx.instanceName = s;
                    }
                });
                ctx.accessType = 'public';
                if (ctx.privateId !== null) {
                    if (ctx.canRequestInvite) {
                        // InvitePlus
                        ctx.accessType = 'invite+';
                    } else {
                        // InviteOnly
                        ctx.accessType = 'invite';
                    }
                    ctx.userId = ctx.privateId;
                } else if (ctx.friendsId !== null) {
                    // FriendsOnly
                    ctx.accessType = 'friends';
                    ctx.userId = ctx.friendsId;
                } else if (ctx.hiddenId !== null) {
                    // FriendsOfGuests
                    ctx.accessType = 'friends+';
                    ctx.userId = ctx.hiddenId;
                }
            } else {
                ctx.worldId = tag;
            }
        }
        return ctx;
    };

    Vue.component('location', {
        template: '<span>{{ text }}<slot></slot></span>',
        props: {
            location: String,
            hint: {
                type: String,
                default: ''
            }
        },
        data() {
            return {
                text: this.location
            };
        },
        methods: {
            parse() {
                var L = API.parseLocation(this.location);
                if (L.isOffline) {
                    this.text = 'Offline';
                } else if (L.isPrivate) {
                    this.text = 'Private';
                } else if (typeof this.hint === 'string' && this.hint !== '') {
                    if (L.instanceId) {
                        this.text = `${this.hint} #${L.instanceName} ${L.accessType}`;
                    } else {
                        this.text = this.hint;
                    }
                } else if (L.worldId) {
                    var ref = API.cachedWorlds.get(L.worldId);
                    if (typeof ref === 'undefined') {
                        API.getWorld({
                            worldId: L.worldId
                        }).then((args) => {
                            if (L.tag === this.location) {
                                if (L.instanceId) {
                                    this.text = `${args.json.name} #${L.instanceName} ${L.accessType}`;
                                } else {
                                    this.text = args.json.name;
                                }
                            }
                            return args;
                        });
                    } else if (L.instanceId) {
                        this.text = `${ref.name} #${L.instanceName} ${L.accessType}`;
                    } else {
                        this.text = ref.name;
                    }
                }
            }
        },
        watch: {
            location() {
                this.parse();
            }
        },
        created() {
            this.parse();
        }
    });

    // API: World

    API.cachedWorlds = new Map();

    API.$on('WORLD', function(args) {
        args.ref = this.applyWorld(args.json);
    });

    API.applyWorld = function(json) {
        var ref = this.cachedWorlds.get(json.id);
        if (typeof ref === 'undefined') {
            ref = {
                id: '',
                name: '',
                description: '',
                authorId: '',
                authorName: '',
                capacity: 0,
                tags: [],
                releaseStatus: '',
                imageUrl: '',
                thumbnailImageUrl: '',
                assetUrl: '',
                assetUrlObject: {},
                pluginUrl: '',
                pluginUrlObject: {},
                unityPackageUrl: '',
                unityPackageUrlObject: {},
                unityPackages: [],
                version: 0,
                favorites: 0,
                created_at: '',
                updated_at: '',
                publicationDate: '',
                labsPublicationDate: '',
                visits: 0,
                popularity: 0,
                heat: 0,
                publicOccupants: 0,
                privateOccupants: 0,
                occupants: 0,
                instances: [],
                // VRCX
                $isLabs: false,
                //
                ...json
            };
            this.cachedWorlds.set(ref.id, ref);
        } else {
            Object.assign(ref, json);
        }
        ref.$isLabs = ref.tags.includes('system_labs');
        return ref;
    };

    /*
        params: {
            worldId: string
        }
    */
    API.getWorld = function(params) {
        return this.call(`worlds/${params.worldId}`, {
            method: 'GET'
        }).then((json) => {
            var args = {
                ref: null,
                json,
                params
            };
            this.$emit('WORLD', args);
            return args;
        });
    };

    // API: User

    API.cachedUsers = new Map();

    API.$on('USER', function(args) {
        args.ref = this.applyUser(args.json);
    });

    API.applyUser = function(json) {
        var ref = this.cachedUsers.get(json.id);
        if (typeof ref === 'undefined') {
            ref = {
                id: '',
                username: '',
                displayName: '',
                userIcon: '',
                bio: '',
                bioLinks: [],
                currentAvatarImageUrl: '',
                currentAvatarThumbnailImageUrl: '',
                status: '',
                statusDescription: '',
                state: '',
                tags: [],
                developerType: '',
                last_login: '',
                last_platform: '',
                allowAvatarCopying: false,
                isFriend: false,
                location: '',
                worldId: '',
                instanceId: '',
                // VRCX
                ...json
            };
            this.cachedUsers.set(ref.id, ref);
        } else {
            var props = {};
            for (var prop in ref) {
                if (ref[prop] !== Object(ref[prop])) {
                    props[prop] = true;
                }
            }
            var $ref = {...ref};
            Object.assign(ref, json);
            for (var prop in ref) {
                if (ref[prop] !== Object(ref[prop])) {
                    props[prop] = true;
                }
            }
            for (var prop in props) {
                var asis = $ref[prop];
                var tobe = ref[prop];
                if (asis === tobe) {
                    delete props[prop];
                } else {
                    props[prop] = [tobe, asis];
                }
            }
        }
        return ref;
    };

    /*
        params: {
            userId: string
        }
    */
    API.getUser = function(params) {
        return this.call(`users/${params.userId}`, {
            method: 'GET'
        }).then((json) => {
            var args = {
                json,
                params
            };
            this.$emit('USER', args);
            return args;
        });
    };

    /*
        params: {
            userId: string
        }
    */
    API.getCachedUser = function(params) {
        return new Promise((resolve, reject) => {
            var ref = this.cachedUsers.get(params.userId);
            if (typeof ref === 'undefined') {
                this.getUser(params)
                    .catch(reject)
                    .then(resolve);
            } else {
                resolve({
                    cache: true,
                    json: ref,
                    params,
                    ref
                });
            }
        });
    };

    var $app = {
        data: {
            API,
            // 1 = 대시보드랑 손목에 보이는거
            // 2 = 항상 화면에 보이는 거
            appType: location.href.substr(-1),
            currentTime: new Date().toJSON(),
            currentUserStatus: null,
            cpuUsage: 0,
            config: {},
            isGameRunning: false,
            isGameNoVR: false,
            lastLocation: {
                date: 0,
                location: '',
                name: '',
                playerList: [],
                friendList: []
            },
            lastLocationTimer: '',
            wristFeedLastEntry: '',
            notyFeedLastEntry: '',
            wristFeed: [],
            notyMap: [],
            devices: []
        },
        computed: {},
        methods: {},
        watch: {},
        el: '#x-app',
        mounted() {
            // https://media.discordapp.net/attachments/581757976625283083/611170278218924033/unknown.png
            // 현재 날짜 시간
            // 컨트롤러 배터리 상황
            // --
            // OO is in Let's Just H!!!!! [GPS]
            // OO has logged in [Online] -> TODO: location
            // OO has logged out [Offline] -> TODO: location
            // OO has joined [OnPlayerJoined]
            // OO has left [OnPlayerLeft]
            // [Moderation]
            // OO has blocked you
            // OO has muted you
            // OO has hidden you
            // --
            API.getConfig()
                .catch((err) => {
                    // FIXME: 어케 복구하냐 이건
                    throw err;
                })
                .then((args) => {
                    if (this.appType === '1') {
                        this.updateCpuUsageLoop();
                    }
                    this.initLoop();
                    return args;
                });
        }
    };

    $app.methods.updateVRConfigVars = function() {
        this.currentUserStatus = sharedRepository.getString(
            'current_user_status'
        );
        this.isGameRunning = sharedRepository.getBool('is_game_running');
        this.isGameNoVR = sharedRepository.getBool('is_Game_No_VR');
        var lastLocation = sharedRepository.getObject('last_location');
        if (lastLocation) {
            this.lastLocation = lastLocation;
            if (this.lastLocation.date !== 0) {
                this.lastLocationTimer = timeToText(
                    Date.now() - this.lastLocation.date
                );
            } else {
                this.lastLocationTimer = '';
            }
        }
        var newConfig = sharedRepository.getObject('VRConfigVars');
        if (newConfig) {
            if (JSON.stringify(newConfig) !== JSON.stringify(this.config)) {
                this.config = newConfig;
                this.notyFeedLastEntry = '';
                this.wristFeedLastEntry = '';
                if (this.appType === '2') {
                    this.initNotyMap();
                }
            }
        } else {
            throw 'config not set';
        }
    };

    $app.methods.initNotyMap = function() {
        var notyFeed = sharedRepository.getArray('notyFeed');
        if (notyFeed === null) {
            return;
        }
        notyFeed.forEach((feed) => {
            var displayName = '';
            if (feed.displayName) {
                displayName = feed.displayName;
            } else if (feed.senderUsername) {
                displayName = feed.senderUsername;
            } else if (feed.sourceDisplayName) {
                displayName = feed.sourceDisplayName;
            } else if (feed.data) {
                displayName = feed.data;
            } else {
                console.error('missing displayName');
            }
            if (
                (displayName && !this.notyMap[displayName]) ||
                this.notyMap[displayName] < feed.created_at
            ) {
                this.notyMap[displayName] = feed.created_at;
            }
        });
    };

    $app.methods.initLoop = async function() {
        if (!sharedRepository.getBool('VRInit')) {
            setTimeout(this.initLoop, 500);
        } else {
            this.updateLoop();
        }
    };

    $app.methods.updateLoop = async function() {
        try {
            this.currentTime = new Date().toJSON();
            await this.updateVRConfigVars();
            if (!this.config.hideDevicesFromFeed && this.appType === '1') {
                AppApi.GetVRDevices().then((devices) => {
                    devices.forEach((device) => {
                        device[2] = parseInt(device[2], 10);
                    });
                    this.devices = devices;
                });
            } else {
                this.devices = '';
            }
            await this.updateSharedFeeds();
        } catch (err) {
            console.error(err);
        }
        setTimeout(() => this.updateLoop(), 500);
    };

    $app.methods.updateCpuUsageLoop = async function() {
        try {
            var cpuUsage = await AppApi.CpuUsage();
            this.cpuUsage = cpuUsage.toFixed(0);
        } catch (err) {
            console.error(err);
        }
        setTimeout(() => this.updateCpuUsageLoop(), 1000);
    };

    $app.methods.updateSharedFeeds = function() {
        if (this.appType === '1') {
            this.wristFeed = sharedRepository.getArray('wristFeed');
        }
        if (this.appType === '2') {
            var notyFeed = sharedRepository.getArray('notyFeed');
            this.updateSharedFeedNoty(notyFeed);
        }
    };

    $app.methods.updateSharedFeedNoty = async function(notyFeed) {
        var notyToPlay = [];
        notyFeed.forEach((feed) => {
            var displayName = '';
            if (feed.displayName) {
                displayName = feed.displayName;
            } else if (feed.senderUsername) {
                displayName = feed.senderUsername;
            } else if (feed.sourceDisplayName) {
                displayName = feed.sourceDisplayName;
            } else if (feed.data) {
                displayName = feed.data;
            } else {
                console.error('missing displayName');
            }
            if (
                (displayName && !this.notyMap[displayName]) ||
                this.notyMap[displayName] < feed.created_at
            ) {
                this.notyMap[displayName] = feed.created_at;
                notyToPlay.push(feed);
            }
        });
        // disable notifications when busy
        if (this.currentUserStatus === 'busy') {
            return;
        }
        var bias = new Date(Date.now() - 60000).toJSON();
        var noty = {};
        var messageList = [
            'inviteMessage',
            'requestMessage',
            'responseMessage'
        ];
        for (var i = 0; i < notyToPlay.length; i++) {
            noty = notyToPlay[i];
            if (noty.created_at < bias) {
                continue;
            }
            var message = '';
            for (i = 0; i < messageList.length; i++) {
                if (
                    typeof noty.details !== 'undefined' &&
                    typeof noty.details[messageList[i]] !== 'undefined'
                ) {
                    message = noty.details[messageList[i]];
                }
            }
            if (
                this.config.overlayNotifications &&
                !this.isGameNoVR &&
                this.isGameRunning
            ) {
                var text = '';
                switch (noty.type) {
                    case 'OnPlayerJoined':
                        text = `<strong>${noty.data}</strong> has joined`;
                        break;
                    case 'OnPlayerLeft':
                        text = `<strong>${noty.data}</strong> has left`;
                        break;
                    case 'OnPlayerJoining':
                        text = `<strong>${noty.displayName}</strong> is joining`;
                        break;
                    case 'GPS':
                        text = `<strong>${
                            noty.displayName
                        }</strong> is in ${await this.displayLocation(
                            noty.location[0]
                        )}`;
                        break;
                    case 'Online':
                        text = `<strong>${noty.displayName}</strong> has logged in`;
                        break;
                    case 'Offline':
                        text = `<strong>${noty.displayName}</strong> has logged out`;
                        break;
                    case 'Status':
                        text = `<strong>${noty.displayName}</strong> status is now <i>${noty.status[0].status}</i> ${noty.status[0].statusDescription}`;
                        break;
                    case 'invite':
                        text = `<strong>${noty.senderUsername}</strong> has invited you to ${noty.details.worldName} ${message}`;
                        break;
                    case 'requestInvite':
                        text = `<strong>${noty.senderUsername}</strong> has requested an invite ${message}`;
                        break;
                    case 'inviteResponse':
                        text = `<strong>${noty.senderUsername}</strong> has responded to your invite ${message}`;
                        break;
                    case 'requestInviteResponse':
                        text = `<strong>${noty.senderUsername}</strong> has responded to your invite request ${message}`;
                        break;
                    case 'friendRequest':
                        text = `<strong>${noty.senderUsername}</strong> has sent you a friend request`;
                        break;
                    case 'Friend':
                        text = `<strong>${noty.displayName}</strong> is now your friend`;
                        break;
                    case 'Unfriend':
                        text = `<strong>${noty.displayName}</strong> is no longer your friend`;
                        break;
                    case 'TrustLevel':
                        text = `<strong>${noty.displayName}</strong> trust level is now ${noty.trustLevel}`;
                        break;
                    case 'DisplayName':
                        text = `<strong>${noty.previousDisplayName}</strong> changed their name to ${noty.displayName}`;
                        break;
                    case 'PortalSpawn':
                        text = `<strong>${noty.data}</strong> has spawned a portal`;
                        break;
                    case 'Event':
                        text = noty.data;
                        break;
                    case 'VideoPlay':
                        text = `<strong>Now playing:</strong> ${noty.data}`;
                        break;
                    case 'BlockedOnPlayerJoined':
                        text = `Blocked user <strong>${noty.displayName}</strong> has joined`;
                        break;
                    case 'BlockedOnPlayerLeft':
                        text = `Blocked user <strong>${noty.displayName}</strong> has left`;
                        break;
                    case 'MutedOnPlayerJoined':
                        text = `Muted user <strong>${noty.displayName}</strong> has joined`;
                        break;
                    case 'MutedOnPlayerLeft':
                        text = `Muted user <strong>${noty.displayName}</strong> has left`;
                        break;
                    default:
                        break;
                }
                if (text) {
                    new Noty({
                        type: 'alert',
                        theme: this.config.notificationTheme,
                        timeout: this.config.notificationTimeout,
                        layout: this.config.notificationPosition,
                        text
                    }).show();
                }
            }
        }
    };

    $app.methods.userStatusClass = function(user) {
        var style = {};
        if (typeof user !== 'undefined') {
            if (user.location === 'offline') {
                // Offline
                style.offline = true;
            } else if (user.state === 'active') {
                // Active
                style.active = true;
            } else if (user.status === 'active') {
                // Online
                style.online = true;
            } else if (user.status === 'join me') {
                // Join Me
                style.joinme = true;
            } else if (user.status === 'ask me') {
                // Ask Me
                style.askme = true;
            } else if (user.status === 'busy') {
                // Do Not Disturb
                style.busy = true;
            }
        }
        return style;
    };

    $app.methods.displayLocation = async function(location) {
        var text = '';
        var L = API.parseLocation(location);
        if (L.isOffline) {
            text = 'Offline';
        } else if (L.isPrivate) {
            text = 'Private';
        } else if (L.worldId) {
            var ref = API.cachedWorlds.get(L.worldId);
            if (typeof ref === 'undefined') {
                await API.getWorld({
                    worldId: L.worldId
                }).then((args) => {
                    if (L.tag === location) {
                        if (L.instanceId) {
                            text = `${args.json.name} ${L.accessType}`;
                        } else {
                            text = args.json.name;
                        }
                    }
                });
            } else if (L.instanceId) {
                text = `${ref.name} ${L.accessType}`;
            } else {
                text = ref.name;
            }
        }
        return text;
    };

    $app.methods.speak = function(text) {
        var tts = new SpeechSynthesisUtterance();
        var voices = speechSynthesis.getVoices();
        var voiceIndex = this.config.notificationTTSVoice;
        tts.voice = voices[voiceIndex];
        tts.text = text;
        speechSynthesis.speak(tts);
    };

    $app = new Vue($app);
    window.$app = $app;
})();

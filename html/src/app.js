// Copyright(c) 2019-2021 pypy and individual contributors.
// All rights reserved.
//
// This work is licensed under the terms of the MIT license.
// For a copy, see <https://opensource.org/licenses/MIT>.

import Noty from 'noty';
import Vue from 'vue';
import VueLazyload from 'vue-lazyload';
import {DataTables} from 'vue-data-tables';
import VSwatches from 'vue-swatches';
import ElementUI from 'element-ui';
import locale from 'element-ui/lib/locale/lang/en';

import {
    nop,
    escapeHtml,
    commaNumber,
    formatDate,
    textToHex,
    timeToText,
    removeFromArray
} from './util';
import * as uuid from './uuid';
import * as pubsub from './pubsub';
import * as api from './api';
import {parseLocation} from './location';

import {appVersion} from './constants.js';
import sharedRepository from './repository/shared';
import configRepository from './repository/config';
import * as gameLogService from './service/gamelog';

// use require()
var ossDialog = require('./vue/oss_dialog');

speechSynthesis.getVoices();

(async function() {
    var $app = null;

    await CefSharp.BindObjectAsync(
        'AppApi',
        'SharedVariable',
        'VRCXStorage',
        'SQLite',
        'LogWatcher',
        'Discord',
        'AssetBundleCacher'
    );

    await configRepository.init();

    document.addEventListener('keyup', function(e) {
        if (e.ctrlKey) {
            if (e.key === 'I') {
                AppApi.ShowDevTools();
            } else if (e.key === 'r') {
                location.reload();
            }
        }
    });

    VRCXStorage.GetArray = function(key) {
        try {
            var array = JSON.parse(VRCXStorage.Get(key));
            if (Array.isArray(array)) {
                return array;
            }
        } catch (err) {
            console.error(err);
        }
        return [];
    };

    VRCXStorage.SetArray = function(key, value) {
        VRCXStorage.Set(key, JSON.stringify(value));
    };

    VRCXStorage.GetObject = function(key) {
        try {
            var object = JSON.parse(VRCXStorage.Get(key));
            if (object === Object(object)) {
                return object;
            }
        } catch (err) {
            console.error(err);
        }
        return {};
    };

    VRCXStorage.SetObject = function(key, value) {
        VRCXStorage.Set(key, JSON.stringify(value));
    };

    setInterval(function() {
        VRCXStorage.Flush();
    }, 5 * 60 * 1000);

    Noty.overrideDefaults({
        animation: {
            open: 'animate__animated animate__bounceInLeft',
            close: 'animate__animated animate__bounceOutLeft'
        },
        layout: 'bottomLeft',
        theme: 'mint',
        timeout: 6000
    });

    Vue.use(ElementUI, {
        locale
    });

    Vue.filter('escapeHtml', escapeHtml);
    Vue.filter('commaNumber', commaNumber);
    Vue.filter('formatDate', formatDate);
    Vue.filter('textToHex', textToHex);
    Vue.filter('timeToText', timeToText);

    Vue.use(VueLazyload, {
        preLoad: 1,
        observer: true,
        observerOptions: {
            rootMargin: '0px',
            threshold: 0.1
        },
        error: './assets/blank.png',
        loading: './assets/blank.png'
    });

    Vue.use(DataTables);

    //
    // API
    //

    var API = {};

    pubsub.subscribe('LOGOUT', function() {
        AppApi.DeleteAllCookies();
    });

    pubsub.subscribe('USER:CURRENT', function(args) {
        var {json} = args;
        api.applyUser({
            id: json.id,
            username: json.username,
            displayName: json.displayName,
            bio: json.bio,
            bioLinks: json.bioLinks,
            currentAvatarImageUrl: json.currentAvatarImageUrl,
            currentAvatarThumbnailImageUrl: json.currentAvatarThumbnailImageUrl,
            status: json.status,
            statusDescription: json.statusDescription,
            state: json.state,
            tags: json.tags,
            developerType: json.developerType,
            last_login: json.last_login,
            last_platform: json.last_platform,
            date_joined: json.date_joined,
            allowAvatarCopying: json.allowAvatarCopying,
            userIcon: json.userIcon,
            fallbackAvatar: json.fallbackAvatar,
            isFriend: false,
            location: $app.lastLocation.location
        });
    });

    pubsub.subscribe('WORLD:DELETE', function(args) {
        var {json} = args;
        if ($app.worldDialog.ref.authorId === json.authorId) {
            var map = new Map();
            for (var ref of api.worldMap.values()) {
                if (ref.authorId === json.authorId) {
                    map.set(ref.id, ref);
                }
            }
            var array = Array.from(map.values());
            $app.sortUserDialogWorlds(array);
        }
    });

    pubsub.subscribe('INSTANCE', function(args) {
        var {json} = args;
        var D = $app.userDialog;
        if (D.ref.location === json.id) {
            D.instance = {
                id: json.id,
                occupants: json.n_users
            };
        }
    });

    pubsub.subscribe('AVATAR:DELETE', function(args) {
        var {json} = args;
        if ($app.userDialog.id === json.authorId) {
            var map = new Map();
            for (var ref of api.avatarMap.values()) {
                if (ref.authorId === json.authorId) {
                    map.set(ref.id, ref);
                }
            }
            var array = Array.from(map.values());
            $app.sortUserDialogAvatars(array);
        }
    });

    // API: WebSocket
    pubsub.subscribe('PIPELINE', function({json}) {
        if ($app.debugWebSocket) {
            var displayName = '';
            if (api.userMap.has(json.content.userId)) {
                var user = api.userMap.get(json.content.userId);
                displayName = user.displayName;
            }
            console.log('WebSocket', json.type, displayName, json.content);
        }
    });

    // API: Visit

    // API

    var extractFileId = (s) => {
        var match = String(s).match(/file_[0-9A-Za-z-]+/);
        return match ? match[0] : '';
    };

    var extractFileVersion = (s) => {
        var match = /(?:\/file_[0-9A-Za-z-]+\/)([0-9]+)/gi.exec(s);
        return match ? match[1] : '';
    };

    var buildTreeData = (json) => {
        var node = [];
        for (var key in json) {
            var value = json[key];
            if (Array.isArray(value)) {
                node.push({
                    children: value.map((val, idx) => {
                        if (val === Object(val)) {
                            return {
                                children: buildTreeData(val),
                                key: idx
                            };
                        }
                        return {
                            key: idx,
                            value: val
                        };
                    }),
                    key
                });
            } else if (value === Object(value)) {
                node.push({
                    children: buildTreeData(value),
                    key
                });
            } else {
                node.push({
                    key,
                    value: String(value)
                });
            }
        }
        node.sort(function(a, b) {
            var A = String(a.key).toUpperCase();
            var B = String(b.key).toUpperCase();
            if (A < B) {
                return -1;
            }
            if (A > B) {
                return 1;
            }
            return 0;
        });
        return node;
    };

    // Misc

    // var $timers = [];

    // Vue.component('timer', {
    //     template: '<span v-text="text"></span>',
    //     props: {
    //         epoch: {
    //             type: Number,
    //             default() {
    //                 return Date.now();
    //             }
    //         }
    //     },
    //     data() {
    //         return {
    //             text: ''
    //         };
    //     },
    //     methods: {
    //         update() {
    //             this.text = timeToText(Date.now() - this.epoch);
    //         }
    //     },
    //     watch: {
    //         date() {
    //             this.update();
    //         }
    //     },
    //     mounted() {
    //         $timers.push(this);
    //         this.update();
    //     },
    //     destroyed() {
    //         removeFromArray($timers, this);
    //     }
    // });

    // setInterval(function() {
    //     for (var $timer of $timers) {
    //         $timer.update();
    //     }
    // }, 5000);

    // initialise

    var $app = {
        components: {
            Location: require('./vue/location').default,
            Launch: require('./vue/launch').default,
            InviteYourself: require('./vue/invite_yourself').default,
            CountdownTimer: require('./vue/countdown_timer').default,
            OssDialog: ossDialog.default,
            VSwatches
        },
        data: {
            api, // BAD
            API,
            nextCurrentUserRefresh: 0,
            nextFriendsRefresh: 0,
            isGameRunning: false,
            isGameNoVR: false,
            appVersion,
            latestAppVersion: '',
            exportFriendsListDialog: false,
            exportFriendsListContent: ''
        },
        computed: {},
        methods: {
            showOssDialog: ossDialog.showDialog
        },
        watch: {},
        el: '#x-app',
        mounted() {
            this.checkAppVersion();
            pubsub.subscribe('SHOW_WORLD_DIALOG', (tag) =>
                this.showWorldDialog(tag)
            );
            pubsub.subscribe('SHOW_LAUNCH_DIALOG', (tag) =>
                this.showLaunchDialog(tag)
            );
            this.updateLoop();
            this.updateGameLogLoop();
            this.$nextTick(async function() {
                this.$el.style.display = '';
                this.loginForm.loading = true;
                try {
                    await api.getConfig();
                    await api.getCurrentUser();
                } catch (err) {
                    console.error(err);
                }
                this.loginForm.loading = false;
            });
        }
    };

    $app.methods.openExternalLink = function(link) {
        this.$confirm(`${link}`, 'Open External Link', {
            confirmButtonText: 'Confirm',
            cancelButtonText: 'Cancel',
            type: 'info',
            callback: (action) => {
                if (action === 'confirm') {
                    AppApi.OpenLink(link);
                }
            }
        });
    };

    $app.methods.languageClass = function(language) {
        var style = {};
        var mapping = api.languageMappings[language];
        if (mapping !== void 0) {
            style[mapping] = true;
        }
        return style;
    };

    $app.methods.checkAppVersion = async function() {
        try {
            var response = await fetch(
                'https://api.github.com/repos/pypy-vrc/VRCX/releases/latest',
                {
                    headers: {
                        'User-Agent': appVersion
                    }
                }
            );
            var json = await response.json();
            if (json === Object(json) && json.name && json.published_at) {
                this.latestAppVersion = `${json.name} (${formatDate(
                    json.published_at,
                    'YYYY-MM-DD HH24:MI:SS'
                )})`;
                if (json.name > this.appVersion) {
                    new Noty({
                        type: 'info',
                        text: `Update available!!<br>${this.latestAppVersion}`,
                        timeout: 60000,
                        callbacks: {
                            onClick: () =>
                                AppApi.OpenLink(
                                    'https://github.com/pypy-vrc/VRCX/releases'
                                )
                        }
                    }).show();
                    this.notifyMenu('settings');
                }
            } else {
                this.latestAppVersion = 'Error occured';
            }
        } catch (err) {
            console.error(err);
            this.latestAppVersion = 'Error occured';
        }
    };

    $app.methods.updateLoop = async function() {
        try {
            if (api.isLoggedIn.value === true) {
                if (--this.nextCurrentUserRefresh <= 0) {
                    this.nextCurrentUserRefresh = 30; // 30secs
                    await api.getCurrentUser();
                }
                if (--this.nextFriendsRefresh <= 0) {
                    this.nextFriendsRefresh = 3600; // 1hour
                    await api.refreshFriends();
                    if (this.isGameRunning === true) {
                        await api.refreshPlayerModerations();
                    }
                }
                var [
                    isGameRunning,
                    isGameNoVR
                ] = await AppApi.CheckGameRunning();
                if (isGameRunning !== this.isGameRunning) {
                    this.isGameRunning = isGameRunning;
                    Discord.SetTimestamps(Date.now(), 0);
                }
                this.isGameNoVR = isGameNoVR;
                this.updateDiscord();
                this.updateOpenVR();
            }
        } catch (err) {
            console.error(err);
        }
        setTimeout(() => this.updateLoop(), 1000);
    };

    $app.data.debug = false;
    $app.data.debugWebRequests = false;
    $app.data.debugWebSocket = false;

    $app.data.APILastOnline = new Map();

    $app.data.sharedFeed = {
        gameLog: {
            wrist: [],
            noty: [],
            lastEntryDate: ''
        },
        feedTable: {
            wrist: [],
            noty: [],
            lastEntryDate: ''
        },
        notificationTable: {
            wrist: [],
            noty: [],
            lastEntryDate: ''
        },
        friendLogTable: {
            wrist: [],
            noty: [],
            lastEntryDate: ''
        },
        pendingUpdate: false
    };

    $app.data.appInit = false;
    $app.data.notyInit = false;

    pubsub.subscribe('LOGIN', function(args) {
        sharedRepository.setArray('wristFeed', []);
        sharedRepository.setArray('notyFeed', []);
        setTimeout(function() {
            $app.appInit = true;
            $app.updateSharedFeed(true);
            $app.notyInit = true;
            sharedRepository.setBool('VRInit', true);
        }, 10000);
    });

    $app.methods.updateSharedFeed = function(forceUpdate) {
        if (!this.appInit) {
            return;
        }
        this.updateSharedFeedGameLog(forceUpdate);
        this.updateSharedFeedFeedTable(forceUpdate);
        this.updateSharedFeedNotificationTable(forceUpdate);
        this.updateSharedFeedFriendLogTable(forceUpdate);
        var feeds = this.sharedFeed;
        if (!feeds.pendingUpdate) {
            return;
        }
        var wristFeed = [];
        wristFeed = wristFeed.concat(
            feeds.gameLog.wrist,
            feeds.feedTable.wrist,
            feeds.notificationTable.wrist,
            feeds.friendLogTable.wrist
        );
        var notyFeed = [];
        notyFeed = notyFeed.concat(
            feeds.gameLog.noty,
            feeds.feedTable.noty,
            feeds.notificationTable.noty,
            feeds.friendLogTable.noty
        );
        // OnPlayerJoining
        var locationBias = Date.now() - 30000; //30 seconds
        if (
            this.isGameRunning &&
            this.lastLocation.date < locationBias &&
            (this.sharedFeedFilters.wrist.OnPlayerJoining === 'Friends' ||
                this.sharedFeedFilters.wrist.OnPlayerJoining === 'VIP' ||
                this.sharedFeedFilters.noty.OnPlayerJoining === 'Friends' ||
                this.sharedFeedFilters.noty.OnPlayerJoining === 'VIP')
        ) {
            var joiningMap = [];
            var bias = new Date(Date.now() - 120000).toJSON(); //2 minutes
            var feedTable = this.feedTable.data;
            for (var i = feedTable.length - 1; i > -1; i--) {
                var ctx = feedTable[i];
                if (ctx.created_at < bias) {
                    break;
                }
                if (
                    ctx.type === 'GPS' &&
                    ctx.location[0] === this.lastLocation.location
                ) {
                    if (joiningMap[ctx.displayName]) {
                        continue;
                    }
                    joiningMap[ctx.displayName] = ctx.created_at;
                    if (api.userMap.has(ctx.userId)) {
                        var user = api.userMap.get(ctx.userId);
                        if (ctx.location[0] !== user.location) {
                            continue;
                        }
                    }
                    var playersInInstance = this.lastLocation.playerList;
                    if (playersInInstance.includes(ctx.displayName)) {
                        continue;
                    }
                    var joining = true;
                    var gameLogTable = this.gameLogTable.data;
                    for (var k = gameLogTable.length - 1; k > -1; k--) {
                        var gameLogItem = gameLogTable[k];
                        if (gameLogItem.type === 'Notification') {
                            continue;
                        }
                        if (
                            gameLogItem.type === 'Location' ||
                            gameLogItem.created_at < bias
                        ) {
                            break;
                        }
                        if (
                            gameLogItem.type === 'OnPlayerJoined' &&
                            gameLogItem.data === ctx.displayName
                        ) {
                            joining = false;
                            break;
                        }
                    }
                    if (joining) {
                        var isFriend = this.friends.has(ctx.userId);
                        var isFavorite = api.favoriteMapByObjectId.has(
                            ctx.userId
                        );
                        var onPlayerJoining = {
                            ...ctx,
                            isFriend,
                            isFavorite,
                            type: 'OnPlayerJoining'
                        };
                        if (
                            this.sharedFeedFilters.wrist.OnPlayerJoining ===
                                'Friends' ||
                            (this.sharedFeedFilters.wrist.OnPlayerJoining ===
                                'VIP' &&
                                isFavorite)
                        ) {
                            wristFeed.unshift(onPlayerJoining);
                        }
                        if (
                            this.sharedFeedFilters.noty.OnPlayerJoining ===
                                'Friends' ||
                            (this.sharedFeedFilters.noty.OnPlayerJoining ===
                                'VIP' &&
                                isFavorite)
                        ) {
                            notyFeed.unshift(onPlayerJoining);
                        }
                    }
                }
            }
        }
        wristFeed.sort(function(a, b) {
            if (a.created_at < b.created_at) {
                return 1;
            }
            if (a.created_at > b.created_at) {
                return -1;
            }
            return 0;
        });
        wristFeed.splice(20);
        notyFeed.sort(function(a, b) {
            if (a.created_at < b.created_at) {
                return 1;
            }
            if (a.created_at > b.created_at) {
                return -1;
            }
            return 0;
        });
        notyFeed.splice(1);
        sharedRepository.setArray('wristFeed', wristFeed);
        sharedRepository.setArray('notyFeed', notyFeed);
        if (this.userDialog.visible) {
            this.applyUserDialogLocation();
        }
        if (this.worldDialog.visible) {
            this.applyWorldDialogInstances();
        }
        this.playNoty(notyFeed);
        feeds.pendingUpdate = false;
    };

    $app.methods.updateSharedFeedGameLog = function(forceUpdate) {
        // Location, OnPlayerJoined, OnPlayerLeft
        var {data} = this.gameLogTable;
        var i = data.length;
        if (i > 0) {
            if (
                data[i - 1].created_at ===
                    this.sharedFeed.gameLog.lastEntryDate &&
                forceUpdate === false
            ) {
                return;
            }
            this.sharedFeed.gameLog.lastEntryDate = data[i - 1].created_at;
        } else {
            return;
        }
        var bias = new Date(Date.now() - 86400000).toJSON(); //24 hours
        var wristArr = [];
        var notyArr = [];
        var w = 0;
        var n = 0;
        var wristFilter = this.sharedFeedFilters.wrist;
        var notyFilter = this.sharedFeedFilters.noty;
        var playerCountIndex = 0;
        var playerList = [];
        var friendList = [];
        var currentUserJoinTime = '';
        var currentUserLeaveTime = '';
        for (var i = data.length - 1; i > -1; i--) {
            var ctx = data[i];
            if (ctx.created_at < bias) {
                break;
            }
            if (ctx.type === 'Notification') {
                continue;
            }
            if (playerCountIndex === 0 && ctx.type === 'Location') {
                playerCountIndex = i;
            }
            // on Location change remove OnPlayerLeft
            if (ctx.type === 'OnPlayerLeft') {
                if (ctx.created_at === currentUserLeaveTime) {
                    continue;
                }
                if (ctx.data === api.currentUser.displayName) {
                    currentUserLeaveTime = ctx.created_at;
                    for (var k = w - 1; k > -1; k--) {
                        var feedItem = wristArr[k];
                        if (
                            feedItem.created_at === currentUserLeaveTime &&
                            feedItem.type === 'OnPlayerLeft'
                        ) {
                            wristArr.splice(k, 1);
                            w--;
                        }
                    }
                    for (var k = n - 1; k > -1; k--) {
                        var feedItem = notyArr[k];
                        if (
                            feedItem.created_at === currentUserLeaveTime &&
                            feedItem.type === 'OnPlayerLeft'
                        ) {
                            notyArr.splice(k, 1);
                            n--;
                        }
                    }
                    continue;
                }
            }
            // on Location change remove OnPlayerJoined
            if (ctx.type === 'OnPlayerJoined') {
                if (ctx.created_at === currentUserJoinTime) {
                    continue;
                }
                if (ctx.data === api.currentUser.displayName) {
                    currentUserJoinTime = ctx.created_at;
                    for (var k = w - 1; k > -1; k--) {
                        var feedItem = wristArr[k];
                        if (
                            feedItem.created_at === currentUserJoinTime &&
                            feedItem.type === 'OnPlayerJoined'
                        ) {
                            wristArr.splice(k, 1);
                            w--;
                        }
                    }
                    for (var k = n - 1; k > -1; k--) {
                        var feedItem = notyArr[k];
                        if (
                            feedItem.created_at === currentUserJoinTime &&
                            feedItem.type === 'OnPlayerJoined'
                        ) {
                            notyArr.splice(k, 1);
                            n--;
                        }
                    }
                    continue;
                }
            }
            // remove current user
            if (
                (ctx.type === 'OnPlayerJoined' ||
                    ctx.type === 'OnPlayerLeft' ||
                    ctx.type === 'PortalSpawn') &&
                ctx.data === api.currentUser.displayName
            ) {
                continue;
            }
            var isFriend = false;
            var isFavorite = false;
            if (
                ctx.type === 'OnPlayerJoined' ||
                ctx.type === 'OnPlayerLeft' ||
                ctx.type === 'PortalSpawn'
            ) {
                for (var ref of api.userMap.values()) {
                    if (ref.displayName === ctx.data) {
                        isFriend = this.friends.has(ref.id);
                        isFavorite = api.favoriteMapByObjectId.has(ref.id);
                        break;
                    }
                }
            }
            //BlockedOnPlayerJoined, BlockedOnPlayerLeft, MutedOnPlayerJoined, MutedOnPlayerLeft
            if (ctx.type === 'OnPlayerJoined' || ctx.type === 'OnPlayerLeft') {
                for (var ref of this.playerModerationTable.data) {
                    if (ref.targetDisplayName === ctx.data) {
                        if (ref.type === 'block') {
                            var type = `Blocked${ctx.type}`;
                        } else if (ref.type === 'mute') {
                            var type = `Muted${ctx.type}`;
                        } else {
                            continue;
                        }
                        var displayName = ref.targetDisplayName;
                        var userId = ref.targetUserId;
                        var created_at = ctx.created_at;
                        if (
                            wristFilter[type] &&
                            (wristFilter[type] === 'Everyone' ||
                                (wristFilter[type] === 'Friends' && isFriend) ||
                                (wristFilter[type] === 'VIP' && isFavorite))
                        ) {
                            wristArr.unshift({
                                created_at,
                                type,
                                displayName,
                                userId,
                                isFriend,
                                isFavorite
                            });
                        }
                        if (
                            notyFilter[type] &&
                            (notyFilter[type] === 'Everyone' ||
                                (notyFilter[type] === 'Friends' && isFriend) ||
                                (notyFilter[type] === 'VIP' && isFavorite))
                        ) {
                            notyArr.unshift({
                                created_at,
                                type,
                                displayName,
                                userId,
                                isFriend,
                                isFavorite
                            });
                        }
                    }
                }
            }
            if (
                w < 20 &&
                wristFilter[ctx.type] &&
                (wristFilter[ctx.type] === 'On' ||
                    wristFilter[ctx.type] === 'Everyone' ||
                    (wristFilter[ctx.type] === 'Friends' && isFriend) ||
                    (wristFilter[ctx.type] === 'VIP' && isFavorite))
            ) {
                wristArr.push({
                    ...ctx,
                    isFriend,
                    isFavorite
                });
                ++w;
            }
            if (
                n < 1 &&
                notyFilter[ctx.type] &&
                (notyFilter[ctx.type] === 'On' ||
                    notyFilter[ctx.type] === 'Everyone' ||
                    (notyFilter[ctx.type] === 'Friends' && isFriend) ||
                    (notyFilter[ctx.type] === 'VIP' && isFavorite))
            ) {
                notyArr.push({
                    ...ctx,
                    isFriend,
                    isFavorite
                });
                ++n;
            }
        }
        // instance player list
        for (var i = playerCountIndex + 1; i < data.length; i++) {
            var ctx = data[i];
            if (ctx.type === 'OnPlayerJoined') {
                playerList.push(ctx.data);
                var isFriend = false;
                for (var ref of api.userMap.values()) {
                    if (ref.displayName === ctx.data) {
                        isFriend = this.friends.has(ref.id);
                        break;
                    }
                }
                if (isFriend) {
                    friendList.push(ctx.data);
                }
            }
            if (ctx.type === 'OnPlayerLeft') {
                var index = playerList.indexOf(ctx.data);
                if (index > -1) {
                    playerList.splice(index, 1);
                }
                var index = friendList.indexOf(ctx.data);
                if (index > -1) {
                    friendList.splice(index, 1);
                }
            }
        }
        if (this.isGameRunning) {
            this.lastLocation.playerList = playerList;
            this.lastLocation.friendList = friendList;
            sharedRepository.setObject('last_location', this.lastLocation);
        }
        this.sharedFeed.gameLog.wrist = wristArr;
        this.sharedFeed.gameLog.noty = notyArr;
        this.sharedFeed.pendingUpdate = true;
    };

    $app.methods.updateSharedFeedFeedTable = function(forceUpdate) {
        // GPS, Online, Offline, Status, Avatar
        var {data} = this.feedTable;
        var i = data.length;
        if (i > 0) {
            if (
                data[i - 1].created_at ===
                    this.sharedFeed.feedTable.lastEntryDate &&
                forceUpdate === false
            ) {
                return;
            }
            this.sharedFeed.feedTable.lastEntryDate = data[i - 1].created_at;
        } else {
            return;
        }
        var bias = new Date(Date.now() - 86400000).toJSON(); //24 hours
        var wristArr = [];
        var notyArr = [];
        var w = 0;
        var n = 0;
        var wristFilter = this.sharedFeedFilters.wrist;
        var notyFilter = this.sharedFeedFilters.noty;
        for (var i = data.length - 1; i > -1; i--) {
            var ctx = data[i];
            if (ctx.created_at < bias) {
                break;
            }
            if (ctx.type === 'Avatar') {
                continue;
            }
            // hide private worlds from feeds
            if (
                this.hidePrivateFromFeed &&
                ctx.type === 'GPS' &&
                ctx.location[0] === 'private'
            ) {
                continue;
            }
            var isFriend = this.friends.has(ctx.userId);
            var isFavorite = api.favoriteMapByObjectId.has(ctx.userId);
            if (
                w < 20 &&
                wristFilter[ctx.type] &&
                (wristFilter[ctx.type] === 'Friends' ||
                    (wristFilter[ctx.type] === 'VIP' && isFavorite))
            ) {
                wristArr.push({
                    ...ctx,
                    isFriend,
                    isFavorite
                });
                ++w;
            }
            if (
                n < 1 &&
                notyFilter[ctx.type] &&
                (notyFilter[ctx.type] === 'Friends' ||
                    (notyFilter[ctx.type] === 'VIP' && isFavorite))
            ) {
                notyArr.push({
                    ...ctx,
                    isFriend,
                    isFavorite
                });
                ++n;
            }
        }
        this.sharedFeed.feedTable.wrist = wristArr;
        this.sharedFeed.feedTable.noty = notyArr;
        this.sharedFeed.pendingUpdate = true;
    };

    $app.methods.updateSharedFeedNotificationTable = function(forceUpdate) {
        // invite, requestInvite, requestInviteResponse, inviteResponse, friendRequest
        var {data} = this.notificationTable;
        var i = data.length;
        if (i > 0) {
            if (
                data[i - 1].created_at ===
                    this.sharedFeed.notificationTable.lastEntryDate &&
                forceUpdate === false
            ) {
                return;
            }
            this.sharedFeed.notificationTable.lastEntryDate =
                data[i - 1].created_at;
        } else {
            return;
        }
        var bias = new Date(Date.now() - 86400000).toJSON(); //24 hours
        var wristArr = [];
        var notyArr = [];
        var w = 0;
        var n = 0;
        var wristFilter = this.sharedFeedFilters.wrist;
        var notyFilter = this.sharedFeedFilters.noty;
        for (var i = data.length - 1; i > -1; i--) {
            var ctx = data[i];
            if (ctx.created_at < bias) {
                break;
            }
            if (ctx.senderUserId === api.currentUser.id) {
                continue;
            }
            var isFriend = this.friends.has(ctx.senderUserId);
            var isFavorite = api.favoriteMapByObjectId.has(ctx.senderUserId);
            if (
                w < 20 &&
                wristFilter[ctx.type] &&
                (wristFilter[ctx.type] === 'On' ||
                    wristFilter[ctx.type] === 'Friends' ||
                    (wristFilter[ctx.type] === 'VIP' && isFavorite))
            ) {
                wristArr.push({
                    ...ctx,
                    isFriend,
                    isFavorite
                });
                ++w;
            }
            if (
                n < 1 &&
                notyFilter[ctx.type] &&
                (notyFilter[ctx.type] === 'On' ||
                    notyFilter[ctx.type] === 'Friends' ||
                    (notyFilter[ctx.type] === 'VIP' && isFavorite))
            ) {
                notyArr.push({
                    ...ctx,
                    isFriend,
                    isFavorite
                });
                ++n;
            }
        }
        this.sharedFeed.notificationTable.wrist = wristArr;
        this.sharedFeed.notificationTable.noty = notyArr;
        this.sharedFeed.pendingUpdate = true;
    };

    $app.methods.updateSharedFeedFriendLogTable = function(forceUpdate) {
        // TrustLevel, Friend, FriendRequest, Unfriend, DisplayName
        var {data} = this.friendLogTable;
        var i = data.length;
        if (i > 0) {
            if (
                data[i - 1].created_at ===
                    this.sharedFeed.friendLogTable.lastEntryDate &&
                forceUpdate === false
            ) {
                return;
            }
            this.sharedFeed.friendLogTable.lastEntryDate =
                data[i - 1].created_at;
        } else {
            return;
        }
        var bias = new Date(Date.now() - 86400000).toJSON(); //24 hours
        var wristArr = [];
        var notyArr = [];
        var w = 0;
        var n = 0;
        var wristFilter = this.sharedFeedFilters.wrist;
        var notyFilter = this.sharedFeedFilters.noty;
        for (var i = data.length - 1; i > -1; i--) {
            var ctx = data[i];
            if (ctx.created_at < bias) {
                break;
            }
            if (ctx.type === 'FriendRequest') {
                continue;
            }
            var isFriend = this.friends.has(ctx.userId);
            var isFavorite = api.favoriteMapByObjectId.has(ctx.userId);
            if (
                w < 20 &&
                wristFilter[ctx.type] &&
                (wristFilter[ctx.type] === 'On' ||
                    wristFilter[ctx.type] === 'Friends' ||
                    (wristFilter[ctx.type] === 'VIP' && isFavorite))
            ) {
                wristArr.push({
                    ...ctx,
                    isFriend,
                    isFavorite
                });
                ++w;
            }
            if (
                n < 1 &&
                notyFilter[ctx.type] &&
                (notyFilter[ctx.type] === 'On' ||
                    notyFilter[ctx.type] === 'Friends' ||
                    (notyFilter[ctx.type] === 'VIP' && isFavorite))
            ) {
                notyArr.push({
                    ...ctx,
                    isFriend,
                    isFavorite
                });
                ++n;
            }
        }
        this.sharedFeed.friendLogTable.wrist = wristArr;
        this.sharedFeed.friendLogTable.noty = notyArr;
        this.sharedFeed.pendingUpdate = true;
    };

    $app.data.notyMap = [];

    $app.methods.playNoty = function(notyFeed) {
        var playNotificationTTS = false;
        if (
            this.notificationTTS === 'Always' ||
            (this.notificationTTS === 'Outside VR' &&
                (this.isGameNoVR || !this.isGameRunning)) ||
            (this.notificationTTS === 'Inside VR' &&
                !this.isGameNoVR &&
                this.isGameRunning) ||
            (this.notificationTTS === 'Game Closed' && !this.isGameRunning) ||
            (this.notificationTTS === 'Desktop Mode' &&
                this.isGameNoVR &&
                this.isGameRunning)
        ) {
            playNotificationTTS = true;
        }
        var playDesktopToast = false;
        if (
            this.desktopToast === 'Always' ||
            (this.desktopToast === 'Outside VR' &&
                (this.isGameNoVR || !this.isGameRunning)) ||
            (this.desktopToast === 'Inside VR' &&
                !this.isGameNoVR &&
                this.isGameRunning) ||
            (this.desktopToast === 'Game Closed' && !this.isGameRunning) ||
            (this.desktopToast === 'Desktop Mode' &&
                this.isGameNoVR &&
                this.isGameRunning)
        ) {
            playDesktopToast = true;
        }
        var playXSNotification = false;
        if (this.xsNotifications && this.isGameRunning && !this.isGameNoVR) {
            playXSNotification = true;
        }
        if (api.currentUserStatus === 'busy' || !this.notyInit) {
            return;
        }
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
            for (var k = 0; k < messageList.length; k++) {
                if (
                    noty.details !== void 0 &&
                    noty.details[messageList[k]] !== void 0
                ) {
                    message = noty.details[messageList[k]];
                }
            }
            if (message) {
                message = `, ${message}`;
            }
            if (playNotificationTTS) {
                this.playNotyTTS(noty, message);
            }
            if (playDesktopToast || playXSNotification) {
                this.notyGetImage(noty).then((image) => {
                    if (playXSNotification) {
                        this.displayXSNotification(noty, message, image);
                    }
                    if (playDesktopToast) {
                        this.displayDesktopToast(noty, message, image);
                    }
                });
            }
        }
    };

    $app.methods.notyGetImage = async function(noty) {
        try {
            var imageURL = '';
            var userId = '';
            if (noty.userId) {
                userId = noty.userId;
            } else if (noty.senderUserId) {
                userId = noty.senderUserId;
            } else if (noty.sourceUserId) {
                userId = noty.sourceUserId;
            } else if (noty.data) {
                for (var ref of api.userMap.values()) {
                    if (ref.displayName === noty.data) {
                        userId = ref.id;
                        break;
                    }
                }
            }
            if (noty.details && noty.details.imageUrl) {
                imageURL = noty.details.imageUrl;
            } else if (userId) {
                var args = await api.getCachedUser({
                    userId
                });
                if (this.displayVRCPlusIconsAsAvatar && args.json.userIcon) {
                    imageURL = args.json.userIcon;
                } else {
                    imageURL = args.json.currentAvatarThumbnailImageUrl;
                }
            }
            if (!imageURL) {
                return false;
            }
            var response = await fetch(imageURL, {
                method: 'GET',
                redirect: 'follow',
                headers: {
                    'User-Agent': appVersion
                }
            });
            var buffer = response.arrayBuffer();
            var binary = '';
            var bytes = new Uint8Array(buffer);
            var length = bytes.byteLength;
            for (var i = 0; i < length; i++) {
                binary += String.fromCharCode(bytes[i]);
            }
            var imageData = btoa(binary);
            AppApi.CacheImage(imageData);
            return true;
        } catch (err) {
            console.error(err);
            return false;
        }
    };

    $app.methods.playNotyTTS = async function(noty, message) {
        switch (noty.type) {
            case 'OnPlayerJoined':
                this.speak(`${noty.data} has joined`);
                break;
            case 'OnPlayerLeft':
                this.speak(`${noty.data} has left`);
                break;
            case 'OnPlayerJoining':
                this.speak(`${noty.displayName} is joining`);
                break;
            case 'GPS':
                this.speak(
                    `${noty.displayName} is in ${await this.displayLocation(
                        noty.location[0]
                    )}`
                );
                break;
            case 'Online':
                this.speak(`${noty.displayName} has logged in`);
                break;
            case 'Offline':
                this.speak(`${noty.displayName} has logged out`);
                break;
            case 'Status':
                this.speak(
                    `${noty.displayName} status is now ${noty.status[0].status} ${noty.status[0].statusDescription}`
                );
                break;
            case 'invite':
                this.speak(
                    `${noty.senderUsername} has invited you to ${noty.details.worldName}${message}`
                );
                break;
            case 'requestInvite':
                this.speak(
                    `${noty.senderUsername} has requested an invite${message}`
                );
                break;
            case 'inviteResponse':
                this.speak(
                    `${noty.senderUsername} has responded to your invite${message}`
                );
                break;
            case 'requestInviteResponse':
                this.speak(
                    `${noty.senderUsername} has responded to your invite request${message}`
                );
                break;
            case 'friendRequest':
                this.speak(
                    `${noty.senderUsername} has sent you a friend request`
                );
                break;
            case 'Friend':
                this.speak(`${noty.displayName} is now your friend`);
                break;
            case 'Unfriend':
                this.speak(`${noty.displayName} is no longer your friend`);
                break;
            case 'TrustLevel':
                this.speak(
                    `${noty.displayName} trust level is now ${noty.trustLevel}`
                );
                break;
            case 'DisplayName':
                this.speak(
                    `${noty.previousDisplayName} changed their name to ${noty.displayName}`
                );
                break;
            case 'PortalSpawn':
                this.speak(`${noty.data} has spawned a portal`);
                break;
            case 'Event':
                this.speak(noty.data);
                break;
            case 'VideoPlay':
                this.speak(`Now playing: ${noty.data}`);
                break;
            case 'BlockedOnPlayerJoined':
                this.speak(`Blocked user ${noty.displayName} has joined`);
                break;
            case 'BlockedOnPlayerLeft':
                this.speak(`Blocked user ${noty.displayName} has left`);
                break;
            case 'MutedOnPlayerJoined':
                this.speak(`Muted user ${noty.displayName} has joined`);
                break;
            case 'MutedOnPlayerLeft':
                this.speak(`Muted user ${noty.displayName} has left`);
                break;
            default:
                break;
        }
    };

    $app.methods.displayXSNotification = async function(noty, message, image) {
        var timeout = parseInt(parseInt(this.notificationTimeout) / 1000);
        switch (noty.type) {
            case 'OnPlayerJoined':
                AppApi.XSNotification(
                    'VRCX',
                    `${noty.data} has joined`,
                    timeout,
                    image
                );
                break;
            case 'OnPlayerLeft':
                AppApi.XSNotification(
                    'VRCX',
                    `${noty.data} has left`,
                    timeout,
                    image
                );
                break;
            case 'OnPlayerJoining':
                AppApi.XSNotification(
                    'VRCX',
                    `${noty.displayName} is joining`,
                    timeout,
                    image
                );
                break;
            case 'GPS':
                AppApi.XSNotification(
                    'VRCX',
                    `${noty.displayName} is in ${await this.displayLocation(
                        noty.location[0]
                    )}`,
                    timeout,
                    image
                );
                break;
            case 'Online':
                AppApi.XSNotification(
                    'VRCX',
                    `${noty.displayName} has logged in`,
                    timeout,
                    image
                );
                break;
            case 'Offline':
                AppApi.XSNotification(
                    'VRCX',
                    `${noty.displayName} has logged out`,
                    timeout,
                    image
                );
                break;
            case 'Status':
                AppApi.XSNotification(
                    'VRCX',
                    `${noty.displayName} status is now ${noty.status[0].status} ${noty.status[0].statusDescription}`,
                    timeout,
                    image
                );
                break;
            case 'invite':
                AppApi.XSNotification(
                    'VRCX',
                    `${noty.senderUsername} has invited you to ${noty.details.worldName}${message}`,
                    timeout,
                    image
                );
                break;
            case 'requestInvite':
                AppApi.XSNotification(
                    'VRCX',
                    `${noty.senderUsername} has requested an invite${message}`,
                    timeout,
                    image
                );
                break;
            case 'inviteResponse':
                AppApi.XSNotification(
                    'VRCX',
                    `${noty.senderUsername} has responded to your invite${message}`,
                    timeout,
                    image
                );
                break;
            case 'requestInviteResponse':
                AppApi.XSNotification(
                    'VRCX',
                    `${noty.senderUsername} has responded to your invite request${message}`,
                    timeout,
                    image
                );
                break;
            case 'friendRequest':
                AppApi.XSNotification(
                    'VRCX',
                    `${noty.senderUsername} has sent you a friend request`,
                    timeout,
                    image
                );
                break;
            case 'Friend':
                AppApi.XSNotification(
                    'VRCX',
                    `${noty.displayName} is now your friend`,
                    timeout,
                    image
                );
                break;
            case 'Unfriend':
                AppApi.XSNotification(
                    'VRCX',
                    `${noty.displayName} is no longer your friend`,
                    timeout,
                    image
                );
                break;
            case 'TrustLevel':
                AppApi.XSNotification(
                    'VRCX',
                    `${noty.displayName} trust level is now ${noty.trustLevel}`,
                    timeout,
                    image
                );
                break;
            case 'DisplayName':
                AppApi.XSNotification(
                    'VRCX',
                    `${noty.previousDisplayName} changed their name to ${noty.displayName}`,
                    timeout,
                    image
                );
                break;
            case 'PortalSpawn':
                AppApi.XSNotification(
                    'VRCX',
                    `${noty.data} has spawned a portal`,
                    timeout,
                    image
                );
                break;
            case 'Event':
                AppApi.XSNotification('VRCX', noty.data, timeout, image);
                break;
            case 'VideoPlay':
                AppApi.XSNotification(
                    'VRCX',
                    `Now playing: ${noty.data}`,
                    timeout,
                    image
                );
                break;
            case 'BlockedOnPlayerJoined':
                AppApi.XSNotification(
                    'VRCX',
                    `Blocked user ${noty.displayName} has joined`,
                    timeout,
                    image
                );
                break;
            case 'BlockedOnPlayerLeft':
                AppApi.XSNotification(
                    'VRCX',
                    `Blocked user ${noty.displayName} has left`,
                    timeout,
                    image
                );
                break;
            case 'MutedOnPlayerJoined':
                AppApi.XSNotification(
                    'VRCX',
                    `Muted user ${noty.displayName} has joined`,
                    timeout,
                    image
                );
                break;
            case 'MutedOnPlayerLeft':
                AppApi.XSNotification(
                    'VRCX',
                    `Muted user ${noty.displayName} has left`,
                    timeout,
                    image
                );
                break;
            default:
                break;
        }
    };

    $app.methods.displayDesktopToast = async function(noty, message, image) {
        switch (noty.type) {
            case 'OnPlayerJoined':
                AppApi.DesktopNotification(noty.data, 'has joined', image);
                break;
            case 'OnPlayerLeft':
                AppApi.DesktopNotification(noty.data, 'has left', image);
                break;
            case 'OnPlayerJoining':
                AppApi.DesktopNotification(
                    noty.displayName,
                    'is joining',
                    image
                );
                break;
            case 'GPS':
                AppApi.DesktopNotification(
                    noty.displayName,
                    `is in ${await this.displayLocation(noty.location[0])}`,
                    image
                );
                break;
            case 'Online':
                AppApi.DesktopNotification(
                    noty.displayName,
                    'has logged in',
                    image
                );
                break;
            case 'Offline':
                AppApi.DesktopNotification(
                    noty.displayName,
                    'has logged out',
                    image
                );
                break;
            case 'Status':
                AppApi.DesktopNotification(
                    noty.displayName,
                    `status is now ${noty.status[0].status} ${noty.status[0].statusDescription}`,
                    image
                );
                break;
            case 'invite':
                AppApi.DesktopNotification(
                    noty.senderUsername,
                    `has invited you to ${noty.details.worldName}${message}`,
                    image
                );
                break;
            case 'requestInvite':
                AppApi.DesktopNotification(
                    noty.senderUsername,
                    `has requested an invite${message}`,
                    image
                );
                break;
            case 'inviteResponse':
                AppApi.DesktopNotification(
                    noty.senderUsername,
                    `has responded to your invite${message}`,
                    image
                );
                break;
            case 'requestInviteResponse':
                AppApi.DesktopNotification(
                    noty.senderUsername,
                    `has responded to your invite request${message}`,
                    image
                );
                break;
            case 'friendRequest':
                AppApi.DesktopNotification(
                    noty.senderUsername,
                    'has sent you a friend request',
                    image
                );
                break;
            case 'Friend':
                AppApi.DesktopNotification(
                    noty.displayName,
                    'is now your friend',
                    image
                );
                break;
            case 'Unfriend':
                AppApi.DesktopNotification(
                    noty.displayName,
                    'is no longer your friend',
                    image
                );
                break;
            case 'TrustLevel':
                AppApi.DesktopNotification(
                    noty.displayName,
                    `trust level is now ${noty.trustLevel}`,
                    image
                );
                break;
            case 'DisplayName':
                AppApi.DesktopNotification(
                    noty.previousDisplayName,
                    `changed their name to ${noty.displayName}`,
                    image
                );
                break;
            case 'PortalSpawn':
                AppApi.DesktopNotification(
                    noty.data,
                    `has spawned a portal`,
                    image
                );
                break;
            case 'Event':
                AppApi.DesktopNotification('Event', noty.data, image);
                break;
            case 'VideoPlay':
                AppApi.DesktopNotification('Now playing', noty.data, image);
                break;
            case 'BlockedOnPlayerJoined':
                AppApi.DesktopNotification(
                    noty.displayName,
                    'blocked user has joined',
                    image
                );
                break;
            case 'BlockedOnPlayerLeft':
                AppApi.DesktopNotification(
                    noty.displayName,
                    'blocked user has left',
                    image
                );
                break;
            case 'MutedOnPlayerJoined':
                AppApi.DesktopNotification(
                    noty.displayName,
                    'muted user has joined',
                    image
                );
                break;
            case 'MutedOnPlayerLeft':
                AppApi.DesktopNotification(
                    noty.displayName,
                    'muted user has left',
                    image
                );
                break;
            default:
                break;
        }
    };

    $app.methods.displayLocation = async function(location) {
        var text = '';
        var L = parseLocation(location);
        if (L.isOffline) {
            text = 'Offline';
        } else if (L.isPrivate) {
            text = 'Private';
        } else if (L.worldId) {
            var ref = api.worldMap.get(L.worldId);
            if (ref === void 0) {
                var {json} = await api.getWorld({
                    worldId: L.worldId
                });
                if (json !== void 0 && L.location === location) {
                    if (L.instanceId) {
                        text = `${args.json.name} ${L.accessType}`;
                    } else {
                        text = args.json.name;
                    }
                }
            } else if (L.instanceId) {
                text = `${ref.name} ${L.accessType}`;
            } else {
                text = ref.name;
            }
        }
        return text;
    };

    $app.methods.notifyMenu = function(index) {
        var {menu} = this.$refs;
        if (menu.activeIndex !== index) {
            var item = menu.items[index];
            if (item) {
                item.$el.classList.add('notify');
            }
        }
    };

    $app.methods.selectMenu = function(index) {
        // NOTE
        // 툴팁이 쌓여서 느려지기 때문에 날려줌.
        // 근데 이 방법이 안전한지는 모르겠음
        document.querySelectorAll('[role="tooltip"]').forEach((node) => {
            node.remove();
        });
        var item = this.$refs.menu.items[index];
        if (item) {
            item.$el.classList.remove('notify');
        }
        if (index === 'notification') {
            this.unseenNotifications = [];
        }
    };

    $app.methods.promptTOTP = function() {
        this.$prompt(
            'Enter a numeric code from your authenticator app',
            'Two-factor Authentication',
            {
                distinguishCancelAndClose: true,
                cancelButtonText: 'Use OTP',
                confirmButtonText: 'Verify',
                inputPlaceholder: 'Code',
                inputPattern: /^[0-9]{6}$/,
                inputErrorMessage: 'Invalid Code',
                callback: async (action, instance) => {
                    if (action === 'confirm') {
                        try {
                            await api.verifyTOTP({
                                code: instance.inputValue
                            });
                            await api.getCurrentUser();
                        } catch (err) {
                            console.error(err);
                            this.promptTOTP();
                        }
                    } else if (action === 'cancel') {
                        this.promptOTP();
                    }
                }
            }
        );
    };

    $app.methods.promptOTP = function() {
        this.$prompt(
            'Enter one of your saved recovery codes',
            'Two-factor Authentication',
            {
                distinguishCancelAndClose: true,
                cancelButtonText: 'Use TOTP',
                confirmButtonText: 'Verify',
                inputPlaceholder: 'Code',
                inputPattern: /^[a-z0-9]{4}-[a-z0-9]{4}$/,
                inputErrorMessage: 'Invalid Code',
                callback: async (action, instance) => {
                    if (action === 'confirm') {
                        try {
                            await api.verifyOTP({
                                code: instance.inputValue
                            });
                            await api.getCurrentUser();
                        } catch (err) {
                            or(err);
                            this.promptOTP();
                        }
                    } else if (action === 'cancel') {
                        this.promptTOTP();
                    }
                }
            }
        );
    };

    $app.methods.showExportFriendsListDialog = function() {
        var {friends} = api.currentUser;
        if (Array.isArray(friends) === false) {
            return;
        }
        var lines = ['UserID,DisplayName,Memo'];
        var _ = function(str) {
            if (/[\x00-\x1f,"]/.test(str) === true) {
                str = `"${str.replace(/"/g, '""')}"`;
            }
            return str;
        };
        for (var userId of friends) {
            var ref = this.friends.get(userId);
            var name = ref?.name ?? '';
            var memo = ref?.memo ?? '';
            lines.push(`${_(userId)},${_(name)},${_(memo)}`);
        }
        this.exportFriendsListContent = lines.join('\n');
        this.exportFriendsListDialog = true;
    };

    $app.data.exportAvatarsListDialog = false;
    $app.data.exportAvatarsListContent = '';

    $app.methods.showExportAvatarsListDialog = async function() {
        for (var ref of api.avatarMap.values()) {
            if (ref.authorId === api.currentUser.id) {
                api.avatarMap.delete(ref.id);
            }
        }
        var params = {
            sort: 'updated',
            order: 'descending',
            releaseStatus: 'all',
            user: 'me'
        };
        var map = new Map();
        try {
            for (var offset = 0; ; offset += 100) {
                var {json} = await api.getAvatars({
                    n: 100,
                    offset,
                    ...params
                });
                if (json === void 0 || json.length === 0) {
                    break;
                }
                for (var apiAvatar of json) {
                    var $ref = api.avatarMap.get(apiAvatar.id);
                    if ($ref !== void 0) {
                        map.set($ref.id, $ref);
                    }
                }
            }
        } catch (err) {
            console.error(err);
        }
        var avatars = Array.from(map.values());
        if (Array.isArray(avatars) === false) {
            return;
        }
        var lines = ['AvatarID,AvatarName'];
        var _ = function(str) {
            if (/[\x00-\x1f,"]/.test(str) === true) {
                str = `"${str.replace(/"/g, '""')}"`;
            }
            return str;
        };
        for (var avatar of avatars) {
            lines.push(`${_(avatar.id)},${_(avatar.name)}`);
        }
        this.exportAvatarsListContent = lines.join('\n');
        this.exportAvatarsListDialog = true;
    };

    pubsub.subscribe('USER:2FA', function() {
        $app.promptTOTP();
    });

    pubsub.subscribe('LOGOUT', function() {
        new Noty({
            type: 'success',
            text: `See you again, <strong>${escapeHtml(
                api.currentUser.displayName
            )}</strong>!`
        }).show();
    });

    pubsub.subscribe('LOGIN', function(args) {
        new Noty({
            type: 'success',
            text: `Hello there, <strong>${escapeHtml(
                args.ref.displayName
            )}</strong>!`
        }).show();
        $app.$refs.menu.activeIndex = 'feed';
        $app.resetGameLog();
    });

    pubsub.subscribe('LOGIN', function(args) {
        $app.updateStoredUser(args.ref);
    });

    pubsub.subscribe('LOGOUT', function() {
        $app.updateStoredUser(api.currentUser);
    });

    $app.methods.updateStoredUser = function(currentUser) {
        var savedCredentialsArray = {};
        if (configRepository.getString('savedCredentials') !== null) {
            var savedCredentialsArray = JSON.parse(
                configRepository.getString('savedCredentials')
            );
        }
        if (this.saveCredentials) {
            var credentialsToSave = {
                user: currentUser,
                loginParams: this.saveCredentials
            };
            savedCredentialsArray[currentUser.username] = credentialsToSave;
            delete this.saveCredentials;
        } else if (savedCredentialsArray[currentUser.username] !== void 0) {
            savedCredentialsArray[currentUser.username].user = currentUser;
        }
        this.loginForm.savedCredentials = savedCredentialsArray;
        var jsonCredentialsArray = JSON.stringify(savedCredentialsArray);
        configRepository.setString('savedCredentials', jsonCredentialsArray);
        this.loginForm.lastUserLoggedIn = currentUser.username;
        configRepository.setString('lastUserLoggedIn', currentUser.username);
    };

    $app.methods.relogin = async function(loginParams) {
        this.loginForm.loading = true;

        try {
            await api.getConfig();
            await api.login({
                username: loginParams.username,
                password: loginParams.password
            });
        } catch (err) {
            console.error(err);
        }

        this.loginForm.loading = false;
    };

    $app.methods.deleteSavedLogin = function(username) {
        var savedCredentialsArray = JSON.parse(
            configRepository.getString('savedCredentials')
        );
        delete savedCredentialsArray[username];
        $app.loginForm.savedCredentials = savedCredentialsArray;
        var jsonCredentialsArray = JSON.stringify(savedCredentialsArray);
        configRepository.setString('savedCredentials', jsonCredentialsArray);
        new Noty({
            type: 'success',
            text: 'Account removed.'
        }).show();
    };

    // API RESPONSE:
    // if ((status === 401) && (data.error.message === '"Missing Credentials"') && ($app.isAutoLogin)) {
    //     if (endpoint.substring(0, 10) === 'auth/user?') {
    //         this.$emit('AUTOLOGIN');
    //     }
    //     throw new Error('401: Missing Credentials');
    // }

    pubsub.subscribe('AUTOLOGIN', async function() {
        var user =
            $app.loginForm.savedCredentials[$app.loginForm.lastUserLoggedIn];
        if (user === void 0) {
            return;
        }
        try {
            await $app.relogin({
                username: user.loginParams.username,
                password: user.loginParams.password
            });
            new Noty({
                type: 'success',
                text: 'Automatically logged in.'
            }).show();
        } catch (err) {
            console.error(err);
        }
    });

    $app.data.loginForm = {
        loading: true,
        username: '',
        password: '',
        saveCredentials: false,
        savedCredentials:
            configRepository.getString('lastUserLoggedIn') !== null
                ? JSON.parse(configRepository.getString('savedCredentials'))
                : {},
        lastUserLoggedIn: configRepository.getString('lastUserLoggedIn'),
        rules: {
            username: [
                {
                    required: true,
                    trigger: 'blur'
                }
            ],
            password: [
                {
                    required: true,
                    trigger: 'blur'
                }
            ]
        }
    };

    $app.methods.login = function() {
        this.$refs.loginForm.validate(async (valid) => {
            if (valid && !this.loginForm.loading) {
                this.loginForm.loading = true;

                try {
                    await api.getConfig();

                    if (this.loginForm.saveCredentials) {
                        this.saveCredentials = {
                            username: this.loginForm.username,
                            password: this.loginForm.password
                        };
                    } else {
                        this.saveCredentials = null;
                    }

                    await api.login({
                        username: this.loginForm.username,
                        password: this.loginForm.password
                    });
                } catch (err) {
                    console.error(err);
                }

                this.loginForm.password = '';
                this.loginForm.loading = false;
            }
        });
    };

    $app.methods.loginWithSteam = async function() {
        if (!this.loginForm.loading) {
            this.loginForm.loading = true;

            try {
                var steamTicket = await AppApi.LoginWithSteam();
                if (steamTicket) {
                    await api.getConfig();
                    await api.loginWithSteam({
                        steamTicket
                    });
                } else {
                    this.$message({
                        message: 'It only works when VRChat is running.',
                        type: 'error'
                    });
                }
            } catch (err) {
                console.error(err);
            }

            this.loginForm.loading = false;
        }
    };

    $app.methods.loadMemo = function(id) {
        var key = `memo_${id}`;
        return VRCXStorage.Get(key);
    };

    $app.methods.saveMemo = function(id, memo) {
        var key = `memo_${id}`;
        if (memo) {
            VRCXStorage.Set(key, String(memo));
        } else {
            VRCXStorage.Remove(key);
        }
        var ref = this.friends.get(id);
        if (ref) {
            ref.memo = String(memo || '');
        }
    };

    // App: Friends

    $app.data.friends = new Map();
    $app.data.pendingActiveFriends = new Set();
    $app.data.friendsNo = 0;
    $app.data.isFriendsGroupMe = true;
    $app.data.isFriendsGroup0 = true;
    $app.data.isFriendsGroup1 = true;
    $app.data.isFriendsGroup2 = true;
    $app.data.isFriendsGroup3 = false;
    $app.data.friendsGroup0_ = [];
    $app.data.friendsGroup1_ = [];
    $app.data.friendsGroup2_ = [];
    $app.data.friendsGroup3_ = [];
    $app.data.friendsGroupA_ = [];
    $app.data.friendsGroupB_ = [];
    $app.data.friendsGroupC_ = [];
    $app.data.friendsGroupD_ = [];
    $app.data.sortFriendsGroup0 = false;
    $app.data.sortFriendsGroup1 = false;
    $app.data.sortFriendsGroup2 = false;
    $app.data.sortFriendsGroup3 = false;
    $app.data.orderFriendsGroup0 = configRepository.getBool(
        'orderFriendGroup0'
    );
    $app.data.orderFriendsGroup1 = configRepository.getBool(
        'orderFriendGroup1'
    );
    $app.data.orderFriendsGroup2 = configRepository.getBool(
        'orderFriendGroup2'
    );
    $app.data.orderFriendsGroup3 = configRepository.getBool(
        'orderFriendGroup3'
    );
    var saveOrderFriendGroup = function() {
        configRepository.setBool('orderFriendGroup0', this.orderFriendsGroup0);
        configRepository.setBool('orderFriendGroup1', this.orderFriendsGroup1);
        configRepository.setBool('orderFriendGroup2', this.orderFriendsGroup2);
        configRepository.setBool('orderFriendGroup3', this.orderFriendsGroup3);
    };
    $app.watch.orderFriendsGroup0 = saveOrderFriendGroup;
    $app.watch.orderFriendsGroup1 = saveOrderFriendGroup;
    $app.watch.orderFriendsGroup2 = saveOrderFriendGroup;
    $app.watch.orderFriendsGroup3 = saveOrderFriendGroup;

    pubsub.subscribe('LOGIN', function() {
        $app.friends.clear();
        $app.pendingActiveFriends.clear();
        $app.friendsNo = 0;
        $app.isFriendsGroup0 = true;
        $app.isFriendsGroup1 = true;
        $app.isFriendsGroup2 = true;
        $app.isFriendsGroup3 = false;
        $app.friendsGroup0_ = [];
        $app.friendsGroup1_ = [];
        $app.friendsGroup2_ = [];
        $app.friendsGroup3_ = [];
        $app.friendsGroupA_ = [];
        $app.friendsGroupB_ = [];
        $app.friendsGroupC_ = [];
        $app.friendsGroupD_ = [];
        $app.sortFriendsGroup0 = false;
        $app.sortFriendsGroup1 = false;
        $app.sortFriendsGroup2 = false;
        $app.sortFriendsGroup3 = false;
    });

    pubsub.subscribe('USER:CURRENT', function(args) {
        // initFriendship()이 LOGIN에서 처리되기 때문에
        // USER:CURRENT에서 처리를 함
        $app.refreshFriends(args.ref, args.origin);
    });

    pubsub.subscribe('USER', function(args) {
        $app.updateFriend(args.ref.id);
    });

    pubsub.subscribe('FRIEND:ADD', function(args) {
        $app.addFriend(args.params.userId);
    });

    pubsub.subscribe('FRIEND:DELETE', function(args) {
        $app.deleteFriend(args.params.userId);
    });

    pubsub.subscribe('FRIEND:STATE', function(args) {
        if (args.json.state === 'online') {
            $app.APILastOnline.set(args.params.userId, Date.now());
        }
        $app.updateFriend(args.params.userId, args.json.state);
    });

    pubsub.subscribe('FAVORITE', function(args) {
        $app.updateFriend(args.ref.favoriteId);
    });

    pubsub.subscribe('FAVORITE:@DELETE', function(args) {
        $app.updateFriend(args.ref.favoriteId);
    });

    $app.methods.refreshFriendList = function() {
        this.nextCurrentUserRefresh = 0;
        this.nextFriendsRefresh = 0;
    };

    $app.methods.refreshFriends = function(ref, origin) {
        var map = new Map();
        for (var id of ref.friends) {
            map.set(id, 'offline');
        }
        for (var id of ref.offlineFriends) {
            map.set(id, 'offline');
        }
        for (var id of ref.activeFriends) {
            map.set(id, 'active');
        }
        for (var id of ref.onlineFriends) {
            map.set(id, 'online');
        }
        for (var [id, state] of map) {
            if (this.friends.has(id)) {
                this.updateFriend(id, state, origin);
            } else {
                this.addFriend(id, state);
            }
        }
        for (var id of this.friends.keys()) {
            if (map.has(id) === false) {
                api.deleteFriend(id);
            }
        }
    };

    $app.methods.addFriend = function(id, state) {
        if (this.friends.has(id)) {
            return;
        }
        var ref = api.userMap.get(id);
        var isVIP = api.favoriteMapByObjectId.has(id);
        var ctx = {
            id,
            state: state || 'offline',
            isVIP,
            ref,
            name: '',
            no: ++this.friendsNo,
            memo: this.loadMemo(id)
        };
        if (ref === void 0) {
            ref = this.friendLog[id];
            if (ref !== void 0 && ref.displayName) {
                ctx.name = ref.displayName;
            }
        } else {
            ctx.name = ref.name;
        }
        this.friends.set(id, ctx);
        if (ctx.state === 'online') {
            if (ctx.isVIP) {
                this.sortFriendsGroup0 = true;
                this.friendsGroup0_.push(ctx);
                this.friendsGroupA_.unshift(ctx);
            } else {
                this.sortFriendsGroup1 = true;
                this.friendsGroup1_.push(ctx);
                this.friendsGroupB_.unshift(ctx);
            }
        } else if (ctx.state === 'active') {
            this.sortFriendsGroup2 = true;
            this.friendsGroup2_.push(ctx);
            this.friendsGroupC_.unshift(ctx);
        } else {
            this.sortFriendsGroup3 = true;
            this.friendsGroup3_.push(ctx);
            this.friendsGroupD_.unshift(ctx);
        }
    };

    $app.methods.deleteFriend = function(id) {
        var ctx = this.friends.get(id);
        if (ctx === void 0) {
            return;
        }
        this.friends.delete(id);
        if (ctx.state === 'online') {
            if (ctx.isVIP) {
                removeFromArray(this.friendsGroup0_, ctx);
                removeFromArray(this.friendsGroupA_, ctx);
            } else {
                removeFromArray(this.friendsGroup1_, ctx);
                removeFromArray(this.friendsGroupB_, ctx);
            }
        } else if (ctx.state === 'active') {
            removeFromArray(this.friendsGroup2_, ctx);
            removeFromArray(this.friendsGroupC_, ctx);
        } else {
            removeFromArray(this.friendsGroup3_, ctx);
            removeFromArray(this.friendsGroupD_, ctx);
        }
    };

    $app.data.updateFriendInProgress = new Set();

    $app.methods.updateFriend = async function(id, newState, origin) {
        var ctx = this.friends.get(id);
        if (ctx === void 0) {
            return;
        }
        if (this.updateFriendInProgress.has(id)) {
            return;
        }
        this.updateFriendInProgress.add(id);
        var ref = api.userMap.get(id);
        var isVIP = api.favoriteMapByObjectId.has(id);
        if (newState === void 0 || ctx.state === newState) {
            // this is should be: undefined -> user
            if (ctx.ref !== ref) {
                ctx.ref = ref;
                // NOTE
                // AddFriend (CurrentUser) 이후,
                // 서버에서 오는 순서라고 보면 될 듯.
                if (ctx.state === 'online') {
                    if (this.appInit) {
                        api.getUser({
                            userId: id
                        });
                    }
                    if (ctx.isVIP) {
                        removeFromArray(this.friendsGroupA_, ctx);
                        this.friendsGroupA_.push(ctx);
                    } else {
                        removeFromArray(this.friendsGroupB_, ctx);
                        this.friendsGroupB_.push(ctx);
                    }
                } else if (ctx.state === 'active') {
                    removeFromArray(this.friendsGroupC_, ctx);
                    this.friendsGroupC_.push(ctx);
                } else {
                    removeFromArray(this.friendsGroupD_, ctx);
                    this.friendsGroupD_.push(ctx);
                }
            }
            if (ctx.isVIP !== isVIP) {
                ctx.isVIP = isVIP;
                if (ctx.state === 'online') {
                    if (ctx.isVIP) {
                        removeFromArray(this.friendsGroup1_, ctx);
                        removeFromArray(this.friendsGroupB_, ctx);
                        this.sortFriendsGroup0 = true;
                        this.friendsGroup0_.push(ctx);
                        this.friendsGroupA_.unshift(ctx);
                    } else {
                        removeFromArray(this.friendsGroup0_, ctx);
                        removeFromArray(this.friendsGroupA_, ctx);
                        this.sortFriendsGroup1 = true;
                        this.friendsGroup1_.push(ctx);
                        this.friendsGroupB_.unshift(ctx);
                    }
                }
            }
            if (ref !== void 0 && ctx.name !== ref.displayName) {
                ctx.name = ref.displayName;
                if (ctx.state === 'online') {
                    if (ctx.isVIP) {
                        this.sortFriendsGroup0 = true;
                    } else {
                        this.sortFriendsGroup1 = true;
                    }
                } else if (ctx.state === 'active') {
                    this.sortFriendsGroup2 = true;
                } else {
                    this.sortFriendsGroup3 = true;
                }
            }
            // FIXME: 도배 가능성 있음
            if (
                origin &&
                ctx.state !== 'online' &&
                ref !== void 0 &&
                ref.location !== '' &&
                ref.location !== 'offline' &&
                ref.location !== 'private'
            ) {
                api.getUser({
                    userId: id
                }).catch((err) => {
                    this.updateFriendInProgress.remove(id);
                });
            }
        } else {
            if (ctx.state === 'online' && newState === 'active') {
                this.updateFriendInProgress.delete(id);
                await new Promise((resolve) => setTimeout(resolve, 50000));
                if (this.APILastOnline.has(id)) {
                    var date = this.APILastOnline.get(id);
                    if (date > Date.now() - 60000) {
                        return;
                    }
                }
            }
            if (ctx.state === 'online') {
                if (ctx.isVIP) {
                    removeFromArray(this.friendsGroup0_, ctx);
                    removeFromArray(this.friendsGroupA_, ctx);
                } else {
                    removeFromArray(this.friendsGroup1_, ctx);
                    removeFromArray(this.friendsGroupB_, ctx);
                }
            } else if (ctx.state === 'active') {
                removeFromArray(this.friendsGroup2_, ctx);
                removeFromArray(this.friendsGroupC_, ctx);
            } else {
                removeFromArray(this.friendsGroup3_, ctx);
                removeFromArray(this.friendsGroupD_, ctx);
            }
            var location = '';
            var $location_at = '';
            if (ref !== void 0 && ref.location !== void 0) {
                var {location, $location_at} = ref;
            }
            var args = await api
                .getUser({
                    userId: id
                })
                .catch((err) => {
                    this.updateFriendInProgress.remove(id);
                });
            if (args !== void 0 && args.ref !== void 0) {
                newState = args.ref.state;
                ctx.ref = args.ref;
            }
            if (ctx.state !== newState) {
                if (
                    ctx.ref.$offline_for !== void 0 &&
                    ctx.ref.$offline_for === '' &&
                    (newState === 'offline' || newState === 'active') &&
                    ctx.state === 'online'
                ) {
                    ctx.ref.$online_for = '';
                    ctx.ref.$offline_for = Date.now();
                    if (ctx.state === 'online') {
                        var ts = Date.now();
                        var time = ts - $location_at;
                        this.addFeed('Offline', ctx.ref, {
                            location: location === 'offline' ? '' : location,
                            time
                        });
                    }
                } else if (newState === 'online') {
                    ctx.ref.$location_at = Date.now();
                    ctx.ref.$online_for = Date.now();
                    ctx.ref.$offline_for = '';
                    this.addFeed('Online', ctx.ref, {
                        location: ctx.ref.location
                    });
                }
            }
            // changing property triggers Vue
            // so, we need compare and set
            if (ctx.state !== newState) {
                ctx.state = newState;
            }
            if (ctx.isVIP !== isVIP) {
                ctx.isVIP = isVIP;
            }
            if (ctx.ref.state === '') {
                ctx.ref.state = 'offline';
            }
            if (ctx.name !== ctx.ref.displayName) {
                ctx.name = ctx.ref.displayName;
            }
            if (ctx.state === 'online') {
                if (ctx.isVIP) {
                    removeFromArray(this.friendsGroup0_, ctx);
                    removeFromArray(this.friendsGroupA_, ctx);
                } else {
                    removeFromArray(this.friendsGroup1_, ctx);
                    removeFromArray(this.friendsGroupB_, ctx);
                }
            } else if (ctx.state === 'active') {
                removeFromArray(this.friendsGroup2_, ctx);
                removeFromArray(this.friendsGroupC_, ctx);
            } else {
                removeFromArray(this.friendsGroup3_, ctx);
                removeFromArray(this.friendsGroupD_, ctx);
            }
            if (newState === 'online') {
                if (isVIP) {
                    this.sortFriendsGroup0 = true;
                    this.friendsGroup0_.push(ctx);
                    this.friendsGroupA_.unshift(ctx);
                } else {
                    this.sortFriendsGroup1 = true;
                    this.friendsGroup1_.push(ctx);
                    this.friendsGroupB_.unshift(ctx);
                }
            } else if (newState === 'active') {
                this.sortFriendsGroup2 = true;
                this.friendsGroup2_.push(ctx);
                this.friendsGroupC_.unshift(ctx);
            } else {
                this.sortFriendsGroup3 = true;
                this.friendsGroup3_.push(ctx);
                this.friendsGroupD_.unshift(ctx);
            }
            // changing property triggers Vue
            // so, we need compare and set
            if (ctx.state !== newState) {
                ctx.state = newState;
            }
            if (ctx.name !== ctx.ref.displayName) {
                ctx.name = ctx.ref.displayName;
            }
            if (ctx.isVIP !== isVIP) {
                ctx.isVIP = isVIP;
            }
        }
        this.updateFriendInProgress.delete(id);
    };

    $app.methods.updateFriendGPS = function(userId) {
        var ctx = this.friends.get(userId);
        if (
            ctx.ref !== void 0 &&
            ctx.ref.location !== 'private' &&
            ctx.state === 'online'
        ) {
            if (ctx.isVIP) {
                removeFromArray(this.friendsGroupA_, ctx);
                this.friendsGroupA_.unshift(ctx);
            } else {
                removeFromArray(this.friendsGroupB_, ctx);
                this.friendsGroupB_.unshift(ctx);
            }
        }
    };

    // ascending
    var compareByName = function(a, b) {
        var A = String(a.name).toUpperCase();
        var B = String(b.name).toUpperCase();
        if (A < B) {
            return -1;
        }
        if (A > B) {
            return 1;
        }
        return 0;
    };

    // descending
    var compareByUpdatedAt = function(a, b) {
        var A = String(a.updated_at).toUpperCase();
        var B = String(b.updated_at).toUpperCase();
        if (A < B) {
            return 1;
        }
        if (A > B) {
            return -1;
        }
        return 0;
    };

    // ascending
    var compareByDisplayName = function(a, b) {
        var A = String(a.displayName).toUpperCase();
        var B = String(b.displayName).toUpperCase();
        if (A < B) {
            return -1;
        }
        if (A > B) {
            return 1;
        }
        return 0;
    };

    // VIP friends
    $app.computed.friendsGroup0 = function() {
        if (this.orderFriendsGroup0) {
            return this.friendsGroupA_;
        }
        if (this.sortFriendsGroup0) {
            this.sortFriendsGroup0 = false;
            this.friendsGroup0_.sort(compareByName);
        }
        return this.friendsGroup0_;
    };

    // Online friends
    $app.computed.friendsGroup1 = function() {
        if (this.orderFriendsGroup1) {
            return this.friendsGroupB_;
        }
        if (this.sortFriendsGroup1) {
            this.sortFriendsGroup1 = false;
            this.friendsGroup1_.sort(compareByName);
        }
        return this.friendsGroup1_;
    };

    // Active friends
    $app.computed.friendsGroup2 = function() {
        if (this.orderFriendsGroup2) {
            return this.friendsGroupC_;
        }
        if (this.sortFriendsGroup2) {
            this.sortFriendsGroup2 = false;
            this.friendsGroup2_.sort(compareByName);
        }
        return this.friendsGroup2_;
    };

    // Offline friends
    $app.computed.friendsGroup3 = function() {
        if (this.orderFriendsGroup3) {
            return this.friendsGroupD_;
        }
        if (this.sortFriendsGroup3) {
            this.sortFriendsGroup3 = false;
            this.friendsGroup3_.sort(compareByName);
        }
        return this.friendsGroup3_;
    };

    $app.methods.userStatusClass = function(user) {
        var style = {};
        if (user !== void 0) {
            var id = '';
            if (user.id) {
                id = user.id;
            } else if (user.userId) {
                id = user.userId;
            }
            if (!user.isFriend && id && id !== api.currentUser.id) {
                return;
            }
            //temp fix
            if (
                user.status !== 'active' &&
                user.location === 'private' &&
                user.state === '' &&
                id &&
                id !== api.currentUser.id &&
                !api.currentUser.onlineFriends.includes(id)
            ) {
                if (api.currentUser.activeFriends.includes(id)) {
                    // Active
                    style.active = true;
                } else {
                    // Offline
                    style.offline = true;
                }
            } else if (user.location === 'offline') {
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

    $app.methods.confirmDeleteFriend = function(id) {
        this.$confirm('Continue? Unfriend', 'Confirm', {
            confirmButtonText: 'Confirm',
            cancelButtonText: 'Cancel',
            type: 'info',
            callback: (action) => {
                if (action === 'confirm') {
                    api.deleteFriend({
                        userId: id
                    });
                }
            }
        });
    };

    // App: Quick Search

    $app.data.quickSearch = '';
    $app.data.quickSearchItems = [];

    $app.methods.quickSearchRemoteMethod = function(query) {
        var results = [];
        if (query) {
            var QUERY = query.toUpperCase();
            for (var ctx of this.friends.values()) {
                if (ctx.ref === void 0) {
                    continue;
                }
                var NAME = ctx.name.toUpperCase();
                var match = NAME.includes(QUERY);
                if (!match) {
                    var uname = String(ctx.ref.username);
                    match =
                        uname.toUpperCase().includes(QUERY) &&
                        !uname.startsWith('steam_');
                }
                if (!match && ctx.memo) {
                    match = String(ctx.memo)
                        .toUpperCase()
                        .includes(QUERY);
                }
                if (match) {
                    results.push({
                        value: ctx.id,
                        label: ctx.name,
                        ref: ctx.ref,
                        NAME
                    });
                }
            }
            results.sort(function(a, b) {
                var A = a.NAME.startsWith(QUERY);
                var B = b.NAME.startsWith(QUERY);
                if (A !== B) {
                    if (A) {
                        return -1;
                    }
                    if (B) {
                        return 1;
                    }
                }
                if (a.NAME < b.NAME) {
                    return -1;
                }
                if (a.NAME > b.NAME) {
                    return 1;
                }
                return 0;
            });
            if (results.length > 4) {
                results.length = 4;
            }
            results.push({
                value: `search:${query}`,
                label: query
            });
        }
        this.quickSearchItems = results;
    };

    $app.methods.quickSearchChange = function(value) {
        if (value) {
            if (value.startsWith('search:')) {
                this.friendsListSearch = value.substr(7);
                this.$refs.menu.activeIndex = 'friendsList';
            } else {
                this.showUserDialog(value);
            }
        }
    };

    // NOTE: 그냥 열고 닫고 했을때 changed 이벤트 발생이 안되기 때문에 넣음
    $app.methods.quickSearchVisibleChange = function(value) {
        if (value) {
            this.quickSearch = '';
        }
    };

    // App: Feed

    $app.data.feedTable = {
        data: [],
        filters: [
            {
                prop: 'type',
                value: [],
                filterFn: (row, filter) =>
                    filter.value.some((v) => v === row.type)
            },
            {
                prop: 'displayName',
                value: ''
            },
            {
                prop: 'userId',
                value: false,
                filterFn: (row, filter) =>
                    !filter.value || api.favoriteMapByObjectId.has(row.userId)
            }
        ],
        tableProps: {
            stripe: true,
            size: 'mini',
            defaultSort: {
                prop: 'created_at',
                order: 'descending'
            }
        },
        pageSize: 10,
        paginationProps: {
            small: true,
            layout: 'sizes,prev,pager,next,total',
            pageSizes: [10, 25, 50, 100]
        }
    };

    pubsub.subscribe('LOGIN', function(args) {
        $app.feedTable.data = VRCXStorage.GetArray(`${args.ref.id}_feedTable`);
        $app.sweepFeed();
    });

    pubsub.subscribe('USER:UPDATE', function(args) {
        var {ref, props} = args;
        if ($app.friends.has(ref.id) === false) {
            return;
        }
        if (
            props.location &&
            props.location[0] !== 'offline' &&
            props.location[0] !== '' &&
            props.location[1] !== 'offline' &&
            props.location[0] !== 'private'
        ) {
            $app.addFeed('GPS', ref, {
                location: [props.location[0], props.location[1]],
                time: props.location[2]
            });
            $app.updateFriendGPS(ref.id);
            $app.feedDownloadWorldCache(ref);
        }
        if (
            props.currentAvatarImageUrl ||
            props.currentAvatarThumbnailImageUrl
        ) {
            $app.addFeed('Avatar', ref, {
                avatar: [
                    {
                        currentAvatarImageUrl: props.currentAvatarImageUrl
                            ? props.currentAvatarImageUrl[0]
                            : ref.currentAvatarImageUrl,
                        currentAvatarThumbnailImageUrl: props.currentAvatarThumbnailImageUrl
                            ? props.currentAvatarThumbnailImageUrl[0]
                            : ref.currentAvatarThumbnailImageUrl
                    },
                    {
                        currentAvatarImageUrl: props.currentAvatarImageUrl
                            ? props.currentAvatarImageUrl[1]
                            : ref.currentAvatarImageUrl,
                        currentAvatarThumbnailImageUrl: props.currentAvatarThumbnailImageUrl
                            ? props.currentAvatarThumbnailImageUrl[1]
                            : ref.currentAvatarThumbnailImageUrl
                    }
                ]
            });
        }
        if (props.status || props.statusDescription) {
            $app.addFeed('Status', ref, {
                status: [
                    {
                        status: props.status ? props.status[0] : ref.status,
                        statusDescription: props.statusDescription
                            ? props.statusDescription[0]
                            : ref.statusDescription
                    },
                    {
                        status: props.status ? props.status[1] : ref.status,
                        statusDescription: props.statusDescription
                            ? props.statusDescription[1]
                            : ref.statusDescription
                    }
                ]
            });
        }
    });

    var saveFeedTimer = null;
    $app.methods.saveFeed = function() {
        if (saveFeedTimer !== null) {
            return;
        }
        saveFeedTimer = setTimeout(() => {
            saveFeedTimer = null;
            VRCXStorage.SetArray(
                `${api.currentUser.id}_feedTable`,
                this.feedTable.data
            );
        }, 1);
    };

    $app.methods.addFeed = function(type, ref, extra) {
        this.feedTable.data.push({
            created_at: new Date().toJSON(),
            type,
            userId: ref.id,
            displayName: ref.displayName,
            ...extra
        });
        this.sweepFeed();
        this.saveFeed();
        this.updateSharedFeed(false);
        this.notifyMenu('feed');
    };

    $app.methods.clearFeed = function() {
        // FIXME: 메시지 수정
        this.$confirm('Continue? Clear Feed', 'Confirm', {
            confirmButtonText: 'Confirm',
            cancelButtonText: 'Cancel',
            type: 'info',
            callback: (action) => {
                if (action === 'confirm') {
                    // 필터된 데이터만 삭제 하려면.. 허어
                    var T = this.feedTable;
                    T.data = T.data.filter(
                        (row) =>
                            !T.filters.every((filter) => {
                                if (filter.value) {
                                    if (!Array.isArray(filter.value)) {
                                        if (filter.filterFn) {
                                            return filter.filterFn(row, filter);
                                        }
                                        return String(row[filter.prop])
                                            .toUpperCase()
                                            .includes(
                                                String(
                                                    filter.value
                                                ).toUpperCase()
                                            );
                                    }
                                    if (filter.value.length) {
                                        if (filter.filterFn) {
                                            return filter.filterFn(row, filter);
                                        }
                                        var prop = String(
                                            row[filter.prop]
                                        ).toUpperCase();
                                        return filter.value.some((v) =>
                                            prop.includes(
                                                String(v).toUpperCase()
                                            )
                                        );
                                    }
                                }
                                return true;
                            })
                    );
                }
            }
        });
    };

    $app.methods.sweepFeed = function() {
        var {data} = this.feedTable;
        // 로그는 3일까지만 남김
        var limit = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toJSON();
        var i = 0;
        var j = data.length;
        while (i < j && data[i].created_at < limit) {
            ++i;
        }
        if (i === j) {
            this.feedTable.data = [];
        } else if (i) {
            data.splice(0, i);
        }
    };

    // App: gameLog

    $app.data.lastLocation = {
        date: 0,
        location: '',
        name: '',
        playerList: [],
        friendList: []
    };
    $app.data.lastLocation$ = {};
    $app.data.discordActive = configRepository.getBool('discordActive');
    $app.data.discordInstance = configRepository.getBool('discordInstance');
    var saveDiscordOption = function() {
        configRepository.setBool('discordActive', this.discordActive);
        configRepository.setBool('discordInstance', this.discordInstance);
    };
    $app.watch.discordActive = saveDiscordOption;
    $app.watch.discordInstance = saveDiscordOption;

    $app.data.gameLogTable = {
        data: [],
        lastEntryDate: '',
        filters: [
            {
                prop: 'type',
                value: [],
                filterFn: (row, filter) =>
                    filter.value.some((v) => v === row.type)
            },
            {
                prop: 'data',
                value: ''
            },
            {
                prop: 'data',
                value: true,
                filterFn: (row, filter) =>
                    row.data !== api.currentUser.displayName
            }
        ],
        tableProps: {
            stripe: true,
            size: 'mini',
            defaultSort: {
                prop: 'created_at',
                order: 'descending'
            }
        },
        pageSize: 10,
        paginationProps: {
            small: true,
            layout: 'sizes,prev,pager,next,total',
            pageSizes: [10, 25, 50, 100]
        }
    };

    $app.methods.resetGameLog = async function() {
        await gameLogService.reset();
        this.gameLogTable.data = [];
        this.lastLocation = {
            date: 0,
            location: '',
            name: '',
            playerList: [],
            friendList: []
        };
    };

    $app.methods.updateGameLogLoop = async function() {
        try {
            if (api.isLoggedIn.value === true) {
                await this.updateGameLog();
                this.sweepGameLog();
                var length = this.gameLogTable.data.length;
                if (length > 0) {
                    if (
                        this.gameLogTable.data[length - 1].created_at !==
                        this.gameLogTable.lastEntryDate
                    ) {
                        this.notifyMenu('gameLog');
                    }
                    this.gameLogTable.lastEntryDate = this.gameLogTable.data[
                        length - 1
                    ].created_at;
                }
                this.updateSharedFeed(false);
            }
        } catch (err) {
            console.error(err);
        }
        setTimeout(() => this.updateGameLogLoop(), 500);
    };

    $app.methods.updateGameLog = async function() {
        for (var gameLog of await gameLogService.poll()) {
            var tableData = null;

            switch (gameLog.type) {
                case 'location':
                    if (this.isGameRunning) {
                        this.lastLocation = {
                            date: Date.parse(gameLog.dt),
                            location: gameLog.location,
                            name: gameLog.worldName,
                            playerList: [],
                            friendList: []
                        };
                    }
                    tableData = {
                        created_at: gameLog.dt,
                        type: 'Location',
                        data: [gameLog.location, gameLog.worldName]
                    };
                    break;

                case 'player-joined':
                    tableData = {
                        created_at: gameLog.dt,
                        type: 'OnPlayerJoined',
                        data: gameLog.userDisplayName
                    };
                    break;

                case 'player-left':
                    tableData = {
                        created_at: gameLog.dt,
                        type: 'OnPlayerLeft',
                        data: gameLog.userDisplayName
                    };
                    break;

                case 'notification':
                    tableData = {
                        created_at: gameLog.dt,
                        type: 'Notification',
                        data: gameLog.json
                    };
                    break;

                case 'portal-spawn':
                    tableData = {
                        created_at: gameLog.dt,
                        type: 'PortalSpawn',
                        data: gameLog.userDisplayName
                    };
                    break;

                case 'event':
                    tableData = {
                        created_at: gameLog.dt,
                        type: 'Event',
                        data: gameLog.event
                    };
                    break;

                case 'video-play':
                    tableData = {
                        created_at: gameLog.dt,
                        type: 'VideoPlay',
                        data: gameLog.videoURL,
                        displayName: gameLog.displayName
                    };
                    break;

                default:
                    break;
            }

            if (tableData !== null) {
                this.gameLogTable.data.push(tableData);
            }
        }
    };

    $app.methods.sweepGameLog = function() {
        var {data} = this.gameLogTable;
        // 로그는 7일까지만 남김
        var limit = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toJSON();
        var i = 0;
        var j = data.length;
        while (i < j && data[i].created_at < limit) {
            ++i;
        }
        if (i === j) {
            this.gameLogTable.data = [];
        } else if (i) {
            data.splice(0, i);
        }
    };

    $app.methods.updateDiscord = function() {
        var ref = api.userMap.get(api.currentUser.id);
        if (ref !== void 0) {
            var myLocation = this.lastLocation.location;
            if (ref.location !== myLocation) {
                api.applyUser({
                    id: ref.id,
                    location: myLocation
                });
            }
        }
        if (this.isGameRunning === false || this.lastLocation.location === '') {
            Discord.SetActive(false);
            return;
        }
        if (this.lastLocation.location !== this.lastLocation$.location) {
            var L = parseLocation(this.lastLocation.location);
            L.worldName = L.worldId;
            this.lastLocation$ = L;
            if (L.worldId) {
                var ref = api.worldMap.get(L.worldId);
                if (ref) {
                    L.worldName = ref.name;
                } else {
                    var {json} = api.getWorld({
                        worldId: L.worldId
                    });
                    if (json !== void 0) {
                        L.worldName = json.name;
                    }
                }
            }
        }
        // NOTE
        // 글자 수가 짧으면 업데이트가 안된다..
        var LL = this.lastLocation$;
        if (LL.worldName.length < 2) {
            LL.worldName += '\uFFA0'.repeat(2 - LL.worldName.length);
        }
        if (this.discordInstance) {
            Discord.SetText(LL.worldName, `#${LL.name} ${LL.accessType}`);
        } else {
            Discord.SetText(LL.worldName, '');
        }
        Discord.SetActive(this.discordActive);
    };

    $app.methods.lookupUser = async function(name) {
        for (var ref of api.userMap.values()) {
            if (ref.displayName === name) {
                this.showUserDialog(ref.id);
                return;
            }
        }
        this.searchText = name;
        await this.searchUser();
        for (var ref of this.searchUserResults) {
            if (ref.displayName === name) {
                this.searchText = '';
                this.clearSearch();
                this.showUserDialog(ref.id);
                return;
            }
        }
        this.$refs.searchTab.currentName = '0';
        this.$refs.menu.activeIndex = 'search';
    };

    // App: Search

    $app.data.searchText = '';
    $app.data.searchUserResults = [];
    $app.data.searchUserParams = {};
    $app.data.searchWorldResults = [];
    $app.data.searchWorldOption = '';
    $app.data.searchWorldParams = {};
    $app.data.searchAvatarResults = [];
    $app.data.searchAvatarParams = {};
    $app.data.isSearchUserLoading = false;
    $app.data.isSearchWorldLoading = false;
    $app.data.isSearchAvatarLoading = false;

    pubsub.subscribe('LOGIN', function() {
        $app.searchText = '';
        $app.searchUserResults = [];
        $app.searchUserParams = {};
        $app.searchWorldResults = [];
        $app.searchWorldOption = '';
        $app.searchWorldParams = {};
        $app.searchAvatarResults = [];
        $app.searchAvatarParams = {};
        $app.isSearchUserLoading = false;
        $app.isSearchWorldLoading = false;
        $app.isSearchAvatarLoading = false;
    });

    $app.methods.clearSearch = function() {
        this.searchUserResults = [];
        this.searchWorldResults = [];
        this.searchAvatarResults = [];
    };

    $app.methods.search = function() {
        this.searchUser();
        this.searchWorld({});
    };

    $app.methods.searchUser = async function() {
        this.searchUserParams = {
            n: 10,
            offset: 0,
            search: this.searchText
        };
        await this.moreSearchUser();
    };

    $app.methods.moreSearchUser = async function(go) {
        var params = this.searchUserParams;
        if (go) {
            params.offset += params.n * go;
            if (params.offset < 0) {
                params.offset = 0;
            }
        }
        this.isSearchUserLoading = true;
        try {
            var {json} = await api.getUsers(params);
            var map = new Map();
            for (var apiUser of json) {
                var ref = api.userMap.get(apiUser.id);
                if (ref !== void 0) {
                    map.set(ref.id, ref);
                }
            }
            this.searchUserResults = [...map.values()];
        } catch (err) {
            console.error(err);
        }
        this.isSearchUserLoading = false;
    };

    $app.methods.searchWorld = function(ref) {
        this.searchWorldOption = '';
        var params = {
            n: 10,
            offset: 0
        };
        switch (ref.sortHeading) {
            case 'featured':
                params.sort = 'order';
                params.featured = 'true';
                break;
            case 'trending':
                params.sort = 'popularity';
                params.featured = 'false';
                break;
            case 'updated':
                params.sort = 'updated';
                break;
            case 'created':
                params.sort = 'created';
                break;
            case 'publication':
                params.sort = 'publicationDate';
                break;
            case 'shuffle':
                params.sort = 'shuffle';
                break;
            case 'active':
                this.searchWorldOption = 'active';
                break;
            case 'recent':
                this.searchWorldOption = 'recent';
                break;
            case 'favorite':
                this.searchWorldOption = 'favorites';
                break;
            case 'labs':
                params.sort = 'labsPublicationDate';
                break;
            case 'heat':
                params.sort = 'heat';
                params.featured = 'false';
                break;
            default:
                params.sort = 'popularity';
                params.search = this.searchText;
                break;
        }
        params.order = ref.sortOrder || 'descending';
        if (ref.sortOwnership === 'mine') {
            params.user = 'me';
            params.releaseStatus = 'all';
        }
        if (ref.tag) {
            params.tag = ref.tag;
        }
        // TODO: option.platform
        this.searchWorldParams = params;
        this.moreSearchWorld();
    };

    $app.methods.moreSearchWorld = async function(go) {
        var params = this.searchWorldParams;
        if (go) {
            params.offset += params.n * go;
            if (params.offset < 0) {
                params.offset = 0;
            }
        }
        this.isSearchWorldLoading = true;
        try {
            var {json} = await api.getWorlds(params, this.searchWorldOption);
            var map = new Map();
            for (var apiWorld of json) {
                var ref = api.worldMap.get(apiWorld.id);
                if (ref !== void 0) {
                    map.set(ref.id, ref);
                }
            }
            this.searchWorldResults = [...map.values()];
        } catch (err) {
            console.error(err);
        }
        this.isSearchWorldLoading = false;
    };

    $app.methods.searchAvatar = function(option) {
        var params = {
            n: 10,
            offset: 0
        };
        switch (option) {
            case 'updated':
                params.sort = 'updated';
                break;
            case 'created':
                params.sort = 'created';
                break;
            case 'mine':
                params.user = 'me';
                params.releaseStatus = 'all';
                break;
            default:
                params.sort = 'popularity';
                params.search = this.searchText;
                break;
        }
        params.order = 'descending';
        // TODO: option.platform
        this.searchAvatarParams = params;
        this.moreSearchAvatar();
    };

    $app.methods.moreSearchAvatar = async function(go) {
        var params = this.searchAvatarParams;
        if (go) {
            params.offset += params.n * go;
            if (params.offset < 0) {
                params.offset = 0;
            }
        }
        this.isSearchAvatarLoading = true;
        try {
            var {json} = await api.getAvatars(params);
            var map = new Map();
            for (var apiAvatar of json) {
                var ref = api.avatarMap.get(apiAvatar.id);
                if (ref !== void 0) {
                    map.set(ref.id, ref);
                }
            }
            this.searchAvatarResults = Array.from(map.values());
        } catch (err) {
            console.error(err);
        }
        this.isSearchAvatarLoading = false;
    };

    // App: Favorite

    $app.data.favoriteObjects = new Map();
    $app.data.favoriteFriends_ = [];
    $app.data.favoriteWorlds_ = [];
    $app.data.favoriteAvatars_ = [];
    $app.data.sortFavoriteFriends = false;
    $app.data.sortFavoriteWorlds = false;
    $app.data.sortFavoriteAvatars = false;

    pubsub.subscribe('LOGIN', function() {
        $app.favoriteObjects.clear();
        $app.favoriteFriends_ = [];
        $app.favoriteWorlds_ = [];
        $app.favoriteAvatars_ = [];
        $app.sortFavoriteFriends = false;
        $app.sortFavoriteWorlds = false;
        $app.sortFavoriteAvatars = false;
    });

    pubsub.subscribe('FAVORITE', function(args) {
        $app.applyFavorite(args.ref.type, args.ref.favoriteId);
    });

    pubsub.subscribe('FAVORITE:@DELETE', function(args) {
        $app.applyFavorite(args.ref.type, args.ref.favoriteId);
    });

    pubsub.subscribe('USER', function(args) {
        $app.applyFavorite('friend', args.ref.id);
    });

    pubsub.subscribe('WORLD', function(args) {
        $app.applyFavorite('world', args.ref.id);
    });

    pubsub.subscribe('AVATAR', function(args) {
        $app.applyFavorite('avatar', args.ref.id);
    });

    $app.methods.applyFavorite = function(type, objectId) {
        var favorite = api.favoriteMapByObjectId.get(objectId);
        var ctx = this.favoriteObjects.get(objectId);
        if (favorite !== void 0) {
            var isTypeChanged = false;
            if (ctx === void 0) {
                ctx = {
                    id: objectId,
                    type,
                    groupKey: favorite.$groupKey,
                    ref: null,
                    name: ''
                };
                this.favoriteObjects.set(objectId, ctx);
                if (type === 'friend') {
                    var ref = api.userMap.get(objectId);
                    if (ref === void 0) {
                        ref = this.friendLog[objectId];
                        if (ref !== void 0 && ref.displayName) {
                            ctx.name = ref.displayName;
                        }
                    } else {
                        ctx.ref = ref;
                        ctx.name = ref.displayName;
                    }
                } else if (type === 'world') {
                    var ref = api.worldMap.get(objectId);
                    if (ref !== void 0) {
                        ctx.ref = ref;
                        ctx.name = ref.name;
                    }
                } else if (type === 'avatar') {
                    var ref = api.avatarMap.get(objectId);
                    if (ref !== void 0) {
                        ctx.ref = ref;
                        ctx.name = ref.name;
                    }
                }
                isTypeChanged = true;
            } else {
                if (ctx.type !== type) {
                    // WTF???
                    isTypeChanged = true;
                    if (type === 'friend') {
                        removeFromArray(this.favoriteFriends_, ctx);
                    } else if (type === 'world') {
                        removeFromArray(this.favoriteWorlds_, ctx);
                    } else if (type === 'avatar') {
                        removeFromArray(this.favoriteAvatars_, ctx);
                    }
                }
                if (type === 'friend') {
                    var ref = api.userMap.get(objectId);
                    if (ref !== void 0) {
                        if (ctx.ref !== ref) {
                            ctx.ref = ref;
                        }
                        if (ctx.name !== ref.displayName) {
                            ctx.name = ref.displayName;
                            this.sortFavoriteFriends = true;
                        }
                    }
                } else if (type === 'world') {
                    var ref = api.worldMap.get(objectId);
                    if (ref !== void 0) {
                        if (ctx.ref !== ref) {
                            ctx.ref = ref;
                        }
                        if (ctx.name !== ref.name) {
                            ctx.name = ref.name;
                            this.sortFavoriteWorlds = true;
                        }
                    }
                } else if (type === 'avatar') {
                    var ref = api.avatarMap.get(objectId);
                    if (ref !== void 0) {
                        if (ctx.ref !== ref) {
                            ctx.ref = ref;
                        }
                        if (ctx.name !== ref.name) {
                            ctx.name = ref.name;
                            this.sortFavoriteAvatars = true;
                        }
                    }
                }
            }
            if (isTypeChanged) {
                if (type === 'friend') {
                    this.favoriteFriends_.push(ctx);
                    this.sortFavoriteFriends = true;
                } else if (type === 'world') {
                    this.favoriteWorlds_.push(ctx);
                    this.sortFavoriteWorlds = true;
                } else if (type === 'avatar') {
                    this.favoriteAvatars_.push(ctx);
                    this.sortFavoriteAvatars = true;
                }
            }
        } else if (ctx !== void 0) {
            this.favoriteObjects.delete(objectId);
            if (type === 'friend') {
                removeFromArray(this.favoriteFriends_, ctx);
            } else if (type === 'world') {
                removeFromArray(this.favoriteWorlds_, ctx);
            } else if (type === 'avatar') {
                removeFromArray(this.favoriteAvatars_, ctx);
            }
        }
    };

    $app.methods.deleteFavorite = function(objectId) {
        // FIXME: 메시지 수정
        this.$confirm('Continue? Delete Favorite', 'Confirm', {
            confirmButtonText: 'Confirm',
            cancelButtonText: 'Cancel',
            type: 'info',
            callback: (action) => {
                if (action === 'confirm') {
                    api.deleteFavorite({
                        objectId
                    });
                }
            }
        });
    };

    $app.methods.changeFavoriteGroupName = function(ctx) {
        this.$prompt('Enter a new name', 'Change Group Name', {
            distinguishCancelAndClose: true,
            cancelButtonText: 'Cancel',
            confirmButtonText: 'Change',
            inputPlaceholder: 'Name',
            inputValue: ctx.displayName,
            inputPattern: /\S+/,
            inputErrorMessage: 'Name is required',
            callback: async (action, instance) => {
                if (action === 'confirm') {
                    try {
                        await api.saveFavoriteGroup({
                            type: ctx.type,
                            group: ctx.name,
                            displayName: instance.inputValue
                        });
                        this.$message({
                            message: 'Group renamed',
                            type: 'success'
                        });
                    } catch (err) {
                        console.error(err);
                    }
                }
            }
        });
    };

    $app.methods.clearFavoriteGroup = function(ctx) {
        // FIXME: 메시지 수정
        this.$confirm('Continue? Clear Group', 'Confirm', {
            confirmButtonText: 'Confirm',
            cancelButtonText: 'Cancel',
            type: 'info',
            callback: (action) => {
                if (action === 'confirm') {
                    api.clearFavoriteGroup({
                        type: ctx.type,
                        group: ctx.name
                    });
                }
            }
        });
    };

    $app.computed.favoriteFriends = function() {
        if (this.sortFavoriteFriends) {
            this.sortFavoriteFriends = false;
            this.favoriteFriends_.sort(compareByName);
        }
        return this.favoriteFriends_;
    };

    $app.computed.favoriteWorlds = function() {
        if (this.sortFavoriteWorlds) {
            this.sortFavoriteWorlds = false;
            this.favoriteWorlds_.sort(compareByName);
        }
        return this.favoriteWorlds_;
    };

    $app.computed.favoriteAvatars = function() {
        if (this.sortFavoriteAvatars) {
            this.sortFavoriteAvatars = false;
            this.favoriteAvatars_.sort(compareByName);
        }
        return this.favoriteAvatars_;
    };

    // App: friendLog

    $app.data.friendLog = {};
    $app.data.friendLogTable = {
        data: [],
        filters: [
            {
                prop: 'type',
                value: [],
                filterFn: (row, filter) =>
                    filter.value.some((v) => v === row.type)
            },
            {
                prop: 'displayName',
                value: ''
            }
        ],
        tableProps: {
            stripe: true,
            size: 'mini',
            defaultSort: {
                prop: 'created_at',
                order: 'descending'
            }
        },
        pageSize: 10,
        paginationProps: {
            small: true,
            layout: 'sizes,prev,pager,next,total',
            pageSizes: [10, 25, 50, 100]
        }
    };

    pubsub.subscribe('LOGIN', function(args) {
        $app.initFriendship(args.ref);
    });

    pubsub.subscribe('USER:CURRENT', function(args) {
        $app.updateFriendships(args.ref);
    });

    pubsub.subscribe('USER', function(args) {
        $app.updateFriendship(args.ref);
    });

    pubsub.subscribe('FRIEND:ADD', function(args) {
        $app.addFriendship(args.params.userId);
    });

    pubsub.subscribe('FRIEND:DELETE', function(args) {
        $app.deleteFriendship(args.params.userId);
    });

    pubsub.subscribe('FRIEND:REQUEST', function(args) {
        var ref = api.userMap.get(args.params.userId);
        if (ref === void 0) {
            return;
        }
        $app.friendLogTable.data.push({
            created_at: new Date().toJSON(),
            type: 'FriendRequest',
            userId: ref.id,
            displayName: ref.displayName
        });
        $app.saveFriendLog();
    });

    pubsub.subscribe('FRIEND:REQUEST:CANCEL', function(args) {
        var ref = api.userMap.get(args.params.userId);
        if (ref === void 0) {
            return;
        }
        $app.friendLogTable.data.push({
            created_at: new Date().toJSON(),
            type: 'CancelFriendRequst',
            userId: ref.id,
            displayName: ref.displayName
        });
        $app.saveFriendLog();
    });

    var saveFriendLogTimer = null;
    $app.methods.saveFriendLog = function() {
        if (saveFriendLogTimer !== null) {
            return;
        }
        this.updateSharedFeed(true);
        saveFriendLogTimer = setTimeout(() => {
            saveFriendLogTimer = null;
            VRCXStorage.SetObject(
                `${api.currentUser.id}_friendLog`,
                this.friendLog
            );
            VRCXStorage.SetArray(
                `${api.currentUser.id}_friendLogTable`,
                this.friendLogTable.data
            );
            VRCXStorage.Set(
                `${api.currentUser.id}_friendLogUpdatedAt`,
                new Date().toJSON()
            );
        }, 1);
    };

    $app.methods.initFriendship = function(ref) {
        if (VRCXStorage.Get(`${ref.id}_friendLogUpdatedAt`)) {
            this.friendLog = VRCXStorage.GetObject(`${ref.id}_friendLog`);
            this.friendLogTable.data = VRCXStorage.GetArray(
                `${ref.id}_friendLogTable`
            );
        } else {
            var friendLog = {};
            for (var id of ref.friends) {
                // DO NOT set displayName,
                // it's flag about it's new friend
                var ctx = {
                    id
                };
                var user = api.userMap.get(id);
                if (user !== void 0) {
                    ctx.displayName = user.displayName;
                    ctx.trustLevel = user.$trustLevel;
                }
                friendLog[id] = ctx;
            }
            this.friendLog = friendLog;
            this.friendLogTable.data = [];
            this.saveFriendLog();
        }
    };

    $app.methods.addFriendship = function(id) {
        if (this.friendLog[id] !== void 0) {
            return;
        }
        var ctx = {
            id,
            displayName: null,
            trustLevel: null
        };
        Vue.set(this.friendLog, id, ctx);
        var ref = api.userMap.get(id);
        if (ref !== void 0) {
            ctx.displayName = ref.displayName;
            ctx.trustLevel = ref.$trustLevel;
            this.friendLogTable.data.push({
                created_at: new Date().toJSON(),
                type: 'Friend',
                userId: ref.id,
                displayName: ctx.displayName
            });
        }
        this.saveFriendLog();
        this.notifyMenu('friendLog');
    };

    $app.methods.deleteFriendship = function(id) {
        var ctx = this.friendLog[id];
        if (ctx === void 0) {
            return;
        }
        Vue.delete(this.friendLog, id);
        this.friendLogTable.data.push({
            created_at: new Date().toJSON(),
            type: 'Unfriend',
            userId: id,
            displayName: ctx.displayName
        });
        this.saveFriendLog();
        this.notifyMenu('friendLog');
    };

    $app.methods.updateFriendships = function(ref) {
        var set = new Set();
        for (var id of ref.friends) {
            set.add(id);
            this.addFriendship(id);
        }
        for (var id in this.friendLog) {
            if (set.has(id) === false) {
                api.deleteFriendship(id);
            }
        }
    };

    $app.methods.updateFriendship = function(ref) {
        var ctx = this.friendLog[ref.id];
        if (ctx === void 0) {
            return;
        }
        if (ctx.displayName !== ref.displayName) {
            if (ctx.displayName) {
                this.friendLogTable.data.push({
                    created_at: new Date().toJSON(),
                    type: 'DisplayName',
                    userId: ref.id,
                    displayName: ref.displayName,
                    previousDisplayName: ctx.displayName
                });
            } else if (ctx.displayName === null) {
                this.friendLogTable.data.push({
                    created_at: new Date().toJSON(),
                    type: 'Friend',
                    userId: ref.id,
                    displayName: ref.displayName
                });
            }
            ctx.displayName = ref.displayName;
            this.saveFriendLog();
            this.notifyMenu('friendLog');
        }
        if (ref.$trustLevel && ctx.trustLevel !== ref.$trustLevel) {
            if (ctx.trustLevel) {
                this.friendLogTable.data.push({
                    created_at: new Date().toJSON(),
                    type: 'TrustLevel',
                    userId: ref.id,
                    displayName: ref.displayName,
                    trustLevel: ref.$trustLevel,
                    previousTrustLevel: ctx.trustLevel
                });
            }
            ctx.trustLevel = ref.$trustLevel;
            this.saveFriendLog();
            this.notifyMenu('friendLog');
        }
    };

    $app.methods.deleteFriendLog = function(row) {
        // FIXME: 메시지 수정
        this.$confirm('Continue? Delete Log', 'Confirm', {
            confirmButtonText: 'Confirm',
            cancelButtonText: 'Cancel',
            type: 'info',
            callback: (action) => {
                if (
                    action === 'confirm' &&
                    removeFromArray(this.friendLogTable.data, row)
                ) {
                    this.saveFriendLog();
                }
            }
        });
    };

    // App: Moderation

    $app.data.playerModerationTable = {
        data: [],
        lastRunLength: 0,
        filters: [
            {
                prop: 'type',
                value: [],
                filterFn: (row, filter) =>
                    filter.value.some((v) => v === row.type)
            },
            {
                prop: ['sourceDisplayName', 'targetDisplayName'],
                value: ''
            }
        ],
        tableProps: {
            stripe: true,
            size: 'mini',
            defaultSort: {
                prop: 'created',
                order: 'descending'
            }
        },
        pageSize: 10,
        paginationProps: {
            small: true,
            layout: 'sizes,prev,pager,next,total',
            pageSizes: [10, 25, 50, 100]
        }
    };

    pubsub.subscribe('LOGIN', function() {
        $app.playerModerationTable.data = [];
    });

    pubsub.subscribe('PLAYER-MODERATION', function(args) {
        var {ref} = args;
        var array = $app.playerModerationTable.data;
        var {length} = array;
        for (var i = 0; i < length; ++i) {
            if (array[i].id === ref.id) {
                if (ref.$isDeleted) {
                    array.splice(i, 1);
                } else {
                    Vue.set(array, i, ref);
                }
                return;
            }
        }
        if (ref.$isDeleted === false) {
            $app.playerModerationTable.data.push(ref);
        }
    });

    pubsub.subscribe('PLAYER-MODERATION:@DELETE', function(args) {
        var {ref} = args;
        var array = $app.playerModerationTable.data;
        var {length} = array;
        for (var i = 0; i < length; ++i) {
            if (array[i].id === ref.id) {
                array.splice(i, 1);
                return;
            }
        }
    });

    $app.methods.deletePlayerModeration = function(row) {
        // FIXME: 메시지 수정
        this.$confirm('Continue? Delete Moderation', 'Confirm', {
            confirmButtonText: 'Confirm',
            cancelButtonText: 'Cancel',
            type: 'info',
            callback: (action) => {
                if (action === 'confirm') {
                    api.deletePlayerModeration({
                        moderated: row.targetUserId,
                        type: row.type
                    });
                }
            }
        });
    };

    // App: Notification

    $app.data.notificationTable = {
        data: [],
        filters: [
            {
                prop: 'type',
                value: [],
                filterFn: (row, filter) =>
                    filter.value.some((v) => v === row.type)
            },
            {
                prop: 'senderUsername',
                value: ''
            }
        ],
        tableProps: {
            stripe: true,
            size: 'mini',
            defaultSort: {
                prop: 'created_at',
                order: 'descending'
            }
        },
        pageSize: 10,
        paginationProps: {
            small: true,
            layout: 'sizes,prev,pager,next,total',
            pageSizes: [10, 25, 50, 100]
        }
    };

    pubsub.subscribe('LOGIN', function() {
        $app.notificationTable.data = [];
    });

    $app.data.unseenNotifications = [];

    pubsub.subscribe('NOTIFICATION:REFRESH', function(args) {
        $app.unseenNotifications = [];
    });

    pubsub.subscribe('NOTIFICATION', function(args) {
        var {ref} = args;
        var array = $app.notificationTable.data;
        var {length} = array;
        for (var i = 0; i < length; ++i) {
            if (array[i].id === ref.id) {
                if (ref.$isDeleted) {
                    array.splice(i, 1);
                } else {
                    Vue.set(array, i, ref);
                }
                return;
            }
        }
        if (ref.$isDeleted === false) {
            $app.notificationTable.data.push(ref);
            if (ref.senderUserId !== api.currentUser.id) {
                $app.notifyMenu('notification');
                $app.unseenNotifications.push(ref.id);
            }
        }
        $app.updateSharedFeed(true);
    });

    pubsub.subscribe('NOTIFICATION:SEE', function(args) {
        var {notificationId} = args.params;
        removeFromArray($app.unseenNotifications, notificationId);
        if ($app.unseenNotifications.length === 0) {
            $app.selectMenu('notification');
        }
    });

    pubsub.subscribe('NOTIFICATION:@DELETE', function(args) {
        var {ref} = args;
        var array = $app.notificationTable.data;
        var {length} = array;
        for (var i = 0; i < length; ++i) {
            if (array[i].id === ref.id) {
                array.splice(i, 1);
                return;
            }
        }
    });

    $app.methods.acceptNotification = function(row) {
        // FIXME: 메시지 수정
        this.$confirm('Continue? Accept Friend Request', 'Confirm', {
            confirmButtonText: 'Confirm',
            cancelButtonText: 'Cancel',
            type: 'info',
            callback: (action) => {
                if (action === 'confirm') {
                    api.acceptNotification({
                        notificationId: row.id
                    });
                }
            }
        });
    };

    $app.methods.hideNotification = function(row) {
        // FIXME: 메시지 수정
        this.$confirm('Continue? Delete Notification', 'Confirm', {
            confirmButtonText: 'Confirm',
            cancelButtonText: 'Cancel',
            type: 'info',
            callback: (action) => {
                if (action === 'confirm') {
                    api.hideNotification({
                        notificationId: row.id
                    });
                }
            }
        });
    };

    $app.methods.parseInviteLocation = function(ref) {
        try {
            var L = parseLocation(ref.details.worldId);
            if (L.worldId && L.instanceId) {
                return `${ref.details.worldName} #${L.name} ${L.accessType}`;
            }
            return ref.message || ref.details.worldId || ref.details.worldName;
        } catch (err) {
            return '';
        }
    };

    // App: Profile + Settings

    $app.data.configTreeData = [];
    $app.data.currentUserTreeData = [];
    $app.data.pastDisplayNameTable = {
        data: [],
        tableProps: {
            stripe: true,
            size: 'mini',
            defaultSort: {
                prop: 'updated_at',
                order: 'descending'
            }
        },
        layout: 'table'
    };
    $app.data.VRCPlusIconsTable = {};
    $app.data.inviteMessageTable = {
        visible: false,
        data: [],
        tableProps: {
            stripe: true,
            size: 'mini'
        },
        layout: 'table'
    };
    $app.data.inviteResponseMessageTable = {
        visible: false,
        data: [],
        tableProps: {
            stripe: true,
            size: 'mini'
        },
        layout: 'table'
    };
    $app.data.inviteRequestMessageTable = {
        visible: false,
        data: [],
        tableProps: {
            stripe: true,
            size: 'mini'
        },
        layout: 'table'
    };
    $app.data.inviteRequestResponseMessageTable = {
        visible: false,
        data: [],
        tableProps: {
            stripe: true,
            size: 'mini'
        },
        layout: 'table'
    };
    $app.data.friendsListTable = {
        visible: false,
        data: [],
        tableProps: {
            stripe: true,
            size: 'mini',
            defaultSort: {
                prop: '$friendNum',
                order: 'descending'
            }
        },
        pageSize: 100,
        paginationProps: {
            small: true,
            layout: 'sizes,prev,pager,next,total',
            pageSizes: [50, 100, 250, 500]
        }
    };
    $app.data.downloadHistoryTable = {
        data: [],
        tableProps: {
            stripe: true,
            size: 'mini'
        },
        pageSize: 10,
        paginationProps: {
            small: true,
            layout: 'prev,pager,next',
            pageSizes: [10, 25, 50, 100]
        }
    };
    $app.data.downloadQueueTable = {
        data: [],
        tableProps: {
            stripe: true,
            size: 'mini'
        },
        layout: 'table'
    };
    $app.data.socialStatusHistoryTable = {
        data: [],
        tableProps: {
            stripe: true,
            size: 'mini'
        },
        layout: 'table'
    };
    $app.data.visits = 0;
    $app.data.openVR = configRepository.getBool('openVR');
    $app.data.openVRAlways = configRepository.getBool('openVRAlways');
    $app.data.overlaybutton = configRepository.getBool('VRCX_overlaybutton');
    $app.data.hidePrivateFromFeed = configRepository.getBool(
        'VRCX_hidePrivateFromFeed'
    );
    $app.data.hideDevicesFromFeed = configRepository.getBool(
        'VRCX_hideDevicesFromFeed'
    );
    $app.data.overlayNotifications = configRepository.getBool(
        'VRCX_overlayNotifications'
    );
    $app.data.overlayWrist = configRepository.getBool('VRCX_overlayWrist');
    $app.data.xsNotifications = configRepository.getBool(
        'VRCX_xsNotifications'
    );
    $app.data.desktopToast = configRepository.getString('VRCX_desktopToast');
    $app.data.minimalFeed = configRepository.getBool('VRCX_minimalFeed');
    $app.data.displayVRCPlusIconsAsAvatar = configRepository.getBool(
        'displayVRCPlusIconsAsAvatar'
    );
    $app.data.notificationTTS = configRepository.getString(
        'VRCX_notificationTTS'
    );
    $app.data.notificationTTSVoice = configRepository.getString(
        'VRCX_notificationTTSVoice'
    );
    $app.data.notificationTimeout = configRepository.getString(
        'VRCX_notificationTimeout'
    );
    $app.data.worldAutoCacheInvite = configRepository.getString(
        'VRCX_worldAutoCacheInvite'
    );
    $app.data.worldAutoCacheGPS = configRepository.getString(
        'VRCX_worldAutoCacheGPS'
    );
    $app.data.worldAutoCacheInviteFilter = configRepository.getBool(
        'VRCX_worldAutoCacheInviteFilter'
    );
    $app.data.worldAutoCacheGPSFilter = configRepository.getBool(
        'VRCX_worldAutoCacheGPSFilter'
    );
    $app.data.autoSweepVRChatCache = configRepository.getBool(
        'VRCX_autoSweepVRChatCache'
    );
    var saveOpenVROption = function() {
        configRepository.setBool('openVR', this.openVR);
        configRepository.setBool('openVRAlways', this.openVRAlways);
        configRepository.setBool('VRCX_overlaybutton', this.overlaybutton);
        configRepository.setBool(
            'VRCX_hidePrivateFromFeed',
            this.hidePrivateFromFeed
        );
        configRepository.setBool(
            'VRCX_hideDevicesFromFeed',
            this.hideDevicesFromFeed
        );
        configRepository.setBool(
            'VRCX_overlayNotifications',
            this.overlayNotifications
        );
        configRepository.setBool('VRCX_overlayWrist', this.overlayWrist);
        configRepository.setBool('VRCX_xsNotifications', this.xsNotifications);
        configRepository.setString('VRCX_desktopToast', this.desktopToast);
        configRepository.setBool('VRCX_minimalFeed', this.minimalFeed);
        configRepository.setBool(
            'displayVRCPlusIconsAsAvatar',
            this.displayVRCPlusIconsAsAvatar
        );
        configRepository.setString(
            'VRCX_worldAutoCacheInvite',
            this.worldAutoCacheInvite
        );
        configRepository.setString(
            'VRCX_worldAutoCacheGPS',
            this.worldAutoCacheGPS
        );
        configRepository.setBool(
            'VRCX_worldAutoCacheInviteFilter',
            this.worldAutoCacheInviteFilter
        );
        configRepository.setBool(
            'VRCX_worldAutoCacheGPSFilter',
            this.worldAutoCacheGPSFilter
        );
        configRepository.setBool(
            'VRCX_autoSweepVRChatCache',
            this.autoSweepVRChatCache
        );
        this.updateVRConfigVars();
    };
    $app.data.TTSvoices = speechSynthesis.getVoices();
    var saveNotificationTTS = function() {
        speechSynthesis.cancel();
        if (
            configRepository.getString('VRCX_notificationTTS') === 'Never' &&
            this.notificationTTS !== 'Never'
        ) {
            this.speak('Notification text-to-speech enabled');
        }
        configRepository.setString(
            'VRCX_notificationTTS',
            this.notificationTTS
        );
        this.updateVRConfigVars();
    };
    $app.watch.openVR = saveOpenVROption;
    $app.watch.openVRAlways = saveOpenVROption;
    $app.watch.overlaybutton = saveOpenVROption;
    $app.watch.hidePrivateFromFeed = saveOpenVROption;
    $app.watch.hideDevicesFromFeed = saveOpenVROption;
    $app.watch.overlayNotifications = saveOpenVROption;
    $app.watch.overlayWrist = saveOpenVROption;
    $app.watch.xsNotifications = saveOpenVROption;
    $app.watch.desktopToast = saveOpenVROption;
    $app.watch.minimalFeed = saveOpenVROption;
    $app.watch.displayVRCPlusIconsAsAvatar = saveOpenVROption;
    $app.watch.worldAutoCacheInvite = saveOpenVROption;
    $app.watch.worldAutoCacheGPS = saveOpenVROption;
    $app.watch.worldAutoCacheInviteFilter = saveOpenVROption;
    $app.watch.worldAutoCacheGPSFilter = saveOpenVROption;
    $app.watch.autoSweepVRChatCache = saveOpenVROption;
    $app.watch.notificationTTS = saveNotificationTTS;
    if (configRepository.getBool('isDarkMode') === true) {
        document.getElementsByTagName('body')[0].classList.add('dark');
        $app.data.isDarkMode = true;
    } else {
        $app.data.isDarkMode = false;
    }
    $app.watch.isDarkMode = function() {
        configRepository.setBool('isDarkMode', this.isDarkMode);
        if ($app.isDarkMode === true) {
            document.getElementsByTagName('body')[0].classList.add('dark');
        } else {
            document.getElementsByTagName('body')[0].classList.remove('dark');
        }
        this.updateVRConfigVars();
    };
    $app.data.isStartAtWindowsStartup = configRepository.getBool(
        'VRCX_StartAtWindowsStartup'
    );
    $app.data.isStartAsMinimizedState =
        VRCXStorage.Get('VRCX_StartAsMinimizedState') === 'true';
    $app.data.isCloseToTray = configRepository.getBool('VRCX_CloseToTray');
    $app.data.isAutoLogin = configRepository.getBool('VRCX_AutoLogin');
    var saveVRCXWindowOption = function() {
        configRepository.setBool(
            'VRCX_StartAtWindowsStartup',
            this.isStartAtWindowsStartup
        );
        VRCXStorage.Set(
            'VRCX_StartAsMinimizedState',
            this.isStartAsMinimizedState.toString()
        );
        configRepository.setBool('VRCX_CloseToTray', this.isCloseToTray);
        AppApi.SetStartup(this.isStartAtWindowsStartup);
        configRepository.setBool('VRCX_AutoLogin', this.isAutoLogin);
    };
    $app.watch.isStartAtWindowsStartup = saveVRCXWindowOption;
    $app.watch.isStartAsMinimizedState = saveVRCXWindowOption;
    $app.watch.isCloseToTray = saveVRCXWindowOption;
    $app.watch.isAutoLogin = saveVRCXWindowOption;

    // setting defaults
    if (configRepository.getBool('displayVRCPlusIconsAsAvatar') === null) {
        $app.data.displayVRCPlusIconsAsAvatar = true;
        configRepository.setBool(
            'displayVRCPlusIconsAsAvatar',
            $app.data.displayVRCPlusIconsAsAvatar
        );
    }
    if (!configRepository.getString('VRCX_notificationPosition')) {
        $app.data.notificationPosition = 'topCenter';
        configRepository.setString(
            'VRCX_notificationPosition',
            $app.data.notificationPosition
        );
    }
    if (!configRepository.getString('VRCX_notificationTimeout')) {
        $app.data.notificationTimeout = 3000;
        configRepository.setString(
            'VRCX_notificationTimeout',
            $app.data.notificationTimeout
        );
    }
    if (!configRepository.getString('VRCX_notificationTTSVoice')) {
        $app.data.notificationTTSVoice = '0';
        configRepository.setString(
            'VRCX_notificationTTSVoice',
            $app.data.notificationTTSVoice
        );
    }
    if (!configRepository.getString('VRCX_desktopToast')) {
        $app.data.desktopToast = 'Never';
        configRepository.setString('VRCX_desktopToast', $app.data.desktopToast);
    }
    if (!configRepository.getString('VRCX_notificationTTS')) {
        $app.data.notificationTTS = 'Never';
        configRepository.setString(
            'VRCX_notificationTTS',
            $app.data.notificationTTS
        );
    }
    if (!configRepository.getString('VRCX_worldAutoCacheInvite')) {
        $app.data.worldAutoCacheInvite = 'Never';
        configRepository.setString(
            'VRCX_worldAutoCacheInvite',
            $app.data.worldAutoCacheInvite
        );
    }
    if (!configRepository.getString('VRCX_worldAutoCacheGPS')) {
        $app.data.worldAutoCacheGPS = 'Never';
        configRepository.setString(
            'VRCX_worldAutoCacheGPS',
            $app.data.worldAutoCacheGPS
        );
    }
    if (!configRepository.getString('sharedFeedFilters')) {
        var sharedFeedFilters = {
            noty: {
                Location: 'Off',
                OnPlayerJoined: 'VIP',
                OnPlayerLeft: 'VIP',
                OnPlayerJoining: 'Off',
                Online: 'VIP',
                Offline: 'VIP',
                GPS: 'Off',
                Status: 'Off',
                invite: 'Friends',
                requestInvite: 'Friends',
                inviteResponse: 'Friends',
                requestInviteResponse: 'Friends',
                friendRequest: 'On',
                Friend: 'On',
                Unfriend: 'On',
                DisplayName: 'VIP',
                TrustLevel: 'VIP',
                PortalSpawn: 'Everyone',
                Event: 'On',
                VideoPlay: 'On',
                BlockedOnPlayerJoined: 'Off',
                BlockedOnPlayerLeft: 'Off',
                MutedOnPlayerJoined: 'Off',
                MutedOnPlayerLeft: 'Off'
            },
            wrist: {
                Location: 'On',
                OnPlayerJoined: 'Everyone',
                OnPlayerLeft: 'Everyone',
                OnPlayerJoining: 'Friends',
                Online: 'Friends',
                Offline: 'Friends',
                GPS: 'Friends',
                Status: 'Friends',
                invite: 'Friends',
                requestInvite: 'Friends',
                inviteResponse: 'Friends',
                requestInviteResponse: 'Friends',
                friendRequest: 'On',
                Friend: 'On',
                Unfriend: 'On',
                DisplayName: 'Friends',
                TrustLevel: 'Friends',
                PortalSpawn: 'Everyone',
                Event: 'On',
                VideoPlay: 'On',
                BlockedOnPlayerJoined: 'Off',
                BlockedOnPlayerLeft: 'Off',
                MutedOnPlayerJoined: 'Off',
                MutedOnPlayerLeft: 'Off'
            }
        };
        configRepository.setString(
            'sharedFeedFilters',
            JSON.stringify(sharedFeedFilters)
        );
    }
    $app.data.sharedFeedFilters = JSON.parse(
        configRepository.getString('sharedFeedFilters')
    );

    var toggleSwitchLayout = {
        backgroundColor: 'white',
        selectedBackgroundColor: '#409eff',
        selectedColor: 'white',
        color: '#409eff',
        borderColor: '#409eff',
        fontWeight: 'bold',
        fontFamily:
            '"Noto Sans JP", "Noto Sans KR", "Meiryo UI", "Malgun Gothic", "Segoe UI", "sans-serif"'
    };

    $app.data.toggleSwitchOptionsEveryone = {
        layout: toggleSwitchLayout,
        size: {
            height: 1.5,
            width: 15,
            padding: 0.1,
            fontSize: 0.75
        },
        items: {
            labels: [
                {name: 'Off'},
                {name: 'VIP'},
                {name: 'Friends'},
                {name: 'Everyone'}
            ]
        }
    };
    $app.data.toggleSwitchOptionsFriends = {
        layout: toggleSwitchLayout,
        size: {
            height: 1.5,
            width: 11.25,
            padding: 0.1,
            fontSize: 0.75
        },
        items: {
            labels: [{name: 'Off'}, {name: 'VIP'}, {name: 'Friends'}]
        }
    };
    $app.data.toggleSwitchOptionsOn = {
        layout: toggleSwitchLayout,
        size: {
            height: 1.5,
            width: 7.5,
            padding: 0.1,
            fontSize: 0.75
        },
        items: {
            labels: [{name: 'Off'}, {name: 'On'}]
        }
    };
    $app.data.whenToPlayToggleSwitchOption = {
        layout: toggleSwitchLayout,
        size: {
            height: 1.5,
            width: 33,
            padding: 0.1,
            fontSize: 0.75
        },
        items: {
            labels: [
                {name: 'Never'},
                {name: 'Desktop Mode'},
                {name: 'Outside VR'},
                {name: 'Inside VR'},
                {name: 'Game Closed'},
                {name: 'Always'}
            ]
        }
    };
    $app.data.worldCacheToggleSwitchOption = {
        layout: toggleSwitchLayout,
        size: {
            height: 1.5,
            width: 23,
            padding: 0.1,
            fontSize: 0.75
        },
        items: {
            labels: [
                {name: 'Never'},
                {name: 'Game Closed'},
                {name: 'Game Running'},
                {name: 'Always'}
            ]
        }
    };

    if (!configRepository.getString('VRCX_trustColor')) {
        var trustColor = {
            untrusted: '#CCCCCC',
            basic: '#1778FF',
            known: '#2BCF5C',
            trusted: '#FF7B42',
            veteran: '#B18FFF',
            legend: '#FFD000',
            legendary: '#FF69B4',
            vip: '#FF2626',
            troll: '#782F2F'
        };
        configRepository.setString(
            'VRCX_trustColor',
            JSON.stringify(trustColor)
        );
    }
    $app.data.trustColor = JSON.parse(
        configRepository.getString('VRCX_trustColor')
    );

    $app.data.trustColorSwatches = [
        '#CCCCCC',
        '#1778FF',
        '#2BCF5C',
        '#FF7B42',
        '#B18FFF',
        '#FFD000',
        '#FF69B4',
        '#ABCDEF',
        '#8143E6',
        '#B52626',
        '#FF2626',
        '#782F2F'
    ];

    $app.methods.updatetrustColor = function() {
        var trustColor = $app.trustColor;
        if (trustColor) {
            configRepository.setString(
                'VRCX_trustColor',
                JSON.stringify(trustColor)
            );
        } else {
            trustColor = JSON.parse(
                configRepository.getString('VRCX_trustColor')
            );
            $app.trustColor = trustColor;
        }
        if (document.getElementById('trustColor') !== null) {
            document.getElementById('trustColor').outerHTML = '';
        }
        var style = document.createElement('style');
        style.id = 'trustColor';
        style.type = 'text/css';
        var newCSS = '';
        for (var rank in trustColor) {
            newCSS += `.x-tag-${rank} { color: ${trustColor[rank]} !important; border-color: ${trustColor[rank]} !important; } `;
        }
        style.innerHTML = newCSS;
        document.getElementsByTagName('head')[0].appendChild(style);
    };
    $app.methods.updatetrustColor();
    $app.watch['trustColor.untrusted'] = $app.methods.updatetrustColor;
    $app.watch['trustColor.basic'] = $app.methods.updatetrustColor;
    $app.watch['trustColor.known'] = $app.methods.updatetrustColor;
    $app.watch['trustColor.trusted'] = $app.methods.updatetrustColor;
    $app.watch['trustColor.veteran'] = $app.methods.updatetrustColor;
    $app.watch['trustColor.legend'] = $app.methods.updatetrustColor;
    $app.watch['trustColor.legendary'] = $app.methods.updatetrustColor;
    $app.watch['trustColor.vip'] = $app.methods.updatetrustColor;
    $app.watch['trustColor.troll'] = $app.methods.updatetrustColor;

    $app.methods.saveSharedFeedFilters = function() {
        this.notyFeedFiltersDialog.visible = false;
        this.wristFeedFiltersDialog.visible = false;
        configRepository.setString(
            'sharedFeedFilters',
            JSON.stringify(this.sharedFeedFilters)
        );
        this.updateVRConfigVars();
    };

    $app.methods.cancelSharedFeedFilters = function() {
        this.notyFeedFiltersDialog.visible = false;
        this.wristFeedFiltersDialog.visible = false;
        this.sharedFeedFilters = JSON.parse(
            configRepository.getString('sharedFeedFilters')
        );
    };

    $app.data.notificationPosition = configRepository.getString(
        'VRCX_notificationPosition'
    );
    $app.methods.changeNotificationPosition = function() {
        configRepository.setString(
            'VRCX_notificationPosition',
            this.notificationPosition
        );
        this.updateVRConfigVars();
    };

    sharedRepository.setBool('is_game_running', false);
    var isGameRunningStateChange = function() {
        sharedRepository.setBool('is_game_running', this.isGameRunning);
        this.lastLocation = {
            date: 0,
            location: '',
            name: '',
            playerList: [],
            friendList: []
        };
        if (this.isGameRunning) {
            api.currentUser.$online_for = Date.now();
            api.currentUser.$offline_for = '';
        } else {
            api.currentUser.$online_for = '';
            api.currentUser.$offline_for = Date.now();
            this.autoVRChatCacheManagement();
        }
    };
    $app.watch.isGameRunning = isGameRunningStateChange;

    sharedRepository.setBool('is_Game_No_VR', false);
    var isGameNoVRStateChange = function() {
        sharedRepository.setBool('is_Game_No_VR', this.isGameNoVR);
    };
    $app.watch.isGameNoVR = isGameNoVRStateChange;

    var lastLocationStateChange = function() {
        sharedRepository.setObject('last_location', $app.lastLocation);
        $app.checkVRChatCacheDownload($app.lastLocation.location);
    };
    $app.watch['lastLocation.location'] = lastLocationStateChange;

    $app.methods.updateVRConfigVars = function() {
        if (configRepository.getBool('isDarkMode')) {
            var notificationTheme = 'sunset';
        } else {
            var notificationTheme = 'relax';
        }
        var VRConfigVars = {
            notificationTTS: this.notificationTTS,
            notificationTTSVoice: this.notificationTTSVoice,
            overlayNotifications: this.overlayNotifications,
            hideDevicesFromFeed: this.hideDevicesFromFeed,
            minimalFeed: this.minimalFeed,
            displayVRCPlusIconsAsAvatar: this.displayVRCPlusIconsAsAvatar,
            notificationPosition: this.notificationPosition,
            notificationTimeout: this.notificationTimeout,
            notificationTheme
        };
        sharedRepository.setObject('VRConfigVars', VRConfigVars);
        this.updateSharedFeed(true);
    };

    pubsub.subscribe('LOGIN', function() {
        $app.updateVRConfigVars();
    });

    pubsub.subscribe('LOGIN', function() {
        $app.currentUserTreeData = [];
        $app.pastDisplayNameTable.data = [];
    });

    pubsub.subscribe('USER:CURRENT', function(args) {
        if (args.ref.pastDisplayNames) {
            $app.pastDisplayNameTable.data = args.ref.pastDisplayNames;
        }
    });

    pubsub.subscribe('VISITS', function(args) {
        $app.visits = args;
    });

    $app.methods.logout = function() {
        this.$confirm('Continue? Logout', 'Confirm', {
            confirmButtonText: 'Confirm',
            cancelButtonText: 'Cancel',
            type: 'info',
            callback: (action) => {
                if (action === 'confirm') {
                    api.logout();
                }
            }
        });
    };

    $app.methods.resetHome = function() {
        this.$confirm('Continue? Reset Home', 'Confirm', {
            confirmButtonText: 'Confirm',
            cancelButtonText: 'Cancel',
            type: 'info',
            callback: async (action) => {
                if (action === 'confirm') {
                    try {
                        await api.saveCurrentUser({
                            homeLocation: ''
                        });
                        this.$message({
                            message: 'Home world has been reset',
                            type: 'success'
                        });
                    } catch (err) {
                        console.error(err);
                    }
                }
            }
        });
    };

    $app.methods.updateOpenVR = function() {
        if (
            this.openVR &&
            this.isGameNoVR === false &&
            (this.isGameRunning || this.openVRAlways)
        ) {
            AppApi.StartVR();
        } else {
            AppApi.StopVR();
        }
    };

    $app.methods.changeTTSVoice = function(index) {
        this.notificationTTSVoice = index;
        configRepository.setString(
            'VRCX_notificationTTSVoice',
            this.notificationTTSVoice
        );
        var voices = speechSynthesis.getVoices();
        var voiceName = voices[index].name;
        speechSynthesis.cancel();
        this.speak(voiceName);
        this.updateVRConfigVars();
    };

    $app.methods.speak = function(text) {
        var tts = new SpeechSynthesisUtterance();
        var voices = speechSynthesis.getVoices();
        tts.voice = voices[this.notificationTTSVoice];
        tts.text = text;
        speechSynthesis.speak(tts);
    };

    $app.methods.refreshConfigTreeData = function() {
        this.configTreeData = buildTreeData(api.config);
    };

    $app.methods.refreshCurrentUserTreeData = function() {
        api.currentUserTreeData = buildTreeData(api.currentUser);
    };

    $app.methods.promptUserDialog = function() {
        this.$prompt('Enter a User ID (UUID)', 'Direct Access', {
            distinguishCancelAndClose: true,
            confirmButtonText: 'OK',
            cancelButtonText: 'Cancel',
            inputPattern: /\S+/,
            inputErrorMessage: 'User ID is required',
            callback: (action, instance) => {
                if (action === 'confirm' && instance.inputValue) {
                    this.showUserDialog(instance.inputValue);
                }
            }
        });
    };

    $app.methods.promptWorldDialog = function() {
        this.$prompt('Enter a World URL or ID (UUID)', 'Direct Access', {
            distinguishCancelAndClose: true,
            confirmButtonText: 'OK',
            cancelButtonText: 'Cancel',
            inputPattern: /\S+/,
            inputErrorMessage: 'World URL/ID is required',
            callback: (action, instance) => {
                if (action === 'confirm' && instance.inputValue) {
                    var testUrl = instance.inputValue.substring(0, 15);
                    if (testUrl === 'https://vrchat.') {
                        var worldInstance = parseLocationUrl(
                            instance.inputValue
                        );
                        this.showWorldDialog(worldInstance);
                    } else {
                        this.showWorldDialog(instance.inputValue);
                    }
                }
            }
        });
    };

    $app.methods.promptSelectAvatarDialog = function() {
        this.$prompt('Enter a Avatar ID (UUID)', 'Select avatar', {
            distinguishCancelAndClose: true,
            confirmButtonText: 'OK',
            cancelButtonText: 'Cancel',
            inputPattern: /\S+/,
            inputErrorMessage: 'Avatar ID is required',
            callback: async (action, instance) => {
                if (action === 'confirm' && instance.inputValue) {
                    try {
                        await api.selectAvatar({
                            avatarId: instance.inputValue
                        });
                        this.$message({
                            message: 'Avatar changed',
                            type: 'success'
                        });
                    } catch (err) {
                        console.error(err);
                    }
                }
            }
        });
    };

    $app.methods.promptNotificationTimeout = function() {
        this.$prompt('Enter amount of seconds', 'Notification Timeout', {
            distinguishCancelAndClose: true,
            confirmButtonText: 'OK',
            cancelButtonText: 'Cancel',
            inputValue: this.notificationTimeout / 1000,
            inputPattern: /\d+$/,
            inputErrorMessage: 'Valid number is required',
            callback: (action, instance) => {
                if (
                    action === 'confirm' &&
                    instance.inputValue &&
                    !isNaN(instance.inputValue)
                ) {
                    this.notificationTimeout = Math.trunc(
                        Number(instance.inputValue) * 1000
                    );
                    configRepository.setString(
                        'VRCX_notificationTimeout',
                        this.notificationTimeout
                    );
                }
            }
        });
    };

    $app.methods.promptRenameAvatar = function(avatar) {
        this.$prompt('Enter avatar name', 'Rename Avatar', {
            distinguishCancelAndClose: true,
            confirmButtonText: 'OK',
            cancelButtonText: 'Cancel',
            inputValue: avatar.ref.name,
            inputErrorMessage: 'Valid name is required',
            callback: async (action, instance) => {
                if (
                    action === 'confirm' &&
                    instance.inputValue !== avatar.ref.name
                ) {
                    try {
                        await api.saveAvatar({
                            id: avatar.id,
                            name: instance.inputValue
                        });
                        this.$message({
                            message: 'Avatar renamed',
                            type: 'success'
                        });
                    } catch (err) {
                        console.error(err);
                    }
                }
            }
        });
    };

    $app.methods.promptChangeAvatarDescription = function(avatar) {
        this.$prompt('Enter avatar description', 'Change Description', {
            distinguishCancelAndClose: true,
            confirmButtonText: 'OK',
            cancelButtonText: 'Cancel',
            inputValue: avatar.ref.description,
            inputErrorMessage: 'Valid description is required',
            callback: async (action, instance) => {
                if (
                    action === 'confirm' &&
                    instance.inputValue !== avatar.ref.description
                ) {
                    try {
                        await api.saveAvatar({
                            id: avatar.id,
                            description: instance.inputValue
                        });
                        this.$message({
                            message: 'Avatar description changed',
                            type: 'success'
                        });
                    } catch (err) {
                        console.error(err);
                    }
                }
            }
        });
    };

    $app.methods.promptRenameWorld = function(world) {
        this.$prompt('Enter world name', 'Rename World', {
            distinguishCancelAndClose: true,
            confirmButtonText: 'OK',
            cancelButtonText: 'Cancel',
            inputValue: world.ref.name,
            inputErrorMessage: 'Valid name is required',
            callback: async (action, instance) => {
                if (
                    action === 'confirm' &&
                    instance.inputValue !== world.ref.name
                ) {
                    try {
                        await api.saveWorld({
                            id: world.id,
                            name: instance.inputValue
                        });
                        this.$message({
                            message: 'World renamed',
                            type: 'success'
                        });
                    } catch (err) {
                        console.error(err);
                    }
                }
            }
        });
    };

    $app.methods.promptChangeWorldDescription = function(world) {
        this.$prompt('Enter world description', 'Change Description', {
            distinguishCancelAndClose: true,
            confirmButtonText: 'OK',
            cancelButtonText: 'Cancel',
            inputValue: world.ref.description,
            inputErrorMessage: 'Valid description is required',
            callback: async (action, instance) => {
                if (
                    action === 'confirm' &&
                    instance.inputValue !== world.ref.description
                ) {
                    try {
                        await api.saveWorld({
                            id: world.id,
                            description: instance.inputValue
                        });
                        this.$message({
                            message: 'World description changed',
                            type: 'success'
                        });
                    } catch (err) {
                        console.error(err);
                    }
                }
            }
        });
    };

    $app.methods.promptAddAvatarFavoriteDialog = function() {
        this.$prompt('Enter a Avatar ID (UUID)', 'Avatar Favorite', {
            distinguishCancelAndClose: true,
            confirmButtonText: 'OK',
            cancelButtonText: 'Cancel',
            inputPattern: /\S+/,
            inputErrorMessage: 'Avatar ID is required',
            callback: (action, instance) => {
                if (action === 'confirm' && instance.inputValue) {
                    if (api.avatarMap.has(instance.inputValue)) {
                        this.showAvatarDialog(instance.inputValue);
                        return;
                    }
                    this.showFavoriteDialog('avatar', instance.inputValue);
                }
            }
        });
    };

    // App: Dialog

    var adjustDialogZ = (el) => {
        var z = 0;
        document
            .querySelectorAll('.v-modal,.el-dialog__wrapper')
            .forEach((v) => {
                var _z = Number(v.style.zIndex) || 0;
                if (_z && _z > z && v !== el) {
                    z = _z;
                }
            });
        if (z) {
            el.style.zIndex = z + 1;
        }
    };

    // App: User Dialog

    $app.data.userDialog = {
        visible: false,
        loading: false,
        id: '',
        ref: {},
        friend: {},
        isFriend: false,
        incomingRequest: false,
        outgoingRequest: false,
        isBlock: false,
        isMute: false,
        isHideAvatar: false,
        isFavorite: false,

        $location: {},
        users: [],
        instance: {},

        worlds: [],
        avatars: [],
        isWorldsLoading: false,
        isFavoriteWorldsLoading: false,
        isAvatarsLoading: false,

        worldSorting: 'update',
        avatarSorting: 'update',
        avatarReleaseStatus: 'all',

        treeData: [],
        memo: '',
        $avatarInfo: {
            ownerId: '',
            avatarName: '',
            fileCreatedAt: ''
        }
    };

    $app.watch['userDialog.memo'] = function() {
        var D = this.userDialog;
        this.saveMemo(D.id, D.memo);
    };

    $app.methods.getFaviconUrl = function(resource) {
        try {
            var url = new URL(resource);
            return `https://www.google.com/s2/favicons?domain=${url.origin}`;
        } catch (err) {
            return '';
        }
    };

    pubsub.subscribe('LOGOUT', function() {
        $app.userDialog.visible = false;
    });

    pubsub.subscribe('USER', function(args) {
        var {ref} = args;
        var D = $app.userDialog;
        if (D.visible === false || D.id !== ref.id) {
            return;
        }
        D.ref = ref;
        $app.applyUserDialogLocation();
    });

    pubsub.subscribe('WORLD', function(args) {
        var D = $app.userDialog;
        if (D.visible === false || D.$location.worldId !== args.ref.id) {
            return;
        }
        $app.applyUserDialogLocation();
    });

    pubsub.subscribe('FRIEND:STATUS', function(args) {
        var D = $app.userDialog;
        if (D.visible === false || D.id !== args.params.userId) {
            return;
        }
        var {json} = args;
        D.isFriend = json.isFriend;
        D.incomingRequest = json.incomingRequest;
        D.outgoingRequest = json.outgoingRequest;
    });

    pubsub.subscribe('FRIEND:REQUEST', function(args) {
        var D = $app.userDialog;
        if (D.visible === false || D.id !== args.params.userId) {
            return;
        }
        if (args.json.success) {
            D.isFriend = true;
        } else {
            D.outgoingRequest = true;
        }
    });

    pubsub.subscribe('FRIEND:REQUEST:CANCEL', function(args) {
        var D = $app.userDialog;
        if (D.visible === false || D.id !== args.params.userId) {
            return;
        }
        D.outgoingRequest = false;
    });

    pubsub.subscribe('NOTIFICATION', function(args) {
        var {ref} = args;
        var D = $app.userDialog;
        if (
            D.visible === false ||
            ref.$isDeleted ||
            ref.type !== 'friendRequest' ||
            ref.senderUserId !== D.id
        ) {
            return;
        }
        D.incomingRequest = true;
    });

    pubsub.subscribe('NOTIFICATION:ACCEPT', function(args) {
        var {ref} = args;
        var D = $app.userDialog;
        // 얘는 @DELETE가 오고나서 ACCEPT가 옴
        // 따라서 $isDeleted라면 ref가 undefined가 됨
        if (
            D.visible === false ||
            ref === void 0 ||
            ref.type !== 'friendRequest' ||
            ref.senderUserId !== D.id
        ) {
            return;
        }
        D.isFriend = true;
    });

    pubsub.subscribe('NOTIFICATION:@DELETE', function(args) {
        var {ref} = args;
        var D = $app.userDialog;
        if (
            D.visible === false ||
            ref.type !== 'friendRequest' ||
            ref.senderUserId !== D.id
        ) {
            return;
        }
        D.incomingRequest = false;
    });

    pubsub.subscribe('FRIEND:DELETE', function(args) {
        var D = $app.userDialog;
        if (D.visible === false || D.id !== args.params.userId) {
            return;
        }
        D.isFriend = false;
    });

    pubsub.subscribe('PLAYER-MODERATION:@SEND', function(args) {
        var {ref} = args;
        var D = $app.userDialog;
        if (
            D.visible === false ||
            ref.$isDeleted ||
            (ref.targetUserId !== D.id &&
                ref.sourceUserId !== api.currentUser.id)
        ) {
            return;
        }
        if (ref.type === 'block') {
            D.isBlock = true;
        } else if (ref.type === 'mute') {
            D.isMute = true;
        } else if (ref.type === 'hideAvatar') {
            D.isHideAvatar = true;
        }
        $app.$message({
            message: 'User moderated',
            type: 'success'
        });
    });

    pubsub.subscribe('PLAYER-MODERATION:@DELETE', function(args) {
        var {ref} = args;
        var D = $app.userDialog;
        if (
            D.visible === false ||
            ref.targetUserId !== D.id ||
            ref.sourceUserId !== api.currentUser.id
        ) {
            return;
        }
        if (ref.type === 'block') {
            D.isBlock = false;
        } else if (ref.type === 'mute') {
            D.isMute = false;
        } else if (ref.type === 'hideAvatar') {
            D.isHideAvatar = false;
        }
    });

    pubsub.subscribe('FAVORITE', function(args) {
        var {ref} = args;
        var D = $app.userDialog;
        if (D.visible === false || ref.$isDeleted || ref.favoriteId !== D.id) {
            return;
        }
        D.isFavorite = true;
    });

    pubsub.subscribe('FAVORITE:@DELETE', function(args) {
        var D = $app.userDialog;
        if (D.visible === false || D.id !== args.ref.favoriteId) {
            return;
        }
        D.isFavorite = false;
    });

    $app.methods.showUserDialog = async function(userId) {
        this.$nextTick(() => adjustDialogZ(this.$refs.userDialog.$el));
        var D = this.userDialog;
        D.currentAvatarThumbnailImageUrl = '';
        D.userIcon = '';
        D.id = userId;
        D.treeData = [];
        D.memo = this.loadMemo(userId);
        D.visible = true;
        D.loading = true;
        D.avatars = [];
        D.worlds = [];
        D.instance = {};
        try {
            var args = await api.getCachedUser({
                userId
            });
            if (args.ref.id === D.id) {
                D.loading = false;
                D.ref = args.ref;
                D.friend = this.friends.get(D.id);
                D.isFriend = Boolean(D.friend);
                D.incomingRequest = false;
                D.outgoingRequest = false;
                D.isBlock = false;
                D.isMute = false;
                D.isHideAvatar = false;
                for (var ref of api.playerModerationMap.values()) {
                    if (
                        ref.$isDeleted === false &&
                        ref.targetUserId === D.id &&
                        ref.sourceUserId === api.currentUser.id
                    ) {
                        if (ref.type === 'block') {
                            D.isBlock = true;
                        } else if (ref.type === 'mute') {
                            D.isMute = true;
                        } else if (ref.type === 'hideAvatar') {
                            D.isHideAvatar = true;
                        }
                    }
                }
                D.isFavorite = api.favoriteMapByObjectId.has(D.id);
                this.applyUserDialogLocation();
                if (this.$refs.userDialogTabs.currentName === '0') {
                    this.userDialogLastActiveTab = 'Info';
                } else if (this.$refs.userDialogTabs.currentName === '1') {
                    this.userDialogLastActiveTab = 'Worlds';
                    this.setUserDialogWorlds(userId);
                    if (this.userDialogLastWorld !== userId) {
                        this.userDialogLastWorld = userId;
                        this.refreshUserDialogWorlds();
                    }
                } else if (this.$refs.userDialogTabs.currentName === '2') {
                    this.userDialogLastActiveTab = 'Favorite Worlds';
                    if (this.userDialogLastFavoriteWorld !== userId) {
                        this.userDialogLastFavoriteWorld = userId;
                        this.getUserFavoriteWorlds(userId);
                    }
                } else if (this.$refs.userDialogTabs.currentName === '3') {
                    this.userDialogLastActiveTab = 'Avatars';
                    this.setUserDialogAvatars(userId);
                    if (this.userDialogLastAvatar !== userId) {
                        this.userDialogLastAvatar = userId;
                        if (
                            userId === api.currentUser.id &&
                            D.avatars.length === 0
                        ) {
                            this.refreshUserDialogAvatars();
                        }
                    }
                } else if (this.$refs.userDialogTabs.currentName === '4') {
                    this.userDialogLastActiveTab = 'JSON';
                    this.refreshUserDialogTreeData();
                }
                api.getFriendStatus({
                    userId: D.id
                });
                if (args.cache) {
                    api.getUser(args.params);
                }
                this.getAvatarName();
                var L = parseLocation(D.ref.location);
                if (L.worldId && this.lastLocation.location !== L.location) {
                    api.getInstance({
                        worldId: L.worldId,
                        instanceId: L.instanceId
                    });
                }
            }
        } catch (err) {
            console.log(err);
            D.loading = false;
            D.visible = false;
        }
    };

    $app.methods.applyUserDialogLocation = function() {
        var D = this.userDialog;

        var L = parseLocation(D.ref.location);
        D.$location = L;

        if (L.ownerId) {
            var ref = api.userMap.get(L.ownerId);
            if (ref === void 0) {
                api.getUser({
                    userId: L.ownerId
                }).then((args) => {
                    Vue.set(L, 'user', args.ref);
                    return args;
                });
            } else {
                L.user = ref;
            }
        }

        var users = [];
        var playersInInstance = this.lastLocation.playerList;
        if (
            this.lastLocation.location === L.location &&
            playersInInstance.length > 0
        ) {
            var ref = api.userMap.get(api.currentUser.id);
            if (ref === void 0) {
                ref = api.currentUser;
            }
            if (playersInInstance.includes(ref.displayName)) {
                users.push(ref);
            }
            var friendsInInstance = this.lastLocation.friendList;
            for (var i = 0; i < friendsInInstance.length; i++) {
                var addUser = true;
                var player = friendsInInstance[i];
                for (var k = 0; k < users.length; k++) {
                    var user = users[k];
                    if (user.displayName === player) {
                        addUser = false;
                        break;
                    }
                }
                if (addUser) {
                    for (var ref of api.userMap.values()) {
                        if (ref.displayName === player) {
                            users.push(ref);
                            break;
                        }
                    }
                }
            }
        } else if (L.isOffline === false) {
            for (var {ref} of this.friends.values()) {
                if (ref !== void 0 && ref.location === L.location) {
                    if (ref.state === 'active' && ref.location === 'private') {
                        continue;
                    }
                    users.push(ref);
                }
            }
        }

        users.sort(compareByDisplayName);

        D.users = users;
        if (!L.worldId) {
            return;
        }

        if (this.lastLocation.location === L.location) {
            D.instance = {
                id: L.location,
                occupants: this.lastLocation.playerList.length
            };
        }
    };

    $app.methods.setUserDialogWorlds = function(userId) {
        var worlds = [];
        for (var ref of api.worldMap.values()) {
            if (ref.authorId === userId) {
                worlds.push(ref);
            }
        }
        this.sortUserDialogWorlds(worlds);
    };

    $app.methods.sortUserDialogWorlds = function(array) {
        var D = this.userDialog;
        if (D.worldSorting === 'update') {
            array.sort(compareByUpdatedAt);
        } else {
            array.sort(compareByName);
        }
        D.worlds = array;
    };

    $app.methods.setUserDialogAvatars = function(userId) {
        var avatars = [];
        for (var ref of api.avatarMap.values()) {
            if (ref.authorId === userId) {
                avatars.push(ref);
            }
        }
        this.sortUserDialogAvatars(avatars);
    };

    $app.methods.sortUserDialogAvatars = function(array) {
        var D = this.userDialog;
        if (D.avatarSorting === 'update') {
            array.sort(compareByUpdatedAt);
        } else {
            array.sort(compareByName);
        }
        D.avatars = array;
    };

    $app.methods.refreshUserDialogWorlds = async function() {
        var D = this.userDialog;
        if (D.isWorldsLoading) {
            return;
        }
        D.isWorldsLoading = true;
        var params = {
            sort: 'updated',
            order: 'descending',
            // user: 'friends',
            userId: D.id,
            releaseStatus: 'public'
        };
        if (params.userId === api.currentUser.id) {
            params.user = 'me';
            params.releaseStatus = 'all';
        }
        var map = new Map();
        for (var ref of api.worldMap.values()) {
            if (ref.authorId === D.id) {
                api.worldMap.delete(ref.id);
            }
        }
        try {
            for (var offset = 0; ; offset += 100) {
                var {json} = await api.getWorlds({
                    n: 100,
                    offset,
                    ...params
                });
                if (json === void 0 || json.length === 0) {
                    break;
                }
                for (var apiWorld of json) {
                    var $ref = api.worldMap.get(apiWorld.id);
                    if ($ref !== void 0) {
                        map.set($ref.id, $ref);
                    }
                }
            }
        } catch (err) {
            console.error(err);
        }
        if (D.id === params.userId) {
            var array = Array.from(map.values());
            this.sortUserDialogWorlds(array);
        }
        D.isWorldsLoading = false;
    };

    $app.methods.refreshUserDialogAvatars = async function(fileId) {
        var D = this.userDialog;
        if (D.isAvatarsLoading) {
            return;
        }
        D.isAvatarsLoading = true;
        if (fileId) {
            D.loading = true;
        }
        var params = {
            sort: 'updated',
            order: 'descending',
            releaseStatus: 'all',
            user: 'me'
        };
        try {
            for (var ref of api.avatarMap.values()) {
                if (ref.authorId === D.id) {
                    api.avatarMap.delete(ref.id);
                }
            }
            var map = new Map();
            for (var offset = 0; ; offset += 100) {
                var {json} = await api.getAvatars({
                    n: 100,
                    offset,
                    ...params
                });
                if (json === void 0 || json.length === 0) {
                    break;
                }
                for (var apiAvatar of json) {
                    var $ref = api.avatarMap.get(apiAvatar.id);
                    if ($ref !== void 0) {
                        map.set($ref.id, $ref);
                    }
                }
            }
        } catch (err) {
            console.error(err);
        }
        var array = Array.from(map.values());
        this.sortUserDialogAvatars(array);
        D.isAvatarsLoading = false;
        if (fileId) {
            D.loading = false;
            for (var ref of array) {
                if (extractFileId(ref.imageUrl) === fileId) {
                    this.showAvatarDialog(ref.id);
                    return;
                }
            }
            this.$message({
                message: 'Own avatar not found',
                type: 'error'
            });
        }
    };

    var performUserDialogCommand = (command, userId) => {
        switch (command) {
            case 'Delete Favorite':
                api.deleteFavorite({
                    objectId: userId
                });
                break;
            case 'Accept Friend Request':
                var key = api.getFriendRequest(userId);
                if (key === '') {
                    api.sendFriendRequest({
                        userId
                    });
                } else {
                    api.acceptNotification({
                        notificationId: key
                    });
                }
                break;
            case 'Decline Friend Request':
                var key = api.getFriendRequest(userId);
                if (key === '') {
                    api.cancelFriendRequest({
                        userId
                    });
                } else {
                    api.hideNotification({
                        notificationId: key
                    });
                }
                break;
            case 'Cancel Friend Request':
                api.cancelFriendRequest({
                    userId
                });
                break;
            case 'Send Friend Request':
                api.sendFriendRequest({
                    userId
                });
                break;
            case 'Unblock':
                api.deletePlayerModeration({
                    moderated: userId,
                    type: 'block'
                });
                break;
            case 'Block':
                api.sendPlayerModeration({
                    moderated: userId,
                    type: 'block'
                });
                break;
            case 'Unmute':
                api.deletePlayerModeration({
                    moderated: userId,
                    type: 'mute'
                });
                break;
            case 'Mute':
                api.sendPlayerModeration({
                    moderated: userId,
                    type: 'mute'
                });
                break;
            case 'Show Avatar':
                api.deletePlayerModeration({
                    moderated: userId,
                    type: 'hideAvatar'
                });
                break;
            case 'Hide Avatar':
                api.sendPlayerModeration({
                    moderated: userId,
                    type: 'hideAvatar'
                });
                break;
            case 'Unfriend':
                api.deleteFriend({
                    userId
                });
                break;
            default:
                break;
        }
    };

    $app.methods.userDialogCommand = async function(command) {
        var D = this.userDialog;
        if (D.visible === false) {
            return;
        }
        if (command === 'Add Favorite') {
            this.showFavoriteDialog('friend', D.id);
        } else if (command === 'Edit Social Status') {
            this.showSocialStatusDialog();
        } else if (command === 'Edit Language') {
            this.showLanguageDialog();
        } else if (command === 'Edit Bio') {
            this.showBioDialog();
        } else if (command === 'Logout') {
            this.logout();
        } else if (command === 'Request Invite') {
            try {
                await api.sendRequestInvite(D.id, {
                    platform: 'standalonewindows'
                });
                this.$message('Request invite sent');
            } catch (err) {
                console.error(err);
            }
        } else if (command === 'Invite Message') {
            try {
                var L = parseLocation(this.lastLocation.location);
                var args = await api.getCachedWorld({
                    worldId: L.worldId
                });
                this.showSendInviteDialog(D.id, {
                    instanceId: this.lastLocation.location,
                    worldId: this.lastLocation.location,
                    worldName: args.ref.name
                });
            } catch (err) {
                console.error(err);
            }
        } else if (command === 'Request Invite Message') {
            this.showSendInviteRequestDialog(
                {
                    platform: 'standalonewindows'
                },
                D.id
            );
        } else if (command === 'Invite') {
            try {
                var L = parseLocation(this.lastLocation.location);
                var args = await api.getCachedWorld({
                    worldId: L.worldId
                });
                await api.sendInvite(D.id, {
                    instanceId: this.lastLocation.location,
                    worldId: this.lastLocation.location,
                    worldName: args.ref.name
                });
                this.$message('Invite sent');
            } catch (err) {
                console.error(err);
            }
        } else if (command === 'Show Avatar Author') {
            var {currentAvatarImageUrl} = D.ref;
            this.showAvatarAuthorDialog(D.id, currentAvatarImageUrl);
        } else if (command === 'Show Fallback Avatar Details') {
            var {fallbackAvatar} = D.ref;
            if (fallbackAvatar) {
                this.showAvatarDialog(fallbackAvatar);
            } else {
                this.$message({
                    message: 'No fallback avatar set',
                    type: 'error'
                });
            }
        } else if (command === 'Previous Images') {
            this.displayPreviousImages('User', 'Display');
        } else if (command === 'Select Avatar') {
            this.promptSelectAvatarDialog();
        } else {
            this.$confirm(`Continue? ${command}`, 'Confirm', {
                confirmButtonText: 'Confirm',
                cancelButtonText: 'Cancel',
                type: 'info',
                callback: (action) => {
                    if (action === 'confirm') {
                        performUserDialogCommand(command, D.id);
                    }
                }
            });
        }
    };

    $app.methods.refreshUserDialogTreeData = function() {
        var D = this.userDialog;
        D.treeData = buildTreeData(D.ref);
    };

    $app.methods.changeUserDialogWorldSorting = function() {
        var D = this.userDialog;
        this.sortUserDialogWorlds(D.worlds);
    };

    $app.methods.changeUserDialogAvatarSorting = function() {
        var D = this.userDialog;
        this.sortUserDialogAvatars(D.avatars);
    };

    $app.computed.userDialogAvatars = function() {
        var {avatars, avatarReleaseStatus} = this.userDialog;
        if (
            avatarReleaseStatus === 'public' ||
            avatarReleaseStatus === 'private'
        ) {
            return avatars.filter(
                (avatar) => avatar.releaseStatus === avatarReleaseStatus
            );
        }
        return avatars;
    };

    // App: World Dialog

    $app.data.worldDialog = {
        visible: false,
        loading: false,
        id: '',
        $location: {},
        ref: {},
        isFavorite: false,
        rooms: [],
        treeData: [],
        fileCreatedAt: '',
        fileSize: ''
    };

    pubsub.subscribe('LOGOUT', function() {
        $app.worldDialog.visible = false;
    });

    pubsub.subscribe('WORLD', async function(args) {
        var {ref} = args;
        var D = $app.worldDialog;
        if (D.visible === false || D.id !== ref.id) {
            return;
        }

        D.ref = ref;
        $app.applyWorldDialogInstances();

        if (D.fileSize !== 'Loading') {
            return;
        }

        var assetUrl = '';
        for (var i = ref.unityPackages.length - 1; i > -1; i--) {
            var unityPackage = ref.unityPackages[i];
            if (
                unityPackage.platform === 'standalonewindows' &&
                unityPackage.unitySortNumber <= 20180420000
            ) {
                assetUrl = unityPackage.assetUrl;
                break;
            }
        }
        var fileId = extractFileId(assetUrl);
        var fileVersion = extractFileVersion(assetUrl);

        try {
            var args = await API.getBundles(fileId);
            var {versions} = args.json;
            for (var i = versions.length - 1; i > -1; i--) {
                var version = versions[i];
                if (version.version == fileVersion) {
                    D.fileCreatedAt = version.created_at;
                    D.fileSize = `${(
                        version.file.sizeInBytes / 1048576
                    ).toFixed(2)} MiB`;
                    break;
                }
            }
        } catch (err) {
            console.error(err);
        }
    });

    pubsub.subscribe('FAVORITE', function(args) {
        var {ref} = args;
        var D = $app.worldDialog;
        if (D.visible === false || ref.$isDeleted || ref.favoriteId !== D.id) {
            return;
        }
        D.isFavorite = true;
    });

    pubsub.subscribe('FAVORITE:@DELETE', function(args) {
        var D = $app.worldDialog;
        if (D.visible === false || D.id !== args.ref.favoriteId) {
            return;
        }
        D.isFavorite = false;
    });

    $app.methods.showWorldDialog = async function(tag) {
        this.$nextTick(() => adjustDialogZ(this.$refs.worldDialog.$el));
        var D = this.worldDialog;
        var L = parseLocation(tag);
        if (L.worldId === '') {
            return;
        }
        D.id = L.worldId;
        D.$location = L;
        D.treeData = [];
        D.fileCreatedAt = '';
        D.fileSize = 'Loading';
        D.visible = true;
        D.loading = true;
        try {
            var args = await api.getCachedWorld({
                worldId: L.worldId
            });
            if (D.id === args.ref.id) {
                D.loading = false;
                D.ref = args.ref;
                D.isFavorite = api.favoriteMapByObjectId.has(D.id);
                D.rooms = [];
                this.updateVRChatCache().catch(nop);
                this.applyWorldDialogInstances();
                if (args.cache) {
                    api.getWorld(args.params);
                }
            }
        } catch (err) {
            console.error(err);
            D.loading = false;
            D.visible = false;
        }
    };

    $app.methods.applyWorldDialogInstances = function() {
        var D = this.worldDialog;

        var instances = {};
        for (var [id, occupants] of D.ref.instances) {
            instances[id] = {
                id,
                occupants,
                users: []
            };
        }

        var {instanceId} = D.$location;
        if (instanceId && instances[instanceId] === void 0) {
            instances[instanceId] = {
                id: instanceId,
                occupants: 0,
                users: []
            };
        }

        var lastLocation$ = parseLocation(this.lastLocation.location);
        var playersInInstance = this.lastLocation.playerList;

        if (lastLocation$.worldId === D.id && playersInInstance.length > 0) {
            var instance = instances[lastLocation$.instanceId];
            if (instance === void 0) {
                instance = {
                    id: lastLocation$.instanceId,
                    occupants: 1,
                    users: []
                };
                instances[instance.id] = instance;
            }
            instances[instance.id].occupants = playersInInstance.length;
            var ref = api.userMap.get(api.currentUser.id);
            if (ref === void 0) {
                ref = api.currentUser;
            }
            if (playersInInstance.includes(ref.displayName)) {
                instance.users.push(ref);
            }
            var friendsInInstance = this.lastLocation.friendList;
            for (var i = 0; i < friendsInInstance.length; i++) {
                var addUser = true;
                var player = friendsInInstance[i];
                for (var k = 0; k < instance.users.length; k++) {
                    var user = instance.users[k];
                    if (user.displayName === player) {
                        addUser = false;
                        break;
                    }
                }
                if (addUser) {
                    for (var ref of api.userMap.values()) {
                        if (ref.displayName === player) {
                            instance.users.push(ref);
                            break;
                        }
                    }
                }
            }
        }

        for (var {ref} of this.friends.values()) {
            if (
                ref === void 0 ||
                ref.$location === void 0 ||
                ref.$location.worldId !== D.id ||
                ref.$location.instanceId === lastLocation$.instanceId
            ) {
                continue;
            }
            var {instanceId} = ref.$location;
            var instance = instances[instanceId];
            if (instance === void 0) {
                instance = {
                    id: instanceId,
                    occupants: 0,
                    users: []
                };
                instances[instanceId] = instance;
            }
            instance.users.push(ref);
        }

        var rooms = [];
        for (var instance of Object.values(instances)) {
            // due to references on callback of api.getUser()
            // this should be block scope variable
            const L = parseLocation(`${D.id}:${instance.id}`);
            instance.location = L.location;
            instance.$location = L;

            if (L.ownerId) {
                var ref = api.userMap.get(L.ownerId);
                if (ref === void 0) {
                    api.getUser({
                        userId: L.ownerId
                    }).then((args) => {
                        Vue.set(L, 'user', args.ref);
                        return args;
                    });
                } else {
                    L.user = ref;
                }
            }

            instance.users.sort(compareByDisplayName);
            rooms.push(instance);
        }

        // sort by more friends, occupants
        rooms.sort(function(a, b) {
            return b.users.length - a.users.length || b.occupants - a.occupants;
        });

        D.rooms = rooms;
    };

    $app.methods.worldDialogCommand = async function(command) {
        var {worldDialog} = this;
        if (worldDialog.visible === false) {
            return;
        }
        switch (command) {
            case 'Refresh':
                worldDialog.loading = true;
                try {
                    var args = await api.getWorld({
                        worldId: worldDialog.id
                    });
                    if (worldDialog.id === args.ref.id) {
                        worldDialog.ref = args.ref;
                        worldDialog.isFavorite = api.favoriteMapByObjectId.has(
                            worldDialog.id
                        );
                        worldDialog.rooms = [];
                        this.applyWorldDialogInstances();
                        if (args.cache) {
                            api.getWorld(args.params);
                        }
                    }
                } catch (err) {
                    console.error(err);
                }
                worldDialog.loading = false;
                break;

            case 'New Instance':
                this.showNewInstanceDialog(worldDialog.$location.location);
                break;

            case 'Add Favorite':
                this.showFavoriteDialog('world', worldDialog.id);
                break;

            case 'Rename':
                this.promptRenameWorld(worldDialog);
                break;

            case 'Change Image':
                this.displayPreviousImages('World', 'Change');
                break;

            case 'Previous Images':
                this.displayPreviousImages('World', 'Display');
                break;

            case 'Change Description':
                this.promptChangeWorldDescription(worldDialog);
                break;

            default:
                this.$confirm(`Continue? ${command}`, 'Confirm', {
                    confirmButtonText: 'Confirm',
                    cancelButtonText: 'Cancel',
                    type: 'info',
                    callback: async (action) => {
                        if (action !== 'confirm') {
                            return;
                        }
                        switch (command) {
                            case 'Delete Favorite':
                                try {
                                    await api.deleteFavorite({
                                        objectId: worldDialog.id
                                    });
                                } catch (err) {
                                    console.error(err);
                                }
                                break;

                            case 'Make Home':
                                try {
                                    await api.saveCurrentUser({
                                        homeLocation: worldDialog.id
                                    });
                                    this.$message({
                                        message: 'Home world updated',
                                        type: 'success'
                                    });
                                } catch (err) {
                                    console.error(err);
                                }
                                break;

                            case 'Reset Home':
                                try {
                                    await api.saveCurrentUser({
                                        homeLocation: ''
                                    });
                                    this.$message({
                                        message: 'Home world has been reset',
                                        type: 'success'
                                    });
                                } catch (err) {
                                    console.error(err);
                                }
                                break;

                            case 'Delete':
                                try {
                                    await api.deleteWorld({
                                        worldId: worldDialog.id
                                    });
                                    this.$message({
                                        message: 'World has been deleted',
                                        type: 'success'
                                    });
                                    worldDialog.visible = false;
                                } catch (err) {
                                    console.error(err);
                                }
                                break;
                        }
                    }
                });
                break;
        }
    };

    $app.methods.refreshWorldDialogTreeData = function() {
        var D = this.worldDialog;
        D.treeData = buildTreeData(D.ref);
    };

    $app.computed.worldDialogPlatform = function() {
        var {ref} = this.worldDialog;
        var platforms = [];
        if (ref.unityPackages) {
            for (var unityPackage of ref.unityPackages) {
                var platform = 'PC';
                if (unityPackage.platform === 'standalonewindows') {
                    platform = 'PC';
                } else if (unityPackage.platform === 'android') {
                    platform = 'Quest';
                } else if (unityPackage.platform) {
                    ({platform} = unityPackage);
                }
                platforms.push(`${platform}/${unityPackage.unityVersion}`);
            }
        }
        return platforms.join(', ');
    };

    // App: Avatar Dialog

    $app.data.avatarDialog = {
        visible: false,
        loading: false,
        id: '',
        ref: {},
        isFavorite: false,
        treeData: [],
        fileCreatedAt: '',
        fileSize: ''
    };

    pubsub.subscribe('LOGOUT', function() {
        $app.avatarDialog.visible = false;
    });

    pubsub.subscribe('AVATAR', async function(args) {
        var D = $app.avatarDialog;
        if (D.visible === false || D.id !== args.ref.id) {
            return;
        }

        var {ref} = args;
        D.ref = ref;

        if (D.fileSize !== 'Loading') {
            return;
        }

        var assetUrl = '';
        for (var i = ref.unityPackages.length - 1; i > -1; i--) {
            var unityPackage = ref.unityPackages[i];
            if (
                unityPackage.platform === 'standalonewindows' &&
                unityPackage.unitySortNumber <= 20180420000
            ) {
                assetUrl = unityPackage.assetUrl;
                break;
            }
        }

        var fileId = extractFileId(assetUrl);
        var fileVersion = extractFileVersion(assetUrl);
        if (!fileId) {
            var fileId = extractFileId(ref.assetUrl);
            var fileVersion = extractFileVersion(ref.assetUrl);
        }

        if (!fileId) {
            return;
        }

        try {
            var args = await API.getBundles(fileId);
            var {versions} = args.json;
            for (var i = versions.length - 1; i > -1; i--) {
                var version = versions[i];
                if (version.version == fileVersion) {
                    D.ref.created_at = version.created_at;
                    D.fileSize = `${(
                        version.file.sizeInBytes / 1048576
                    ).toFixed(2)} MiB`;
                    break;
                }
            }
        } catch (err) {
            console.error(err);
        }
    });

    pubsub.subscribe('FAVORITE', function(args) {
        var {ref} = args;
        var D = $app.avatarDialog;
        if (D.visible === false || ref.$isDeleted || ref.favoriteId !== D.id) {
            return;
        }
        D.isFavorite = true;
    });

    pubsub.subscribe('FAVORITE:@DELETE', function(args) {
        var D = $app.avatarDialog;
        if (D.visible === false || D.id !== args.ref.favoriteId) {
            return;
        }
        D.isFavorite = false;
    });

    $app.methods.showAvatarDialog = async function(avatarId) {
        this.$nextTick(() => adjustDialogZ(this.$refs.avatarDialog.$el));

        var D = this.avatarDialog;
        D.id = avatarId;

        var ref = api.avatarMap.get(avatarId);
        if (!ref) {
            D.visible = false;
            this.$message({
                message: 'Avatar cache unavailable',
                type: 'error'
            });
            return;
        }

        D.treeData = [];
        D.fileSize = 'Unknown';
        D.visible = true;
        D.ref = ref;
        D.isFavorite = api.favoriteMapByObjectId.has(avatarId);

        if (D.ref.authorId === api.currentUser.id) {
            D.fileSize = 'Loading';
            api.getAvatar({avatarId});
        } else {
            var assetUrl = '';
            for (var i = ref.unityPackages.length - 1; i > -1; i--) {
                var unityPackage = ref.unityPackages[i];
                if (
                    unityPackage.platform === 'standalonewindows' &&
                    unityPackage.unitySortNumber <= 20180420000
                ) {
                    assetUrl = unityPackage.assetUrl;
                    break;
                }
            }
            var fileId = extractFileId(assetUrl);
            var fileVersion = extractFileVersion(assetUrl);
            if (!fileId) {
                var fileId = extractFileId(ref.assetUrl);
                var fileVersion = extractFileVersion(ref.assetUrl);
            }
            var imageId = extractFileId(ref.thumbnailImageUrl);
            if (fileId) {
                D.fileSize = 'Loading';
                try {
                    var args = await API.getBundles(fileId);
                    var {versions} = args.json;
                    for (var i = versions.length - 1; i > -1; i--) {
                        var version = versions[i];
                        if (version.version == fileVersion) {
                            D.ref.created_at = version.created_at;
                            D.fileSize = `${(
                                version.file.sizeInBytes / 1048576
                            ).toFixed(2)} MiB`;
                            break;
                        }
                    }
                } catch (err) {
                    console.error(err);
                }
            } else if (imageId && !D.ref.created_at) {
                if (API.cachedAvatarNames.has(imageId)) {
                    var avatarInfo = API.cachedAvatarNames.get(imageId);
                    D.ref.created_at = avatarInfo.fileCreatedAt;
                } else {
                    try {
                        var args = await API.getAvatarImages({
                            fileId: imageId
                        });
                        var avatarInfo = this.storeAvatarImage(args);
                        D.ref.created_at = avatarInfo.fileCreatedAt;
                    } catch (err) {
                        console.error(err);
                    }
                }
            }
        }
    };

    $app.methods.avatarDialogCommand = function(command) {
        var D = this.avatarDialog;
        if (D.visible === false) {
            return;
        }
        switch (command) {
            case 'Rename':
                this.promptRenameAvatar(D);
                break;

            case 'Upload Image':
                document.getElementById('AvatarImageUploadButton').click();
                break;

            case 'Change Image':
                this.displayPreviousImages('Avatar', 'Change');
                break;

            case 'Previous Images':
                this.displayPreviousImages('Avatar', 'Display');
                break;

            case 'Change Description':
                this.promptChangeAvatarDescription(D);
                break;

            case 'Download Unity Package':
                this.openExternalLink(this.avatarDialog.ref.unityPackageUrl);
                break;

            case 'Add Favorite':
                this.showFavoriteDialog('avatar', D.id);
                break;

            default:
                this.$confirm(`Continue? ${command}`, 'Confirm', {
                    confirmButtonText: 'Confirm',
                    cancelButtonText: 'Cancel',
                    type: 'info',
                    callback: async (action) => {
                        if (action !== 'confirm') {
                            return;
                        }
                        switch (command) {
                            case 'Delete Favorite':
                                try {
                                    await api.deleteFavorite({
                                        objectId: D.id
                                    });
                                } catch (err) {
                                    console.error(err);
                                }
                                break;

                            case 'Select Avatar':
                                try {
                                    await api.selectAvatar({
                                        avatarId: D.id
                                    });
                                    this.$message({
                                        message: 'Avatar changed',
                                        type: 'success'
                                    });
                                } catch (err) {
                                    console.error(err);
                                }
                                break;

                            case 'Select Fallback Avatar':
                                try {
                                    await api.selectFallbackAvatar({
                                        avatarId: D.id
                                    });
                                    this.$message({
                                        message: 'Fallback avatar changed',
                                        type: 'success'
                                    });
                                } catch (err) {
                                    console.error(err);
                                }
                                break;

                            case 'Make Public':
                                try {
                                    await api.saveAvatar({
                                        id: D.id,
                                        releaseStatus: 'public'
                                    });
                                    this.$message({
                                        message: 'Avatar updated to public',
                                        type: 'success'
                                    });
                                } catch (err) {
                                    console.error(err);
                                }
                                break;

                            case 'Make Private':
                                try {
                                    await api.saveAvatar({
                                        id: D.id,
                                        releaseStatus: 'private'
                                    });
                                    this.$message({
                                        message: 'Avatar updated to private',
                                        type: 'success'
                                    });
                                } catch (err) {
                                    console.error(err);
                                }
                                break;

                            case 'Delete':
                                try {
                                    await api.deleteAvatar({
                                        avatarId: D.id
                                    });
                                    this.$message({
                                        message: 'Avatar deleted',
                                        type: 'success'
                                    });
                                    D.visible = false;
                                } catch (err) {
                                    console.error(err);
                                }
                                break;
                        }
                    }
                });
                break;
        }
    };

    $app.methods.showAvatarAuthorDialog = async function(
        refUserId,
        currentAvatarImageUrl
    ) {
        var fileId = extractFileId(currentAvatarImageUrl);
        if (!fileId) {
            this.$message({
                message: 'Sorry, the author is unknown',
                type: 'error'
            });
            return;
        }

        if (
            refUserId === api.currentUser.id &&
            api.avatarMap.has(api.currentUser.currentAvatar)
        ) {
            this.showAvatarDialog(api.currentUser.currentAvatar);
            return;
        }

        for (var ref of api.avatarMap.values()) {
            if (extractFileId(ref.imageUrl) === fileId) {
                this.showAvatarDialog(ref.id);
                return;
            }
        }

        if (API.cachedAvatarNames.has(fileId)) {
            var {ownerId} = API.cachedAvatarNames.get(fileId);
            if (ownerId === api.currentUser.id) {
                this.refreshUserDialogAvatars(fileId);
                return;
            }

            if (ownerId === refUserId) {
                this.$message({
                    message: "It's personal (own) avatar",
                    type: 'warning'
                });
                return;
            }

            this.showUserDialog(ownerId);
            return;
        }

        try {
            var args = await API.getAvatarImages({
                fileId
            });

            var ownerId = args.json.ownerId;
            if (ownerId === refUserId) {
                this.$message({
                    message: "It's personal (own) avatar",
                    type: 'warning'
                });
                return;
            }

            this.showUserDialog(ownerId);
        } catch (err) {
            console.error(err);
        }
    };

    $app.methods.refreshAvatarDialogTreeData = function() {
        var D = this.avatarDialog;
        D.treeData = buildTreeData(D.ref);
    };

    $app.computed.avatarDialogPlatform = function() {
        var {ref} = this.avatarDialog;
        var platforms = [];
        if (ref.unityPackages) {
            for (var unityPackage of ref.unityPackages) {
                var platform = 'PC';
                if (unityPackage.platform === 'standalonewindows') {
                    platform = 'PC';
                } else if (unityPackage.platform === 'android') {
                    platform = 'Quest';
                } else if (unityPackage.platform) {
                    ({platform} = unityPackage);
                }
                platforms.push(`${platform}/${unityPackage.unityVersion}`);
            }
        }
        return platforms.join(', ');
    };

    // App: Favorite Dialog

    $app.data.favoriteDialog = {
        visible: false,
        loading: false,
        type: '',
        objectId: '',
        groups: []
    };

    pubsub.subscribe('LOGOUT', function() {
        $app.favoriteDialog.visible = false;
    });

    $app.methods.addFavorite = async function(group) {
        var D = this.favoriteDialog;
        D.loading = true;

        try {
            await api.addFavorite({
                type: D.type,
                favoriteId: D.objectId,
                tags: group.name
            });
            D.visible = false;
        } catch (err) {
            console.error(err);
        }

        D.loading = false;
    };

    $app.methods.addFavoriteAvatar = async function(ref, group) {
        try {
            await api.addFavorite({
                type: 'avatar',
                favoriteId: ref.id,
                tags: group.name
            });
        } catch (err) {
            console.error(err);
        }
    };

    $app.methods.moveFavorite = async function(ref, group, type) {
        try {
            await api.deleteFavorite({
                objectId: ref.id
            });
            await api.addFavorite({
                type,
                favoriteId: ref.id,
                tags: group.name
            });
        } catch (err) {
            console.error(err);
        }
    };

    $app.methods.showFavoriteDialog = function(type, objectId) {
        this.$nextTick(() => adjustDialogZ(this.$refs.favoriteDialog.$el));

        var D = this.favoriteDialog;
        D.type = type;
        D.objectId = objectId;

        if (type === 'friend') {
            D.groups = api.favoriteFriendGroups;
            D.visible = true;
        } else if (type === 'world') {
            D.groups = api.favoriteWorldGroups;
            D.visible = true;
        } else if (type === 'avatar') {
            D.groups = api.favoriteAvatarGroups;
            D.visible = true;
        }
    };

    // App: Invite Dialog

    $app.data.inviteDialog = {
        visible: false,
        loading: false,
        worldId: '',
        worldName: '',
        userIds: []
    };

    pubsub.subscribe('LOGOUT', function() {
        $app.inviteDialog.visible = false;
    });

    $app.methods.sendInvite = function() {
        this.$confirm('Continue? Invite', 'Confirm', {
            confirmButtonText: 'Confirm',
            cancelButtonText: 'Cancel',
            type: 'info',
            callback: async (action) => {
                var D = this.inviteDialog;
                if (action !== 'confirm' || D.loading === true) {
                    return;
                }

                if (
                    api.currentUser.status === 'busy' &&
                    D.userIds.includes(this.api.currentUser.id) === true
                ) {
                    this.$message({
                        message:
                            "You can't invite yourself in 'Do Not Disturb' mode",
                        type: 'error'
                    });
                    return;
                }

                D.loading = true;

                while (D.userIds.length > 0) {
                    var receiverUserId = D.userIds.shift();
                    try {
                        await api.sendInvite(receiverUserId, {
                            instanceId: D.worldId,
                            worldId: D.worldId,
                            worldName: D.worldName
                        });
                    } catch (err) {
                        console.error(err);
                    }
                }

                this.$message({
                    message: 'Invite sent',
                    type: 'success'
                });

                D.loading = false;
                D.visible = false;
            }
        });
    };

    $app.methods.showInviteDialog = async function(tag) {
        this.$nextTick(() => adjustDialogZ(this.$refs.inviteDialog.$el));

        var L = parseLocation(tag);
        if (L.isOffline || L.isPrivate || L.worldId === '') {
            return;
        }

        try {
            var args = await api.getCachedWorld({
                worldId: L.worldId
            });

            var D = this.inviteDialog;
            D.userIds = [];
            D.worldId = L.location;
            D.worldName = args.ref.name;
            D.visible = true;
        } catch (err) {
            console.error(err);
        }
    };

    // App: Social Status Dialog

    $app.data.socialStatusDialog = {
        visible: false,
        loading: false,
        status: '',
        statusDescription: ''
    };

    pubsub.subscribe('LOGOUT', function() {
        $app.socialStatusDialog.visible = false;
    });

    $app.methods.saveSocialStatus = async function() {
        var D = this.socialStatusDialog;
        if (D.loading) {
            return;
        }

        D.loading = true;

        try {
            await api.saveCurrentUser({
                status: D.status,
                statusDescription: D.statusDescription
            });
            this.$message({
                message: 'Status updated',
                type: 'success'
            });
            D.visible = false;
        } catch (err) {
            console.error(err);
        }

        D.loading = false;
    };

    $app.methods.showSocialStatusDialog = function() {
        this.$nextTick(() => adjustDialogZ(this.$refs.socialStatusDialog.$el));
        var D = this.socialStatusDialog;
        var {statusHistory} = api.currentUser;
        var statusHistoryArray = [];
        for (var i = 0; i < statusHistory.length; ++i) {
            var addStatus = {
                no: i + 1,
                status: statusHistory[i]
            };
            statusHistoryArray.push(addStatus);
        }
        this.socialStatusHistoryTable.data = statusHistoryArray;
        D.status = api.currentUser.status;
        D.statusDescription = api.currentUser.statusDescription;
        D.visible = true;
    };

    $app.methods.setSocialStatusFromHistory = function(val) {
        if (val === null) {
            return;
        }
        var D = this.socialStatusDialog;
        D.statusDescription = val.status;
    };

    // App: Language Dialog

    $app.data.languageDialog = {
        visible: false,
        loading: false,
        languageChoice: false,
        languageValue: '',
        languages: (function() {
            var data = [];
            for (var key in api.subsetOfLanguages) {
                var value = api.subsetOfLanguages[key];
                data.push({
                    key,
                    value
                });
            }
            return data;
        })()
    };

    pubsub.subscribe('LOGOUT', function() {
        $app.languageDialog.visible = false;
    });

    $app.methods.addUserLanguage = function(language) {
        if (language !== String(language)) {
            return;
        }
        var D = this.languageDialog;
        D.loading = true;
        api.addUserTags({
            tags: [`language_${language}`]
        }).finally(function() {
            D.loading = false;
        });
    };

    $app.methods.removeUserLanguage = function(language) {
        if (language !== String(language)) {
            return;
        }
        var D = this.languageDialog;
        D.loading = true;
        api.removeUserTags({
            tags: [`language_${language}`]
        }).finally(function() {
            D.loading = false;
        });
    };

    $app.methods.showLanguageDialog = function() {
        this.$nextTick(() => adjustDialogZ(this.$refs.languageDialog.$el));
        var D = this.languageDialog;
        D.visible = true;
    };

    // App: Bio Dialog

    $app.data.bioDialog = {
        visible: false,
        loading: false,
        bio: '',
        bioLinks: []
    };

    pubsub.subscribe('LOGOUT', function() {
        $app.bioDialog.visible = false;
    });

    $app.methods.saveBio = async function() {
        var D = this.bioDialog;
        if (D.loading) {
            return;
        }

        D.loading = true;

        try {
            await api.saveCurrentUser({
                bio: D.bio,
                bioLinks: D.bioLinks
            });

            this.$message({
                message: 'Bio updated',
                type: 'success'
            });

            D.visible = false;
        } catch (err) {
            console.error(err);
        }

        D.loading = false;
    };

    $app.methods.showBioDialog = function() {
        this.$nextTick(() => adjustDialogZ(this.$refs.bioDialog.$el));
        var D = this.bioDialog;
        D.bio = api.currentUser.bio;
        D.bioLinks = api.currentUser.bioLinks.slice();
        D.visible = true;
    };

    // App: New Instance Dialog

    $app.data.newInstanceDialog = {
        visible: false,
        loading: false,
        worldId: '',
        instanceId: '',
        accessType: '',
        location: '',
        url: ''
    };

    pubsub.subscribe('LOGOUT', function() {
        $app.newInstanceDialog.visible = false;
    });

    $app.methods.buildInstance = function() {
        var D = this.newInstanceDialog;
        var tags = [];
        tags.push((99999 * Math.random() + 1).toFixed(0));
        if (D.accessType !== 'public') {
            if (D.accessType === 'friends+') {
                tags.push(`~hidden(${api.currentUser.id})`);
            } else if (D.accessType === 'friends') {
                tags.push(`~friends(${api.currentUser.id})`);
            } else {
                tags.push(`~private(${api.currentUser.id})`);
            }
            // NOTE : crypto.getRandomValues()를 쓰면 안전한 대신 무겁겠지..
            /*
            var nonce = [];
            for (var i = 0; i < 10; ++i) {
                nonce.push(Math.random().toString(16).substr(2).toUpperCase());
            }
            nonce = nonce.join('').substr(0, 64);
            */
            if (D.accessType === 'invite+') {
                tags.push('~canRequestInvite');
            }
            tags.push(`~nonce(${uuid.v4()})`);
        }
        D.instanceId = tags.join('');
    };

    var getLaunchURL = function(worldId, instanceId) {
        if (instanceId) {
            return `https://vrchat.com/home/launch?worldId=${encodeURIComponent(
                worldId
            )}&instanceId=${encodeURIComponent(instanceId)}`;
        }
        return `https://vrchat.com/home/launch?worldId=${encodeURIComponent(
            worldId
        )}`;
    };

    var updateLocationURL = function() {
        var D = this.newInstanceDialog;
        if (D.instanceId) {
            D.location = `${D.worldId}:${D.instanceId}`;
        } else {
            D.location = D.worldId;
        }
        D.url = getLaunchURL(D.worldId, D.instanceId);
    };
    $app.watch['newInstanceDialog.worldId'] = updateLocationURL;
    $app.watch['newInstanceDialog.instanceId'] = updateLocationURL;

    $app.methods.showNewInstanceDialog = function(tag) {
        this.$nextTick(() => adjustDialogZ(this.$refs.newInstanceDialog.$el));
        var L = parseLocation(tag);
        if (L.isOffline || L.isPrivate || L.worldId === '') {
            return;
        }
        var D = this.newInstanceDialog;
        D.worldId = L.worldId;
        D.accessType = 'public';
        this.buildInstance();
        D.visible = true;
    };

    $app.methods.makeHome = function(tag) {
        this.$confirm('Continue? Make Home', 'Confirm', {
            confirmButtonText: 'Confirm',
            cancelButtonText: 'Cancel',
            type: 'info',
            callback: async (action) => {
                if (action !== 'confirm') {
                    return;
                }
                try {
                    await api.saveCurrentUser({
                        homeLocation: tag
                    });
                    this.$message({
                        message: 'Home world updated',
                        type: 'success'
                    });
                } catch (err) {
                    console.error(err);
                }
            }
        });
    };

    // App: Launch Options

    $app.data.launchArguments = VRCXStorage.Get('launchArguments');

    // App: Launch Options Dialog

    $app.data.launchOptionsDialog = {
        visible: false,
        arguments: ''
    };

    pubsub.subscribe('LOGOUT', function() {
        $app.launchOptionsDialog.visible = false;
    });

    $app.methods.updateLaunchOptions = function() {
        var D = this.launchOptionsDialog;
        D.visible = false;
        var args = String(D.arguments)
            .replace(/\s+/g, ' ')
            .trim();
        this.launchArguments = args;
        VRCXStorage.Set('launchArguments', args);
        this.$message({
            message: 'updated',
            type: 'success'
        });
    };

    $app.methods.showLaunchOptions = function() {
        this.$nextTick(() => adjustDialogZ(this.$refs.launchOptionsDialog.$el));
        var D = this.launchOptionsDialog;
        D.arguments = this.launchArguments;
        D.visible = true;
    };

    // App: Notification position

    $app.data.notificationPositionDialog = {
        visible: false
    };

    $app.methods.showNotificationPositionDialog = function() {
        this.$nextTick(() =>
            adjustDialogZ(this.$refs.notificationPositionDialog.$el)
        );
        this.notificationPositionDialog.visible = true;
    };

    // App: Noty feed filters

    $app.data.notyFeedFiltersDialog = {
        visible: false
    };

    $app.methods.showNotyFeedFiltersDialog = function() {
        this.$nextTick(() =>
            adjustDialogZ(this.$refs.notyFeedFiltersDialog.$el)
        );
        this.notyFeedFiltersDialog.visible = true;
    };

    // App: Wrist feed filters

    $app.data.wristFeedFiltersDialog = {
        visible: false
    };

    $app.methods.showWristFeedFiltersDialog = function() {
        this.$nextTick(() =>
            adjustDialogZ(this.$refs.wristFeedFiltersDialog.$el)
        );
        this.wristFeedFiltersDialog.visible = true;
    };

    // App: Launch Dialog

    $app.data.launchDialog = {
        visible: false,
        loading: false,
        desktop: configRepository.getBool('launchAsDesktop'),
        location: '',
        url: ''
    };

    $app.watch['launchDialog.desktop'] = function() {
        configRepository.setBool('launchAsDesktop', this.launchDialog.desktop);
    };

    pubsub.subscribe('LOGOUT', function() {
        $app.launchDialog.visible = false;
    });

    $app.methods.showLaunchDialog = function(tag) {
        this.$nextTick(() => adjustDialogZ(this.$refs.launchDialog.$el));
        var L = parseLocation(tag);
        if (L.isOffline || L.isPrivate || L.worldId === '') {
            return;
        }
        var D = this.launchDialog;
        if (L.instanceId) {
            D.location = `${L.worldId}:${L.instanceId}`;
        } else {
            D.location = L.worldId;
        }
        D.url = getLaunchURL(L.worldId, L.instanceId);
        D.visible = true;
    };

    $app.methods.locationToLaunchArg = function(location) {
        return `vrchat://launch?id=${location}`;
    };

    $app.methods.launchGame = function(...args) {
        var D = this.launchDialog;
        if (this.launchArguments) {
            args.push(this.launchArguments);
        }
        if (D.desktop === true) {
            args.push('--no-vr');
        }
        AppApi.StartGame(args.join(' '));
        D.visible = false;
    };

    // App: Copy To Clipboard

    $app.methods.copyToClipboard = function(text) {
        var textArea = document.createElement('textarea');
        textArea.id = 'copy_to_clipboard';
        textArea.value = text;
        textArea.style.top = '0';
        textArea.style.left = '0';
        textArea.style.position = 'fixed';
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        document.execCommand('copy');
        document.getElementById('copy_to_clipboard').remove();
    };

    $app.methods.copyInstanceUrl = function(url) {
        this.copyToClipboard(url);
        this.$message({
            message: 'Instance URL copied to clipboard',
            type: 'success'
        });
        this.launchDialog.visible = false;
        this.newInstanceDialog.visible = false;
    };

    $app.methods.copyLocation = function(location) {
        var L = parseLocation(location);
        var url = getLaunchURL(L.worldId, L.instanceId);
        this.copyToClipboard(url);
        this.$message({
            message: 'Instance URL copied to clipboard',
            type: 'success'
        });
    };

    $app.methods.copyLocationCheck = function(location) {
        if (
            location === '' ||
            location === 'offline' ||
            location === 'private'
        ) {
            return false;
        }
        return true;
    };

    // App: VRCPlus Icons

    pubsub.subscribe('LOGIN', function() {
        $app.VRCPlusIconsTable = {};
    });

    $app.methods.displayVRCPlusIconsTable = async function() {
        try {
            await API.refreshVRCPlusIconsTableData({
                n: 50,
                tag: 'icon'
            });
        } catch (err) {
            console.error(err);
        }
    };

    API.refreshVRCPlusIconsTableData = async function(params) {
        var json = await api.legacyApi('files', {
            method: 'GET',
            params
        });
        var args = {
            json,
            params
        };
        pubsub.publish('VRCPLUSICON:LIST', args);
        return args;
    };

    pubsub.subscribe('VRCPLUSICON:LIST', function(args) {
        $app.VRCPlusIconsTable = args.json;
    });

    $app.methods.setVRCPlusIcon = async function(userIcon) {
        if (userIcon !== '') {
            userIcon = `https://api.vrchat.cloud/api/1/file/${userIcon}/1`;
        }
        try {
            await API.setVRCPlusIcon({
                userIcon
            });
            this.$message({
                message: 'Icon changed',
                type: 'success'
            });
        } catch (err) {
            console.error(err);
        }
    };

    API.setVRCPlusIcon = async function(params) {
        var json = await api.legacyApi(`users/${api.currentUser.id}`, {
            method: 'PUT',
            params
        });
        var args = {
            json,
            params
        };
        pubsub.publish('USER:CURRENT:SAVE', args);
        return args;
    };

    $app.methods.deleteVRCPlusIcon = async function(userIcon) {
        try {
            await API.deleteVRCPlusIcon(userIcon);
        } catch (err) {
            console.error(err);
        }
    };

    pubsub.subscribe('VRCPLUSICON:DELETE', function(args) {
        var array = $app.VRCPlusIconsTable;
        var {length} = array;
        for (var i = 0; i < length; ++i) {
            if (args.userIcon === array[i].id) {
                array.splice(i, 1);
                break;
            }
        }
    });

    API.deleteVRCPlusIcon = async function(userIcon) {
        var json = await api.legacyApi(`file/${userIcon}`, {
            method: 'DELETE'
        });
        var args = {
            json,
            userIcon
        };
        pubsub.publish('VRCPLUSICON:DELETE', args);
        return args;
    };

    $app.methods.compareCurrentVRCPlusIcon = function(userIcon) {
        try {
            var currentUserIcon = extractFileId(api.currentUser.userIcon);
            if (userIcon === currentUserIcon) {
                return true;
            }
        } catch (err) {}
        return false;
    };

    $app.methods.onFileChangeVRCPlusIcon = async function(e) {
        try {
            var files = e.target.files || e.dataTransfer.files;
            if (!files.length) {
                return;
            }

            if (files[0].size >= 10000000) {
                //10MB
                $app.$message({
                    message: 'File size too large',
                    type: 'error'
                });
                return;
            }

            if (!files[0].type.match(/image.*/)) {
                $app.$message({
                    message: "File isn't an image",
                    type: 'error'
                });
                return;
            }

            try {
                await API.uploadVRCPlusIcon(files[0]);
                $app.$message({
                    message: 'Icon uploaded',
                    type: 'success'
                });
            } catch (err) {
                console.error(err);
            }
        } finally {
            if (document.querySelector('#VRCPlusIconUploadButton')) {
                document.querySelector('#VRCPlusIconUploadButton').value = '';
            }
        }
    };

    API.uploadVRCPlusIcon = async function(image) {
        var formData = new FormData();
        formData.set('image', image);
        var json = await api.legacyApi('icon', {
            method: 'POST',
            params: formData
        });
        var args = {
            json
        };
        pubsub.publish('VRCPLUSICON:ADD', args);
        return args;
    };

    pubsub.subscribe('VRCPLUSICON:ADD', function(args) {
        if (Object.keys($app.VRCPlusIconsTable).length !== 0) {
            $app.VRCPlusIconsTable.push(args.json);
        }
    });

    $app.methods.displayVRCPlusIconUpload = function() {
        document.getElementById('VRCPlusIconUploadButton').click();
    };

    /** @type {File?} */
    var inviteImageFile = void 0;

    $app.methods.clearInviteImageUpload = function() {
        for (var button of document.querySelectorAll(
            '.inviteImageUploadButton'
        )) {
            button.value = '';
        }
        inviteImageFile = void 0;
    };

    $app.methods.inviteImageUpload = function(e) {
        var files = e.target.files || e.dataTransfer.files;
        if (!files.length) {
            return;
        }

        if (files[0].size >= 10000000) {
            //10MB
            $app.$message({
                message: 'File size too large',
                type: 'error'
            });
            this.clearInviteImageUpload();
            return;
        }

        if (!files[0].type.match(/image.png/)) {
            $app.$message({
                message: "File isn't a png",
                type: 'error'
            });
            this.clearInviteImageUpload();
            return;
        }

        inviteImageFile = files[0];
    };

    $app.methods.userOnlineFor = function(ctx) {
        if (ctx.ref.state === 'online' && ctx.ref.$online_for) {
            return timeToText(Date.now() - ctx.ref.$online_for);
        } else if (ctx.ref.$offline_for) {
            return timeToText(Date.now() - ctx.ref.$offline_for);
        }
        return '-';
    };

    // App: Invite Messages

    pubsub.subscribe('LOGIN', function() {
        $app.inviteMessageTable.data = [];
        $app.inviteResponseMessageTable.data = [];
        $app.inviteRequestMessageTable.data = [];
        $app.inviteRequestResponseMessageTable.data = [];
        $app.inviteMessageTable.visible = false;
        $app.inviteResponseMessageTable.visible = false;
        $app.inviteRequestMessageTable.visible = false;
        $app.inviteRequestResponseMessageTable.visible = false;
    });

    $app.methods.refreshInviteMessageTable = function(messageType) {
        API.refreshInviteMessageTableData(messageType);
    };

    API.refreshInviteMessageTableData = async function(messageType) {
        var json = await api.legacyApi(
            `message/${api.currentUser.id}/${messageType}`,
            {
                method: 'GET'
            }
        );
        var args = {
            json,
            messageType
        };
        pubsub.publish(`INVITE:${messageType.toUpperCase()}`, args);
        return args;
    };

    API.editInviteMessage = async function(messageType, slot, params) {
        var json = await api.legacyApi(
            `message/${api.currentUser.id}/${messageType}/${slot}`,
            {
                method: 'PUT',
                params
            }
        );
        var args = {
            json,
            params,
            messageType,
            slot
        };
        pubsub.publish(`INVITE:${messageType.toUpperCase()}`, args);
        return args;
    };

    pubsub.subscribe('INVITE:MESSAGE', function(args) {
        $app.inviteMessageTable.data = args.json;
    });

    pubsub.subscribe('INVITE:RESPONSE', function(args) {
        $app.inviteResponseMessageTable.data = args.json;
    });

    pubsub.subscribe('INVITE:REQUEST', function(args) {
        $app.inviteRequestMessageTable.data = args.json;
    });

    pubsub.subscribe('INVITE:REQUESTRESPONSE', function(args) {
        $app.inviteRequestResponseMessageTable.data = args.json;
    });

    // App: Edit Invite Message Dialog

    $app.data.editInviteMessageDialog = {
        visible: false,
        inviteMessage: {},
        messageType: '',
        newMessage: ''
    };

    $app.methods.showEditInviteMessageDialog = function(
        messageType,
        inviteMessage
    ) {
        this.$nextTick(() =>
            adjustDialogZ(this.$refs.editInviteMessageDialog.$el)
        );
        var D = this.editInviteMessageDialog;
        D.newMessage = inviteMessage.message;
        D.visible = true;
        D.inviteMessage = inviteMessage;
        D.messageType = messageType;
    };

    $app.methods.saveEditInviteMessage = async function() {
        var {editInviteMessageDialog} = this;
        editInviteMessageDialog.visible = false;

        var {
            inviteMessage: {message, slot},
            messageType,
            newMessage
        } = editInviteMessageDialog;

        if (message === newMessage) {
            return;
        }

        try {
            var {json} = await API.editInviteMessage(messageType, slot, {
                message: newMessage
            });

            if (json[slot].message !== newMessage) {
                this.$message({
                    message: "VRChat API didn't update message, try again",
                    type: 'error'
                });
                return;
            }

            this.$message('Invite message updated');
        } catch (err) {
            console.error(err);
        }
    };

    $app.methods.cancelEditInviteMessage = function() {
        this.editInviteMessageDialog.visible = false;
    };

    // App: Edit and Send Invite Response Message Dialog

    $app.data.editAndSendInviteResponseDialog = {
        visible: false,
        messageType: '',
        inviteMessage: {},
        newMessage: ''
    };

    $app.methods.showEditAndSendInviteResponseDialog = function(
        messageType,
        inviteMessage
    ) {
        this.$nextTick(() =>
            adjustDialogZ(this.$refs.editAndSendInviteResponseDialog.$el)
        );
        this.editAndSendInviteResponseDialog = {
            visible: true,
            messageType,
            inviteMessage,
            newMessage: inviteMessage.message
        };
    };

    $app.methods.saveEditAndSendInviteResponse = async function() {
        var {editAndSendInviteResponseDialog} = this;
        editAndSendInviteResponseDialog.visible = false;

        try {
            var {
                messageType,
                inviteMessage: {slot, message},
                newMessage
            } = editAndSendInviteResponseDialog;

            if (message !== newMessage) {
                var {json} = await API.editInviteMessage(messageType, slot, {
                    message: newMessage
                });

                if (json[slot].message !== newMessage) {
                    this.$message({
                        message: "VRChat API didn't update message, try again",
                        type: 'error'
                    });
                    return;
                }

                this.$message('Invite message updated');
            }

            var inviteId = this.sendInviteResponseDialog.invite.id;

            if (inviteImageFile) {
                await api.sendInviteResponsePhoto(inviteId, {
                    rsvp: 'true',
                    responseSlot: slot,
                    image: inviteImageFile
                });
                this.$message({
                    message: 'Invite response photo message sent',
                    type: 'success'
                });
            } else {
                await api.sendInviteResponse(inviteId, {
                    rsvp: 'true',
                    responseSlot: slot
                });
                this.$message({
                    message: 'Invite response message sent',
                    type: 'success'
                });
            }

            await api.hideNotification({
                notificationId: inviteId
            });
        } catch (err) {
            console.error(err);
            return;
        }

        this.sendInviteResponseDialogVisible = false;
        this.sendInviteRequestResponseDialogVisible = false;
    };

    $app.methods.cancelEditAndSendInviteResponse = function() {
        this.editAndSendInviteResponseDialog.visible = false;
    };

    $app.data.sendInviteResponseDialog = {
        message: '',
        messageSlot: 0,
        invite: {}
    };

    $app.data.sendInviteResponseDialogVisible = false;

    $app.data.sendInviteResponseConfirmDialog = {
        visible: false
    };

    pubsub.subscribe('LOGIN', function() {
        $app.sendInviteResponseDialogVisible = false;
        $app.sendInviteResponseConfirmDialog.visible = false;
    });

    $app.methods.showSendInviteResponseDialog = function(invite) {
        this.sendInviteResponseDialog = {
            invite
        };

        API.refreshInviteMessageTableData('response');

        this.$nextTick(() =>
            adjustDialogZ(this.$refs.sendInviteResponseDialog.$el)
        );

        this.clearInviteImageUpload();
        this.sendInviteResponseDialogVisible = true;
    };

    $app.methods.showSendInviteResponseConfirmDialog = function(val) {
        if (
            this.editAndSendInviteResponseDialog.visible === true ||
            val === null
        ) {
            return;
        }

        this.$nextTick(() =>
            adjustDialogZ(this.$refs.sendInviteResponseConfirmDialog.$el)
        );

        this.sendInviteResponseConfirmDialog.visible = true;
        this.sendInviteResponseDialog.messageSlot = val.slot;
    };

    $app.methods.cancelSendInviteResponse = function() {
        this.sendInviteResponseDialogVisible = false;
    };

    $app.methods.cancelInviteResponseConfirm = function() {
        this.sendInviteResponseConfirmDialog.visible = false;
    };

    $app.methods.sendInviteResponseConfirm = async function() {
        var {sendInviteResponseDialog} = this;

        try {
            var {
                messageSlot,
                invite: {id: inviteId}
            } = sendInviteResponseDialog;

            if (inviteImageFile) {
                await api.sendInviteResponsePhoto(inviteId, {
                    rsvp: 'true',
                    responseSlot: messageSlot,
                    image: inviteImageFile
                });
                this.$message({
                    message: 'Invite response photo message sent',
                    type: 'success'
                });
            } else {
                await api.sendInviteResponse(inviteId, {
                    rsvp: 'true',
                    responseSlot: messageSlot
                });
                this.$message({
                    message: 'Invite response message sent',
                    type: 'success'
                });
            }

            await api.hideNotification({
                notificationId: inviteId
            });
        } catch (err) {
            console.error(err);
        }

        this.sendInviteResponseDialogVisible = false;
        this.sendInviteRequestResponseDialogVisible = false;
        this.sendInviteResponseConfirmDialog.visible = false;
    };

    // App: Invite Request Response Message Dialog

    $app.data.sendInviteRequestResponseDialogVisible = false;

    $app.methods.cancelSendInviteRequestResponse = function() {
        this.sendInviteRequestResponseDialogVisible = false;
    };

    pubsub.subscribe('LOGIN', function() {
        $app.sendInviteRequestResponseDialogVisible = false;
        $app.showSendInviteResponseConfirmDialog.visible = false;
    });

    $app.methods.showSendInviteRequestResponseDialog = function(invite) {
        this.sendInviteResponseDialog = {
            invite
        };

        API.refreshInviteMessageTableData('requestResponse');

        this.$nextTick(() =>
            adjustDialogZ(this.$refs.sendInviteRequestResponseDialog.$el)
        );

        this.clearInviteImageUpload();
        this.sendInviteRequestResponseDialogVisible = true;
    };

    // App: Invite Message Dialog

    $app.data.editAndSendInviteDialog = {
        visible: false,
        messageType: '',
        inviteMessage: {},
        newMessage: ''
    };

    $app.methods.showEditAndSendInviteDialog = function(
        messageType,
        inviteMessage
    ) {
        this.$nextTick(() =>
            adjustDialogZ(this.$refs.editAndSendInviteDialog.$el)
        );
        this.editAndSendInviteDialog = {
            visible: true,
            messageType,
            inviteMessage,
            newMessage: inviteMessage.message
        };
    };

    $app.methods.saveEditAndSendInvite = async function() {
        if (api.currentUser.status === 'busy') {
            this.$message({
                message: "You can't invite yourself in 'Do Not Disturb' mode",
                type: 'error'
            });
            return;
        }

        try {
            var {editAndSendInviteDialog} = this;
            editAndSendInviteDialog.visible = false;

            var {
                messageType,
                inviteMessage: {slot, message},
                newMessage
            } = editAndSendInviteDialog;

            if (message !== newMessage) {
                var {json} = await API.editInviteMessage(messageType, slot, {
                    message: newMessage
                });

                if (json[slot].message !== newMessage) {
                    this.$message({
                        message: "VRChat API didn't update message, try again",
                        type: 'error'
                    });
                    return;
                }

                this.$message('Invite message updated');
            }

            var {inviteDialog, sendInviteDialog} = this;

            if (inviteDialog.visible) {
                var {userIds, worldId} = inviteDialog;
                inviteDialog.loading = true;

                if (inviteImageFile) {
                    var params = {
                        instanceId: worldId,
                        worldId: worldId,
                        messageSlot: slot,
                        image: inviteImageFile
                    };
                    while (userIds.length > 0) {
                        var userId = userIds.shift();
                        try {
                            await api.sendInvitePhoto(userId, params);
                        } catch (err) {
                            console.error(err);
                        }
                    }
                } else {
                    var params = {
                        instanceId: worldId,
                        worldId: worldId,
                        messageSlot: slot
                    };
                    while (userIds.length > 0) {
                        var userId = userIds.shift();
                        try {
                            await api.sendInvite(userId, params);
                        } catch (err) {
                            console.error(err);
                        }
                    }
                }

                this.$message({
                    message: 'Invite message sent',
                    type: 'success'
                });

                inviteDialog.loading = false;
                inviteDialog.visible = false;
            } else {
                var {
                    userId,
                    messageType,
                    params: {worldId}
                } = sendInviteDialog;
                if (messageType === 'invite') {
                    if (inviteImageFile) {
                        await api.sendInvitePhoto(userId, {
                            instanceId: worldId,
                            worldId: worldId,
                            messageSlot: slot,
                            image: inviteImageFile
                        });
                        this.$message({
                            message: 'Invite photo message sent',
                            type: 'success'
                        });
                    } else {
                        await api.sendInvitePhoto(userId, {
                            instanceId: worldId,
                            worldId: worldId,
                            messageSlot: slot
                        });
                        this.$message({
                            message: 'Invite message sent',
                            type: 'success'
                        });
                    }
                } else if (messageType === 'requestInvite') {
                    if (inviteImageFile) {
                        await api.sendRequestInvitePhoto(userId, {
                            instanceId: worldId,
                            worldId: worldId,
                            requestSlot: slot,
                            image: inviteImageFile
                        });
                        this.$message({
                            message: 'Request invite photo message sent',
                            type: 'success'
                        });
                    } else {
                        await api.sendRequestInvite(userId, {
                            instanceId: worldId,
                            worldId: worldId,
                            requestSlot: slot
                        });
                        this.$message({
                            message: 'Request invite message sent',
                            type: 'success'
                        });
                    }
                }
            }
        } catch (err) {
            console.error(err);
            this.clearInviteImageUpload();
        }

        this.sendInviteDialogVisible = false;
        this.sendInviteRequestDialogVisible = false;
    };

    $app.methods.cancelEditAndSendInvite = function() {
        this.editAndSendInviteDialog.visible = false;
    };

    $app.data.sendInviteDialog = {
        userId: '',
        messageType: '',
        messageSlot: 0,
        message: '',
        params: {}
    };

    $app.data.sendInviteDialogVisible = false;

    $app.data.sendInviteConfirmDialog = {
        visible: false
    };

    pubsub.subscribe('LOGIN', function() {
        $app.sendInviteDialogVisible = false;
        $app.sendInviteConfirmDialog.visible = false;
    });

    $app.methods.showSendInviteDialog = function(userId, params = {}) {
        this.sendInviteDialog = {
            userId,
            messageType: 'invite',
            params
        };

        API.refreshInviteMessageTableData('message');

        this.$nextTick(() => adjustDialogZ(this.$refs.sendInviteDialog.$el));

        this.clearInviteImageUpload();
        this.sendInviteDialogVisible = true;
    };

    $app.methods.showSendInviteConfirmDialog = function(val) {
        if (this.editAndSendInviteDialog.visible === true || val === null) {
            return;
        }
        this.$nextTick(() =>
            adjustDialogZ(this.$refs.sendInviteConfirmDialog.$el)
        );
        this.sendInviteConfirmDialog.visible = true;
        this.sendInviteDialog.messageSlot = val.slot;
    };

    $app.methods.cancelSendInvite = function() {
        this.sendInviteDialogVisible = false;
    };

    $app.methods.cancelInviteConfirm = function() {
        this.sendInviteConfirmDialog.visible = false;
    };

    $app.methods.sendInviteConfirm = async function() {
        if (api.currentUser.status === 'busy') {
            this.$message({
                message: "You can't invite yourself in 'Do Not Disturb' mode",
                type: 'error'
            });
            return;
        }

        try {
            var {sendInviteDialog, inviteDialog} = this;
            var {messageSlot} = sendInviteDialog;

            if (inviteDialog.visible) {
                var {userIds, worldId} = inviteDialog;
                inviteDialog.loading = true;

                if (inviteImageFile) {
                    var params = {
                        instanceId: worldId,
                        worldId: worldId,
                        messageSlot,
                        image: inviteImageFile
                    };
                    while (userIds.length > 0) {
                        var userId = userIds.shift();
                        try {
                            await api.sendInvitePhoto(userId, params);
                        } catch (err) {
                            console.error(err);
                        }
                    }
                } else {
                    var params = {
                        instanceId: worldId,
                        worldId: worldId,
                        messageSlot
                    };
                    while (userIds.length > 0) {
                        var userId = userIds.shift();
                        try {
                            await api.sendInvite(userId, params);
                        } catch (err) {
                            console.error(err);
                        }
                    }
                }

                this.$message({
                    message: 'Invite message sent',
                    type: 'success'
                });

                inviteDialog.loading = false;
                inviteDialog.visible = false;
            } else {
                var {
                    userId,
                    messageType,
                    params: {worldId}
                } = sendInviteDialog;

                if (messageType === 'invite') {
                    if (inviteImageFile) {
                        await api.sendInvitePhoto(userId, {
                            instanceId: worldId,
                            worldId: worldId,
                            messageSlot,
                            image: inviteImageFile
                        });
                        this.$message({
                            message: 'Invite photo message sent',
                            type: 'success'
                        });
                    } else {
                        await api.sendInvitePhoto(userId, {
                            instanceId: worldId,
                            worldId: worldId,
                            messageSlot
                        });
                        this.$message({
                            message: 'Invite message sent',
                            type: 'success'
                        });
                    }
                } else if (messageType === 'requestInvite') {
                    if (inviteImageFile) {
                        await api.sendRequestInvitePhoto(userId, {
                            instanceId: worldId,
                            worldId: worldId,
                            requestSlot: messageSlot,
                            image: inviteImageFile
                        });
                        this.$message({
                            message: 'Request invite photo message sent',
                            type: 'success'
                        });
                    } else {
                        await api.sendRequestInvite(userId, {
                            instanceId: worldId,
                            worldId: worldId,
                            requestSlot: messageSlot
                        });
                        this.$message({
                            message: 'Request invite message sent',
                            type: 'success'
                        });
                    }
                }
            }
        } catch (err) {
            console.error(err);
        }

        this.sendInviteDialogVisible = false;
        this.sendInviteRequestDialogVisible = false;
        this.sendInviteConfirmDialog.visible = false;
    };

    // App: Invite Request Message Dialog

    $app.data.sendInviteRequestDialogVisible = false;

    $app.methods.cancelSendInviteRequest = function() {
        this.sendInviteRequestDialogVisible = false;
    };

    pubsub.subscribe('LOGIN', function() {
        $app.sendInviteRequestDialogVisible = false;
        $app.showSendInviteConfirmDialog.visible = false;
    });

    $app.methods.showSendInviteRequestDialog = function(params, userId) {
        this.sendInviteDialog = {
            params,
            userId,
            messageType: 'requestInvite'
        };

        API.refreshInviteMessageTableData('request');

        this.$nextTick(() =>
            adjustDialogZ(this.$refs.sendInviteRequestDialog.$el)
        );

        this.clearInviteImageUpload();
        this.sendInviteRequestDialogVisible = true;
    };

    // App: Friends List

    pubsub.subscribe('LOGIN', function() {
        $app.friendsListTable.data = [];
    });

    $app.methods.selectFriendsListRow = function(val) {
        if (val === null) {
            return;
        }
        this.showUserDialog(val.id);
    };

    $app.data.friendsListSearch = '';
    $app.data.friendsListSearchFilterVIP = false;
    $app.data.friendsListSearchFilters = [
        'Display Name',
        'User Name',
        'Rank',
        'Status',
        'Bio',
        'Memo'
    ];

    $app.methods.friendsListSearchChange = function() {
        var filters = this.friendsListSearchFilters;
        var results = [];
        if (this.friendsListSearch) {
            var query = this.friendsListSearch.toUpperCase();
        }
        for (var ctx of this.friends.values()) {
            if (ctx.ref === void 0) {
                continue;
            }
            if (this.friendsListSearchFilterVIP && !ctx.isVIP) {
                continue;
            }
            if (query && filters) {
                var match = false;
                if (!match && filters.includes('User Name')) {
                    var uname = String(ctx.ref.username);
                    match =
                        uname.toUpperCase().includes(query) &&
                        !uname.startsWith('steam_');
                }
                if (
                    !match &&
                    filters.includes('Display Name') &&
                    ctx.ref.displayName
                ) {
                    match = String(ctx.ref.displayName)
                        .toUpperCase()
                        .includes(query);
                }
                if (!match && filters.includes('Memo') && ctx.memo) {
                    match = String(ctx.memo)
                        .toUpperCase()
                        .includes(query);
                }
                if (!match && filters.includes('Bio') && ctx.ref.bio) {
                    match = String(ctx.ref.bio)
                        .toUpperCase()
                        .includes(query);
                }
                if (
                    !match &&
                    filters.includes('Status') &&
                    ctx.ref.statusDescription
                ) {
                    match = String(ctx.ref.statusDescription)
                        .toUpperCase()
                        .includes(query);
                }
                if (!match && filters.includes('Rank') && ctx.ref.$friendNum) {
                    match = String(ctx.ref.$trustLevel)
                        .toUpperCase()
                        .includes(query);
                }
                if (!match) {
                    continue;
                }
            }
            ctx.ref.$friendNum = ctx.no;
            switch (ctx.ref.$trustLevel) {
                case 'Nuisance':
                    ctx.ref.$trustNum = '0';
                    break;
                case 'Visitor':
                    ctx.ref.$trustNum = '1';
                    break;
                case 'New User':
                    ctx.ref.$trustNum = '2';
                    break;
                case 'User':
                    ctx.ref.$trustNum = '3';
                    break;
                case 'Known User':
                    ctx.ref.$trustNum = '4';
                    break;
                case 'Trusted User':
                    ctx.ref.$trustNum = '5';
                    break;
                case 'Veteran User':
                    ctx.ref.$trustNum = '6';
                    break;
                case 'Legendary User':
                    ctx.ref.$trustNum = '7';
                    break;
                case 'VRChat Team':
                    ctx.ref.$trustNum = '8';
                    break;
            }
            results.push(ctx.ref);
        }
        this.friendsListTable.data = results;
    };

    $app.watch.friendsListSearch = $app.methods.friendsListSearchChange;
    $app.data.friendsListLoading = false;
    $app.data.friendsListLoadingProgress = '';

    $app.methods.friendsListLoadUsers = async function() {
        this.friendsListLoading = true;
        var i = 0;
        var toFetch = [];
        for (var ctx of this.friends.values()) {
            if (ctx.ref && !ctx.ref.date_joined) {
                toFetch.push(ctx.id);
            }
        }
        var length = toFetch.length;
        for (var userId of toFetch) {
            if (!this.friendsListLoading) {
                this.friendsListLoadingProgress = '';
                return;
            }
            i++;
            this.friendsListLoadingProgress = `${i}/${length}`;
            await api.getUser({
                userId: userId
            });
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        this.friendsListLoadingProgress = '';
        this.friendsListLoading = false;
    };

    $app.methods.sortAlphabetically = function(a, b, field) {
        return a[field].toLowerCase().localeCompare(b[field].toLowerCase());
    };

    $app.methods.sortLanguages = function(a, b) {
        var sortedA = [];
        var sortedB = [];
        a.$languages.forEach((item) => {
            sortedA.push(item.value);
        });
        b.$languages.forEach((item) => {
            sortedB.push(item.value);
        });
        sortedA.sort();
        sortedB.sort();
        return JSON.stringify(sortedA).localeCompare(JSON.stringify(sortedB));
    };

    $app.methods.genMd5 = async function(file) {
        var response = await AppApi.MD5File(file);
        return response;
    };

    $app.methods.genSig = async function(file) {
        var response = await AppApi.SignFile(file);
        return response;
    };

    $app.methods.genLength = async function(file) {
        var response = await AppApi.FileLength(file);
        return response;
    };

    // Upload avatar image

    $app.methods.onFileChangeAvatarImage = function(e) {
        try {
            var files = e.target.files || e.dataTransfer.files;
            if (
                !files.length ||
                !this.avatarDialog.visible ||
                this.avatarDialog.loading
            ) {
                return;
            }

            if (files[0].size >= 10000000) {
                //10MB
                $app.$message({
                    message: 'File size too large',
                    type: 'error'
                });
                return;
            }

            if (!files[0].type.match(/image.png/)) {
                $app.$message({
                    message: "File isn't a png",
                    type: 'error'
                });
                return;
            }

            var r = new FileReader();
            r.onload = async function(file) {
                var base64File = btoa(r.result);
                var fileMd5 = await $app.genMd5(base64File);
                var fileSizeInBytes = file.total;
                var base64SignatureFile = await $app.genSig(base64File);
                var signatureMd5 = await $app.genMd5(base64SignatureFile);
                var signatureSizeInBytes = await $app.genLength(
                    base64SignatureFile
                );

                var avatarId = $app.avatarDialog.id;
                var fileId = extractFileId($app.avatarDialog.ref.imageUrl);
                if (!fileId) {
                    $app.$message({
                        message: 'Current avatar image invalid',
                        type: 'error'
                    });
                    return;
                }

                $app.avatarImage = {
                    base64File,
                    fileMd5,
                    base64SignatureFile,
                    signatureMd5,
                    fileId,
                    avatarId
                };

                var params = {
                    fileMd5,
                    fileSizeInBytes,
                    signatureMd5,
                    signatureSizeInBytes
                };

                this.avatarDialog.loading = true;

                try {
                    var json = await api.legacyApi(`file/${fileId}`, {
                        method: 'POST',
                        params
                    });

                    var fileVersion =
                        json.versions[json.versions.length - 1].version;

                    var json = await api.legacyApi(
                        `file/${fileId}/${fileVersion}/file/start`,
                        {
                            method: 'PUT'
                        }
                    );

                    await API.uploadAvatarImageFileAWS({
                        url: json.url,
                        fileId,
                        fileVersion
                    });

                    await api.legacyApi(
                        `file/${fileId}/${fileVersion}/file/finish`,
                        {
                            method: 'PUT',
                            params: {
                                maxParts: 0,
                                nextPartNumber: 0
                            }
                        }
                    );

                    var json = await api.legacyApi(
                        `file/${fileId}/${fileVersion}/signature/start`,
                        {
                            method: 'PUT'
                        }
                    );

                    await API.uploadAvatarImageSigAWS({
                        url: json.url,
                        fileId,
                        fileVersion
                    });

                    await api.legacyApi(
                        `file/${fileId}/${fileVersion}/signature/finish`,
                        {
                            method: 'PUT',
                            params: {
                                maxParts: 0,
                                nextPartNumber: 0
                            }
                        }
                    );

                    await API.setAvatarImage({
                        id: avatarId,
                        imageUrl: `https://api.vrchat.cloud/api/1/file/${fileId}/${fileVersion}/file`
                    });
                } catch (err) {
                    console.error(err);

                    // uploadAvatarFailCleanup
                    try {
                        var json = await api.legacyApi(`file/${fileId}`, {
                            method: 'GET'
                        });

                        var fileVersion =
                            json.versions[json.versions.length - 1].version;

                        await Promise.all([
                            api.legacyApi(
                                `file/${fileId}/${fileVersion}/signature/finish`,
                                {
                                    method: 'PUT'
                                }
                            ),
                            api.legacyApi(
                                `file/${fileId}/${fileVersion}/file/finish`,
                                {
                                    method: 'PUT'
                                }
                            )
                        ]);
                    } catch (err) {
                        console.error(err);
                    }
                }

                app.avatarDialog.loading = false;
            };
            r.readAsBinaryString(files[0]);
        } finally {
            if (document.querySelector('#AvatarImageUploadButton')) {
                document.querySelector('#AvatarImageUploadButton').value = '';
            }
        }
    };

    API.uploadAvatarImageFileAWS = function(params) {
        // return webApiService.execute({
        //     url: params.url,
        //     uploadFilePUT: true,
        //     fileData: $app.avatarImage.base64File,
        //     fileMIME: 'image/png',
        //     headers: {
        //         'Content-MD5': $app.avatarImage.fileMd5
        //     }
        // }).then((json) => {
        //     if (json.status !== 200) {
        //         $app.avatarDialog.loading = false;
        //         this.$throw('Avatar image upload failed', json);
        //     }
        //     var args = {
        //         json,
        //         params
        //     };
        //     pubsub.publish('AVATARIMAGE:FILEAWS', args);
        //     return args;
        // });
    };

    API.uploadAvatarImageSigAWS = function(params) {
        // return webApiService.execute({
        //     url: params.url,
        //     uploadFilePUT: true,
        //     fileData: $app.avatarImage.base64SignatureFile,
        //     fileMIME: 'application/x-rsync-signature',
        //     headers: {
        //         'Content-MD5': $app.avatarImage.signatureMd5
        //     }
        // }).then((json) => {
        //     if (json.status !== 200) {
        //         $app.avatarDialog.loading = false;
        //         this.$throw('Avatar image upload failed', json);
        //     }
        //     var args = {
        //         json,
        //         params
        //     };
        //     pubsub.publish('AVATARIMAGE:SIGAWS', args);
        //     return args;
        // });
    };

    API.setAvatarImage = async function(params) {
        var json = await api.legacyApi(`avatars/${params.id}`, {
            method: 'PUT',
            params
        });
        var args = {
            json,
            params
        };
        pubsub.publish('AVATARIMAGE:SET', args);
        pubsub.publish('AVATAR', args);
        return args;
    };

    pubsub.subscribe('AVATARIMAGE:SET', function(args) {
        $app.avatarDialog.loading = false;
        if (args.json.imageUrl === args.params.imageUrl) {
            $app.$message({
                message: 'Avatar image changed',
                type: 'success'
            });
        } else {
            this.$throw(0, 'Avatar image change failed');
        }
    });

    API.setWorldImage = async function(params) {
        var json = await api.legacyApi(`worlds/${params.id}`, {
            method: 'PUT',
            params
        });
        var args = {
            json,
            params
        };
        pubsub.publish('WORLDIMAGE:SET', args);
        pubsub.publish('WORLD', args);
        return args;
    };

    pubsub.subscribe('WORLDIMAGE:SET', function(args) {
        $app.worldDialog.loading = false;
        if (args.json.imageUrl === args.params.imageUrl) {
            $app.$message({
                message: 'World image changed',
                type: 'success'
            });
        } else {
            this.$throw(0, 'World image change failed');
        }
    });

    // Set avatar/world image

    $app.methods.displayPreviousImages = async function(type, command) {
        this.previousImagesTableFileId = '';
        this.previousImagesTable = '';

        if (type === 'Avatar') {
            var {imageUrl} = this.avatarDialog.ref;
        } else if (type === 'World') {
            var {imageUrl} = this.worldDialog.ref;
        } else if (type === 'User') {
            var imageUrl = this.userDialog.ref.currentAvatarImageUrl;
        }

        var fileId = extractFileId(imageUrl);
        if (!fileId) {
            return;
        }

        var params = {
            fileId
        };

        if (command === 'Display') {
            this.previousImagesDialogVisible = true;
            this.$nextTick(() =>
                adjustDialogZ(this.$refs.previousImagesDialog.$el)
            );
        }

        if (type === 'Avatar') {
            if (command === 'Change') {
                this.changeAvatarImageDialogVisible = true;
                this.$nextTick(() =>
                    adjustDialogZ(this.$refs.changeAvatarImageDialog.$el)
                );
            }
            try {
                var args = await API.getAvatarImages(params);
                this.previousImagesTableFileId = args.json.id;
                var images = args.json.versions;
                this.checkPreviousImageAvailable(images);
            } catch (err) {
                console.error(err);
            }
        } else if (type === 'World') {
            if (command === 'Change') {
                this.changeWorldImageDialogVisible = true;
                this.$nextTick(() =>
                    adjustDialogZ(this.$refs.changeWorldImageDialog.$el)
                );
            }
            try {
                var args = await API.getWorldImages(params);
                this.previousImagesTableFileId = args.json.id;
                var images = args.json.versions;
                this.checkPreviousImageAvailable(images);
            } catch (err) {
                console.error(err);
            }
        } else if (type === 'User') {
            try {
                var args = await API.getAvatarImages(params);
                this.previousImagesTableFileId = args.json.id;
                var images = args.json.versions;
                this.checkPreviousImageAvailable(images);
            } catch (err) {
                console.error(err);
            }
        }
    };

    $app.methods.checkPreviousImageAvailable = async function(images) {
        this.previousImagesTable = [];
        for (var image of images) {
            var url = image?.file?.url;
            if (url === void 0) {
                continue;
            }
            try {
                var response = await fetch(url, {
                    method: 'HEAD',
                    redirect: 'follow',
                    headers: {
                        'User-Agent': appVersion
                    }
                });
                if (response.status === 200) {
                    this.previousImagesTable.push(image);
                }
            } catch (err) {
                console.error(err);
            }
        }
    };

    $app.data.previousImagesDialogVisible = false;
    $app.data.changeAvatarImageDialogVisible = false;
    $app.data.changeAvatarImageDialogLoading = false;
    $app.data.changeWorldImageDialogVisible = false;
    $app.data.changeWorldImageDialogLoading = false;
    $app.data.previousImagesTable = {};
    $app.data.previousImagesFileId = '';

    pubsub.subscribe('LOGIN', function() {
        $app.previousImagesTable = {};
        $app.previousImagesDialogVisible = false;
    });

    API.getAvatarImages = async function(params) {
        var json = await api.legacyApi(`file/${params.fileId}`, {
            method: 'GET',
            params
        });
        var args = {
            json,
            params
        };
        pubsub.publish('AVATARIMAGE:GET', args);
        return args;
    };

    API.getWorldImages = async function(params) {
        var json = await api.legacyApi(`file/${params.fileId}`, {
            method: 'GET',
            params
        });
        var args = {
            json,
            params
        };
        pubsub.publish('WORLDIMAGE:GET', args);
        return args;
    };

    pubsub.subscribe('AVATARIMAGE:GET', function(args) {
        $app.storeAvatarImage(args);
    });

    $app.methods.storeAvatarImage = function(args) {
        var refCreatedAt = args.json.versions[0];
        var fileCreatedAt = refCreatedAt.created_at;
        var ref = args.json.versions[args.json.versions.length - 1];
        var fileId = args.params.fileId;
        var avatarName = '';
        var imageName = args.json.name;
        var avatarNameRegex = /Avatar - (.*) - Image -/g.exec(imageName);
        if (avatarNameRegex) {
            avatarName = avatarNameRegex[1];
        }
        var ownerId = args.json.ownerId;
        var avatarInfo = {
            ownerId,
            avatarName,
            fileCreatedAt
        };
        API.cachedAvatarNames.set(fileId, avatarInfo);
        return avatarInfo;
    };

    $app.methods.setAvatarImage = async function(image) {
        this.changeAvatarImageDialogLoading = true;

        try {
            await API.setAvatarImage({
                id: this.avatarDialog.id,
                imageUrl: `https://api.vrchat.cloud/api/1/file/${this.previousImagesTableFileId}/${image.version}/file`
            });
            this.changeAvatarImageDialogVisible = false;
        } catch (err) {
            console.error(err);
        }

        this.changeAvatarImageDialogLoading = false;
    };

    $app.methods.setWorldImage = async function(image) {
        this.changeWorldImageDialogLoading = true;

        try {
            await API.setWorldImage({
                id: this.worldDialog.id,
                imageUrl: `https://api.vrchat.cloud/api/1/file/${this.previousImagesTableFileId}/${image.version}/file`
            });
            this.changeWorldImageDialogVisible = false;
        } catch (err) {
            console.error(err);
        }

        this.changeWorldImageDialogLoading = false;
    };

    $app.methods.compareCurrentImage = function(image) {
        if (
            `https://api.vrchat.cloud/api/1/file/${this.previousImagesTableFileId}/${image.version}/file` ===
            this.avatarDialog.ref.imageUrl
        ) {
            return true;
        }
        return false;
    };

    // Avatar names

    API.cachedAvatarNames = new Map();

    $app.methods.getAvatarName = async function() {
        var D = this.userDialog;
        D.$avatarInfo = {
            ownerId: '',
            avatarName: '-'
        };
        if (!D.visible) {
            return;
        }
        var imageUrl = D.ref.currentAvatarImageUrl;
        var fileId = extractFileId(imageUrl);
        if (!fileId) {
            return;
        }
        if (API.cachedAvatarNames.has(fileId)) {
            D.$avatarInfo = API.cachedAvatarNames.get(fileId);
            return;
        }
        try {
            var args = await API.getAvatarImages({
                fileId
            });
            var avatarInfo = this.storeAvatarImage(args);
            this.userDialog.$avatarInfo = avatarInfo;
        } catch (err) {
            console.error(err);
        }
    };

    $app.data.discordNamesDialogVisible = false;
    $app.data.discordNamesContent = '';

    $app.methods.showDiscordNamesDialog = function() {
        var {friends} = api.currentUser;
        if (Array.isArray(friends) === false) {
            return;
        }
        var lines = ['DisplayName,DiscordName'];
        var _ = function(str) {
            if (/[\x00-\x1f,"]/.test(str) === true) {
                str = `"${str.replace(/"/g, '""')}"`;
            }
            return str;
        };
        for (var userId of friends) {
            var {ref} = this.friends.get(userId);
            var discord = '';
            if (ref === void 0) {
                continue;
            }
            var name = ref.displayName;
            if (ref.statusDescription) {
                var statusRegex = /(?:^|\n*)(?:(?:[^\n:]|\|)*(?::|˸|discord)[\t\v\f\r]*)?([^\n]*(#|＃)(?: )?\d{4})/gi.exec(
                    ref.statusDescription
                );
                if (statusRegex) {
                    discord = statusRegex[1];
                }
            }
            if (!discord && ref.bio) {
                var bioRegex = /(?:^|\n*)(?:(?:[^\n:]|\|)*(?::|˸|discord)[\t\v\f\r]*)?([^\n]*(#|＃)(?: )?\d{4})/gi.exec(
                    ref.bio
                );
                if (bioRegex) {
                    discord = bioRegex[1];
                }
            }
            if (!discord) {
                continue;
            }
            discord = discord.replace('＃', '#');
            if (discord.substring(0, 1) === '#') {
                discord = `${_(name)}${_(discord)}`;
            }
            lines.push(`${_(name)},${_(discord)}`);
        }
        this.discordNamesContent = lines.join('\n');
        this.discordNamesDialogVisible = true;
    };

    // userDialog world/avatar tab click

    $app.data.userDialogLastActiveTab = '';
    $app.data.userDialogLastAvatar = '';
    $app.data.userDialogLastWorld = '';
    $app.data.userDialogLastFavoriteWorld = '';

    $app.methods.userDialogTabClick = function(obj) {
        var userId = this.userDialog.id;
        if (this.userDialogLastActiveTab === obj.label) {
            return;
        }
        if (obj.label === 'Avatars') {
            this.setUserDialogAvatars(userId);
            if (this.userDialogLastAvatar !== userId) {
                this.userDialogLastAvatar = userId;
                if (
                    userId === api.currentUser.id &&
                    this.userDialog.avatars.length === 0
                ) {
                    this.refreshUserDialogAvatars();
                }
            }
        } else if (obj.label === 'Worlds') {
            this.setUserDialogWorlds(userId);
            if (this.userDialogLastWorld !== userId) {
                this.userDialogLastWorld = userId;
                this.refreshUserDialogWorlds();
            }
        } else if (obj.label === 'Favorite Worlds') {
            if (this.userDialogLastFavoriteWorld !== userId) {
                this.userDialogLastFavoriteWorld = userId;
                this.getUserFavoriteWorlds(userId);
            }
        } else if (obj.label === 'JSON') {
            this.refreshUserDialogTreeData();
        }
        this.userDialogLastActiveTab = obj.label;
    };

    // VRChat Config JSON

    $app.data.VRChatConfigFile = {};

    $app.data.VRChatConfigList = {
        cache_size: {name: 'Max Cache Size [GB] (minimum 20)', default: '20'},
        cache_expiry_delay: {
            name: 'Cache Expiry [Days] (minimum 30)',
            default: '30'
        },
        cache_directory: {
            name: 'Custom Cache Folder Location',
            default: '%AppData%\\..\\LocalLow\\VRChat\\vrchat'
        },
        dynamic_bone_max_affected_transform_count: {
            name:
                'Dynamic Bones Limit Max Transforms (0 always disable transforms)',
            default: '32'
        },
        dynamic_bone_max_collider_check_count: {
            name:
                'Dynamic Bones Limit Max Collider Collisions (0 always disable colliders)',
            default: '8'
        }
    };

    $app.methods.readVRChatConfigFile = async function() {
        try {
            var config = await AppApi.ReadConfigFile();
            this.VRChatConfigFile = JSON.parse(config);
        } catch (err) {
            console.error(err);
            this.VRChatConfigFile = {};
        }
    };

    $app.methods.WriteVRChatConfigFile = async function() {
        var json = JSON.stringify(this.VRChatConfigFile, null, '\t');
        AppApi.WriteConfigFile(json);
    };

    $app.data.VRChatConfigDialog = {
        visible: false,
        cameraRes: false,
        screenshotRes: false
    };

    pubsub.subscribe('LOGIN', function() {
        $app.VRChatConfigDialog.visible = false;
    });

    $app.methods.showVRChatConfig = async function() {
        try {
            await this.readVRChatConfigFile();
            this.$nextTick(() =>
                adjustDialogZ(this.$refs.VRChatConfigDialog.$el)
            );
            this.VRChatConfigDialog = {
                cameraRes: false,
                screenshotRes: false,
                visible: true
            };
            if (
                this.VRChatConfigFile.camera_res_height === 2160 &&
                this.VRChatConfigFile.camera_res_width === 3840
            ) {
                this.VRChatConfigDialog.cameraRes = true;
            }
            if (
                this.VRChatConfigFile.screenshot_res_height === 2160 &&
                this.VRChatConfigFile.screenshot_res_width === 3840
            ) {
                this.VRChatConfigDialog.screenshotRes = true;
            }
            if (!this.VRChatUsedCacheSize) {
                this.getVRChatCacheSize();
            }
        } catch (err) {
            console.error(err);
        }
    };

    $app.methods.SaveVRChatConfigFile = function() {
        if (this.VRChatConfigDialog.cameraRes) {
            this.VRChatConfigFile.camera_res_height = 2160;
            this.VRChatConfigFile.camera_res_width = 3840;
        } else {
            delete this.VRChatConfigFile.camera_res_height;
            delete this.VRChatConfigFile.camera_res_width;
        }
        if (this.VRChatConfigDialog.screenshotRes) {
            this.VRChatConfigFile.screenshot_res_height = 2160;
            this.VRChatConfigFile.screenshot_res_width = 3840;
        } else {
            delete this.VRChatConfigFile.screenshot_res_height;
            delete this.VRChatConfigFile.screenshot_res_width;
        }
        for (var item in this.VRChatConfigFile) {
            if (this.VRChatConfigFile[item] === '') {
                delete this.VRChatConfigFile[item];
            } else if (
                typeof this.VRChatConfigFile[item] === 'boolean' &&
                this.VRChatConfigFile[item] === false
            ) {
                delete this.VRChatConfigFile[item];
            } else if (
                typeof this.VRChatConfigFile[item] === 'string' &&
                !isNaN(this.VRChatConfigFile[item])
            ) {
                this.VRChatConfigFile[item] = parseInt(
                    this.VRChatConfigFile[item]
                );
            }
        }
        this.VRChatConfigDialog.visible = false;
        this.WriteVRChatConfigFile();
    };

    $app.methods.getVRChatCacheDir = async function() {
        await this.readVRChatConfigFile();

        var cacheDirectory = '';
        if (this.VRChatConfigFile.cache_directory) {
            cacheDirectory = this.VRChatConfigFile.cache_directory;
        }

        return cacheDirectory;
    };

    $app.methods.checkVRChatCache = async function(ref) {
        return AssetBundleCacher.CheckVRChatCache(
            ref.id,
            ref.version,
            await this.getVRChatCacheDir()
        );
    };

    // Asset Bundle Cacher

    $app.methods.updateVRChatCache = async function() {
        var D = this.worldDialog;
        if (!D.visible) {
            return;
        }

        D.inCache = false;
        D.cacheSize = 0;

        try {
            var cacheSize = await this.checkVRChatCache(D.ref);
            if (cacheSize > 0) {
                D.inCache = true;
                D.cacheSize = `${(cacheSize / 1048576).toFixed(2)} MiB`;
            }
        } catch (err) {
            console.error(err);
        }
    };

    $app.methods.queueCacheDownload = function(ref, type) {
        if (!this.downloadQueue.has(ref.id)) {
            var date = new Date().toJSON();
            var userId = api.currentUser.id;
            var location = ref.id;
            this.downloadQueue.set(ref.id, {ref, type, date, userId, location});
            this.downloadQueueTable.data = Array.from(
                this.downloadQueue.values()
            );
        }
        if (!this.downloadInProgress) {
            this.downloadVRChatCache();
        }
    };

    API.getBundles = async function(fileId) {
        var json = await api.legacyApi(`file/${fileId}`, {
            method: 'GET'
        });
        var args = {
            json
        };
        return args;
    };

    $app.methods.downloadVRChatCache = async function() {
        if (this.downloadQueue.size === 0) {
            return;
        }
        this.downloadProgress = 0;
        this.downloadIsProcessing = false;
        this.downloadInProgress = true;
        this.downloadCurrent = this.downloadQueue.values().next().value;
        this.downloadCurrent.id = this.downloadQueue.keys().next().value;
        var {ref, type} = this.downloadCurrent;
        this.downloadQueue.delete(ref.id);
        this.downloadQueueTable.data = Array.from(this.downloadQueue.values());
        var assetUrl = '';
        for (var i = ref.unityPackages.length - 1; i > -1; i--) {
            var unityPackage = ref.unityPackages[i];
            if (
                unityPackage.platform === 'standalonewindows' &&
                unityPackage.unitySortNumber <= 20180420000
            ) {
                assetUrl = unityPackage.assetUrl;
                break;
            }
        }
        var fileId = extractFileId(assetUrl);
        var fileVersion = extractFileVersion(assetUrl);
        if (!fileId) {
            this.downloadCurrent.status = 'Invalid asset url';
            this.downloadHistoryTable.data.unshift(this.downloadCurrent);
            this.downloadCurrent = {};
            this.downloadInProgress = false;
            this.downloadVRChatCache();
            return;
        }
        var args = await API.getBundles(fileId);
        var {versions} = args.json;
        var file = '';
        for (var i = versions.length - 1; i > -1; i--) {
            var version = versions[i];
            if (version.version == fileVersion) {
                file = version.file;
                break;
            }
        }
        if (!file) {
            this.downloadCurrent.status = 'Missing asset version';
            this.downloadHistoryTable.data.unshift(this.downloadCurrent);
            this.downloadCurrent = {};
            this.downloadInProgress = false;
            this.downloadVRChatCache();
            return;
        }
        var {url, md5, sizeInBytes} = file;
        var cacheDir = await this.getVRChatCacheDir();
        await AssetBundleCacher.DownloadCacheFile(
            cacheDir,
            url,
            ref.id,
            ref.version,
            sizeInBytes,
            md5,
            appVersion
        );
        this.downloadVRChatCacheProgress();
    };

    $app.methods.checkVRChatCacheDownload = function(lastLocation) {
        var L = parseLocation(lastLocation);
        if (L.worldId) {
            if (this.downloadCurrent.id === L.worldId) {
                this.cancelVRChatCacheDownload(L.worldId);
            } else {
                if (this.downloadQueue.has(L.worldId)) {
                    this.downloadQueue.delete(L.worldId);
                    this.downloadQueueTable.data = Array.from(
                        this.downloadQueue.values()
                    );
                }
            }
        }
    };

    $app.methods.cancelVRChatCacheDownload = function(worldId) {
        if (this.downloadCurrent.id === worldId) {
            AssetBundleCacher.CancelDownload();
        }
        if (this.downloadQueue.has(worldId)) {
            this.downloadQueue.delete(worldId);
            this.downloadQueueTable.data = Array.from(
                this.downloadQueue.values()
            );
        }
    };

    $app.methods.cancelAllVRChatCacheDownload = function() {
        if (this.downloadCurrent.id !== void 0) {
            this.cancelVRChatCacheDownload(this.downloadCurrent.id);
        }
        for (var queue of this.downloadQueue.values()) {
            this.cancelVRChatCacheDownload(queue.ref.id);
        }
    };

    pubsub.subscribe('NOTIFICATION', function(args) {
        var {json} = args;
        if (json.type === 'invite') {
            $app.inviteDownloadWorldCache(json);
        }
    });

    $app.methods.inviteDownloadWorldCache = function(invite) {
        if (
            this.worldAutoCacheInvite === 'Always' ||
            (this.worldAutoCacheInvite === 'Game Closed' &&
                !this.isGameRunning) ||
            (this.worldAutoCacheInvite === 'Game Running' && this.isGameRunning)
        ) {
            if (
                !this.worldAutoCacheInviteFilter &&
                !api.favoriteMapByObjectId.has(invite.senderUserId)
            ) {
                return;
            }
            this.autoDownloadWorldCache(
                invite.details.worldId,
                'Invite',
                invite.senderUserId
            );
        }
    };

    $app.methods.feedDownloadWorldCache = function(feed) {
        if (
            this.worldAutoCacheGPS === 'Always' ||
            (this.worldAutoCacheGPS === 'Game Closed' && !this.isGameRunning) ||
            (this.worldAutoCacheGPS === 'Game Running' && this.isGameRunning)
        ) {
            if (
                feed.location === '' ||
                feed.location === 'offline' ||
                feed.location === 'private' ||
                (!this.worldAutoCacheGPSFilter &&
                    !api.favoriteMapByObjectId.has(feed.id))
            ) {
                return;
            }
            this.autoDownloadWorldCache(feed.location, 'GPS', feed.id);
        }
    };

    $app.methods.autoDownloadWorldCache = function(location, type, userId) {
        var L = parseLocation(location);
        if (
            !L.worldId ||
            this.downloadQueue.has(L.worldId) ||
            this.downloadCurrent.id === L.worldId
        ) {
            return;
        }
        api.getWorld({
            worldId: L.worldId
        }).then((args) => {
            var {ref} = args;
            this.checkVRChatCache(ref).then((cacheSize) => {
                if (cacheSize === -1) {
                    this.downloadQueue.set(ref.id, {
                        ref,
                        type,
                        userId,
                        location
                    });
                    this.downloadQueueTable.data = Array.from(
                        this.downloadQueue.values()
                    );
                    if (!this.downloadInProgress) {
                        this.downloadVRChatCache();
                    }
                }
            });
        });
    };

    $app.data.downloadProgress = 0;
    $app.data.downloadInProgress = false;
    $app.data.downloadIsProcessing = false;
    $app.data.downloadQueue = new Map();
    $app.data.downloadCurrent = {};

    $app.methods.downloadVRChatCacheProgress = async function() {
        var downloadProgress = await AssetBundleCacher.CheckDownloadProgress();
        switch (downloadProgress) {
            case -1:
                this.downloadProgress = 100;
                this.downloadIsProcessing = true;
                break;
            case -3:
                if (this.worldDialog.id === this.downloadCurrent.id) {
                    this.updateVRChatCache();
                }
                if (this.downloadCurrent.type === 'manual') {
                    this.$message({
                        message: 'World cache complete',
                        type: 'success'
                    });
                }
                this.downloadCurrent.status = 'Success';
                this.downloadCurrent.date = Date.now();
                this.downloadHistoryTable.data.unshift(this.downloadCurrent);
                this.downloadCurrent = {};
                this.downloadProgress = 0;
                this.downloadInProgress = false;
                this.downloadVRChatCache();
                return;
            case -4:
                this.$message({
                    message: 'Download canceled',
                    type: 'info'
                });
                this.downloadCurrent.status = 'Canceled';
                this.downloadCurrent.date = Date.now();
                this.downloadHistoryTable.data.unshift(this.downloadCurrent);
                this.downloadCurrent = {};
                this.downloadProgress = 0;
                this.downloadInProgress = false;
                this.downloadVRChatCache();
                return;
            case -10:
                this.$message({
                    message: "AssetBundleCacher can't be located",
                    type: 'error'
                });
                this.downloadCurrent = {};
                this.downloadQueue = new Map();
                this.downloadQueueTable.data = [];
                this.downloadProgress = 0;
                this.downloadInProgress = false;
                return;
            case -11:
                this.$message({
                    message: "VRChat can't be located",
                    type: 'error'
                });
                this.downloadCurrent = {};
                this.downloadQueue = new Map();
                this.downloadQueueTable.data = [];
                this.downloadProgress = 0;
                this.downloadInProgress = false;
                return;
            case -12:
                if (this.worldDialog.id === this.downloadCurrent.id) {
                    this.updateVRChatCache();
                }
                if (this.downloadCurrent.type === 'manual') {
                    this.$message({
                        message: 'File already in cache',
                        type: 'warning'
                    });
                }
                this.downloadCurrent.status = 'Already in cache';
                this.downloadCurrent.date = Date.now();
                this.downloadHistoryTable.data.unshift(this.downloadCurrent);
                this.downloadCurrent = {};
                this.downloadProgress = 0;
                this.downloadInProgress = false;
                this.downloadVRChatCache();
                return;
            case -13:
                this.$message({
                    message: 'Failed to process file',
                    type: 'error'
                });
                this.downloadCurrent.status = 'Failed to process';
                this.downloadCurrent.date = Date.now();
                this.downloadHistoryTable.data.unshift(this.downloadCurrent);
                this.downloadCurrent = {};
                this.downloadProgress = 0;
                this.downloadInProgress = false;
                this.downloadVRChatCache();
                return;
            case -14:
                this.$message({
                    message: 'Failed to move file into cache',
                    type: 'error'
                });
                this.downloadCurrent.status = 'Failed to move into cache';
                this.downloadCurrent.date = Date.now();
                this.downloadHistoryTable.data.unshift(this.downloadCurrent);
                this.downloadCurrent = {};
                this.downloadProgress = 0;
                this.downloadInProgress = false;
                this.downloadVRChatCache();
                return;
            case -15:
                this.$message({
                    message: 'Download failed',
                    type: 'error'
                });
                this.downloadCurrent.status = 'Download failed';
                this.downloadCurrent.date = Date.now();
                this.downloadHistoryTable.data.unshift(this.downloadCurrent);
                this.downloadCurrent = {};
                this.downloadProgress = 0;
                this.downloadInProgress = false;
                this.downloadVRChatCache();
                return;
            default:
                this.downloadProgress = downloadProgress;
        }
        setTimeout(() => this.downloadVRChatCacheProgress(), 150);
    };

    $app.methods.showDownloadDialog = function() {
        this.$nextTick(() => adjustDialogZ(this.$refs.downloadDialog.$el));
        this.downloadDialog.visible = true;
    };

    $app.data.downloadDialog = {
        visible: false
    };

    $app.methods.downloadProgressText = function() {
        if (this.downloadIsProcessing) {
            return 'Processing';
        }
        if (this.downloadProgress >= 0) {
            return this.downloadProgress + '%';
        }
        return '';
    };

    $app.methods.getDisplayName = function(userId) {
        if (userId) {
            var ref = api.userMap.get(userId);
            if (ref.displayName) {
                return ref.displayName;
            }
        }
        return '';
    };

    $app.methods.deleteVRChatCache = async function(ref) {
        var cacheDir = await this.getVRChatCacheDir();
        await AssetBundleCacher.DeleteCache(cacheDir, ref.id, ref.version);
        this.getVRChatCacheSize();
        this.updateVRChatCache();
    };

    $app.methods.showDeleteAllVRChatCacheConfirm = function() {
        this.$confirm(`Continue? Delete all VRChat cache`, 'Confirm', {
            confirmButtonText: 'Confirm',
            cancelButtonText: 'Cancel',
            type: 'info',
            callback: (action) => {
                if (action === 'confirm') {
                    this.deleteAllVRChatCache();
                }
            }
        });
    };

    $app.methods.deleteAllVRChatCache = async function() {
        var cacheDir = await this.getVRChatCacheDir();
        await AssetBundleCacher.DeleteAllCache(cacheDir);
        this.getVRChatCacheSize();
    };

    $app.methods.autoVRChatCacheManagement = function() {
        if (this.autoSweepVRChatCache) {
            this.sweepVRChatCache();
        }
    };

    $app.methods.sweepVRChatCache = async function() {
        var cacheDir = await this.getVRChatCacheDir();
        await AssetBundleCacher.SweepCache(cacheDir);
        if (this.VRChatConfigDialog.visible) {
            this.getVRChatCacheSize();
        }
    };

    $app.data.VRChatUsedCacheSize = '';
    $app.data.VRChatTotalCacheSize = '';
    $app.data.VRChatCacheSizeLoading = false;

    $app.methods.getVRChatCacheSize = async function() {
        this.VRChatCacheSizeLoading = true;
        var cacheDir = await this.getVRChatCacheDir();
        var totalCacheSize = 20;
        if (this.VRChatConfigFile.cache_size) {
            totalCacheSize = this.VRChatConfigFile.cache_size;
        }
        this.VRChatTotalCacheSize = totalCacheSize;
        var usedCacheSize = await AssetBundleCacher.GetCacheSize(cacheDir);
        this.VRChatUsedCacheSize = (usedCacheSize / 1073741824).toFixed(2);
        this.VRChatCacheSizeLoading = false;
    };

    pubsub.subscribe('LOGIN', function() {
        $app.downloadDialog.visible = false;
    });

    // Parse location URL

    $app.methods.parseLocationUrl = function(url) {
        var urlParams = new URLSearchParams(url.search);
        var worldId = urlParams.get('worldId');
        var instanceId = urlParams.get('instanceId');
        return `${worldId}:${instanceId}`;
    };

    // userDialog Favorite Worlds

    $app.data.userFavoriteWorlds = [];

    $app.methods.getUserFavoriteWorlds = async function(userId) {
        this.userDialog.isFavoriteWorldsLoading = true;
        this.userFavoriteWorlds = [];
        var worldLists = [];
        var params = {
            ownerId: userId
        };
        try {
            var json = await api.legacyApi('favorite/groups', {
                method: 'GET',
                params
            });
            for (var i = 0; i < json.length; ++i) {
                var list = json[i];
                if (list.type !== 'world') {
                    continue;
                }
                var {json} = await api.getFavoriteWorlds({
                    n: 100,
                    offset: 0,
                    userId,
                    tag: list.name
                });
                worldLists.push([list.displayName, list.visibility, json]);
            }
        } catch (err) {
            console.error(err);
        }
        this.userFavoriteWorlds = worldLists;
        this.userDialog.isFavoriteWorldsLoading = false;
    };

    $app.data.worldGroupVisibilityOptions = ['private', 'friends', 'public'];

    $app.methods.userFavoriteWorldsStatus = function(visibility) {
        var style = {};
        if (visibility === 'public') {
            style.online = true;
        } else if (visibility === 'friends') {
            style.joinme = true;
        } else {
            style.busy = true;
        }
        return style;
    };

    $app.methods.changeWorldGroupVisibility = async function(name, visibility) {
        try {
            await api.saveFavoriteGroup({
                type: 'world',
                group: name,
                visibility
            });
            this.$message({
                message: 'Group visibility changed',
                type: 'success'
            });
        } catch (err) {
            console.error(err);
        }
    };

    $app = new Vue($app);
    window.$app = $app;
})();

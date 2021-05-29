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

import * as api from './api';
import * as pubsub from './pubsub';
import * as uuid from './uuid';
import {
    escapeHtml,
    commaNumber,
    formatDate,
    textToHex,
    timeToText,
    removeFromArray
} from './util';

import {appVersion} from './constants.js';
import sharedRepository from './repository/shared.js';
import configRepository from './repository/config.js';
import gameLogService from './service/gamelog.js';

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

    // API: Config

    pubsub.subscribe('CONFIG', function(args) {
        args.ref = API.applyConfig(args.json);
    });

    API.applyConfig = function(json) {
        var ref = {
            clientApiKey: '',
            ...json
        };
        api.applyConfig(ref);
        return ref;
    };

    API.getConfig = function() {
        return api
            .legacyApi('config', {
                method: 'GET'
            })
            .then((json) => {
                var args = {
                    json
                };
                pubsub.publish('CONFIG', args);
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

    // API: User

    // changeUserName: PUT users/${userId} {displayName: string, currentPassword: string}
    // changeUserEmail: PUT users/${userId} {email: string, currentPassword: string}
    // changePassword: PUT users/${userId} {password: string, currentPassword: string}
    // updateTOSAggreement: PUT users/${userId} {acceptedTOSVersion: number}

    // 2FA
    // removeTwoFactorAuth: DELETE auth/twofactorauth
    // getTwoFactorAuthpendingSecret: POST auth/twofactorauth/totp/pending -> { qrCodeDataUrl: string, secret: string }
    // verifyTwoFactorAuthPendingSecret: POST auth/twofactorauth/totp/pending/verify { code: string } -> { verified: bool, enabled: bool }
    // cancelVerifyTwoFactorAuthPendingSecret: DELETE auth/twofactorauth/totp/pending
    // getTwoFactorAuthOneTimePasswords: GET auth/user/twofactorauth/otp -> { otp: [ { code: string, used: bool } ] }

    // Account Link
    // merge: PUT auth/user/merge {mergeToken: string}
    // 링크됐다면 CurrentUser에 steamId, oculusId 값이 생기는듯
    // 스팀 계정으로 로그인해도 steamId, steamDetails에 값이 생김

    // Password Recovery
    // sendLink: PUT auth/password {email: string}
    // setNewPassword: PUT auth/password {emailToken: string, id: string, password: string}

    pubsub.subscribe('LOGOUT', function() {
        AppApi.DeleteAllCookies();
        api.isLoggedIn.value = false;
    });

    pubsub.subscribe('USER:CURRENT', function(args) {
        var {json} = args;
        args.ref = API.applyCurrentUser(json);
        API.applyUser({
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

    pubsub.subscribe('USER:CURRENT:SAVE', function(args) {
        pubsub.publish('USER:CURRENT', args);
    });

    pubsub.subscribe('USER', function(args) {
        args.ref = API.applyUser(args.json);
    });

    pubsub.subscribe('USER:LIST', function(args) {
        for (var json of args.json) {
            pubsub.publish('USER', {
                json,
                params: {
                    userId: json.id
                }
            });
        }
    });

    API.logout = function() {
        return api
            .legacyApi('logout', {
                method: 'PUT'
            })
            .finally(() => {
                pubsub.publish('LOGOUT');
            });
    };

    /*
        params: {
            username: string,
            password: string
        }
    */
    API.login = function(params) {
        var {username, password, saveCredentials} = params;
        username = encodeURIComponent(username);
        password = encodeURIComponent(password);
        var auth = btoa(`${username}:${password}`);
        if (saveCredentials) {
            delete params.saveCredentials;
            $app.saveCredentials = params;
        }
        return api
            .legacyApi(`auth/user?apiKey=${api.config.clientApiKey}`, {
                method: 'GET',
                auth: {
                    username,
                    password
                }
            })
            .then((json) => {
                var args = {
                    json,
                    params,
                    origin: true
                };
                if (json.requiresTwoFactorAuth) {
                    pubsub.publish('USER:2FA', args);
                } else {
                    pubsub.publish('USER:CURRENT', args);
                }
                return args;
            });
    };

    /*
        params: {
            steamTicket: string
        }
    */
    API.loginWithSteam = function(params) {
        return api
            .legacyApi(`auth/steam?apiKey=${api.config.clientApiKey}`, {
                method: 'POST',
                params
            })
            .then((json) => {
                var args = {
                    json,
                    params,
                    origin: true
                };
                if (json.requiresTwoFactorAuth) {
                    pubsub.publish('USER:2FA', args);
                } else {
                    pubsub.publish('USER:CURRENT', args);
                }
                return args;
            });
    };

    /*
        params: {
            code: string
        }
    */
    API.verifyOTP = function(params) {
        return api
            .legacyApi('auth/twofactorauth/otp/verify', {
                method: 'POST',
                params
            })
            .then((json) => {
                var args = {
                    json,
                    params
                };
                pubsub.publish('OTP', args);
                return args;
            });
    };

    /*
        params: {
            code: string
        }
    */
    API.verifyTOTP = function(params) {
        return api
            .legacyApi('auth/twofactorauth/totp/verify', {
                method: 'POST',
                params
            })
            .then((json) => {
                var args = {
                    json,
                    params
                };
                pubsub.publish('TOTP', args);
                return args;
            });
    };

    API.applyUserTrustLevel = function(ref) {
        ref.$isModerator = ref.developerType && ref.developerType !== 'none';
        ref.$isTroll = false;
        var {tags} = ref;
        if (tags.includes('admin_moderator')) {
            ref.$isModerator = true;
        }
        if (
            tags.includes('system_troll') ||
            tags.includes('system_probable_troll')
        ) {
            ref.$isTroll = true;
        }
        if (tags.includes('system_legend')) {
            ref.$trustLevel = 'Legendary User';
            ref.$trustClass = 'x-tag-legendary';
        } else if (tags.includes('system_trust_legend')) {
            ref.$trustLevel = 'Veteran User';
            ref.$trustClass = 'x-tag-legend';
        } else if (tags.includes('system_trust_veteran')) {
            ref.$trustLevel = 'Trusted User';
            ref.$trustClass = 'x-tag-veteran';
        } else if (tags.includes('system_trust_trusted')) {
            ref.$trustLevel = 'Known User';
            ref.$trustClass = 'x-tag-trusted';
        } else if (tags.includes('system_trust_known')) {
            ref.$trustLevel = 'User';
            ref.$trustClass = 'x-tag-known';
        } else if (tags.includes('system_trust_basic')) {
            ref.$trustLevel = 'New User';
            ref.$trustClass = 'x-tag-basic';
        } else {
            ref.$trustLevel = 'Visitor';
            ref.$trustClass = 'x-tag-untrusted';
        }
        if (ref.$isModerator) {
            ref.$trustLevel = 'VRChat Team';
            ref.$trustClass = 'x-tag-vip';
        } else if (ref.$isTroll) {
            ref.$trustLevel = 'Nuisance';
            ref.$trustClass = 'x-tag-troll';
        }
    };

    // FIXME: it may performance issue. review here
    API.applyUserLanguage = function(ref) {
        ref.$languages = [];
        var {tags} = ref;
        for (var tag of tags) {
            if (tag.startsWith('language_') === false) {
                continue;
            }
            var key = tag.substr(9);
            var value = api.subsetOfLanguages[key];
            if (typeof value === 'undefined') {
                continue;
            }
            ref.$languages.push({
                key,
                value
            });
        }
    };

    API.applyCurrentUser = function(json) {
        var ref = api.currentUser;
        if (api.isLoggedIn.value) {
            Object.assign(ref, json);
            if (ref.homeLocation !== ref.$homeLocation.tag) {
                ref.$homeLocation = API.parseLocation(ref.homeLocation);
            }
            ref.$isVRCPlus = ref.tags.includes('system_supporter');
            API.applyUserTrustLevel(ref);
            API.applyUserLanguage(ref);
        } else {
            ref = {
                id: '',
                username: '',
                displayName: '',
                userIcon: '',
                bio: '',
                bioLinks: [],
                pastDisplayNames: [],
                friends: [],
                currentAvatarImageUrl: '',
                currentAvatarThumbnailImageUrl: '',
                currentAvatar: '',
                homeLocation: '',
                twoFactorAuthEnabled: false,
                status: '',
                statusDescription: '',
                state: '',
                tags: [],
                developerType: '',
                last_login: '',
                last_platform: '',
                date_joined: '',
                allowAvatarCopying: false,
                onlineFriends: [],
                activeFriends: [],
                offlineFriends: [],
                // VRCX
                $homeLocation: {},
                $isVRCPlus: false,
                $isModerator: false,
                $isTroll: false,
                $trustLevel: 'Visitor',
                $trustClass: 'x-tag-untrusted',
                $languages: [],
                //
                ...json
            };
            ref.$homeLocation = API.parseLocation(ref.homeLocation);
            ref.$isVRCPlus = ref.tags.includes('system_supporter');
            API.applyUserTrustLevel(ref);
            API.applyUserLanguage(ref);
            api.applyCurrentUser(ref);
            api.isLoggedIn.value = true;
            pubsub.publish('LOGIN', {
                json,
                ref
            });
        }
        sharedRepository.setString('current_user_status', ref.status);
        return ref;
    };

    API.getCurrentUser = function() {
        return api
            .legacyApi(`auth/user?apiKey=${api.config.clientApiKey}`, {
                method: 'GET'
            })
            .then((json) => {
                var args = {
                    json,
                    origin: true
                };
                if (json.requiresTwoFactorAuth) {
                    pubsub.publish('USER:2FA', args);
                } else {
                    pubsub.publish('USER:CURRENT', args);
                }
                return args;
            });
    };

    var userUpdateQueue = [];
    var userUpdateTimer = null;
    var queueUserUpdate = function(ctx) {
        userUpdateQueue.push(ctx);
        if (userUpdateTimer !== null) {
            return;
        }
        userUpdateTimer = setTimeout(function() {
            userUpdateTimer = null;
            var {length} = userUpdateQueue;
            for (var i = 0; i < length; ++i) {
                pubsub.publish('USER:UPDATE', userUpdateQueue[i]);
            }
            userUpdateQueue.length = 0;
        }, 1);
    };

    API.applyUser = function(json) {
        var ref = api.userMap.get(json.id);
        // some missing variables on currentUser
        if (json.id === api.currentUser.id) {
            json.status = api.currentUser.status;
            json.statusDescription = api.currentUser.statusDescription;
            json.state = api.currentUser.state;
            json.last_login = api.currentUser.last_login;
            if ($app.lastLocation.location) {
                json.location = $app.lastLocation.location;
                json.$location_at = $app.lastLocation.date;
            }
            json.$online_for = api.currentUser.$online_for;
            json.$offline_for = api.currentUser.$offline_for;
        }
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
                date_joined: '',
                allowAvatarCopying: false,
                isFriend: false,
                location: '',
                worldId: '',
                instanceId: '',
                // VRCX
                $location: {},
                $location_at: Date.now(),
                $online_for: Date.now(),
                $offline_for: '',
                $isVRCPlus: false,
                $isModerator: false,
                $isTroll: false,
                $trustLevel: 'Visitor',
                $trustClass: 'x-tag-untrusted',
                $languages: [],
                //
                ...json
            };
            ref.$location = API.parseLocation(ref.location);
            ref.$isVRCPlus = ref.tags.includes('system_supporter');
            API.applyUserTrustLevel(ref);
            API.applyUserLanguage(ref);
            api.userMap.set(ref.id, ref);
        } else {
            var props = {};
            for (var prop in ref) {
                if (ref[prop] !== Object(ref[prop])) {
                    props[prop] = true;
                }
            }
            var $ref = {...ref};
            Object.assign(ref, json);
            if (ref.location !== ref.$location.tag) {
                ref.$location = API.parseLocation(ref.location);
            }
            if (ref.statusDescription) {
                ref.statusDescription = ref.statusDescription.substring(0, 32);
            }
            ref.$isVRCPlus = ref.tags.includes('system_supporter');
            API.applyUserTrustLevel(ref);
            API.applyUserLanguage(ref);
            for (var prop in ref) {
                if (ref[prop] !== Object(ref[prop])) {
                    props[prop] = true;
                }
            }
            var has = false;
            for (var prop in props) {
                var asis = $ref[prop];
                var tobe = ref[prop];
                if (asis === tobe) {
                    delete props[prop];
                } else {
                    has = true;
                    props[prop] = [tobe, asis];
                }
            }
            // FIXME
            // if the status is offline, just ignore status and statusDescription only.
            if (has && ref.status !== 'offline' && $ref.status !== 'offline') {
                if (props.location) {
                    var ts = Date.now();
                    props.location.push(ts - ref.$location_at);
                    ref.$location_at = ts;
                }
                queueUserUpdate({
                    ref,
                    props
                });
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
        return api
            .legacyApi(`users/${params.userId}`, {
                method: 'GET'
            })
            .then((json) => {
                var args = {
                    json,
                    params
                };
                pubsub.publish('USER', args);
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
            var ref = api.userMap.get(params.userId);
            if (typeof ref === 'undefined') {
                API.getUser(params)
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

    /*
        params: {
            n: number,
            offset: number,
            search: string,
            sort: string ('nuisanceFactor', 'created', '_created_at', 'last_login'),
            order: string ('ascending', 'descending')
        }
    */
    API.getUsers = function(params) {
        return api
            .legacyApi('users', {
                method: 'GET',
                params
            })
            .then((json) => {
                var args = {
                    json,
                    params
                };
                pubsub.publish('USER:LIST', args);
                return args;
            });
    };

    /*
        params: {
            status: string ('active', 'offline', 'busy', 'ask me', 'join me'),
            statusDescription: string
        }
    */
    API.saveCurrentUser = function(params) {
        return api
            .legacyApi(`users/${api.currentUser.id}`, {
                method: 'PUT',
                params
            })
            .then((json) => {
                var args = {
                    json,
                    params
                };
                pubsub.publish('USER:CURRENT:SAVE', args);
                return args;
            });
    };

    /*
        params: {
            tags: array[string]
        }
    */
    API.addUserTags = function(params) {
        return api
            .legacyApi(`users/${api.currentUser.id}/addTags`, {
                method: 'POST',
                params
            })
            .then((json) => {
                var args = {
                    json,
                    params
                };
                pubsub.publish('USER:CURRENT:SAVE', args);
                return args;
            });
    };

    /*
        params: {
            tags: array[string]
        }
    */
    API.removeUserTags = function(params) {
        return api
            .legacyApi(`users/${api.currentUser.id}/removeTags`, {
                method: 'POST',
                params
            })
            .then((json) => {
                var args = {
                    json,
                    params
                };
                pubsub.publish('USER:CURRENT:SAVE', args);
                return args;
            });
    };

    // API: World

    pubsub.subscribe('WORLD', function(args) {
        args.ref = API.applyWorld(args.json);
    });

    pubsub.subscribe('WORLD:LIST', function(args) {
        for (var json of args.json) {
            pubsub.publish('WORLD', {
                json,
                params: {
                    worldId: json.id
                }
            });
        }
    });

    pubsub.subscribe('WORLD:DELETE', function(args) {
        var {json} = args;
        api.worldMap.delete(json.id);
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

    pubsub.subscribe('WORLD:SAVE', function(args) {
        var {json} = args;
        pubsub.publish('WORLD', {
            json,
            params: {
                worldId: json.id
            }
        });
    });

    API.applyWorld = function(json) {
        var ref = api.worldMap.get(json.id);
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
            api.worldMap.set(ref.id, ref);
        } else {
            Object.assign(ref, json);
        }
        ref.$isLabs = ref.tags.includes('system_labs');
        return ref;
    };

    /*
        params: {
            n: number,
            offset: number,
            search: string,
            userId: string,
            user: string ('me','friend')
            sort: string ('popularity','heat','trust','shuffle','favorites','reportScore','reportCount','publicationDate','labsPublicationDate','created','_created_at','updated','_updated_at','order'),
            order: string ('ascending','descending'),
            releaseStatus: string ('public','private','hidden','all'),
            featured: boolean
        },
        option: string
    */
    api.getWorlds = function(params, option) {
        var endpoint = 'worlds';
        if (typeof option !== 'undefined') {
            endpoint = `worlds/${option}`;
        }
        return api
            .legacyApi(endpoint, {
                method: 'GET',
                params
            })
            .then((json) => {
                var args = {
                    json,
                    params
                };
                pubsub.publish('WORLD:LIST', args);
                return args;
            });
    };

    /*
        params: {
            worldId: string
        }
    */
    API.deleteWorld = function(params) {
        return api
            .legacyApi(`worlds/${params.worldId}`, {
                method: 'DELETE'
            })
            .then((json) => {
                var args = {
                    json,
                    params
                };
                pubsub.publish('WORLD:DELETE', args);
                return args;
            });
    };

    /*
        params: {
            worldId: string
        }
    */
    API.saveWorld = function(params) {
        return api
            .legacyApi(`worlds/${params.id}`, {
                method: 'PUT',
                params
            })
            .then((json) => {
                var args = {
                    json,
                    params
                };
                pubsub.publish('WORLD:SAVE', args);
                return args;
            });
    };

    /*
        params: {
            worldId: string,
            instanceId: string
        }
    */
    API.getInstance = function(params) {
        return api
            .legacyApi(`instances/${params.worldId}:${params.instanceId}`, {
                method: 'GET'
            })
            .then((json) => {
                var args = {
                    json,
                    params
                };
                pubsub.publish('INSTANCE', args);
                return args;
            });
    };

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

    // API: Friend

    pubsub.subscribe('LOGIN', function() {
        api.friends200.clear();
        api.friends404.clear();
        api.isFriendsLoading.value = false;
    });

    pubsub.subscribe('USER', function(args) {
        api.friends200.add(args.ref.id);
        api.friends404.delete(args.ref.id);
    });

    pubsub.subscribe('FRIEND:LIST', function(args) {
        for (var json of args.json) {
            pubsub.publish('USER', {
                json,
                params: {
                    userId: json.id
                }
            });
        }
    });

    API.isAllFriendsRetrived = function(flag) {
        if (flag) {
            for (var id of api.currentUser.friends) {
                if (api.friends200.has(id) === false) {
                    var n = api.friends404.get(id) || 0;
                    if (n < 2) {
                        api.friends404.set(id, n + 1);
                    }
                }
            }
        } else {
            for (var id of api.currentUser.friends) {
                if (
                    api.friends200.has(id) === false ||
                    api.friends404.get(id) < 2
                ) {
                    return false;
                }
            }
        }
        return true;
    };

    API.refreshFriends = async function() {
        api.isFriendsLoading.value = true;

        try {
            var missingFriendIdSet = new Set(api.currentUser.friends);

            // fetch online friend list
            for (var offset = 0; missingFriendIdSet.size > 0; offset += 50) {
                var {json} = await API.getFriends({
                    n: 50,
                    offset,
                    offline: 'false'
                });
                if (json === void 0 || json.length === 0) {
                    break;
                }
                for (var apiUser of json) {
                    missingFriendIdSet.delete(apiUser.id);
                }
            }

            // fetch offline friend list
            for (var offset = 0; missingFriendIdSet.size > 0; offset += 50) {
                var {json} = await API.getFriends({
                    n: 50,
                    offset,
                    offline: 'true'
                });
                if (json === void 0 || json.length === 0) {
                    break;
                }
                for (var apiUser of json) {
                    missingFriendIdSet.delete(apiUser.id);
                }
            }

            console.log('missingFriendIds', missingFriendIdSet);
        } catch (err) {
            console.error(err);
        }

        api.isFriendsLoading.value = false;
    };

    /*
        params: {
            n: number,
            offset: number,
            offline: boolean
        }
    */
    API.getFriends = function(params) {
        return api
            .legacyApi('auth/user/friends', {
                method: 'GET',
                params
            })
            .then((json) => {
                var args = {
                    json,
                    params
                };
                pubsub.publish('FRIEND:LIST', args);
                return args;
            });
    };

    /*
        params: {
            userId: string
        }
    */
    API.deleteFriend = function(params) {
        return api
            .legacyApi(`auth/user/friends/${params.userId}`, {
                method: 'DELETE'
            })
            .then((json) => {
                var args = {
                    json,
                    params
                };
                pubsub.publish('FRIEND:DELETE', args);
                return args;
            });
    };

    /*
        params: {
            userId: string
        }
    */
    API.sendFriendRequest = function(params) {
        return api
            .legacyApi(`user/${params.userId}/friendRequest`, {
                method: 'POST'
            })
            .then((json) => {
                var args = {
                    json,
                    params
                };
                pubsub.publish('FRIEND:REQUEST', args);
                return args;
            });
    };

    /*
        params: {
            userId: string
        }
    */
    API.cancelFriendRequest = function(params) {
        return api
            .legacyApi(`user/${params.userId}/friendRequest`, {
                method: 'DELETE'
            })
            .then((json) => {
                var args = {
                    json,
                    params
                };
                pubsub.publish('FRIEND:REQUEST:CANCEL', args);
                return args;
            });
    };

    /*
        params: {
            userId: string
        }
    */
    API.getFriendStatus = function(params) {
        return api
            .legacyApi(`user/${params.userId}/friendStatus`, {
                method: 'GET'
            })
            .then((json) => {
                var args = {
                    json,
                    params
                };
                pubsub.publish('FRIEND:STATUS', args);
                return args;
            });
    };

    // API: Avatar

    API.cachedAvatars = new Map();

    pubsub.subscribe('AVATAR', function(args) {
        args.ref = API.applyAvatar(args.json);
    });

    pubsub.subscribe('AVATAR:LIST', function(args) {
        for (var json of args.json) {
            pubsub.publish('AVATAR', {
                json,
                params: {
                    avatarId: json.id
                }
            });
        }
    });

    pubsub.subscribe('AVATAR:SAVE', function(args) {
        var {json} = args;
        pubsub.publish('AVATAR', {
            json,
            params: {
                avatarId: json.id
            }
        });
    });

    pubsub.subscribe('AVATAR:SELECT', function(args) {
        pubsub.publish('USER:CURRENT', args);
    });

    pubsub.subscribe('AVATAR:DELETE', function(args) {
        var {json} = args;
        API.cachedAvatars.delete(json._id);
        if ($app.userDialog.id === json.authorId) {
            var map = new Map();
            for (var ref of API.cachedAvatars.values()) {
                if (ref.authorId === json.authorId) {
                    map.set(ref.id, ref);
                }
            }
            var array = Array.from(map.values());
            $app.sortUserDialogAvatars(array);
        }
    });

    API.applyAvatar = function(json) {
        var ref = API.cachedAvatars.get(json.id);
        if (typeof ref === 'undefined') {
            ref = {
                id: '',
                name: '',
                description: '',
                authorId: '',
                authorName: '',
                tags: [],
                assetUrl: '',
                assetUrlObject: {},
                imageUrl: '',
                thumbnailImageUrl: '',
                releaseStatus: '',
                version: 0,
                unityPackages: [],
                unityPackageUrl: '',
                unityPackageUrlObject: {},
                created_at: '',
                updated_at: '',
                ...json
            };
            API.cachedAvatars.set(ref.id, ref);
        } else {
            Object.assign(ref, json);
        }
        return ref;
    };

    /*
        params: {
            avatarId: string
        }
    */
    API.getAvatar = function(params) {
        return api
            .legacyApi(`avatars/${params.avatarId}`, {
                method: 'GET'
            })
            .then((json) => {
                var args = {
                    json,
                    params
                };
                pubsub.publish('AVATAR', args);
                return args;
            });
    };

    /*
        params: {
            n: number,
            offset: number,
            search: string,
            userId: string,
            user: string ('me','friends')
            sort: string ('created','updated','order','_created_at','_updated_at'),
            order: string ('ascending','descending'),
            releaseStatus: string ('public','private','hidden','all'),
            featured: boolean
        }
    */
    API.getAvatars = function(params) {
        return api
            .legacyApi('avatars', {
                method: 'GET',
                params
            })
            .then((json) => {
                var args = {
                    json,
                    params
                };
                pubsub.publish('AVATAR:LIST', args);
                return args;
            });
    };

    /*
        params: {
            id: string
            releaseStatus: string ('public','private'),
        }
    */
    API.saveAvatar = function(params) {
        return api
            .legacyApi(`avatars/${params.id}`, {
                method: 'PUT',
                params
            })
            .then((json) => {
                var args = {
                    json,
                    params
                };
                pubsub.publish('AVATAR:SAVE', args);
                return args;
            });
    };

    /*
        params: {
            avatarId: string
        }
    */
    API.selectAvatar = function(params) {
        return api
            .legacyApi(`avatars/${params.avatarId}/select`, {
                method: 'PUT',
                params
            })
            .then((json) => {
                var args = {
                    json,
                    params
                };
                pubsub.publish('AVATAR:SELECT', args);
                return args;
            });
    };

    /*
        params: {
            avatarId: string
        }
    */
    API.selectFallbackAvatar = function(params) {
        return api
            .legacyApi(`avatars/${params.avatarId}/selectfallback`, {
                method: 'PUT',
                params
            })
            .then((json) => {
                var args = {
                    json,
                    params
                };
                pubsub.publish('AVATAR:SELECT', args);
                return args;
            });
    };

    /*
        params: {
            avatarId: string
        }
    */
    API.deleteAvatar = function(params) {
        return api
            .legacyApi(`avatars/${params.avatarId}`, {
                method: 'DELETE'
            })
            .then((json) => {
                var args = {
                    json,
                    params
                };
                pubsub.publish('AVATAR:DELETE', args);
                return args;
            });
    };

    // API: Notification

    pubsub.subscribe('LOGIN', function() {
        api.notificationMap.clear();
        api.isNotificationsLoading.value = false;
    });

    pubsub.subscribe('NOTIFICATION', function(args) {
        args.ref = API.applyNotification(args.json);
    });

    pubsub.subscribe('NOTIFICATION:LIST', function(args) {
        for (var json of args.json) {
            pubsub.publish('NOTIFICATION', {
                json,
                params: {
                    notificationId: json.id
                }
            });
        }
    });

    pubsub.subscribe('NOTIFICATION:ACCEPT', function(args) {
        var ref = api.notificationMap.get(args.params.notificationId);
        if (typeof ref === 'undefined' || ref.$isDeleted) {
            return;
        }
        args.ref = ref;
        ref.$isDeleted = true;
        pubsub.publish('NOTIFICATION:@DELETE', {
            ref,
            params: {
                notificationId: ref.id
            }
        });
        pubsub.publish('FRIEND:ADD', {
            params: {
                userId: ref.senderUserId
            }
        });
    });

    pubsub.subscribe('NOTIFICATION:HIDE', function(args) {
        var ref = api.notificationMap.get(args.params.notificationId);
        if (typeof ref === 'undefined' && ref.$isDeleted) {
            return;
        }
        args.ref = ref;
        ref.$isDeleted = true;
        pubsub.publish('NOTIFICATION:@DELETE', {
            ref,
            params: {
                notificationId: ref.id
            }
        });
    });

    API.applyNotification = function(json) {
        var ref = api.notificationMap.get(json.id);
        if (typeof ref === 'undefined') {
            ref = {
                id: '',
                senderUserId: '',
                senderUsername: '',
                type: '',
                message: '',
                details: {},
                seen: false,
                created_at: '',
                // VRCX
                $isDeleted: false,
                $isExpired: false,
                //
                ...json
            };
            api.notificationMap.set(ref.id, ref);
        } else {
            Object.assign(ref, json);
            ref.$isExpired = false;
        }
        if (ref.details !== Object(ref.details)) {
            var details = {};
            if (ref.details !== '{}') {
                try {
                    var object = JSON.parse(ref.details);
                    if (object === Object(object)) {
                        details = object;
                    }
                } catch (err) {}
            }
            ref.details = details;
        }
        return ref;
    };

    API.expireNotifications = function() {
        for (var ref of api.notificationMap.values()) {
            ref.$isExpired = true;
        }
    };

    API.deleteExpiredNotifcations = function() {
        for (var ref of api.notificationMap.values()) {
            if (ref.$isDeleted || ref.$isExpired === false) {
                continue;
            }
            ref.$isDeleted = true;
            pubsub.publish('NOTIFICATION:@DELETE', {
                ref,
                params: {
                    notificationId: ref.id
                }
            });
        }
    };

    API.refreshNotifications = function() {
        // NOTE : 캐시 때문에 after=~ 로는 갱신이 안됨. 그래서 첨부터 불러옴
        if (api.isNotificationsLoading.value) {
            return;
        }
        api.isNotificationsLoading.value = true;
        API.expireNotifications();
        API.expireNotifications();
        API.getNotifications({n: 100}).then(() => {
            API.deleteExpiredNotifcations();
            api.isNotificationsLoading.value = false;
            $app.unseenNotifications = [];
        });
        try {
            API.getNotifications({n: 100});
        } catch (err) {
            console.error(err);
        }
        API.deleteExpiredNotifcations();
        api.isNotificationsLoading.value = false;
    };

    /*
        params: {
            n: number,
            offset: number,
            sent: boolean,
            type: string,
            after: string (ISO8601 or 'five_minutes_ago')
        }
    */
    API.getNotifications = function(params) {
        return api
            .legacyApi('auth/user/notifications', {
                method: 'GET',
                params
            })
            .then((json) => {
                var args = {
                    json,
                    params
                };
                pubsub.publish('NOTIFICATION:LIST', args);
                return args;
            });
    };

    API.clearNotifications = function() {
        return api
            .legacyApi('auth/user/notifications/clear', {
                method: 'PUT'
            })
            .then((json) => {
                var args = {
                    json
                };
                // FIXME: NOTIFICATION:CLEAR 핸들링
                pubsub.publish('NOTIFICATION:CLEAR', args);
                return args;
            });
    };

    API.sendInvitePhoto = function(receiverUserId, params) {
        var formData = new FormData();
        for (var key of Object.keys(params)) {
            formData.set(key, params[key]);
        }
        return api
            .legacyApi(`invite/${receiverUserId}/photo`, {
                method: 'POST',
                params: formData
            })
            .then((json) => {
                var args = {
                    json
                };
                pubsub.publish('NOTIFICATION:INVITE:PHOTO:SEND', args);
                return args;
            });
    };

    API.sendRequestInvite = function(receiverUserId, params) {
        return api
            .legacyApi(`requestInvite/${receiverUserId}`, {
                method: 'POST',
                params
            })
            .then((json) => {
                var args = {
                    json
                };
                pubsub.publish('NOTIFICATION:REQUESTINVITE:SEND', args);
                return args;
            });
    };

    API.sendRequestInvitePhoto = function(receiverUserId, params) {
        var formData = new FormData();
        for (var key of Object.keys(params)) {
            formData.set(key, params[key]);
        }
        return api
            .legacyApi(`requestInvite/${receiverUserId}/photo`, {
                method: 'POST',
                params: formData
            })
            .then((json) => {
                var args = {
                    json
                };
                pubsub.publish('NOTIFICATION:REQUESTINVITE:PHOTO:SEND', args);
                return args;
            });
    };

    API.sendInviteResponse = function(inviteId, params) {
        return api
            .legacyApi(`invite/${inviteId}/response`, {
                method: 'POST',
                params
            })
            .then((json) => {
                var args = {
                    json,
                    inviteID: inviteId
                };
                pubsub.publish('INVITE:RESPONSE:SEND', args);
                return args;
            });
    };

    API.sendInviteResponsePhoto = function(inviteId, params) {
        var formData = new FormData();
        for (var key of Object.keys(params)) {
            formData.set(key, params[key]);
        }
        return api
            .legacyApi(`invite/${inviteID}/response/photo`, {
                method: 'POST',
                params: formData
            })
            .then((json) => {
                var args = {
                    json,
                    inviteID
                };
                pubsub.publish('INVITE:RESPONSE:PHOTO:SEND', args);
                return args;
            });
    };

    /*
        params: {
            notificationId: string
        }
    */
    API.acceptNotification = function(params) {
        return api
            .legacyApi(
                `auth/user/notifications/${params.notificationId}/accept`,
                {
                    method: 'PUT'
                }
            )
            .then((json) => {
                var args = {
                    json,
                    params
                };
                pubsub.publish('NOTIFICATION:ACCEPT', args);
                return args;
            });
    };

    /*
        params: {
            notificationId: string
        }
    */
    API.hideNotification = function(params) {
        return api
            .legacyApi(
                `auth/user/notifications/${params.notificationId}/hide`,
                {
                    method: 'PUT'
                }
            )
            .then((json) => {
                var args = {
                    json,
                    params
                };
                pubsub.publish('NOTIFICATION:HIDE', args);
                return args;
            });
    };

    API.getFriendRequest = function(userId) {
        for (var ref of api.notificationMap.values()) {
            if (
                ref.$isDeleted === false &&
                ref.type === 'friendRequest' &&
                ref.senderUserId === userId
            ) {
                return ref.id;
            }
        }
        return '';
    };

    API.parseInviteLocation = function(ref) {
        try {
            var L = API.parseLocation(ref.details.worldId);
            if (L.worldId && L.instanceId) {
                return `${ref.details.worldName} #${L.instanceName} ${L.accessType}`;
            }
            return ref.message || ref.details.worldId || ref.details.worldName;
        } catch (err) {
            return '';
        }
    };

    // API: PlayerModeration

    pubsub.subscribe('LOGIN', function() {
        api.playerModerationMap.clear();
        api.isPlayerModerationsLoading.value = false;
        API.refreshPlayerModerations();
    });

    pubsub.subscribe('PLAYER-MODERATION', function(args) {
        args.ref = API.applyPlayerModeration(args.json);
    });

    pubsub.subscribe('PLAYER-MODERATION:LIST', function(args) {
        for (var json of args.json) {
            pubsub.publish('PLAYER-MODERATION', {
                json,
                params: {
                    playerModerationId: json.id
                }
            });
        }
    });

    pubsub.subscribe('PLAYER-MODERATION:SEND', function(args) {
        var ref = {
            json: args.json,
            params: {
                playerModerationId: args.json.id
            }
        };
        pubsub.publish('PLAYER-MODERATION', ref);
        pubsub.publish('PLAYER-MODERATION:@SEND', ref);
    });

    pubsub.subscribe('PLAYER-MODERATION:DELETE', function(args) {
        var {type, moderated} = args.params;
        var userId = api.currentUser.id;
        for (var ref of api.playerModerationMap.values()) {
            if (
                ref.$isDeleted === false &&
                ref.type === type &&
                ref.targetUserId === moderated &&
                ref.sourceUserId === userId
            ) {
                ref.$isDeleted = true;
                pubsub.publish('PLAYER-MODERATION:@DELETE', {
                    ref,
                    params: {
                        playerModerationId: ref.id
                    }
                });
            }
        }
    });

    API.applyPlayerModeration = function(json) {
        var ref = api.playerModerationMap.get(json.id);
        if (typeof ref === 'undefined') {
            ref = {
                id: '',
                type: '',
                sourceUserId: '',
                sourceDisplayName: '',
                targetUserId: '',
                targetDisplayName: '',
                created: '',
                // VRCX
                $isDeleted: false,
                $isExpired: false,
                //
                ...json
            };
            api.playerModerationMap.set(ref.id, ref);
        } else {
            Object.assign(ref, json);
            ref.$isExpired = false;
        }
        return ref;
    };

    API.expirePlayerModerations = function() {
        for (var ref of api.playerModerationMap.values()) {
            ref.$isExpired = true;
        }
    };

    API.deleteExpiredPlayerModerations = function() {
        for (var ref of api.playerModerationMap.values()) {
            if (ref.$isDeleted || ref.$isExpired === false) {
                continue;
            }
            ref.$isDeleted = true;
            pubsub.publish('PLAYER-MODERATION:@DELETE', {
                ref,
                params: {
                    playerModerationId: ref.id
                }
            });
        }
    };

    API.refreshPlayerModerations = function() {
        if (api.isPlayerModerationsLoading.value) {
            return;
        }
        api.isPlayerModerationsLoading.value = true;
        API.expirePlayerModerations();
        Promise.all([
            API.getPlayerModerations()
            //API.getPlayerModerationsAgainstMe();
        ])
            .finally(() => {
                api.isPlayerModerationsLoading.value = false;
            })
            .then(() => {
                API.deleteExpiredPlayerModerations();
            });
    };

    API.getPlayerModerations = function() {
        return api
            .legacyApi('auth/user/playermoderations', {
                method: 'GET'
            })
            .then((json) => {
                var args = {
                    json
                };
                pubsub.publish('PLAYER-MODERATION:LIST', args);
                return args;
            });
    };

    API.getPlayerModerationsAgainstMe = function() {
        return api
            .legacyApi('auth/user/playermoderated', {
                method: 'GET'
            })
            .then((json) => {
                var args = {
                    json
                };
                pubsub.publish('PLAYER-MODERATION:LIST', args);
                return args;
            });
    };

    /*
        params: {
            moderated: string,
            type: string
        }
    */
    // old-way: POST auth/user/blocks {blocked:userId}
    API.sendPlayerModeration = function(params) {
        return api
            .legacyApi('auth/user/playermoderations', {
                method: 'POST',
                params
            })
            .then((json) => {
                var args = {
                    json,
                    params
                };
                pubsub.publish('PLAYER-MODERATION:SEND', args);
                return args;
            });
    };

    /*
        params: {
            moderated: string,
            type: string
        }
    */
    // old-way: PUT auth/user/unblocks {blocked:userId}
    API.deletePlayerModeration = function(params) {
        return api
            .legacyApi('auth/user/unplayermoderate', {
                method: 'PUT',
                params
            })
            .then((json) => {
                var args = {
                    json,
                    params
                };
                pubsub.publish('PLAYER-MODERATION:DELETE', args);
                return args;
            });
    };

    // API: Favorite

    pubsub.subscribe('LOGIN', function() {
        api.favoriteMap.clear();
        api.favoriteMapByObjectId.clear();
        api.favoriteGroupMap.clear();
        api.favoriteGroupMapByTypeName.clear();
        api.favoriteFriendGroups.length = 0;
        api.favoriteWorldGroups.length = 0;
        api.favoriteAvatarGroups.length = 0;
        api.isFavoriteLoading.value = false;
        api.isFavoriteGroupLoading.value = false;
        API.refreshFavorites();
    });

    pubsub.subscribe('FAVORITE', function(args) {
        var ref = API.applyFavorite(args.json);
        if (ref.$isDeleted) {
            return;
        }
        args.ref = ref;
    });

    pubsub.subscribe('FAVORITE:@DELETE', function(args) {
        var {ref} = args;
        if (ref.$groupRef !== null) {
            --ref.$groupRef.count;
        }
    });

    pubsub.subscribe('FAVORITE:LIST', function(args) {
        for (var json of args.json) {
            pubsub.publish('FAVORITE', {
                json,
                params: {
                    favoriteId: json.id
                }
            });
        }
    });

    pubsub.subscribe('FAVORITE:ADD', function(args) {
        pubsub.publish('FAVORITE', {
            json: args.json,
            params: {
                favoriteId: args.json.id
            }
        });
    });

    pubsub.subscribe('FAVORITE:ADD', function(args) {
        if (
            args.params.type === 'avatar' &&
            !API.cachedAvatars.has(args.params.favoriteId)
        ) {
            API.refreshFavoriteAvatars(args.params.tags);
        }
    });

    pubsub.subscribe('FAVORITE:DELETE', function(args) {
        var ref = api.favoriteMapByObjectId.get(args.params.objectId);
        if (typeof ref === 'undefined') {
            return;
        }
        // 애초에 $isDeleted인데 여기로 올 수 가 있나..?
        api.favoriteMapByObjectId.delete(args.params.objectId);
        if (ref.$isDeleted) {
            return;
        }
        args.ref = ref;
        ref.$isDeleted = true;
        pubsub.publish('FAVORITE:@DELETE', {
            ref,
            params: {
                favoriteId: ref.id
            }
        });
    });

    pubsub.subscribe('FAVORITE:GROUP', function(args) {
        var ref = API.applyFavoriteGroup(args.json);
        if (ref.$isDeleted) {
            return;
        }
        args.ref = ref;
        if (ref.$groupRef !== null) {
            ref.$groupRef.displayName = ref.displayName;
            ref.$groupRef.visibility = ref.visibility;
        }
    });

    pubsub.subscribe('FAVORITE:GROUP:LIST', function(args) {
        for (var json of args.json) {
            pubsub.publish('FAVORITE:GROUP', {
                json,
                params: {
                    favoriteGroupId: json.id
                }
            });
        }
    });

    pubsub.subscribe('FAVORITE:GROUP:SAVE', function(args) {
        pubsub.publish('FAVORITE:GROUP', {
            json: args.json,
            params: {
                favoriteGroupId: args.json.id
            }
        });
    });

    pubsub.subscribe('FAVORITE:GROUP:CLEAR', function(args) {
        var key = `${args.params.type}:${args.params.group}`;
        for (var ref of api.favoriteMap.values()) {
            if (ref.$isDeleted || ref.$groupKey !== key) {
                continue;
            }
            api.favoriteMapByObjectId.delete(ref.favoriteId);
            ref.$isDeleted = true;
            pubsub.publish('FAVORITE:@DELETE', {
                ref,
                params: {
                    favoriteId: ref.id
                }
            });
        }
    });

    pubsub.subscribe('FAVORITE:WORLD:LIST', function(args) {
        for (var json of args.json) {
            if (json.id === '???') {
                // FIXME
                // json.favoriteId로 따로 불러와야 하나?
                // 근데 ???가 많으면 과다 요청이 될듯
                continue;
            }
            pubsub.publish('WORLD', {
                json,
                params: {
                    worldId: json.id
                }
            });
        }
    });

    pubsub.subscribe('FAVORITE:AVATAR:LIST', function(args) {
        for (var json of args.json) {
            if (json.releaseStatus === 'hidden') {
                // NOTE: 얘는 또 더미 데이터로 옴
                continue;
            }
            pubsub.publish('AVATAR', {
                json,
                params: {
                    avatarId: json.id
                }
            });
        }
    });

    API.applyFavorite = function(json) {
        var ref = api.favoriteMap.get(json.id);
        if (typeof ref === 'undefined') {
            ref = {
                id: '',
                type: '',
                favoriteId: '',
                tags: [],
                // VRCX
                $isDeleted: false,
                $isExpired: false,
                $groupKey: '',
                $groupRef: null,
                //
                ...json
            };
            api.favoriteMap.set(ref.id, ref);
            api.favoriteMapByObjectId.set(ref.favoriteId, ref);
        } else {
            Object.assign(ref, json);
            ref.$isExpired = false;
        }
        ref.$groupKey = `${ref.type}:${String(ref.tags[0])}`;
        if (ref.$isDeleted === false && ref.$groupRef === null) {
            var group = api.favoriteGroupMapByTypeName.get(ref.$groupKey);
            if (typeof group !== 'undefined') {
                ref.$groupRef = group;
                ++group.count;
            }
        }
        return ref;
    };

    API.expireFavorites = function() {
        for (var ref of api.favoriteMap.values()) {
            ref.$isExpired = true;
        }
    };

    API.deleteExpiredFavorites = function() {
        for (var ref of api.favoriteMap.values()) {
            if (ref.$isDeleted || ref.$isExpired === false) {
                continue;
            }
            ref.$isDeleted = true;
            pubsub.publish('FAVORITE:@DELETE', {
                ref,
                params: {
                    favoriteId: ref.id
                }
            });
        }
    };

    API.refreshFavoriteAvatars = function(tag) {
        var params = {
            n: 100,
            offset: 0,
            tag
        };
        API.getFavoriteAvatars(params);
    };

    API.refreshFavoriteItems = async function() {
        var favoriteGroups = {
            world: [0, 'getFavoriteWorlds'],
            avatar: [0, 'getFavoriteAvatars']
        };
        var avatarTags = [];
        for (var apiFavorite of api.favoriteMap.values()) {
            if (apiFavorite.$isDeleted) {
                continue;
            }
            var favoriteGroup = favoriteGroups[apiFavorite.type];
            if (favoriteGroup === void 0) {
                continue;
            }
            if (
                apiFavorite.type === 'avatar' &&
                !avatarTags.includes(apiFavorite.tags[0])
            ) {
                avatarTags.push(apiFavorite.tags[0]);
            }
            ++favoriteGroup[0];
        }
        if (favoriteGroups.world[0] > 0) {
            try {
                for (var offset = 0; ; offset += 100) {
                    var {json} = await API.getFavoriteWorlds({
                        n: 100,
                        offset
                    });
                    if (json === void 0 || json.length === 0) {
                        break;
                    }
                }
            } catch (err) {
                console.log(err);
            }
        }
        if (favoriteGroups.avatar[0] > 0) {
            try {
                for (var tag of avatarTags) {
                    for (var offset = 0; ; offset += 100) {
                        var {json} = await API.getFavoriteAvatars({
                            n: 100,
                            offset,
                            tag
                        });
                        if (json === void 0 || json.length === 0) {
                            break;
                        }
                    }
                }
            } catch (err) {
                console.error(err);
            }
        }
    };

    API.refreshFavorites = async function() {
        if (api.isFavoriteLoading.value) {
            return;
        }
        api.isFavoriteLoading.value = true;
        API.expireFavorites();
        try {
            for (var offset = 0; ; offset += 100) {
                var {json} = await API.getFavorites({
                    n: 100,
                    offset
                });
                if (json === void 0 || json.length === 0) {
                    break;
                }
            }
        } catch (err) {
            console.error(err);
        }
        API.deleteExpiredFavorites();
        API.refreshFavoriteItems();
        API.refreshFavoriteGroups();
        api.isFavoriteLoading.value = false;
    };

    API.applyFavoriteGroup = function(json) {
        var ref = api.favoriteGroupMap.get(json.id);
        if (typeof ref === 'undefined') {
            ref = {
                id: '',
                ownerId: '',
                ownerDisplayName: '',
                name: '',
                displayName: '',
                type: '',
                visibility: '',
                tags: [],
                // VRCX
                $isDeleted: false,
                $isExpired: false,
                $groupRef: null,
                //
                ...json
            };
            api.favoriteGroupMap.set(ref.id, ref);
        } else {
            Object.assign(ref, json);
            ref.$isExpired = false;
        }
        return ref;
    };

    API.buildFavoriteGroups = function() {
        // 192 = ['group_0', 'group_1', 'group_2'] x 64
        api.favoriteFriendGroups.length = 0;
        for (var i = 0; i < 3; ++i) {
            api.favoriteFriendGroups.push({
                assign: false,
                key: `friend:group_${i}`,
                type: 'friend',
                name: `group_${i}`,
                displayName: `Group ${i + 1}`,
                capacity: 64,
                count: 0,
                visibility: 'private'
            });
        }
        // 256 = ['worlds1', 'worlds2', 'worlds3', 'worlds4'] x 64
        api.favoriteWorldGroups.length = 0;
        for (var i = 0; i < 4; ++i) {
            api.favoriteWorldGroups.push({
                assign: false,
                key: `world:worlds${i + 1}`,
                type: 'world',
                name: `worlds${i + 1}`,
                displayName: `Group ${i + 1}`,
                capacity: 64,
                count: 0,
                visibility: 'private'
            });
        }
        // 100 = ['avatars1'] x 25
        // Favorite Avatars (0/25)
        // VRC+ Group 1 (0/25)
        // VRC+ Group 2 (0/25)
        // VRC+ Group 3 (0/25)
        var avatarGroupNames = [
            'Favorite Avatars',
            'VRC+ Group 1',
            'VRC+ Group 2',
            'VRC+ Group 3'
        ];
        api.favoriteAvatarGroups.length = 0;
        for (var i = 0; i < 4; ++i) {
            api.favoriteAvatarGroups.push({
                assign: false,
                key: `avatar:avatars${i + 1}`,
                type: 'avatar',
                name: `avatars${i + 1}`,
                displayName: avatarGroupNames[i],
                capacity: 25,
                count: 0,
                visibility: 'private'
            });
        }
        var types = {
            friend: api.favoriteFriendGroups,
            world: api.favoriteWorldGroups,
            avatar: api.favoriteAvatarGroups
        };
        var assigns = new Set();
        // assign the same name first
        for (var ref of api.favoriteGroupMap.values()) {
            if (ref.$isDeleted) {
                continue;
            }
            var groups = types[ref.type];
            if (typeof groups === 'undefined') {
                continue;
            }
            for (var group of groups) {
                if (group.assign === false && group.name === ref.name) {
                    group.assign = true;
                    if (ref.type !== 'avatar') {
                        group.displayName = ref.displayName;
                    }
                    group.visibility = ref.visibility;
                    ref.$groupRef = group;
                    assigns.add(ref.id);
                    break;
                }
            }
        }
        // assign the rest
        // FIXME
        // The order (cachedFavoriteGroups) is very important. It should be
        // processed in the order in which the server responded. But since we
        // used Map(), the order would be a mess. So we need something to solve
        // this.
        for (var ref of api.favoriteGroupMap.values()) {
            if (ref.$isDeleted || assigns.has(ref.id)) {
                continue;
            }
            var groups = types[ref.type];
            if (typeof groups === 'undefined') {
                continue;
            }
            for (var group of groups) {
                if (group.assign === false) {
                    group.assign = true;
                    group.key = `${group.type}:${ref.name}`;
                    group.name = ref.name;
                    if (ref.type !== 'avatar') {
                        group.displayName = ref.displayName;
                    }
                    ref.$groupRef = group;
                    assigns.add(ref.id);
                    break;
                }
            }
        }
        // update favorites
        api.favoriteGroupMapByTypeName.clear();
        for (var type in types) {
            for (var group of types[type]) {
                api.favoriteGroupMapByTypeName.set(group.key, group);
            }
        }
        for (var ref of api.favoriteMap.values()) {
            ref.$groupRef = null;
            if (ref.$isDeleted) {
                continue;
            }
            var group = api.favoriteGroupMapByTypeName.get(ref.$groupKey);
            if (typeof group === 'undefined') {
                continue;
            }
            ref.$groupRef = group;
            ++group.count;
        }
    };

    API.expireFavoriteGroups = function() {
        for (var ref of api.favoriteGroupMap.values()) {
            ref.$isExpired = true;
        }
    };

    API.deleteExpiredFavoriteGroups = function() {
        for (var ref of api.favoriteGroupMap.values()) {
            if (ref.$isDeleted || ref.$isExpired === false) {
                continue;
            }
            ref.$isDeleted = true;
            pubsub.publish('FAVORITE:GROUP:@DELETE', {
                ref,
                params: {
                    favoriteGroupId: ref.id
                }
            });
        }
    };

    API.refreshFavoriteGroups = async function() {
        if (api.isFavoriteGroupLoading.value) {
            return;
        }
        api.isFavoriteGroupLoading.value = true;
        API.expireFavoriteGroups();
        try {
            for (var offset = 0; ; offset += 100) {
                var {json} = await API.getFavoriteGroups({
                    n: 100,
                    offset
                });
                if (json === void 0 || json.length === 0) {
                    break;
                }
            }
        } catch (err) {
            console.error(err);
        }
        API.deleteExpiredFavoriteGroups();
        this.buildFavoriteGroups();
        api.isFavoriteGroupLoading.value = false;
    };

    /*
        params: {
            n: number,
            offset: number,
            type: string,
            tag: string
        }
    */
    API.getFavorites = function(params) {
        return api
            .legacyApi('favorites', {
                method: 'GET',
                params
            })
            .then((json) => {
                var args = {
                    json,
                    params
                };
                pubsub.publish('FAVORITE:LIST', args);
                return args;
            });
    };

    /*
        params: {
            type: string,
            favoriteId: string (objectId),
            tags: string
        }
    */
    API.addFavorite = function(params) {
        return api
            .legacyApi('favorites', {
                method: 'POST',
                params
            })
            .then((json) => {
                var args = {
                    json,
                    params
                };
                pubsub.publish('FAVORITE:ADD', args);
                return args;
            });
    };

    /*
        params: {
            objectId: string
        }
    */
    API.deleteFavorite = function(params) {
        return api
            .legacyApi(`favorites/${params.objectId}`, {
                method: 'DELETE'
            })
            .then((json) => {
                var args = {
                    json,
                    params
                };
                pubsub.publish('FAVORITE:DELETE', args);
                return args;
            });
    };

    /*
        params: {
            n: number,
            offset: number,
            type: string
        }
    */
    API.getFavoriteGroups = function(params) {
        return api
            .legacyApi('favorite/groups', {
                method: 'GET',
                params
            })
            .then((json) => {
                var args = {
                    json,
                    params
                };
                pubsub.publish('FAVORITE:GROUP:LIST', args);
                return args;
            });
    };

    /*
        params: {
            type: string,
            group: string (name),
            displayName: string,
            visibility: string
        }
    */
    API.saveFavoriteGroup = function(params) {
        return api
            .legacyApi(
                `favorite/group/${params.type}/${params.group}/${api.currentUser.id}`,
                {
                    method: 'PUT',
                    params
                }
            )
            .then((json) => {
                var args = {
                    json,
                    params
                };
                pubsub.publish('FAVORITE:GROUP:SAVE', args);
                return args;
            });
    };

    /*
        params: {
            type: string,
            group: string (name)
        }
    */
    API.clearFavoriteGroup = function(params) {
        return api
            .legacyApi(
                `favorite/group/${params.type}/${params.group}/${api.currentUser.id}`,
                {
                    method: 'DELETE',
                    params
                }
            )
            .then((json) => {
                var args = {
                    json,
                    params
                };
                pubsub.publish('FAVORITE:GROUP:CLEAR', args);
                return args;
            });
    };

    /*
        params: {
            n: number,
            offset: number
        }
    */
    API.getFavoriteWorlds = function(params) {
        return api
            .legacyApi('worlds/favorites', {
                method: 'GET',
                params
            })
            .then((json) => {
                var args = {
                    json,
                    params
                };
                pubsub.publish('FAVORITE:WORLD:LIST', args);
                return args;
            });
    };

    /*
        params: {
            n: number,
            offset: number
        }
    */
    API.getFavoriteAvatars = function(params) {
        return api
            .legacyApi('avatars/favorites', {
                method: 'GET',
                params
            })
            .then((json) => {
                var args = {
                    json,
                    params
                };
                pubsub.publish('FAVORITE:AVATAR:LIST', args);
                return args;
            });
    };

    // API: WebSocket

    API.webSocket = null;

    pubsub.subscribe('LOGOUT', function() {
        API.closeWebSocket();
    });

    pubsub.subscribe('USER:CURRENT', function() {
        if (API.webSocket === null) {
            API.getAuth();
        }
    });

    pubsub.subscribe('AUTH', function(args) {
        if (args.json.ok) {
            API.connectWebSocket(args.json.token);
        }
    });

    pubsub.subscribe('PIPELINE', function(args) {
        var {type, content} = args.json;
        if (typeof content.user !== 'undefined') {
            delete content.user.state;
        }
        switch (type) {
            case 'notification':
                pubsub.publish('NOTIFICATION', {
                    json: content,
                    params: {
                        notificationId: content.id
                    }
                });
                break;

            case 'notification-see':
                pubsub.publish('NOTIFICATION:SEE', {
                    params: {
                        notificationId: content.notificationId
                    }
                });
                break;

            case 'friend-add':
                pubsub.publish('USER', {
                    json: content.user,
                    params: {
                        userId: content.userId
                    }
                });
                pubsub.publish('FRIEND:ADD', {
                    params: {
                        userId: content.userId
                    }
                });
                break;

            case 'friend-delete':
                pubsub.publish('FRIEND:DELETE', {
                    params: {
                        userId: content.userId
                    }
                });
                break;

            case 'friend-online':
                if (content.location !== 'private') {
                    pubsub.publish('WORLD', {
                        json: content.world,
                        params: {
                            worldId: content.world.id
                        }
                    });
                }
                pubsub.publish('USER', {
                    json: {
                        location: content.location,
                        ...content.user
                    },
                    params: {
                        userId: content.userId
                    }
                });
                pubsub.publish('FRIEND:STATE', {
                    json: {
                        state: 'online'
                    },
                    params: {
                        userId: content.userId
                    }
                });
                break;

            case 'friend-active':
                pubsub.publish('USER', {
                    json: content.user,
                    params: {
                        userId: content.userId
                    }
                });
                pubsub.publish('FRIEND:STATE', {
                    json: {
                        state: 'active'
                    },
                    params: {
                        userId: content.userId
                    }
                });
                break;

            case 'friend-offline':
                pubsub.publish('FRIEND:STATE', {
                    json: {
                        state: 'offline'
                    },
                    params: {
                        userId: content.userId
                    }
                });
                break;

            case 'friend-update':
                pubsub.publish('USER', {
                    json: content.user,
                    params: {
                        userId: content.userId
                    }
                });
                break;

            case 'friend-location':
                if (content.location !== 'private') {
                    pubsub.publish('WORLD', {
                        json: content.world,
                        params: {
                            worldId: content.world.id
                        }
                    });
                }
                if (content.userId === api.currentUser.id) {
                    pubsub.publish('USER', {
                        json: content.user,
                        params: {
                            userId: content.userId
                        }
                    });
                } else {
                    pubsub.publish('USER', {
                        json: {
                            location: content.location,
                            ...content.user
                        },
                        params: {
                            userId: content.userId
                        }
                    });
                }
                break;

            case 'user-update':
                pubsub.publish('USER:CURRENT', {
                    json: content.user,
                    params: {
                        userId: content.userId
                    }
                });
                break;

            case 'user-location':
                if (content.world === Object(content.world)) {
                    pubsub.publish('WORLD', {
                        json: content.world,
                        params: {
                            worldId: content.world.id
                        }
                    });
                }
                pubsub.publish('USER', {
                    json: {
                        id: content.userId,
                        location: content.location
                    },
                    params: {
                        userId: content.userId
                    }
                });
                break;

            default:
                break;
        }
    });

    API.getAuth = function() {
        return api
            .legacyApi('auth', {
                method: 'GET'
            })
            .then((json) => {
                var args = {
                    json
                };
                pubsub.publish('AUTH', args);
                return args;
            });
    };

    API.connectWebSocket = function(token) {
        if (API.webSocket === null) {
            var socket = new WebSocket(
                `wss://pipeline.vrchat.cloud/?auth=${token}`
            );
            socket.onclose = () => {
                if (API.webSocket === socket) {
                    API.webSocket = null;
                }
                try {
                    socket.close();
                } catch (err) {}
            };
            socket.onerror = socket.onclose;
            socket.onmessage = ({data}) => {
                try {
                    var json = JSON.parse(data);
                    json.content = JSON.parse(json.content);
                    if ($app.debugWebSocket) {
                        var displayName = '';
                        if (api.userMap.has(json.content.userId)) {
                            var user = api.userMap.get(json.content.userId);
                            displayName = user.displayName;
                        }
                        console.log(
                            'WebSocket',
                            json.type,
                            displayName,
                            json.content
                        );
                    }
                    pubsub.publish('PIPELINE', {
                        json
                    });
                } catch (err) {
                    console.error(err);
                }
            };
            API.webSocket = socket;
        }
    };

    API.closeWebSocket = function() {
        var socket = API.webSocket;
        if (socket === null) {
            return;
        }
        API.webSocket = null;
        try {
            socket.close();
        } catch (err) {}
    };

    // API: Visit

    API.getVisits = function() {
        return api
            .legacyApi('visits', {
                method: 'GET'
            })
            .then((json) => {
                var args = {
                    json
                };
                pubsub.publish('VISITS', args);
                return args;
            });
    };

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
            this.$nextTick(function() {
                this.$el.style.display = '';
                this.loginForm.loading = true;
                API.getConfig()
                    .catch((err) => {
                        this.loginForm.loading = false;
                        throw err;
                    })
                    .then((args) => {
                        API.getCurrentUser().finally(() => {
                            this.loginForm.loading = false;
                        });
                        return args;
                    });
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
        if (typeof mapping !== 'undefined') {
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

    $app.methods.updateLoop = function() {
        try {
            if (api.isLoggedIn.value === true) {
                if (--this.nextCurrentUserRefresh <= 0) {
                    this.nextCurrentUserRefresh = 60; // 30secs
                    API.getCurrentUser().catch((err1) => {
                        throw err1;
                    });
                }
                if (--this.nextFriendsRefresh <= 0) {
                    this.nextFriendsRefresh = 7200; // 1hour
                    API.refreshFriends();
                    if (API.isGameRunning) {
                        API.refreshPlayerModerations();
                    }
                }
                AppApi.CheckGameRunning().then(
                    ([isGameRunning, isGameNoVR]) => {
                        if (isGameRunning !== API.isGameRunning) {
                            API.isGameRunning = isGameRunning;
                            Discord.SetTimestamps(Date.now(), 0);
                        }
                        API.isGameNoVR = isGameNoVR;
                        this.updateDiscord();
                        this.updateOpenVR();
                    }
                );
            }
        } catch (err) {
            console.error(err);
        }
        setTimeout(() => this.updateLoop(), 500);
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
            API.isGameRunning &&
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
        if (API.isGameRunning) {
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
                (API.isGameNoVR || !API.isGameRunning)) ||
            (this.notificationTTS === 'Inside VR' &&
                !API.isGameNoVR &&
                API.isGameRunning) ||
            (this.notificationTTS === 'Game Closed' && !API.isGameRunning) ||
            (this.notificationTTS === 'Desktop Mode' &&
                API.isGameNoVR &&
                API.isGameRunning)
        ) {
            playNotificationTTS = true;
        }
        var playDesktopToast = false;
        if (
            this.desktopToast === 'Always' ||
            (this.desktopToast === 'Outside VR' &&
                (API.isGameNoVR || !API.isGameRunning)) ||
            (this.desktopToast === 'Inside VR' &&
                !API.isGameNoVR &&
                API.isGameRunning) ||
            (this.desktopToast === 'Game Closed' && !API.isGameRunning) ||
            (this.desktopToast === 'Desktop Mode' &&
                API.isGameNoVR &&
                API.isGameRunning)
        ) {
            playDesktopToast = true;
        }
        var playXSNotification = false;
        if (this.xsNotifications && API.isGameRunning && !API.isGameNoVR) {
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
                    typeof noty.details !== 'undefined' &&
                    typeof noty.details[messageList[k]] !== 'undefined'
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
            imageURL = await API.getCachedUser({
                userId
            })
                .catch((err) => {
                    console.error(err);
                    return false;
                })
                .then((args) => {
                    if (
                        this.displayVRCPlusIconsAsAvatar &&
                        args.json.userIcon
                    ) {
                        return args.json.userIcon;
                    }
                    return args.json.currentAvatarThumbnailImageUrl;
                });
        }
        if (!imageURL) {
            return false;
        }
        try {
            await fetch(imageURL, {
                method: 'GET',
                redirect: 'follow',
                headers: {
                    'User-Agent': appVersion
                }
            })
                .then((response) => {
                    return response.arrayBuffer();
                })
                .then((buffer) => {
                    var binary = '';
                    var bytes = new Uint8Array(buffer);
                    var length = bytes.byteLength;
                    for (var i = 0; i < length; i++) {
                        binary += String.fromCharCode(bytes[i]);
                    }
                    var imageData = btoa(binary);
                    AppApi.CacheImage(imageData);
                });
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
        var L = API.parseLocation(location);
        if (L.isOffline) {
            text = 'Offline';
        } else if (L.isPrivate) {
            text = 'Private';
        } else if (L.worldId) {
            var ref = api.worldMap.get(L.worldId);
            if (typeof ref === 'undefined') {
                await api
                    .getWorld({
                        worldId: L.worldId
                    })
                    .then((args) => {
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
                callback: (action, instance) => {
                    if (action === 'confirm') {
                        API.verifyTOTP({
                            code: instance.inputValue
                        })
                            .catch((err) => {
                                this.promptTOTP();
                                throw err;
                            })
                            .then((args) => {
                                API.getCurrentUser();
                                return args;
                            });
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
                callback: (action, instance) => {
                    if (action === 'confirm') {
                        API.verifyOTP({
                            code: instance.inputValue
                        })
                            .catch((err) => {
                                this.promptOTP();
                                throw err;
                            })
                            .then((args) => {
                                API.getCurrentUser();
                                return args;
                            });
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
            var name = (typeof ref !== 'undefined' && ref.name) || '';
            var memo = (typeof ref !== 'undefined' && ref.memo) || '';
            lines.push(`${_(userId)},${_(name)},${_(memo)}`);
        }
        this.exportFriendsListContent = lines.join('\n');
        this.exportFriendsListDialog = true;
    };

    $app.data.exportAvatarsListDialog = false;
    $app.data.exportAvatarsListContent = '';

    $app.methods.showExportAvatarsListDialog = async function() {
        for (var ref of API.cachedAvatars.values()) {
            if (ref.authorId === api.currentUser.id) {
                API.cachedAvatars.delete(ref.id);
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
                var {json} = await API.getAvatars({
                    n: 100,
                    offset,
                    ...params
                });
                if (json === void 0 || json.length === 0) {
                    break;
                }
                for (var apiAvatar of json) {
                    var $ref = API.cachedAvatars.get(apiAvatar.id);
                    if (typeof $ref !== void 0) {
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
                loginParmas: this.saveCredentials
            };
            savedCredentialsArray[currentUser.username] = credentialsToSave;
            delete this.saveCredentials;
        } else if (
            typeof savedCredentialsArray[currentUser.username] !== 'undefined'
        ) {
            savedCredentialsArray[currentUser.username].user = currentUser;
        }
        this.loginForm.savedCredentials = savedCredentialsArray;
        var jsonCredentialsArray = JSON.stringify(savedCredentialsArray);
        configRepository.setString('savedCredentials', jsonCredentialsArray);
        this.loginForm.lastUserLoggedIn = currentUser.username;
        configRepository.setString('lastUserLoggedIn', currentUser.username);
    };

    $app.methods.relogin = function(loginParmas) {
        this.loginForm.loading = true;
        return API.getConfig()
            .catch((err) => {
                this.loginForm.loading = false;
                throw err;
            })
            .then(() => {
                API.login({
                    username: loginParmas.username,
                    password: loginParmas.password
                })
                    .catch((err2) => {
                        API.logout();
                        throw err2;
                    })
                    .finally(() => {
                        this.loginForm.loading = false;
                    });
            });
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

    pubsub.subscribe('AUTOLOGIN', function() {
        var user =
            $app.loginForm.savedCredentials[$app.loginForm.lastUserLoggedIn];
        if (typeof user !== 'undefined') {
            $app.relogin({
                username: user.loginParmas.username,
                password: user.loginParmas.password
            }).then(() => {
                new Noty({
                    type: 'success',
                    text: 'Automatically logged in.'
                }).show();
            });
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
        this.$refs.loginForm.validate((valid) => {
            if (valid && !this.loginForm.loading) {
                this.loginForm.loading = true;
                API.getConfig()
                    .catch((err) => {
                        this.loginForm.loading = false;
                        throw err;
                    })
                    .then((args) => {
                        API.login({
                            username: this.loginForm.username,
                            password: this.loginForm.password,
                            saveCredentials: this.loginForm.saveCredentials
                        }).finally(() => {
                            this.loginForm.username = '';
                            this.loginForm.password = '';
                            this.loginForm.loading = false;
                        });
                        return args;
                    });
            }
        });
    };

    $app.methods.loginWithSteam = function() {
        if (!this.loginForm.loading) {
            this.loginForm.loading = true;
            AppApi.LoginWithSteam()
                .catch((err) => {
                    this.loginForm.loading = false;
                    throw err;
                })
                .then((steamTicket) => {
                    if (steamTicket) {
                        API.getConfig()
                            .catch((err) => {
                                this.loginForm.loading = false;
                                throw err;
                            })
                            .then((args) => {
                                API.loginWithSteam({
                                    steamTicket
                                }).finally(() => {
                                    this.loginForm.loading = false;
                                });
                                return args;
                            });
                    } else {
                        this.loginForm.loading = false;
                        this.$message({
                            message: 'It only works when VRChat is running.',
                            type: 'error'
                        });
                    }
                });
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

    $app.methods.fetchActiveFriend = function(userId) {
        this.pendingActiveFriends.add(userId);
        // FIXME: handle error
        return API.getUser({
            userId
        }).then((args) => {
            this.pendingActiveFriends.delete(userId);
            return args;
        });
    };

    pubsub.subscribe('USER:CURRENT', function(args) {
        $app.checkActiveFriends(args.json);
    });

    $app.methods.checkActiveFriends = function(ref) {
        if (Array.isArray(ref.activeFriends) === false || !this.appInit) {
            return;
        }
        for (var userId of ref.activeFriends) {
            if (this.pendingActiveFriends.has(userId)) {
                continue;
            }
            var user = api.userMap.get(userId);
            if (typeof user !== 'undefined' && user.status !== 'offline') {
                continue;
            }
            if (this.pendingActiveFriends.size >= 5) {
                break;
            }
            this.fetchActiveFriend(userId);
        }
    };

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
                API.deleteFriend(id);
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
            no: ++API.friendsNo,
            memo: this.loadMemo(id)
        };
        if (typeof ref === 'undefined') {
            ref = this.friendLog[id];
            if (typeof ref !== 'undefined' && ref.displayName) {
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
        if (typeof ctx === 'undefined') {
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
                        API.getUser({
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
            if (typeof ref !== 'undefined' && ctx.name !== ref.displayName) {
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
                typeof ref !== 'undefined' &&
                ref.location !== '' &&
                ref.location !== 'offline' &&
                ref.location !== 'private'
            ) {
                API.getUser({
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
            if (
                typeof ref !== 'undefined' &&
                typeof ref.location !== 'undefined'
            ) {
                var {location, $location_at} = ref;
            }
            var args = await API.getUser({
                userId: id
            }).catch((err) => {
                this.updateFriendInProgress.remove(id);
            });
            if (
                typeof args !== 'undefined' &&
                typeof args.ref !== 'undefined'
            ) {
                newState = args.ref.state;
                ctx.ref = args.ref;
            }
            if (ctx.state !== newState) {
                if (
                    typeof ctx.ref.$offline_for !== 'undefined' &&
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
            typeof ctx.ref !== 'undefined' &&
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
        if (typeof user !== 'undefined') {
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
                    API.deleteFriend({
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
                if (typeof ctx.ref === 'undefined') {
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
                API.friendsListSearch = value.substr(7);
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
                    if (API.isGameRunning) {
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
        if (typeof ref !== 'undefined') {
            var myLocation = this.lastLocation.location;
            if (ref.location !== myLocation) {
                API.applyUser({
                    id: ref.id,
                    location: myLocation
                });
            }
        }
        if (API.isGameRunning === false || this.lastLocation.location === '') {
            Discord.SetActive(false);
            return;
        }
        if (this.lastLocation.location !== this.lastLocation$.tag) {
            var L = API.parseLocation(this.lastLocation.location);
            L.worldName = L.worldId;
            this.lastLocation$ = L;
            if (L.worldId) {
                var ref = api.worldMap.get(L.worldId);
                if (ref) {
                    L.worldName = ref.name;
                } else {
                    api.getWorld({
                        worldId: L.worldId
                    }).then((args) => {
                        L.worldName = args.ref.name;
                        return args;
                    });
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
            Discord.SetText(
                LL.worldName,
                `#${LL.instanceName} ${LL.accessType}`
            );
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
        API.isSearchUserLoading = true;
        await API.getUsers(params)
            .finally(() => {
                API.isSearchUserLoading = false;
            })
            .then((args) => {
                var map = new Map();
                for (var json of args.json) {
                    var ref = api.userMap.get(json.id);
                    if (typeof ref !== 'undefined') {
                        map.set(ref.id, ref);
                    }
                }
                this.searchUserResults = Array.from(map.values());
                return args;
            });
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

    $app.methods.moreSearchWorld = function(go) {
        var params = this.searchWorldParams;
        if (go) {
            params.offset += params.n * go;
            if (params.offset < 0) {
                params.offset = 0;
            }
        }
        API.isSearchWorldLoading = true;
        api.getWorlds(params, this.searchWorldOption)
            .finally(() => {
                API.isSearchWorldLoading = false;
            })
            .then((args) => {
                var map = new Map();
                for (var json of args.json) {
                    var ref = api.worldMap.get(json.id);
                    if (typeof ref !== 'undefined') {
                        map.set(ref.id, ref);
                    }
                }
                this.searchWorldResults = Array.from(map.values());
                return args;
            });
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

    $app.methods.moreSearchAvatar = function(go) {
        var params = this.searchAvatarParams;
        if (go) {
            params.offset += params.n * go;
            if (params.offset < 0) {
                params.offset = 0;
            }
        }
        API.isSearchAvatarLoading = true;
        API.getAvatars(params)
            .finally(() => {
                API.isSearchAvatarLoading = false;
            })
            .then((args) => {
                var map = new Map();
                for (var json of args.json) {
                    var ref = API.cachedAvatars.get(json.id);
                    if (typeof ref !== 'undefined') {
                        map.set(ref.id, ref);
                    }
                }
                this.searchAvatarResults = Array.from(map.values());
                return args;
            });
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
        if (typeof favorite !== 'undefined') {
            var isTypeChanged = false;
            if (typeof ctx === 'undefined') {
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
                    if (typeof ref === 'undefined') {
                        ref = this.friendLog[objectId];
                        if (typeof ref !== 'undefined' && ref.displayName) {
                            ctx.name = ref.displayName;
                        }
                    } else {
                        ctx.ref = ref;
                        ctx.name = ref.displayName;
                    }
                } else if (type === 'world') {
                    var ref = api.worldMap.get(objectId);
                    if (typeof ref !== 'undefined') {
                        ctx.ref = ref;
                        ctx.name = ref.name;
                    }
                } else if (type === 'avatar') {
                    var ref = API.cachedAvatars.get(objectId);
                    if (typeof ref !== 'undefined') {
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
                    if (typeof ref !== 'undefined') {
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
                    if (typeof ref !== 'undefined') {
                        if (ctx.ref !== ref) {
                            ctx.ref = ref;
                        }
                        if (ctx.name !== ref.name) {
                            ctx.name = ref.name;
                            this.sortFavoriteWorlds = true;
                        }
                    }
                } else if (type === 'avatar') {
                    var ref = API.cachedAvatars.get(objectId);
                    if (typeof ref !== 'undefined') {
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
        } else if (typeof ctx !== 'undefined') {
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
                    API.deleteFavorite({
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
            callback: (action, instance) => {
                if (action === 'confirm') {
                    API.saveFavoriteGroup({
                        type: ctx.type,
                        group: ctx.name,
                        displayName: instance.inputValue
                    }).then((args) => {
                        this.$message({
                            message: 'Group renamed',
                            type: 'success'
                        });
                        return args;
                    });
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
                    API.clearFavoriteGroup({
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
        if (typeof ref === 'undefined') {
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
        if (typeof ref === 'undefined') {
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
                if (typeof user !== 'undefined') {
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
        if (typeof this.friendLog[id] !== 'undefined') {
            return;
        }
        var ctx = {
            id,
            displayName: null,
            trustLevel: null
        };
        Vue.set(this.friendLog, id, ctx);
        var ref = api.userMap.get(id);
        if (typeof ref !== 'undefined') {
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
        if (typeof ctx === 'undefined') {
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
                API.deleteFriendship(id);
            }
        }
    };

    $app.methods.updateFriendship = function(ref) {
        var ctx = this.friendLog[ref.id];
        if (typeof ctx === 'undefined') {
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
                    API.deletePlayerModeration({
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
                    API.acceptNotification({
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
                    API.hideNotification({
                        notificationId: row.id
                    });
                }
            }
        });
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
    $app.data.isDarkMode = configRepository.getBool('isDarkMode');
    if ($app.data.isDarkMode === true) {
        document.getElementsByTagName('body')[0].classList.add('dark');
    }
    $app.watch.isDarkMode = function() {
        configRepository.setBool('isDarkMode', API.isDarkMode);
        if ($app.data.isDarkMode === true) {
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
            API.isStartAtWindowsStartup
        );
        VRCXStorage.Set(
            'VRCX_StartAsMinimizedState',
            API.isStartAsMinimizedState.toString()
        );
        configRepository.setBool('VRCX_CloseToTray', API.isCloseToTray);
        AppApi.SetStartup(API.isStartAtWindowsStartup);
        configRepository.setBool('VRCX_AutoLogin', API.isAutoLogin);
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
        sharedRepository.setBool('is_game_running', API.isGameRunning);
        this.lastLocation = {
            date: 0,
            location: '',
            name: '',
            playerList: [],
            friendList: []
        };
        if (API.isGameRunning) {
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
        sharedRepository.setBool('is_Game_No_VR', API.isGameNoVR);
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
        $app.visits = args.json;
    });

    $app.methods.logout = function() {
        this.$confirm('Continue? Logout', 'Confirm', {
            confirmButtonText: 'Confirm',
            cancelButtonText: 'Cancel',
            type: 'info',
            callback: (action) => {
                if (action === 'confirm') {
                    API.logout();
                }
            }
        });
    };

    $app.methods.resetHome = function() {
        this.$confirm('Continue? Reset Home', 'Confirm', {
            confirmButtonText: 'Confirm',
            cancelButtonText: 'Cancel',
            type: 'info',
            callback: (action) => {
                if (action === 'confirm') {
                    API.saveCurrentUser({
                        homeLocation: ''
                    }).then((args) => {
                        this.$message({
                            message: 'Home world has been reset',
                            type: 'success'
                        });
                        return args;
                    });
                }
            }
        });
    };

    $app.methods.updateOpenVR = function() {
        if (
            this.openVR &&
            API.isGameNoVR === false &&
            (API.isGameRunning || this.openVRAlways)
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
                        var worldInstance = API.parseLocationUrl(
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
            callback: (action, instance) => {
                if (action === 'confirm' && instance.inputValue) {
                    API.selectAvatar({
                        avatarId: instance.inputValue
                    }).then((args) => {
                        this.$message({
                            message: 'Avatar changed',
                            type: 'success'
                        });
                        return args;
                    });
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
            callback: (action, instance) => {
                if (
                    action === 'confirm' &&
                    instance.inputValue !== avatar.ref.name
                ) {
                    API.saveAvatar({
                        id: avatar.id,
                        name: instance.inputValue
                    }).then((args) => {
                        this.$message({
                            message: 'Avatar renamed',
                            type: 'success'
                        });
                        return args;
                    });
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
            callback: (action, instance) => {
                if (
                    action === 'confirm' &&
                    instance.inputValue !== avatar.ref.description
                ) {
                    API.saveAvatar({
                        id: avatar.id,
                        description: instance.inputValue
                    }).then((args) => {
                        this.$message({
                            message: 'Avatar description changed',
                            type: 'success'
                        });
                        return args;
                    });
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
            callback: (action, instance) => {
                if (
                    action === 'confirm' &&
                    instance.inputValue !== world.ref.name
                ) {
                    API.saveWorld({
                        id: world.id,
                        name: instance.inputValue
                    }).then((args) => {
                        this.$message({
                            message: 'World renamed',
                            type: 'success'
                        });
                        return args;
                    });
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
            callback: (action, instance) => {
                if (
                    action === 'confirm' &&
                    instance.inputValue !== world.ref.description
                ) {
                    API.saveWorld({
                        id: world.id,
                        description: instance.inputValue
                    }).then((args) => {
                        this.$message({
                            message: 'World description changed',
                            type: 'success'
                        });
                        return args;
                    });
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
                    if (API.cachedAvatars.has(instance.inputValue)) {
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
            typeof ref === 'undefined' ||
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

    $app.methods.showUserDialog = function(userId) {
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
        API.getCachedUser({
            userId
        })
            .catch((err) => {
                D.loading = false;
                D.visible = false;
                throw err;
            })
            .then((args) => {
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
                    API.getFriendStatus({
                        userId: D.id
                    });
                    if (args.cache) {
                        API.getUser(args.params);
                    }
                    this.getAvatarName(args);
                    var L = API.parseLocation(D.ref.location);
                    if (L.worldId && this.lastLocation.location !== L.tag) {
                        API.getInstance({
                            worldId: L.worldId,
                            instanceId: L.instanceId
                        });
                    }
                }
                return args;
            });
    };

    $app.methods.applyUserDialogLocation = function() {
        var D = this.userDialog;
        var L = API.parseLocation(D.ref.location);
        D.$location = L;
        if (L.userId) {
            var ref = api.userMap.get(L.userId);
            if (typeof ref === 'undefined') {
                API.getUser({
                    userId: L.userId
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
            this.lastLocation.location === L.tag &&
            playersInInstance.length > 0
        ) {
            var ref = api.userMap.get(api.currentUser.id);
            if (typeof ref === 'undefined') {
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
        } else {
            if (L.isOffline === false) {
                for (var {ref} of this.friends.values()) {
                    if (typeof ref !== 'undefined' && ref.location === L.tag) {
                        if (
                            ref.state === 'active' &&
                            ref.location === 'private'
                        ) {
                            continue;
                        }
                        users.push(ref);
                    }
                }
            }
        }
        users.sort(compareByDisplayName);
        D.users = users;
        if (!L.worldId) {
            return;
        }
        if (this.lastLocation.location === L.tag) {
            D.instance = {
                id: L.tag,
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
        for (var ref of API.cachedAvatars.values()) {
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
            for (var ref of API.cachedAvatars.values()) {
                if (ref.authorId === D.id) {
                    API.cachedAvatars.delete(ref.id);
                }
            }
            var map = new Map();
            for (var offset = 0; ; offset += 100) {
                var {json} = await API.getAvatars({
                    n: 100,
                    offset,
                    ...params
                });
                if (json === void 0 || json.length === 0) {
                    break;
                }
                for (var apiAvatar of json) {
                    var $ref = API.cachedAvatars.get(apiAvatar.id);
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
                API.deleteFavorite({
                    objectId: userId
                });
                break;
            case 'Accept Friend Request':
                var key = API.getFriendRequest(userId);
                if (key === '') {
                    API.sendFriendRequest({
                        userId
                    });
                } else {
                    API.acceptNotification({
                        notificationId: key
                    });
                }
                break;
            case 'Decline Friend Request':
                var key = API.getFriendRequest(userId);
                if (key === '') {
                    API.cancelFriendRequest({
                        userId
                    });
                } else {
                    API.hideNotification({
                        notificationId: key
                    });
                }
                break;
            case 'Cancel Friend Request':
                API.cancelFriendRequest({
                    userId
                });
                break;
            case 'Send Friend Request':
                API.sendFriendRequest({
                    userId
                });
                break;
            case 'Unblock':
                API.deletePlayerModeration({
                    moderated: userId,
                    type: 'block'
                });
                break;
            case 'Block':
                API.sendPlayerModeration({
                    moderated: userId,
                    type: 'block'
                });
                break;
            case 'Unmute':
                API.deletePlayerModeration({
                    moderated: userId,
                    type: 'mute'
                });
                break;
            case 'Mute':
                API.sendPlayerModeration({
                    moderated: userId,
                    type: 'mute'
                });
                break;
            case 'Show Avatar':
                API.deletePlayerModeration({
                    moderated: userId,
                    type: 'hideAvatar'
                });
                break;
            case 'Hide Avatar':
                API.sendPlayerModeration({
                    moderated: userId,
                    type: 'hideAvatar'
                });
                break;
            case 'Unfriend':
                API.deleteFriend({
                    userId
                });
                break;
            default:
                break;
        }
    };

    $app.methods.userDialogCommand = function(command) {
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
            API.sendRequestInvite(D.id, {
                platform: 'standalonewindows'
            }).then((args) => {
                this.$message('Request invite sent');
                return args;
            });
        } else if (command === 'Invite Message') {
            var L = API.parseLocation(this.lastLocation.location);
            api.getCachedWorld({
                worldId: L.worldId
            }).then((args) => {
                this.showSendInviteDialog(
                    {
                        instanceId: this.lastLocation.location,
                        worldId: this.lastLocation.location,
                        worldName: args.ref.name
                    },
                    D.id
                );
            });
        } else if (command === 'Request Invite Message') {
            this.showSendInviteRequestDialog(
                {
                    platform: 'standalonewindows'
                },
                D.id
            );
        } else if (command === 'Invite') {
            var L = API.parseLocation(this.lastLocation.location);
            api.getCachedWorld({
                worldId: L.worldId
            }).then((args) => {
                api.sendInvite(D.id, {
                    instanceId: this.lastLocation.location,
                    worldId: this.lastLocation.location,
                    worldName: args.ref.name
                }).then((_args) => {
                    this.$message('Invite sent');
                    return _args;
                });
            });
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

    pubsub.subscribe('WORLD', function(args) {
        var {ref} = args;
        var D = $app.worldDialog;
        if (D.visible === false || D.id !== ref.id) {
            return;
        }
        D.ref = ref;
        $app.applyWorldDialogInstances();
        if (D.fileSize === 'Loading') {
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
            if (fileId) {
                API.getBundles(fileId).then((args) => {
                    var {versions} = args.json;
                    var ctx = '';
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
                });
            }
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

    $app.methods.showWorldDialog = function(tag) {
        this.$nextTick(() => adjustDialogZ(this.$refs.worldDialog.$el));
        var D = this.worldDialog;
        var L = API.parseLocation(tag);
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
        api.getCachedWorld({
            worldId: L.worldId
        })
            .catch((err) => {
                D.loading = false;
                D.visible = false;
                throw err;
            })
            .then((args) => {
                if (D.id === args.ref.id) {
                    D.loading = false;
                    D.ref = args.ref;
                    D.isFavorite = api.favoriteMapByObjectId.has(D.id);
                    D.rooms = [];
                    this.updateVRChatCache();
                    this.applyWorldDialogInstances();
                    if (args.cache) {
                        api.getWorld(args.params);
                    }
                }
                return args;
            });
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
        if (instanceId && typeof instances[instanceId] === 'undefined') {
            instances[instanceId] = {
                id: instanceId,
                occupants: 0,
                users: []
            };
        }
        var lastLocation$ = API.parseLocation(this.lastLocation.location);
        var playersInInstance = this.lastLocation.playerList;
        if (lastLocation$.worldId === D.id && playersInInstance.length > 0) {
            var instance = instances[lastLocation$.instanceId];
            if (typeof instance === 'undefined') {
                instance = {
                    id: lastLocation$.instanceId,
                    occupants: 1,
                    users: []
                };
                instances[instance.id] = instance;
            }
            instances[instance.id].occupants = playersInInstance.length;
            var ref = api.userMap.get(api.currentUser.id);
            if (typeof ref === 'undefined') {
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
                typeof ref === 'undefined' ||
                typeof ref.$location === 'undefined' ||
                ref.$location.worldId !== D.id ||
                ref.$location.instanceId === lastLocation$.instanceId
            ) {
                continue;
            }
            var {instanceId} = ref.$location;
            var instance = instances[instanceId];
            if (typeof instance === 'undefined') {
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
            // due to references on callback of API.getUser()
            // this should be block scope variable
            const L = API.parseLocation(`${D.id}:${instance.id}`);
            instance.location = L.tag;
            instance.$location = L;
            if (L.userId) {
                var ref = api.userMap.get(L.userId);
                if (typeof ref === 'undefined') {
                    API.getUser({
                        userId: L.userId
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

    $app.methods.worldDialogCommand = function(command) {
        var D = this.worldDialog;
        if (D.visible === false) {
            return;
        }
        switch (command) {
            case 'Refresh':
                D.loading = true;
                api.getWorld({
                    worldId: D.id
                })
                    .catch((err) => {
                        D.loading = false;
                        D.visible = false;
                        throw err;
                    })
                    .then((args) => {
                        if (D.id === args.ref.id) {
                            D.loading = false;
                            D.ref = args.ref;
                            D.isFavorite = api.favoriteMapByObjectId.has(D.id);
                            D.rooms = [];
                            this.applyWorldDialogInstances();
                            if (args.cache) {
                                api.getWorld(args.params);
                            }
                        }
                        return args;
                    });
                break;
            case 'New Instance':
                this.showNewInstanceDialog(D.$location.tag);
                break;
            case 'Add Favorite':
                this.showFavoriteDialog('world', D.id);
                break;
            case 'Rename':
                this.promptRenameWorld(D);
                break;
            case 'Change Image':
                this.displayPreviousImages('World', 'Change');
                break;
            case 'Previous Images':
                this.displayPreviousImages('World', 'Display');
                break;
            case 'Change Description':
                this.promptChangeWorldDescription(D);
                break;
            default:
                this.$confirm(`Continue? ${command}`, 'Confirm', {
                    confirmButtonText: 'Confirm',
                    cancelButtonText: 'Cancel',
                    type: 'info',
                    callback: (action) => {
                        if (action !== 'confirm') {
                            return;
                        }
                        switch (command) {
                            case 'Delete Favorite':
                                API.deleteFavorite({
                                    objectId: D.id
                                });
                                break;
                            case 'Make Home':
                                API.saveCurrentUser({
                                    homeLocation: D.id
                                }).then((args) => {
                                    this.$message({
                                        message: 'Home world updated',
                                        type: 'success'
                                    });
                                    return args;
                                });
                                break;
                            case 'Reset Home':
                                API.saveCurrentUser({
                                    homeLocation: ''
                                }).then((args) => {
                                    this.$message({
                                        message: 'Home world has been reset',
                                        type: 'success'
                                    });
                                    return args;
                                });
                                break;
                            case 'Delete':
                                API.deleteWorld({
                                    worldId: D.id
                                }).then((args) => {
                                    this.$message({
                                        message: 'World has been deleted',
                                        type: 'success'
                                    });
                                    D.visible = false;
                                    return args;
                                });
                                break;
                            default:
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

    pubsub.subscribe('AVATAR', function(args) {
        var D = $app.avatarDialog;
        if (D.visible === false || D.id !== args.ref.id) {
            return;
        }
        var {ref} = args;
        D.ref = ref;
        if (D.fileSize === 'Loading') {
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
            if (fileId) {
                API.getBundles(fileId).then((args) => {
                    var {versions} = args.json;
                    var ctx = '';
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
                });
            }
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

    $app.methods.showAvatarDialog = function(avatarId) {
        this.$nextTick(() => adjustDialogZ(this.$refs.avatarDialog.$el));
        var D = this.avatarDialog;
        D.id = avatarId;
        var ref = API.cachedAvatars.get(avatarId);
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
            API.getAvatar({avatarId});
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
                API.getBundles(fileId).then((args) => {
                    var {versions} = args.json;
                    var ctx = '';
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
                });
            } else if (imageId && !D.ref.created_at) {
                if (API.cachedAvatarNames.has(imageId)) {
                    var avatarInfo = API.cachedAvatarNames.get(imageId);
                    D.ref.created_at = avatarInfo.fileCreatedAt;
                } else {
                    API.getAvatarImages({fileId: imageId}).then((args) => {
                        var avatarInfo = this.storeAvatarImage(args);
                        D.ref.created_at = avatarInfo.fileCreatedAt;
                    });
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
                    callback: (action) => {
                        if (action !== 'confirm') {
                            return;
                        }
                        switch (command) {
                            case 'Delete Favorite':
                                API.deleteFavorite({
                                    objectId: D.id
                                });
                                break;
                            case 'Select Avatar':
                                API.selectAvatar({
                                    avatarId: D.id
                                }).then((args) => {
                                    this.$message({
                                        message: 'Avatar changed',
                                        type: 'success'
                                    });
                                    return args;
                                });
                                break;
                            case 'Select Fallback Avatar':
                                API.selectFallbackAvatar({
                                    avatarId: D.id
                                }).then((args) => {
                                    this.$message({
                                        message: 'Fallback avatar changed',
                                        type: 'success'
                                    });
                                    return args;
                                });
                                break;
                            case 'Make Public':
                                API.saveAvatar({
                                    id: D.id,
                                    releaseStatus: 'public'
                                }).then((args) => {
                                    this.$message({
                                        message: 'Avatar updated to public',
                                        type: 'success'
                                    });
                                    return args;
                                });
                                break;
                            case 'Make Private':
                                API.saveAvatar({
                                    id: D.id,
                                    releaseStatus: 'private'
                                }).then((args) => {
                                    this.$message({
                                        message: 'Avatar updated to private',
                                        type: 'success'
                                    });
                                    return args;
                                });
                                break;
                            case 'Delete':
                                API.deleteAvatar({
                                    avatarId: D.id
                                }).then((args) => {
                                    this.$message({
                                        message: 'Avatar deleted',
                                        type: 'success'
                                    });
                                    D.visible = false;
                                    return args;
                                });
                                break;
                            default:
                                break;
                        }
                    }
                });
                break;
        }
    };

    $app.methods.showAvatarAuthorDialog = function(
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
            API.cachedAvatars.has(api.currentUser.currentAvatar)
        ) {
            this.showAvatarDialog(api.currentUser.currentAvatar);
            return;
        }
        for (var ref of API.cachedAvatars.values()) {
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
        } else {
            API.getAvatarImages({fileId}).then((args) => {
                var ownerId = args.json.ownerId;
                if (ownerId === refUserId) {
                    this.$message({
                        message: "It's personal (own) avatar",
                        type: 'warning'
                    });
                    return;
                }
                this.showUserDialog(ownerId);
            });
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

    $app.methods.addFavorite = function(group) {
        var D = this.favoriteDialog;
        D.loading = true;
        API.addFavorite({
            type: D.type,
            favoriteId: D.objectId,
            tags: group.name
        })
            .finally(() => {
                D.loading = false;
            })
            .then((args) => {
                D.visible = false;
                return args;
            });
    };

    $app.methods.addFavoriteAvatar = function(ref, group) {
        API.addFavorite({
            type: 'avatar',
            favoriteId: ref.id,
            tags: group.name
        });
    };

    $app.methods.moveFavorite = function(ref, group, type) {
        API.deleteFavorite({
            objectId: ref.id
        }).then(() => {
            API.addFavorite({
                type,
                favoriteId: ref.id,
                tags: group.name
            });
        });
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
            callback: (action) => {
                var D = this.inviteDialog;
                if (action !== 'confirm' || D.loading === true) {
                    return;
                }
                if (
                    this.api.currentUser.status === 'busy' &&
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
                var inviteLoop = () => {
                    if (D.userIds.length > 0) {
                        var receiverUserId = D.userIds.shift();
                        api.sendInvite(receiverUserId, {
                            instanceId: D.worldId,
                            worldId: D.worldId,
                            worldName: D.worldName
                        }).finally(inviteLoop);
                    } else {
                        D.loading = false;
                        D.visible = false;
                        this.$message({
                            message: 'Invite sent',
                            type: 'success'
                        });
                    }
                };
                inviteLoop();
            }
        });
    };

    $app.methods.showInviteDialog = function(tag) {
        this.$nextTick(() => adjustDialogZ(this.$refs.inviteDialog.$el));
        var L = API.parseLocation(tag);
        if (L.isOffline || L.isPrivate || L.worldId === '') {
            return;
        }
        api.getCachedWorld({
            worldId: L.worldId
        }).then((args) => {
            var D = this.inviteDialog;
            D.userIds = [];
            D.worldId = L.tag;
            D.worldName = args.ref.name;
            D.visible = true;
        });
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

    $app.methods.saveSocialStatus = function() {
        var D = this.socialStatusDialog;
        if (D.loading) {
            return;
        }
        D.loading = true;
        API.saveCurrentUser({
            status: D.status,
            statusDescription: D.statusDescription
        })
            .finally(() => {
                D.loading = false;
            })
            .then((args) => {
                D.visible = false;
                this.$message({
                    message: 'Status updated',
                    type: 'success'
                });
                return args;
            });
    };

    $app.methods.showSocialStatusDialog = function() {
        this.$nextTick(() => adjustDialogZ(this.$refs.socialStatusDialog.$el));
        var D = this.socialStatusDialog;
        var {statusHistory} = API.currentUser;
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
        API.addUserTags({
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
        API.removeUserTags({
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

    $app.methods.saveBio = function() {
        var D = this.bioDialog;
        if (D.loading) {
            return;
        }
        D.loading = true;
        API.saveCurrentUser({
            bio: D.bio,
            bioLinks: D.bioLinks
        })
            .finally(() => {
                D.loading = false;
            })
            .then((args) => {
                D.visible = false;
                this.$message({
                    message: 'Bio updated',
                    type: 'success'
                });
                return args;
            });
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
        var L = API.parseLocation(tag);
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
            callback: (action) => {
                if (action !== 'confirm') {
                    return;
                }
                API.saveCurrentUser({
                    homeLocation: tag
                }).then((args) => {
                    this.$message({
                        message: 'Home world updated',
                        type: 'success'
                    });
                    return args;
                });
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
        var L = API.parseLocation(tag);
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
        var L = API.parseLocation(location);
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

    $app.methods.displayVRCPlusIconsTable = function() {
        var params = {
            n: 50,
            tag: 'icon'
        };
        API.refreshVRCPlusIconsTableData(params);
    };

    API.refreshVRCPlusIconsTableData = function(params) {
        return api
            .legacyApi('files', {
                method: 'GET',
                params
            })
            .then((json) => {
                var args = {
                    json,
                    params
                };
                pubsub.publish('VRCPLUSICON:LIST', args);
                return args;
            });
    };

    pubsub.subscribe('VRCPLUSICON:LIST', function(args) {
        $app.VRCPlusIconsTable = args.json;
    });

    $app.methods.setVRCPlusIcon = function(userIcon) {
        if (userIcon !== '') {
            userIcon = `https://api.vrchat.cloud/api/1/file/${userIcon}/1`;
        }
        API.setVRCPlusIcon({
            userIcon
        }).then((args) => {
            this.$message({
                message: 'Icon changed',
                type: 'success'
            });
            return args;
        });
    };

    API.setVRCPlusIcon = function(params) {
        return api
            .legacyApi(`users/${api.currentUser.id}`, {
                method: 'PUT',
                params
            })
            .then((json) => {
                var args = {
                    json,
                    params
                };
                pubsub.publish('USER:CURRENT:SAVE', args);
                return args;
            });
    };

    $app.methods.deleteVRCPlusIcon = function(userIcon) {
        API.deleteVRCPlusIcon(userIcon).then((args) => {
            pubsub.publish('VRCPLUSICON:DELETE', args);
            return args;
        });
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

    API.deleteVRCPlusIcon = function(userIcon) {
        return api
            .legacyApi(`file/${userIcon}`, {
                method: 'DELETE'
            })
            .then((json) => {
                var args = {
                    json,
                    userIcon
                };
                return args;
            });
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

    $app.methods.onFileChangeVRCPlusIcon = function(e) {
        var clearFile = function() {
            if (document.querySelector('#VRCPlusIconUploadButton')) {
                document.querySelector('#VRCPlusIconUploadButton').value = '';
            }
        };
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
            clearFile();
            return;
        }
        if (!files[0].type.match(/image.*/)) {
            $app.$message({
                message: "File isn't an image",
                type: 'error'
            });
            clearFile();
            return;
        }
        API.uploadVRCPlusIcon(files[0]).then((args) => {
            $app.$message({
                message: 'Icon uploaded',
                type: 'success'
            });
            clearFile();
            return args;
        });
    };

    $app.methods.displayVRCPlusIconUpload = function() {
        document.getElementById('VRCPlusIconUploadButton').click();
    };

    API.uploadVRCPlusIcon = function(image) {
        var formData = new FormData();
        formData.set('image', image);
        return api
            .legacyApi('icon', {
                method: 'POST',
                params: formData
            })
            .then((json) => {
                var args = {
                    json
                };
                pubsub.publish('VRCPLUSICON:ADD', args);
                return args;
            });
    };

    pubsub.subscribe('VRCPLUSICON:ADD', function(args) {
        if (Object.keys($app.VRCPlusIconsTable).length !== 0) {
            $app.VRCPlusIconsTable.push(args.json);
        }
    });

    /** @type {File?} */
    var inviteImageFile = void 0;

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

    $app.methods.clearInviteImageUpload = function() {
        var buttonList = document.querySelectorAll('.inviteImageUploadButton');
        buttonList.forEach((button) => (button.value = ''));
        inviteImageFile = void 0;
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

    API.refreshInviteMessageTableData = function(messageType) {
        return api
            .legacyApi(`message/${api.currentUser.id}/${messageType}`, {
                method: 'GET'
            })
            .then((json) => {
                var args = {
                    json,
                    messageType
                };
                pubsub.publish(`INVITE:${messageType.toUpperCase()}`, args);
                return args;
            });
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

    API.editInviteMessage = function(params, messageType, slot) {
        return api
            .legacyApi(`message/${api.currentUser.id}/${messageType}/${slot}`, {
                method: 'PUT',
                params
            })
            .then((json) => {
                var args = {
                    json,
                    params,
                    messageType,
                    slot
                };
                return args;
            });
    };

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

    $app.methods.saveEditInviteMessage = function() {
        var D = this.editInviteMessageDialog;
        D.visible = false;
        if (D.inviteMessage.message !== D.newMessage) {
            var slot = D.inviteMessage.slot;
            var messageType = D.messageType;
            var params = {
                message: D.newMessage
            };
            API.editInviteMessage(params, messageType, slot)
                .catch((err) => {
                    throw err;
                })
                .then((args) => {
                    pubsub.publish(`INVITE:${messageType.toUpperCase()}`, args);
                    if (args.json[slot].message === D.inviteMessage.message) {
                        this.$message({
                            message:
                                "VRChat API didn't update message, try again",
                            type: 'error'
                        });
                        throw new Error(
                            "VRChat API didn't update message, try again"
                        );
                    } else {
                        this.$message('Invite message updated');
                    }
                    return args;
                });
        }
    };

    $app.methods.cancelEditInviteMessage = function() {
        this.editInviteMessageDialog.visible = false;
    };

    // App: Edit and Send Invite Response Message Dialog

    $app.data.editAndSendInviteResponseDialog = {
        visible: false,
        inviteMessage: {},
        messageType: '',
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
            newMessage: inviteMessage.message,
            visible: true,
            messageType,
            inviteMessage
        };
    };

    $app.methods.saveEditAndSendInviteResponse = async function() {
        var D = this.editAndSendInviteResponseDialog;
        D.visible = false;
        var messageType = D.messageType;
        var slot = D.inviteMessage.slot;
        if (D.inviteMessage.message !== D.newMessage) {
            var params = {
                message: D.newMessage
            };
            await API.editInviteMessage(params, messageType, slot)
                .catch((err) => {
                    throw err;
                })
                .then((args) => {
                    pubsub.publish(`INVITE:${messageType.toUpperCase()}`, args);
                    if (args.json[slot].message === D.inviteMessage.message) {
                        this.$message({
                            message:
                                "VRChat API didn't update message, try again",
                            type: 'error'
                        });
                        throw new Error(
                            "VRChat API didn't update message, try again"
                        );
                    } else {
                        this.$message('Invite message updated');
                    }
                    return args;
                });
        }
        var I = this.sendInviteResponseDialog;
        var params = {
            responseSlot: slot,
            rsvp: true
        };
        if (inviteImageFile) {
            API.sendInviteResponsePhoto(I.invite.id, params)
                .catch((err) => {
                    throw err;
                })
                .then((args) => {
                    API.hideNotification({
                        notificationId: I.invite.id
                    });
                    this.$message({
                        message: 'Invite response message sent',
                        type: 'success'
                    });
                    this.sendInviteResponseDialogVisible = false;
                    this.sendInviteRequestResponseDialogVisible = false;
                    return args;
                });
        } else {
            API.sendInviteResponse(I.invite.id, params)
                .catch((err) => {
                    throw err;
                })
                .then((args) => {
                    API.hideNotification({
                        notificationId: I.invite.id
                    });
                    this.$message({
                        message: 'Invite response message sent',
                        type: 'success'
                    });
                    this.sendInviteResponseDialogVisible = false;
                    this.sendInviteRequestResponseDialogVisible = false;
                    return args;
                });
        }
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

    $app.methods.sendInviteResponseConfirm = function() {
        var D = this.sendInviteResponseDialog;
        var params = {
            responseSlot: D.messageSlot,
            rsvp: true
        };
        if (inviteImageFile) {
            params.image = inviteImageFile;
            API.sendInviteResponsePhoto(D.invite.id, params)
                .catch((err) => {
                    throw err;
                })
                .then((args) => {
                    API.hideNotification({
                        notificationId: D.invite.id
                    });
                    this.$message({
                        message: 'Invite response photo message sent',
                        type: 'success'
                    });
                    return args;
                });
        } else {
            API.sendInviteResponse(D.invite.id, params)
                .catch((err) => {
                    throw err;
                })
                .then((args) => {
                    API.hideNotification({
                        notificationId: D.invite.id
                    });
                    this.$message({
                        message: 'Invite response message sent',
                        type: 'success'
                    });
                    return args;
                });
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
        newMessage: '',
        inviteMessage: {}
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
            newMessage: inviteMessage.message,
            inviteMessage
        };
    };

    // NEED TO BE CLEANED UP
    $app.methods.saveEditAndSendInvite = async function() {
        var D = this.editAndSendInviteDialog;
        D.visible = false;
        var messageType = D.messageType;
        var slot = D.inviteMessage.slot;
        if (D.inviteMessage.message !== D.newMessage) {
            var params = {
                message: D.newMessage
            };
            await API.editInviteMessage(params, messageType, slot)
                .catch((err) => {
                    throw err;
                })
                .then((args) => {
                    pubsub.publish(`INVITE:${messageType.toUpperCase()}`, args);
                    if (args.json[slot].message === D.inviteMessage.message) {
                        this.$message({
                            message:
                                "VRChat API didn't update message, try again",
                            type: 'error'
                        });
                        throw new Error(
                            "VRChat API didn't update message, try again"
                        );
                    } else {
                        this.$message('Invite message updated');
                    }
                    return args;
                });
        }
        var I = this.sendInviteDialog;
        var J = this.inviteDialog;
        if (J.visible) {
            if (
                this.api.currentUser.status === 'busy' &&
                J.userIds.includes(this.api.currentUser.id) === true
            ) {
                this.$message({
                    message:
                        "You can't invite yourself in 'Do Not Disturb' mode",
                    type: 'error'
                });
                return;
            }
            var inviteLoop = () => {
                if (J.userIds.length > 0) {
                    var receiverUserId = J.userIds.shift();
                    if (inviteImageFile !== void 0) {
                        API.sendInvitePhoto(receiverUserId, {
                            instanceId: J.worldId,
                            worldId: J.worldId,
                            worldName: J.worldName,
                            messageSlot: slot,
                            image: inviteImageFile
                        }).finally(inviteLoop);
                    } else {
                        api.sendInvite(receiverUserId, {
                            instanceId: J.worldId,
                            worldId: J.worldId,
                            worldName: J.worldName,
                            messageSlot: slot
                        }).finally(inviteLoop);
                    }
                } else {
                    J.loading = false;
                    J.visible = false;
                    this.$message({
                        message: 'Invite message sent',
                        type: 'success'
                    });
                }
            };
            inviteLoop();
        } else {
            if (I.messageType === 'invite') {
                I.params.messageSlot = slot;
                if (inviteImageFile !== void 0) {
                    I.params.image = inviteImageFile;
                    API.sendInvitePhoto(I.userId, I.params)
                        .catch((err) => {
                            throw err;
                        })
                        .then((args) => {
                            this.$message({
                                message: 'Invite photo message sent',
                                type: 'success'
                            });
                            return args;
                        });
                } else {
                    I.params.image = void 0;
                    api.sendInvite(I.userId, I.params)
                        .catch((err) => {
                            throw err;
                        })
                        .then((args) => {
                            this.$message({
                                message: 'Invite message sent',
                                type: 'success'
                            });
                            return args;
                        });
                }
            } else if (I.messageType === 'requestInvite') {
                I.params.requestSlot = slot;
                if (inviteImageFile) {
                    I.params.image = inviteImageFile;
                    API.sendRequestInvitePhoto(I.userId, I.params)
                        .catch((err) => {
                            this.clearInviteImageUpload();
                            throw err;
                        })
                        .then((args) => {
                            this.$message({
                                message: 'Request invite photo message sent',
                                type: 'success'
                            });
                            return args;
                        });
                } else {
                    I.params.image = void 0;
                    API.sendRequestInvite(I.userId, I.params)
                        .catch((err) => {
                            throw err;
                        })
                        .then((args) => {
                            this.$message({
                                message: 'Request invite message sent',
                                type: 'success'
                            });
                            return args;
                        });
                }
            }
        }
        this.sendInviteDialogVisible = false;
        this.sendInviteRequestDialogVisible = false;
    };

    $app.methods.cancelEditAndSendInvite = function() {
        this.editAndSendInviteDialog.visible = false;
    };

    $app.data.sendInviteDialog = {
        message: '',
        messageSlot: 0,
        userId: '',
        messageType: '',
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

    $app.methods.showSendInviteDialog = function(params, userId) {
        this.sendInviteDialog = {
            params,
            userId,
            messageType: 'invite'
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

    $app.methods.sendInviteConfirm = function() {
        if (this.api.currentUser.status === 'busy') {
            this.$message({
                message: "You can't invite yourself in 'Do Not Disturb' mode",
                type: 'error'
            });
            return;
        }
        var D = this.sendInviteDialog;
        var J = this.inviteDialog;
        if (J.visible) {
            var inviteLoop = () => {
                if (J.userIds.length > 0) {
                    var receiverUserId = J.userIds.shift();
                    if (inviteImageFile) {
                        API.sendInvitePhoto(receiverUserId, {
                            instanceId: J.worldId,
                            worldId: J.worldId,
                            worldName: J.worldName,
                            messageSlot: D.messageSlot,
                            image: inviteImageFile
                        }).finally(inviteLoop);
                    } else {
                        api.sendInvite(receiverUserId, {
                            instanceId: J.worldId,
                            worldId: J.worldId,
                            worldName: J.worldName,
                            messageSlot: D.messageSlot
                        }).finally(inviteLoop);
                    }
                } else {
                    J.loading = false;
                    J.visible = false;
                    this.$message({
                        message: 'Invite message sent',
                        type: 'success'
                    });
                }
            };
            inviteLoop();
        } else if (D.messageType === 'invite') {
            if (inviteImageFile) {
                D.params.image = inviteImageFile;
                API.sendInvitePhoto(D.userId, D.params)
                    .catch((err) => {
                        throw err;
                    })
                    .then((args) => {
                        this.$message({
                            message: 'Invite photo message sent',
                            type: 'success'
                        });
                        return args;
                    });
            } else {
                D.params.image = void 0;
                api.sendInvite(D.userId, D.params)
                    .catch((err) => {
                        throw err;
                    })
                    .then((args) => {
                        this.$message({
                            message: 'Invite message sent',
                            type: 'success'
                        });
                        return args;
                    });
            }
        } else if (D.messageType === 'requestInvite') {
            D.params.requestSlot = D.messageSlot;
            if (inviteImageFile) {
                D.params.image = inviteImageFile;
                API.sendRequestInvitePhoto(D.userId, D.params)
                    .catch((err) => {
                        this.clearInviteImageUpload();
                        throw err;
                    })
                    .then((args) => {
                        this.$message({
                            message: 'Request invite photo message sent',
                            type: 'success'
                        });
                        return args;
                    });
            } else {
                D.params.image = void 0;
                API.sendRequestInvite(D.userId, D.params)
                    .catch((err) => {
                        throw err;
                    })
                    .then((args) => {
                        this.$message({
                            message: 'Request invite message sent',
                            type: 'success'
                        });
                        return args;
                    });
            }
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
        var filters = API.friendsListSearchFilters;
        var results = [];
        if (API.friendsListSearch) {
            var query = API.friendsListSearch.toUpperCase();
        }
        for (var ctx of this.friends.values()) {
            if (typeof ctx.ref === 'undefined') {
                continue;
            }
            if (API.friendsListSearchFilterVIP && !ctx.isVIP) {
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
        API.friendsListTable.data = results;
    };

    $app.watch.friendsListSearch = $app.methods.friendsListSearchChange;
    $app.data.friendsListLoading = false;
    $app.data.friendsListLoadingProgress = '';

    $app.methods.friendsListLoadUsers = async function() {
        API.friendsListLoading = true;
        var i = 0;
        var toFetch = [];
        for (var ctx of this.friends.values()) {
            if (ctx.ref && !ctx.ref.date_joined) {
                toFetch.push(ctx.id);
            }
        }
        var length = toFetch.length;
        for (var userId of toFetch) {
            if (!API.friendsListLoading) {
                API.friendsListLoadingProgress = '';
                return;
            }
            i++;
            API.friendsListLoadingProgress = `${i}/${length}`;
            await API.getUser({
                userId: userId
            });
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        API.friendsListLoadingProgress = '';
        API.friendsListLoading = false;
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

    function base64ToBufferAsync(base64) {
        var dataUrl = 'data:application/octet-binary;base64,' + base64;

        fetch(dataUrl)
            .then((res) => res.arrayBuffer())
            .then((buffer) => {
                console.log('base64 to buffer: ' + new Uint8Array(buffer));
            });
    }

    // Upload avatar image

    $app.methods.onFileChangeAvatarImage = function(e) {
        var clearFile = function() {
            if (document.querySelector('#AvatarImageUploadButton')) {
                document.querySelector('#AvatarImageUploadButton').value = '';
            }
        };
        var files = e.target.files || e.dataTransfer.files;
        if (
            !files.length ||
            !this.avatarDialog.visible ||
            this.avatarDialog.loading
        ) {
            clearFile();
            return;
        }
        if (files[0].size >= 10000000) {
            //10MB
            $app.$message({
                message: 'File size too large',
                type: 'error'
            });
            clearFile();
            return;
        }
        if (!files[0].type.match(/image.png/)) {
            $app.$message({
                message: "File isn't a png",
                type: 'error'
            });
            clearFile();
            return;
        }
        this.avatarDialog.loading = true;
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
            var {imageUrl} = $app.avatarDialog.ref;
            var fileId = extractFileId(imageUrl);
            if (!fileId) {
                $app.$message({
                    message: 'Current avatar image invalid',
                    type: 'error'
                });
                clearFile();
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
            API.uploadAvatarImage(params, fileId);
        };
        r.readAsBinaryString(files[0]);
        clearFile();
    };

    API.uploadAvatarImage = async function(params, fileId) {
        try {
            return await api
                .legacyApi(`file/${fileId}`, {
                    method: 'POST',
                    params
                })
                .then((json) => {
                    var args = {
                        json,
                        params
                    };
                    pubsub.publish('AVATARIMAGE:INIT', args);
                    return args;
                });
        } catch (err) {
            console.error(err);
            API.uploadAvatarFailCleanup(fileId);
        }
    };

    API.uploadAvatarFailCleanup = async function(fileId) {
        var json = await api
            .legacyApi(`file/${fileId}`, {
                method: 'GET'
            })
            .then((json) => {
                return json;
            });
        var fileId = json.id;
        var fileVersion = json.versions[json.versions.length - 1].version;
        api.legacyApi(`file/${fileId}/${fileVersion}/signature/finish`, {
            method: 'PUT'
        });
        api.legacyApi(`file/${fileId}/${fileVersion}/file/finish`, {
            method: 'PUT'
        });
        $app.avatarDialog.loading = false;
    };

    pubsub.subscribe('AVATARIMAGE:INIT', function(args) {
        var fileId = args.json.id;
        var fileVersion =
            args.json.versions[args.json.versions.length - 1].version;
        var params = {
            fileId,
            fileVersion
        };
        API.uploadAvatarImageFileStart(params);
    });

    API.uploadAvatarImageFileStart = async function(params) {
        try {
            return await api
                .legacyApi(
                    `file/${params.fileId}/${params.fileVersion}/file/start`,
                    {
                        method: 'PUT'
                    }
                )
                .then((json) => {
                    var args = {
                        json,
                        params
                    };
                    pubsub.publish('AVATARIMAGE:FILESTART', args);
                    return args;
                });
        } catch (err) {
            console.error(err);
            API.uploadAvatarFailCleanup(params.fileId);
        }
    };

    pubsub.subscribe('AVATARIMAGE:FILESTART', function(args) {
        var {url} = args.json;
        var {fileId, fileVersion} = args.params;
        var params = {
            url,
            fileId,
            fileVersion
        };
        API.uploadAvatarImageFileAWS(params);
    });

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

    pubsub.subscribe('AVATARIMAGE:FILEAWS', function(args) {
        var {fileId, fileVersion} = args.params;
        var params = {
            fileId,
            fileVersion
        };
        API.uploadAvatarImageFileFinish(params);
    });

    API.uploadAvatarImageFileFinish = function(params) {
        return api
            .legacyApi(
                `file/${params.fileId}/${params.fileVersion}/file/finish`,
                {
                    method: 'PUT',
                    params: {
                        maxParts: 0,
                        nextPartNumber: 0
                    }
                }
            )
            .then((json) => {
                var args = {
                    json,
                    params
                };
                pubsub.publish('AVATARIMAGE:FILEFINISH', args);
                return args;
            });
    };

    pubsub.subscribe('AVATARIMAGE:FILEFINISH', function(args) {
        var {fileId, fileVersion} = args.params;
        var params = {
            fileId,
            fileVersion
        };
        API.uploadAvatarImageSigStart(params);
    });

    API.uploadAvatarImageSigStart = async function(params) {
        try {
            return await api
                .legacyApi(
                    `file/${params.fileId}/${params.fileVersion}/signature/start`,
                    {
                        method: 'PUT'
                    }
                )
                .then((json) => {
                    var args = {
                        json,
                        params
                    };
                    pubsub.publish('AVATARIMAGE:SIGSTART', args);
                    return args;
                });
        } catch (err) {
            console.error(err);
            API.uploadAvatarFailCleanup(params.fileId);
        }
    };

    pubsub.subscribe('AVATARIMAGE:SIGSTART', function(args) {
        var {url} = args.json;
        var {fileId, fileVersion} = args.params;
        var params = {
            url,
            fileId,
            fileVersion
        };
        API.uploadAvatarImageSigAWS(params);
    });

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

    pubsub.subscribe('AVATARIMAGE:SIGAWS', function(args) {
        var {fileId, fileVersion} = args.params;
        var params = {
            fileId,
            fileVersion
        };
        API.uploadAvatarImageSigFinish(params);
    });

    API.uploadAvatarImageSigFinish = function(params) {
        return api
            .legacyApi(
                `file/${params.fileId}/${params.fileVersion}/signature/finish`,
                {
                    method: 'PUT',
                    params: {
                        maxParts: 0,
                        nextPartNumber: 0
                    }
                }
            )
            .then((json) => {
                var args = {
                    json,
                    params
                };
                pubsub.publish('AVATARIMAGE:SIGFINISH', args);
                return args;
            });
    };

    pubsub.subscribe('AVATARIMAGE:SIGFINISH', function(args) {
        var {fileId, fileVersion} = args.params;
        var parmas = {
            id: $app.avatarImage.avatarId,
            imageUrl: `https://api.vrchat.cloud/api/1/file/${fileId}/${fileVersion}/file`
        };
        API.setAvatarImage(parmas);
    });

    API.setAvatarImage = function(params) {
        return api
            .legacyApi(`avatars/${params.id}`, {
                method: 'PUT',
                params
            })
            .then((json) => {
                var args = {
                    json,
                    params
                };
                pubsub.publish('AVATARIMAGE:SET', args);
                pubsub.publish('AVATAR', args);
                return args;
            });
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

    API.setWorldImage = function(params) {
        return api
            .legacyApi(`worlds/${params.id}`, {
                method: 'PUT',
                params
            })
            .then((json) => {
                var args = {
                    json,
                    params
                };
                pubsub.publish('WORLDIMAGE:SET', args);
                pubsub.publish('WORLD', args);
                return args;
            });
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

    $app.methods.displayPreviousImages = function(type, command) {
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
            API.getAvatarImages(params).then((args) => {
                this.previousImagesTableFileId = args.json.id;
                var images = args.json.versions;
                this.checkPreviousImageAvailable(images, command);
            });
        } else if (type === 'World') {
            if (command === 'Change') {
                this.changeWorldImageDialogVisible = true;
                this.$nextTick(() =>
                    adjustDialogZ(this.$refs.changeWorldImageDialog.$el)
                );
            }
            API.getWorldImages(params).then((args) => {
                this.previousImagesTableFileId = args.json.id;
                var images = args.json.versions;
                this.checkPreviousImageAvailable(images, command);
            });
        } else if (type === 'User') {
            API.getAvatarImages(params).then((args) => {
                this.previousImagesTableFileId = args.json.id;
                var images = args.json.versions;
                this.checkPreviousImageAvailable(images, command);
            });
        }
    };

    $app.methods.checkPreviousImageAvailable = async function(images, command) {
        this.previousImagesTable = [];
        for (var image of images) {
            if (image.file && image.file.url) {
                var response = await fetch(image.file.url, {
                    method: 'HEAD',
                    redirect: 'follow',
                    headers: {
                        'User-Agent': appVersion
                    }
                }).catch((error) => {
                    console.log(error);
                });
                if (response.status === 200) {
                    this.previousImagesTable.push(image);
                }
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
        return await api
            .legacyApi(`file/${params.fileId}`, {
                method: 'GET',
                params
            })
            .then((json) => {
                var args = {
                    json,
                    params
                };
                pubsub.publish('AVATARIMAGE:GET', args);
                return args;
            });
    };

    API.getWorldImages = async function(params) {
        return await api
            .legacyApi(`file/${params.fileId}`, {
                method: 'GET',
                params
            })
            .then((json) => {
                var args = {
                    json,
                    params
                };
                pubsub.publish('WORLDIMAGE:GET', args);
                return args;
            });
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

    $app.methods.setAvatarImage = function(image) {
        this.changeAvatarImageDialogLoading = true;
        var parmas = {
            id: this.avatarDialog.id,
            imageUrl: `https://api.vrchat.cloud/api/1/file/${this.previousImagesTableFileId}/${image.version}/file`
        };
        API.setAvatarImage(parmas).finally(() => {
            this.changeAvatarImageDialogLoading = false;
            this.changeAvatarImageDialogVisible = false;
        });
    };

    $app.methods.setWorldImage = function(image) {
        this.changeWorldImageDialogLoading = true;
        var parmas = {
            id: this.worldDialog.id,
            imageUrl: `https://api.vrchat.cloud/api/1/file/${this.previousImagesTableFileId}/${image.version}/file`
        };
        API.setWorldImage(parmas).finally(() => {
            this.changeWorldImageDialogLoading = false;
            this.changeWorldImageDialogVisible = false;
        });
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

    $app.methods.getAvatarName = function(args) {
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
        var params = {
            fileId
        };
        API.getAvatarImages(params).then((args) => {
            var avatarInfo = this.storeAvatarImage(args);
            this.userDialog.$avatarInfo = avatarInfo;
        });
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
            if (typeof ref === 'undefined') {
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
        this.VRChatConfigFile = {};
        var config = await AppApi.ReadConfigFile();
        if (config) {
            try {
                this.VRChatConfigFile = JSON.parse(config);
            } catch {
                this.$message({
                    message: 'Invalid JSON in config.json',
                    type: 'error'
                });
                throw new Error('Invalid JSON in config.json');
            }
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
        await this.readVRChatConfigFile();
        this.$nextTick(() => adjustDialogZ(this.$refs.VRChatConfigDialog.$el));
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
            API.getVRChatCacheSize();
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

    // Asset Bundle Cacher

    $app.methods.updateVRChatCache = function() {
        var D = this.worldDialog;
        if (D.visible) {
            D.inCache = false;
            D.cacheSize = 0;
            this.checkVRChatCache(D.ref).then((cacheSize) => {
                if (cacheSize > 0) {
                    D.inCache = true;
                    D.cacheSize = `${(cacheSize / 1048576).toFixed(2)} MiB`;
                }
            });
        }
    };

    $app.methods.checkVRChatCache = async function(ref) {
        var cacheDir = await this.getVRChatCacheDir();
        return await AssetBundleCacher.CheckVRChatCache(
            ref.id,
            ref.version,
            cacheDir
        );
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
        return api
            .legacyApi(`file/${fileId}`, {
                method: 'GET'
            })
            .then((json) => {
                var args = {
                    json
                };
                return args;
            });
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
        var L = API.parseLocation(lastLocation);
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
        if (typeof this.downloadCurrent.id !== 'undefined') {
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
                !API.isGameRunning) ||
            (this.worldAutoCacheInvite === 'Game Running' && API.isGameRunning)
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
            (this.worldAutoCacheGPS === 'Game Closed' && !API.isGameRunning) ||
            (this.worldAutoCacheGPS === 'Game Running' && API.isGameRunning)
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
        var L = API.parseLocation(location);
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
        API.getVRChatCacheSize();
        this.updateVRChatCache();
    };

    $app.methods.showDeleteAllVRChatCacheConfirm = function() {
        this.$confirm(`Continue? Delete all VRChat cache`, 'Confirm', {
            confirmButtonText: 'Confirm',
            cancelButtonText: 'Cancel',
            type: 'info',
            callback: (action) => {
                if (action === 'confirm') {
                    API.deleteAllVRChatCache();
                }
            }
        });
    };

    $app.methods.deleteAllVRChatCache = async function() {
        var cacheDir = await this.getVRChatCacheDir();
        await AssetBundleCacher.DeleteAllCache(cacheDir);
        API.getVRChatCacheSize();
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
            API.getVRChatCacheSize();
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
        var json = await api.legacyApi('favorite/groups', {
            method: 'GET',
            params
        });
        for (var i = 0; i < json.length; ++i) {
            var list = json[i];
            if (list.type !== 'world') {
                continue;
            }
            var params = {
                n: 100,
                offset: 0,
                userId,
                tag: list.name
            };
            try {
                var args = await API.getFavoriteWorlds(params);
                worldLists.push([list.displayName, list.visibility, args.json]);
            } catch (err) {}
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

    $app.methods.changeWorldGroupVisibility = function(name, visibility) {
        var params = {
            type: 'world',
            group: name,
            visibility
        };
        API.saveFavoriteGroup(params).then((args) => {
            this.$message({
                message: 'Group visibility changed',
                type: 'success'
            });
            return args;
        });
    };

    $app = new Vue($app);
    window.$app = $app;
})();

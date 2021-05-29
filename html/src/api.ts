import Noty from 'noty';
import {Ref} from './ref';
import {isEquals, escapeHtml} from './util';
import * as pubsub from './pubsub';
import {parseLocation} from './location';
import sharedRepository from './repository/shared';

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

export const enum ApiStatusCode {
    OK = 200,
    Unauthorized = 401,
    NotFound = 404
}

export const enum ApiHttpMethod {
    GET = 'GET',
    POST = 'POST',
    PUT = 'PUT',
    DELETE = 'DELETE'
}

export interface ApiReqeustQuery {
    [key: string]: string | number;
}

export interface ApiRequestAuth {
    username: string;
    password: string;
}

export interface ApiRequest {
    method: ApiHttpMethod;
    path: string;
    query?: ApiReqeustQuery;
    body?: object;
    auth?: ApiRequestAuth;
    contentType?: string;
    md5?: string;
    any?: boolean;
}

export interface ApiResponse<T> {
    status: number;
    data?: T;
}

async function api<T>(request: ApiRequest): Promise<ApiResponse<T>> {
    try {
        var headers: HeadersInit = {
            'X-Requested-With': 'XMLHttpRequest',
            Accept: 'application/json'
        };

        var options: RequestInit = {
            method: request.method,
            headers,
            credentials: 'include',
            cache: 'no-cache',
            redirect: 'follow',
            referrer: 'no-referrer'
        };

        var {md5} = request;
        if (md5 !== void 0) {
            headers.md5 = md5;
        }

        var {body} = request;
        if (body !== void 0) {
            // Blob | BufferSource | FormData | URLSearchParams | ReadableStream<Uint8Array> | string
            if (Object(body) === body && body.constructor === Object) {
                headers['Content-Type'] = 'application/json;charset=UTF-8';
                options.body = JSON.stringify(body);
            } else {
                if (request.contentType !== void 0) {
                    headers['Content-Type'] = request.contentType;
                }
                options.body = body as BodyInit;
            }
        }

        if (request.auth !== void 0) {
            var {username, password} = request.auth;
            // two encodeURIComponents are intended for special characters
            username = unescape(
                encodeURIComponent(encodeURIComponent(username))
            );
            password = unescape(
                encodeURIComponent(encodeURIComponent(password))
            );
            headers.Authorization = 'Basic ' + btoa(username + ':' + password);
        }

        var url = new URL(`/api/1/${request.path}`, 'https://api.vrchat.cloud');

        var {query: params} = request;
        if (params !== void 0) {
            var {searchParams} = url;
            for (var key of Object.keys(params)) {
                searchParams.set(key, String(params[key]));
            }
        }

        var response = await fetch(url.toString(), options);
        var {status} = response;

        var contentType = response.headers.get('content-type');
        if (
            contentType !== null &&
            contentType.startsWith('application/json') === true
        ) {
            try {
                var data: any = await response.json();
            } catch {
                var data: any = {};
            }
        } else {
            var data: any = await response.text();
        }

        if (data !== Object(data) && request.any !== true) {
            console.log('not object', data);
            return {
                status: 0,
                data: void 0
            };
        }

        var errorMessage = 'An unknown error occurred';
        if (data === Object(data)) {
            try {
                var {error} = data;
                if (error === Object(error)) {
                    status = parseInt(error.status_code, 10);
                    errorMessage = String(error.message);
                    var json = JSON.parse(error.message);
                    if (json === Object(json)) {
                        errorMessage = String(json.message);
                    } else {
                        errorMessage = String(json);
                    }
                } else if (data.code !== void 0) {
                    status = parseInt(data.code, 10);
                    errorMessage = String(error);
                }
            } catch {}
        }

        if (status !== ApiStatusCode.OK) {
            console.error('vrchat-api:error', {
                status,
                errorMessage
            });
            new Noty({
                type: 'error',
                layout: 'bottomRight',
                theme: 'sunset',
                text: `${escapeHtml(
                    errorMessage
                )}<br><span style="font-size: 11px;">${status} ${
                    response.url
                }</span>`,
                timeout: 6000,
                queue: 'api'
            }).show();
        }

        return {
            status,
            data
        };
    } catch (err) {
        console.error('api error', err);
        return {
            status: 0,
            data: void 0
        };
    }
}

export interface LegacyApiOptions {
    method: any;
    params?: any;
    auth?: any;
    md5?: any;
}

export async function legacyApi(
    path: string,
    options: LegacyApiOptions
): Promise<any> {
    console.log('legacyApi', {path, options});
    try {
        var {method, params, auth, md5} = options;
        if (method === 'GET') {
            var {status, data} = await api({
                method: options.method,
                path,
                query: params,
                auth: auth,
                any: true,
                md5
            });
        } else {
            var {status, data} = await api({
                method,
                path,
                body: params,
                auth,
                any: true,
                md5
            });
        }
        if (status === 200) {
            return data;
        }
        throw data;
    } catch (err) {
        console.error(err);
        throw err;
    }
}

export interface ApiConfig {
    [key: string]: any;
}

export interface ApiCurrentUser {
    [key: string]: any;
}

export interface ApiUser {
    [key: string]: any;
}

export interface ApiWorld {
    [key: string]: any;
}

export interface ApiAvatar {
    [key: string]: any;
}

export interface ApiNotification {
    [key: string]: any;
}

export interface ApiPlayerModeration {
    [key: string]: any;
}

export interface ApiFavorite {
    [key: string]: any;
}

export interface ApiFavoriteGroup {
    [key: string]: any;
}

var isLoggedIn_: Ref<boolean> = {value: false};
var config_: ApiConfig = {};
var currentUser_: ApiCurrentUser = {};
var userMap_: Map<string, ApiUser> = new Map();
var worldMap_: Map<string, ApiWorld> = new Map();
var avatarMap_: Map<string, ApiAvatar> = new Map();
export {
    isLoggedIn_ as isLoggedIn,
    config_ as config,
    currentUser_ as currentUser,
    userMap_ as userMap,
    worldMap_ as worldMap,
    avatarMap_ as avatarMap
};

var isFriendsLoading_: Ref<boolean> = {value: false};
export {isFriendsLoading_ as isFriendsLoading};

var notificationMap_: Map<string, ApiNotification> = new Map();
var isNotificationsLoading_: Ref<boolean> = {value: false};
export {
    notificationMap_ as notificationMap,
    isNotificationsLoading_ as isNotificationsLoading
};

var playerModerationMap_: Map<string, ApiNotification> = new Map();
var isPlayerModerationsLoading_: Ref<boolean> = {value: false};
export {
    playerModerationMap_ as playerModerationMap,
    isPlayerModerationsLoading_ as isPlayerModerationsLoading
};

var favoriteMap_: Map<string, ApiFavorite> = new Map();
var favoriteMapByObjectId_: Map<string, ApiFavorite> = new Map();
var favoriteGroupMap_: Map<string, ApiFavoriteGroup> = new Map();
var favoriteGroupMapByTypeName_: Map<string, ApiFavoriteGroup> = new Map();
export {
    favoriteMap_ as favoriteMap,
    favoriteMapByObjectId_ as favoriteMapByObjectId,
    favoriteGroupMap_ as favoriteGroupMap,
    favoriteGroupMapByTypeName_ as favoriteGroupMapByTypeName
};

var favoriteFriendGroups_: ApiFavoriteGroup[] = [];
var favoriteWorldGroups_: ApiFavoriteGroup[] = [];
var favoriteAvatarGroups_: ApiFavoriteGroup[] = [];
var isFavoriteLoading_: Ref<boolean> = {value: false};
var isFavoriteGroupLoading_: Ref<boolean> = {value: false};
export {
    favoriteFriendGroups_ as favoriteFriendGroups,
    favoriteWorldGroups_ as favoriteWorldGroups,
    favoriteAvatarGroups_ as favoriteAvatarGroups,
    isFavoriteLoading_ as isFavoriteLoading,
    isFavoriteGroupLoading_ as isFavoriteGroupLoading
};

var socket_: WebSocket | undefined = void 0;

//
// Languages
//

export var subsetOfLanguages: Record<string, string> = {
    eng: 'English',
    kor: '한국어',
    rus: 'Русский',
    spa: 'Español',
    por: 'Português',
    zho: '中文',
    deu: 'Deutsch',
    jpn: '日本語',
    fra: 'Français',
    swe: 'Svenska',
    nld: 'Nederlands',
    pol: 'Polski',
    dan: 'Dansk',
    nor: 'Norsk',
    ita: 'Italiano',
    tha: 'ภาษาไทย',
    fin: 'Suomi',
    hun: 'Magyar',
    ces: 'Čeština',
    tur: 'Türkçe',
    ara: 'العربية'
};

// vrchat to famfamfam
export var languageMappings: Record<string, string> = {
    eng: 'us',
    kor: 'kr',
    rus: 'ru',
    spa: 'es',
    por: 'pt',
    zho: 'cn',
    deu: 'de',
    jpn: 'jp',
    fra: 'fr',
    swe: 'se',
    nld: 'nl',
    pol: 'pl',
    dan: 'dk',
    nor: 'no',
    ita: 'it',
    tha: 'th',
    fin: 'fi',
    hun: 'hu',
    ces: 'cz',
    tur: 'tr',
    ara: 'ae'
};

function applyObject(target: any, source: any): any[] {
    var changes = [];

    for (var key of Object.keys(source)) {
        var value = source[key];

        switch (key) {
            case 'tags':
                if (Array.isArray(value) === true) {
                    value = [...new Set(value)].sort(); // fuck yea
                }
                break;
        }

        var oldValue = target[key];
        if (oldValue !== void 0 && isEquals(oldValue, value) === true) {
            continue;
        }

        target[key] = value;
        changes.push([key, value, oldValue]);
    }

    return changes;
}

function replaceObject(target: any, source: any): void {
    var deleteKeys = new Set(Object.keys(target));
    for (var key of Object.keys(source)) {
        target[key] = source[key];
    }
    for (var key of deleteKeys) {
        delete target[key];
    }
}

export function applyConfig(apiConfig: ApiConfig): void {
    replaceObject(config_, apiConfig);
}

export async function getConfig(): Promise<ApiResponse<ApiConfig>> {
    var response = await api<ApiConfig>({
        method: ApiHttpMethod.GET,
        path: 'config'
    });

    var {status, data} = response;
    if (status === ApiStatusCode.OK && data !== void 0) {
        applyConfig(data);
    }

    return response;
}

pubsub.subscribe('LOGIN', function() {
    isFriendsLoading_.value = false;
});

export function applyCurrentUser(json: any): any {
    var ref = currentUser_;
    if (isLoggedIn_.value) {
        Object.assign(ref, json);
        if (ref.homeLocation !== ref.$homeLocation.location) {
            ref.$homeLocation = parseLocation(ref.homeLocation);
        }
        ref.$isVRCPlus = ref.tags.includes('system_supporter');
        applyUserTrustLevel(ref);
        applyUserLanguage(ref);
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
        ref.$homeLocation = parseLocation(ref.homeLocation);
        ref.$isVRCPlus = ref.tags.includes('system_supporter');
        applyUserTrustLevel(ref);
        applyUserLanguage(ref);
        replaceObject(currentUser_, ref);
        isLoggedIn_.value = true;
        pubsub.publish('LOGIN', {
            json,
            ref
        });
    }
    sharedRepository.setString('current_user_status', ref.status);
    return ref;
}

var userUpdateQueue: any[] = [];
var userUpdateTimer: any = void 0;
function queueUserUpdate(ctx: any): void {
    userUpdateQueue.push(ctx);
    if (userUpdateTimer !== void 0) {
        return;
    }
    userUpdateTimer = setTimeout(function() {
        userUpdateTimer = void 0;
        var queue = userUpdateQueue.slice();
        userUpdateQueue.length = 0;
        for (var ctx of queue) {
            try {
                pubsub.publish('USER:UPDATE', ctx);
            } catch {}
        }
    }, 1);
}

export function applyUser(json: any): any {
    var ref = userMap_.get(json.id);
    // some missing variables on currentUser
    if (json.id === currentUser_.id) {
        json.status = currentUser_.status;
        json.statusDescription = currentUser_.statusDescription;
        json.state = currentUser_.state;
        json.last_login = currentUser_.last_login;
        // FIXME
        // if ($app.lastLocation.location) {
        //     json.location = $app.lastLocation.location;
        //     json.$location_at = $app.lastLocation.date;
        // }
        json.$online_for = currentUser_.$online_for;
        json.$offline_for = currentUser_.$offline_for;
    }
    if (ref === void 0) {
        ref = <ApiUser>{
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
        ref.$location = parseLocation(ref.location || 'offline');
        ref.$isVRCPlus = ref.tags.includes('system_supporter');
        applyUserTrustLevel(ref);
        applyUserLanguage(ref);
        userMap_.set(ref.id, ref);
    } else {
        var props: Record<string, any> = {};
        for (var prop in ref) {
            if (ref[prop] !== Object(ref[prop])) {
                props[prop] = true;
            }
        }
        var $ref = {...ref};
        Object.assign(ref, json);
        if (ref.location !== ref.$location.location) {
            ref.$location = parseLocation(ref.location);
        }
        if (ref.statusDescription) {
            ref.statusDescription = ref.statusDescription.substring(0, 32);
        }
        ref.$isVRCPlus = ref.tags.includes('system_supporter');
        applyUserTrustLevel(ref);
        applyUserLanguage(ref);
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
}

export function applyUserTrustLevel(ref: any): void {
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
}

// FIXME: it may performance issue. review here
export function applyUserLanguage(ref: any): void {
    ref.$languages = [];
    var {tags} = ref;
    for (var tag of tags) {
        if (tag.startsWith('language_') === false) {
            continue;
        }
        var key = tag.substr(9);
        var value = subsetOfLanguages[key];
        if (value === void 0) {
            continue;
        }
        ref.$languages.push({
            key,
            value
        });
    }
}

export function applyWorld(json: any): any {
    var ref = worldMap_.get(json.id);
    if (ref === void 0) {
        ref = <ApiWorld>{
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
        worldMap_.set(ref.id, ref);
    } else {
        Object.assign(ref, json);
    }
    ref.$isLabs = ref.tags.includes('system_labs');
    return ref;
}

export function applyAvatar(json: any): any {
    var ref = avatarMap_.get(json.id);
    if (ref === void 0) {
        ref = <ApiAvatar>{
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
        avatarMap_.set(ref.id, ref);
    } else {
        Object.assign(ref, json);
    }
    return ref;
}

export function applyNotification(json: any): any {
    var ref = notificationMap_.get(json.id);
    if (ref === void 0) {
        ref = <ApiNotification>{
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
        notificationMap_.set(ref.id, ref);
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
}

export function applyPlayerModeration(json: any): any {
    var ref = playerModerationMap_.get(json.id);
    if (ref === void 0) {
        ref = <ApiPlayerModeration>{
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
        playerModerationMap_.set(ref.id, ref);
    } else {
        Object.assign(ref, json);
        ref.$isExpired = false;
    }
    return ref;
}

export function applyFavorite(json: any): any {
    var ref = favoriteMap_.get(json.id);
    if (ref === void 0) {
        ref = <ApiFavorite>{
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
        favoriteMap_.set(ref.id, ref);
        favoriteMapByObjectId_.set(ref.favoriteId, ref);
    } else {
        Object.assign(ref, json);
        ref.$isExpired = false;
    }
    ref.$groupKey = `${ref.type}:${String(ref.tags[0])}`;
    if (ref.$isDeleted === false && ref.$groupRef === null) {
        var group = favoriteGroupMapByTypeName_.get(ref.$groupKey);
        if (group !== void 0) {
            ref.$groupRef = group;
            ++group.count;
        }
    }
    return ref;
}

export function applyFavoriteGroup(json: any): any {
    var ref = favoriteGroupMap_.get(json.id);
    if (ref === void 0) {
        ref = <ApiFavoriteGroup>{
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
        favoriteGroupMap_.set(ref.id, ref);
    } else {
        Object.assign(ref, json);
        ref.$isExpired = false;
    }
    return ref;
}

export async function getVisits(): Promise<ApiResponse<number>> {
    var response = await api<number>({
        method: ApiHttpMethod.GET,
        path: 'visits',
        any: true
    });

    var {status, data} = response;
    if (status === ApiStatusCode.OK && data !== void 0) {
        pubsub.publish('VISITS', data);
    }

    return response;
}

pubsub.subscribe('LOGOUT', function() {
    isLoggedIn_.value = false;
});

export function logout(): Promise<any> {
    return legacyApi('logout', {
        method: 'PUT'
    }).finally(() => {
        pubsub.publish('LOGOUT');
    });
}

export function getAuth(): Promise<any> {
    return legacyApi('auth', {
        method: 'GET'
    }).then((json) => {
        var args = {
            json
        };
        pubsub.publish('AUTH', args);
        return args;
    });
}

pubsub.subscribe('USER:CURRENT', function(args: any) {
    var {json} = args;
    args.ref = applyCurrentUser(json);
});

export function getCurrentUser(): Promise<any> {
    return legacyApi(`auth/user?apiKey=${config_.clientApiKey}`, {
        method: 'GET'
    }).then((json) => {
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
}

/*
    params: {
        username: string,
        password: string
    }
*/
export function login(params: any): Promise<any> {
    var {username, password} = params;
    return legacyApi(`auth/user?apiKey=${config_.clientApiKey}`, {
        method: 'GET',
        auth: {
            username,
            password
        }
    }).then((json) => {
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
}

/*
    params: {
        steamTicket: string
    }
*/
export function loginWithSteam(params: any): Promise<any> {
    return legacyApi(`auth/steam?apiKey=${config_.clientApiKey}`, {
        method: 'POST',
        params
    }).then((json) => {
        var args = {
            json,
            params,
            origin: true
        };
        if (json.requiresTwoFactorAuth !== void 0) {
            pubsub.publish('USER:2FA', args);
        } else {
            pubsub.publish('USER:CURRENT', args);
        }
        return args;
    });
}

/*
    params: {
        code: string
    }
*/
export function verifyOTP(params: any): Promise<any> {
    return legacyApi('auth/twofactorauth/otp/verify', {
        method: 'POST',
        params
    }).then((json) => {
        var args = {
            json,
            params
        };
        pubsub.publish('OTP', args);
        return args;
    });
}

/*
    params: {
        code: string
    }
*/
export function verifyTOTP(params: any): Promise<any> {
    return legacyApi('auth/twofactorauth/totp/verify', {
        method: 'POST',
        params
    }).then((json) => {
        var args = {
            json,
            params
        };
        pubsub.publish('TOTP', args);
        return args;
    });
}

pubsub.subscribe('USER', function(args: any) {
    args.ref = applyUser(args.json);
});

/*
    params: {
        userId: string
    }
*/
export function getUser(params: any): Promise<any> {
    return legacyApi(`users/${params.userId}`, {
        method: 'GET'
    }).then((json) => {
        var args = {
            json,
            params
        };
        pubsub.publish('USER', args);
        return args;
    });
}

/*
    params: {
        userId: string
    }
*/
export async function getCachedUser(params: any): Promise<any> {
    var ref = userMap_.get(params.userId);
    if (ref === void 0) {
        return getUser(params);
    }

    return {
        cache: true,
        json: ref,
        params,
        ref
    };
}

pubsub.subscribe('USER:LIST', function(args: any) {
    for (var json of args.json) {
        pubsub.publish('USER', {
            json,
            params: {
                userId: json.id
            }
        });
    }
});

/*
    params: {
        n: number,
        offset: number,
        search: string,
        sort: string ('nuisanceFactor', 'created', '_created_at', 'last_login'),
        order: string ('ascending', 'descending')
    }
*/
export function getUsers(params: any): Promise<any> {
    return legacyApi('users', {
        method: 'GET',
        params
    }).then((json) => {
        var args = {
            json,
            params
        };
        pubsub.publish('USER:LIST', args);
        return args;
    });
}

pubsub.subscribe('USER:CURRENT:SAVE', function(args: any) {
    pubsub.publish('USER:CURRENT', args);
});

/*
    params: {
        status: string ('active', 'offline', 'busy', 'ask me', 'join me'),
        statusDescription: string
    }
*/
export function saveCurrentUser(params: any): Promise<any> {
    return legacyApi(`users/${currentUser_.id}`, {
        method: 'PUT',
        params
    }).then((json) => {
        var args = {
            json,
            params
        };
        pubsub.publish('USER:CURRENT:SAVE', args);
        return args;
    });
}

/*
    params: {
        tags: array[string]
    }
*/
export function addUserTags(params: any): Promise<any> {
    return legacyApi(`users/${currentUser_.id}/addTags`, {
        method: 'POST',
        params
    }).then((json) => {
        var args = {
            json,
            params
        };
        pubsub.publish('USER:CURRENT:SAVE', args);
        return args;
    });
}

/*
    params: {
        tags: array[string]
    }
*/
export function removeUserTags(params: any): Promise<any> {
    return legacyApi(`users/${currentUser_.id}/removeTags`, {
        method: 'POST',
        params
    }).then((json) => {
        var args = {
            json,
            params
        };
        pubsub.publish('USER:CURRENT:SAVE', args);
        return args;
    });
}

pubsub.subscribe('FRIEND:LIST', function(args: any) {
    for (var json of args.json) {
        pubsub.publish('USER', {
            json,
            params: {
                userId: json.id
            }
        });
    }
});

/*
    params: {
        n: number,
        offset: number,
        offline: boolean
    }
*/
export function getFriends(params: any): Promise<any> {
    return legacyApi('auth/user/friends', {
        method: 'GET',
        params
    }).then((json) => {
        var args = {
            json,
            params
        };
        pubsub.publish('FRIEND:LIST', args);
        return args;
    });
}

export async function refreshFriends(): Promise<void> {
    isFriendsLoading_.value = true;

    try {
        var missingFriendIdSet = new Set(currentUser_.friends);

        // fetch online friend list
        for (var offset = 0; missingFriendIdSet.size > 0; offset += 50) {
            var {json} = await getFriends({
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
            var {json} = await getFriends({
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

    isFriendsLoading_.value = false;
}

/*
    params: {
        userId: string
    }
*/
export function deleteFriend(params: any): Promise<any> {
    return legacyApi(`auth/user/friends/${params.userId}`, {
        method: 'DELETE'
    }).then((json) => {
        var args = {
            json,
            params
        };
        pubsub.publish('FRIEND:DELETE', args);
        return args;
    });
}

/*
    params: {
        userId: string
    }
*/
export function sendFriendRequest(params: any): Promise<any> {
    return legacyApi(`user/${params.userId}/friendRequest`, {
        method: 'POST'
    }).then((json) => {
        var args = {
            json,
            params
        };
        pubsub.publish('FRIEND:REQUEST', args);
        return args;
    });
}

/*
    params: {
        userId: string
    }
*/
export function cancelFriendRequest(params: any): Promise<any> {
    return legacyApi(`user/${params.userId}/friendRequest`, {
        method: 'DELETE'
    }).then((json) => {
        var args = {
            json,
            params
        };
        pubsub.publish('FRIEND:REQUEST:CANCEL', args);
        return args;
    });
}

/*
    params: {
        userId: string
    }
*/
export function getFriendStatus(params: any): Promise<any> {
    return legacyApi(`user/${params.userId}/friendStatus`, {
        method: 'GET'
    }).then((json) => {
        var args = {
            json,
            params
        };
        pubsub.publish('FRIEND:STATUS', args);
        return args;
    });
}

pubsub.subscribe('WORLD', function(args: any) {
    args.ref = applyWorld(args.json);
});

/*
    params: {
        worldId: string
    }
*/
export function getWorld(params: any): Promise<any> {
    return legacyApi(`worlds/${params.worldId}`, {
        method: 'GET'
    }).then((json) => {
        var args = {
            json,
            params
        };
        pubsub.publish('WORLD', args);
        return args;
    });
}

/*
    params: {
        worldId: string
    }
*/
export async function getCachedWorld(params: any): Promise<any> {
    var ref = worldMap_.get(params.worldId);
    if (ref === void 0) {
        return getWorld(params);
    }

    return {
        cache: true,
        json: ref,
        params,
        ref
    };
}

pubsub.subscribe('WORLD:LIST', function(args: any) {
    for (var json of args.json) {
        pubsub.publish('WORLD', {
            json,
            params: {
                worldId: json.id
            }
        });
    }
});

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
export function getWorlds(params: any, option?: string): Promise<any> {
    var endpoint = 'worlds';
    if (option !== void 0) {
        endpoint = `worlds/${option}`;
    }
    return legacyApi(endpoint, {
        method: 'GET',
        params
    }).then((json) => {
        var args = {
            json,
            params
        };
        pubsub.publish('WORLD:LIST', args);
        return args;
    });
}

pubsub.subscribe('WORLD:DELETE', function(args: any) {
    var {json} = args;
    worldMap_.delete(json.id);
});

/*
    params: {
        worldId: string
    }
*/
export function deleteWorld(params: any): Promise<any> {
    return legacyApi(`worlds/${params.worldId}`, {
        method: 'DELETE'
    }).then((json) => {
        var args = {
            json,
            params
        };
        pubsub.publish('WORLD:DELETE', args);
        return args;
    });
}

pubsub.subscribe('WORLD:SAVE', function(args: any) {
    var {json} = args;
    pubsub.publish('WORLD', {
        json,
        params: {
            worldId: json.id
        }
    });
});

/*
    params: {
        worldId: string
    }
*/
export function saveWorld(params: any): Promise<any> {
    return legacyApi(`worlds/${params.id}`, {
        method: 'PUT',
        params
    }).then((json) => {
        var args = {
            json,
            params
        };
        pubsub.publish('WORLD:SAVE', args);
        return args;
    });
}

/*
    params: {
        worldId: string,
        instanceId: string
    }
*/
export function getInstance(params: any): Promise<any> {
    return legacyApi(`instances/${params.worldId}:${params.instanceId}`, {
        method: 'GET'
    }).then((json) => {
        var args = {
            json,
            params
        };
        pubsub.publish('INSTANCE', args);
        return args;
    });
}

pubsub.subscribe('AVATAR', function(args: any) {
    args.ref = applyAvatar(args.json);
});

/*
    params: {
        avatarId: string
    }
*/
export function getAvatar(params: any): Promise<any> {
    return legacyApi(`avatars/${params.avatarId}`, {
        method: 'GET'
    }).then((json) => {
        var args = {
            json,
            params
        };
        pubsub.publish('AVATAR', args);
        return args;
    });
}

pubsub.subscribe('AVATAR:LIST', function(args: any) {
    for (var json of args.json) {
        pubsub.publish('AVATAR', {
            json,
            params: {
                avatarId: json.id
            }
        });
    }
});

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
export function getAvatars(params: any): Promise<any> {
    return legacyApi('avatars', {
        method: 'GET',
        params
    }).then((json) => {
        var args = {
            json,
            params
        };
        pubsub.publish('AVATAR:LIST', args);
        return args;
    });
}

pubsub.subscribe('AVATAR:SAVE', function(args: any) {
    var {json} = args;
    pubsub.publish('AVATAR', {
        json,
        params: {
            avatarId: json.id
        }
    });
});

/*
    params: {
        id: string
        releaseStatus: string ('public','private'),
    }
*/
export function saveAvatar(params: any): Promise<any> {
    return legacyApi(`avatars/${params.id}`, {
        method: 'PUT',
        params
    }).then((json) => {
        var args = {
            json,
            params
        };
        pubsub.publish('AVATAR:SAVE', args);
        return args;
    });
}

pubsub.subscribe('AVATAR:SELECT', function(args: any) {
    pubsub.publish('USER:CURRENT', args);
});

/*
    params: {
        avatarId: string
    }
*/
export function selectAvatar(params: any): Promise<any> {
    return legacyApi(`avatars/${params.avatarId}/select`, {
        method: 'PUT',
        params
    }).then((json) => {
        var args = {
            json,
            params
        };
        pubsub.publish('AVATAR:SELECT', args);
        return args;
    });
}

/*
    params: {
        avatarId: string
    }
*/
export function selectFallbackAvatar(params: any): Promise<any> {
    return legacyApi(`avatars/${params.avatarId}/selectfallback`, {
        method: 'PUT',
        params
    }).then((json) => {
        var args = {
            json,
            params
        };
        pubsub.publish('AVATAR:SELECT', args);
        return args;
    });
}

pubsub.subscribe('AVATAR:DELETE', function(args: any) {
    var {json} = args;
    avatarMap_.delete(json._id);
});

/*
    params: {
        avatarId: string
    }
*/
export function deleteAvatar(params: any): Promise<any> {
    return legacyApi(`avatars/${params.avatarId}`, {
        method: 'DELETE'
    }).then((json) => {
        var args = {
            json,
            params
        };
        pubsub.publish('AVATAR:DELETE', args);
        return args;
    });
}

pubsub.subscribe('LOGIN', function() {
    notificationMap_.clear();
    isNotificationsLoading_.value = false;
});

pubsub.subscribe('NOTIFICATION', function(args: any) {
    args.ref = applyNotification(args.json);
});

pubsub.subscribe('NOTIFICATION:LIST', function(args: any) {
    for (var json of args.json) {
        pubsub.publish('NOTIFICATION', {
            json,
            params: {
                notificationId: json.id
            }
        });
    }
});

pubsub.subscribe('NOTIFICATION:ACCEPT', function(args: any) {
    var ref = notificationMap_.get(args.params.notificationId);
    if (ref === void 0 || ref.$isDeleted) {
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

pubsub.subscribe('NOTIFICATION:HIDE', function(args: any) {
    var ref = notificationMap_.get(args.params.notificationId);
    if (ref === void 0 || ref.$isDeleted) {
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

/*
    params: {
        n: number,
        offset: number,
        sent: boolean,
        type: string,
        after: string (ISO8601 or 'five_minutes_ago')
    }
*/
export function getNotifications(params: any): Promise<any> {
    return legacyApi('auth/user/notifications', {
        method: 'GET',
        params
    }).then((json) => {
        var args = {
            json,
            params
        };
        pubsub.publish('NOTIFICATION:LIST', args);
        return args;
    });
}

export function clearNotifications(): Promise<any> {
    return legacyApi('auth/user/notifications/clear', {
        method: 'PUT'
    }).then((json) => {
        var args = {
            json
        };
        // FIXME: NOTIFICATION:CLEAR 핸들링
        pubsub.publish('NOTIFICATION:CLEAR', args);
        return args;
    });
}

export async function refreshNotifications(): Promise<void> {
    // NOTE : 캐시 때문에 after=~ 로는 갱신이 안됨. 그래서 첨부터 불러옴
    if (isNotificationsLoading_.value) {
        return;
    }

    isNotificationsLoading_.value = true;

    for (var ref of notificationMap_.values()) {
        ref.$isExpired = true;
    }

    try {
        await getNotifications({
            n: 100
        });
    } catch (err) {
        console.error(err);
    }

    for (var ref of notificationMap_.values()) {
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

    isNotificationsLoading_.value = false;
    pubsub.publish('NOTIFICATION:REFRESH');
}

export function getFriendRequest(userId: string): string {
    for (var ref of notificationMap_.values()) {
        if (
            ref.$isDeleted === false &&
            ref.type === 'friendRequest' &&
            ref.senderUserId === userId
        ) {
            return ref.id;
        }
    }
    return '';
}

/*
    params: {
        notificationId: string
    }
*/
export function acceptNotification(params: any): Promise<any> {
    return legacyApi(
        `auth/user/notifications/${params.notificationId}/accept`,
        {
            method: 'PUT'
        }
    ).then((json) => {
        var args = {
            json,
            params
        };
        pubsub.publish('NOTIFICATION:ACCEPT', args);
        return args;
    });
}

/*
    params: {
        notificationId: string
    }
*/
export function hideNotification(params: any): Promise<any> {
    return legacyApi(`auth/user/notifications/${params.notificationId}/hide`, {
        method: 'PUT'
    }).then((json) => {
        var args = {
            json,
            params
        };
        pubsub.publish('NOTIFICATION:HIDE', args);
        return args;
    });
}

/*
    params: {
        receiverUserId: string,
        type: string,
        message: string,
        seen: boolean,
        details: json-string
    }
*/
export function sendInvite(receiverUserId: string, params: any): Promise<any> {
    return legacyApi(`invite/${receiverUserId}`, {
        method: 'POST',
        params
    }).then((json) => {
        var args = {
            json
        };
        pubsub.publish('NOTIFICATION:INVITE:SEND', args);
        return args;
    });
}

export function sendInvitePhoto(
    receiverUserId: string,
    params: any
): Promise<any> {
    var formData = new FormData();
    for (var key of Object.keys(params)) {
        formData.set(key, params[key]);
    }
    return legacyApi(`invite/${receiverUserId}/photo`, {
        method: 'POST',
        params: formData
    }).then((json) => {
        var args = {
            json
        };
        pubsub.publish('NOTIFICATION:INVITE:PHOTO:SEND', args);
        return args;
    });
}

export function sendRequestInvite(
    receiverUserId: string,
    params: any
): Promise<any> {
    return legacyApi(`requestInvite/${receiverUserId}`, {
        method: 'POST',
        params
    }).then((json) => {
        var args = {
            json
        };
        pubsub.publish('NOTIFICATION:REQUESTINVITE:SEND', args);
        return args;
    });
}

export function sendRequestInvitePhoto(
    receiverUserId: string,
    params: any
): Promise<any> {
    var formData = new FormData();
    for (var key of Object.keys(params)) {
        formData.set(key, params[key]);
    }
    return legacyApi(`requestInvite/${receiverUserId}/photo`, {
        method: 'POST',
        params: formData
    }).then((json) => {
        var args = {
            json
        };
        pubsub.publish('NOTIFICATION:REQUESTINVITE:PHOTO:SEND', args);
        return args;
    });
}

export function sendInviteResponse(
    inviteId: string,
    params: any
): Promise<any> {
    return legacyApi(`invite/${inviteId}/response`, {
        method: 'POST',
        params
    }).then((json) => {
        var args = {
            json,
            inviteID: inviteId
        };
        pubsub.publish('INVITE:RESPONSE:SEND', args);
        return args;
    });
}

export function sendInviteResponsePhoto(
    inviteId: string,
    params: any
): Promise<any> {
    var formData = new FormData();
    for (var key of Object.keys(params)) {
        formData.set(key, params[key]);
    }
    return legacyApi(`invite/${inviteId}/response/photo`, {
        method: 'POST',
        params: formData
    }).then((json) => {
        var args = {
            json,
            inviteId
        };
        pubsub.publish('INVITE:RESPONSE:PHOTO:SEND', args);
        return args;
    });
}

pubsub.subscribe('LOGIN', function() {
    playerModerationMap_.clear();
    isPlayerModerationsLoading_.value = false;
    refreshPlayerModerations();
});

pubsub.subscribe('PLAYER-MODERATION', function(args: any) {
    args.ref = applyPlayerModeration(args.json);
});

pubsub.subscribe('PLAYER-MODERATION:LIST', function(args: any) {
    for (var json of args.json) {
        pubsub.publish('PLAYER-MODERATION', {
            json,
            params: {
                playerModerationId: json.id
            }
        });
    }
});

export function getPlayerModerations(): Promise<any> {
    return legacyApi('auth/user/playermoderations', {
        method: 'GET'
    }).then((json) => {
        var args = {
            json
        };
        pubsub.publish('PLAYER-MODERATION:LIST', args);
        return args;
    });
}

export function getPlayerModerationsAgainstMe(): Promise<any> {
    return legacyApi('auth/user/playermoderated', {
        method: 'GET'
    }).then((json) => {
        var args = {
            json
        };
        pubsub.publish('PLAYER-MODERATION:LIST', args);
        return args;
    });
}

pubsub.subscribe('PLAYER-MODERATION:SEND', function(args: any) {
    var ref = {
        json: args.json,
        params: {
            playerModerationId: args.json.id
        }
    };
    pubsub.publish('PLAYER-MODERATION', ref);
    pubsub.publish('PLAYER-MODERATION:@SEND', ref);
});

/*
    params: {
        moderated: string,
        type: string
    }
*/
// old-way: POST auth/user/blocks {blocked:userId}
export function sendPlayerModeration(params: any): Promise<any> {
    return legacyApi('auth/user/playermoderations', {
        method: 'POST',
        params
    }).then((json) => {
        var args = {
            json,
            params
        };
        pubsub.publish('PLAYER-MODERATION:SEND', args);
        return args;
    });
}

pubsub.subscribe('PLAYER-MODERATION:DELETE', function(args: any) {
    var {type, moderated} = args.params;
    var userId = currentUser_.id;
    for (var ref of playerModerationMap_.values()) {
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

/*
    params: {
        moderated: string,
        type: string
    }
*/
// old-way: PUT auth/user/unblocks {blocked:userId}
export function deletePlayerModeration(params: any): Promise<any> {
    return legacyApi('auth/user/unplayermoderate', {
        method: 'PUT',
        params
    }).then((json) => {
        var args = {
            json,
            params
        };
        pubsub.publish('PLAYER-MODERATION:DELETE', args);
        return args;
    });
}

export async function refreshPlayerModerations(): Promise<void> {
    if (isPlayerModerationsLoading_.value) {
        return;
    }

    isPlayerModerationsLoading_.value = true;

    for (var ref of playerModerationMap_.values()) {
        ref.$isExpired = true;
    }

    try {
        await Promise.all([
            getPlayerModerations()
            //getPlayerModerationsAgainstMe()
        ]);
    } catch (err) {
        console.error(err);
    }

    for (var ref of playerModerationMap_.values()) {
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

    isPlayerModerationsLoading_.value = false;
}

pubsub.subscribe('LOGIN', function() {
    favoriteMap_.clear();
    favoriteMapByObjectId_.clear();
    favoriteGroupMap_.clear();
    favoriteGroupMapByTypeName_.clear();
    favoriteFriendGroups_.length = 0;
    favoriteWorldGroups_.length = 0;
    favoriteAvatarGroups_.length = 0;
    isFavoriteLoading_.value = false;
    isFavoriteGroupLoading_.value = false;
    refreshFavorites();
});

pubsub.subscribe('FAVORITE', function(args: any) {
    var ref = applyFavorite(args.json);
    if (ref.$isDeleted) {
        return;
    }
    args.ref = ref;
});

pubsub.subscribe('FAVORITE:LIST', function(args: any) {
    for (var json of args.json) {
        pubsub.publish('FAVORITE', {
            json,
            params: {
                favoriteId: json.id
            }
        });
    }
});

/*
    params: {
        n: number,
        offset: number,
        type: string,
        tag: string
    }
*/
export function getFavorites(params: any): Promise<any> {
    return legacyApi('favorites', {
        method: 'GET',
        params
    }).then((json) => {
        var args = {
            json,
            params
        };
        pubsub.publish('FAVORITE:LIST', args);
        return args;
    });
}

pubsub.subscribe('FAVORITE:ADD', function(args: any) {
    pubsub.publish('FAVORITE', {
        json: args.json,
        params: {
            favoriteId: args.json.id
        }
    });
    if (
        args.params.type === 'avatar' &&
        !avatarMap_.has(args.params.favoriteId)
    ) {
        getFavoriteAvatars({
            n: 100,
            offset: 0,
            tag: args.params.tags
        });
    }
});

/*
    params: {
        type: string,
        favoriteId: string (objectId),
        tags: string
    }
*/
export function addFavorite(params: any): Promise<any> {
    return legacyApi('favorites', {
        method: 'POST',
        params
    }).then((json) => {
        var args = {
            json,
            params
        };
        pubsub.publish('FAVORITE:ADD', args);
        return args;
    });
}

pubsub.subscribe('FAVORITE:@DELETE', function(args: any) {
    var {ref} = args;
    if (ref.$groupRef !== null) {
        --ref.$groupRef.count;
    }
});

pubsub.subscribe('FAVORITE:DELETE', function(args: any) {
    var ref = favoriteMapByObjectId_.get(args.params.objectId);
    if (ref === void 0) {
        return;
    }
    // 애초에 $isDeleted인데 여기로 올 수 가 있나..?
    favoriteMapByObjectId_.delete(args.params.objectId);
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

/*
    params: {
        objectId: string
    }
*/
export function deleteFavorite(params: any): Promise<any> {
    return legacyApi(`favorites/${params.objectId}`, {
        method: 'DELETE'
    }).then((json) => {
        var args = {
            json,
            params
        };
        pubsub.publish('FAVORITE:DELETE', args);
        return args;
    });
}

pubsub.subscribe('FAVORITE:GROUP', function(args: any) {
    var ref = applyFavoriteGroup(args.json);
    if (ref.$isDeleted) {
        return;
    }
    args.ref = ref;
    if (ref.$groupRef !== null) {
        ref.$groupRef.displayName = ref.displayName;
        ref.$groupRef.visibility = ref.visibility;
    }
});

pubsub.subscribe('FAVORITE:GROUP:LIST', function(args: any) {
    for (var json of args.json) {
        pubsub.publish('FAVORITE:GROUP', {
            json,
            params: {
                favoriteGroupId: json.id
            }
        });
    }
});

/*
    params: {
        n: number,
        offset: number,
        type: string
    }
*/
export function getFavoriteGroups(params: any): Promise<any> {
    return legacyApi('favorite/groups', {
        method: 'GET',
        params
    }).then((json) => {
        var args = {
            json,
            params
        };
        pubsub.publish('FAVORITE:GROUP:LIST', args);
        return args;
    });
}

pubsub.subscribe('FAVORITE:GROUP:SAVE', function(args: any) {
    pubsub.publish('FAVORITE:GROUP', {
        json: args.json,
        params: {
            favoriteGroupId: args.json.id
        }
    });
});

/*
    params: {
        type: string,
        group: string (name),
        displayName: string,
        visibility: string
    }
*/
export function saveFavoriteGroup(params: any): Promise<any> {
    return legacyApi(
        `favorite/group/${params.type}/${params.group}/${currentUser_.id}`,
        {
            method: 'PUT',
            params
        }
    ).then((json) => {
        var args = {
            json,
            params
        };
        pubsub.publish('FAVORITE:GROUP:SAVE', args);
        return args;
    });
}

pubsub.subscribe('FAVORITE:GROUP:CLEAR', function(args: any) {
    var key = `${args.params.type}:${args.params.group}`;
    for (var ref of favoriteMap_.values()) {
        if (ref.$isDeleted || ref.$groupKey !== key) {
            continue;
        }
        favoriteMapByObjectId_.delete(ref.favoriteId);
        ref.$isDeleted = true;
        pubsub.publish('FAVORITE:@DELETE', {
            ref,
            params: {
                favoriteId: ref.id
            }
        });
    }
});

/*
    params: {
        type: string,
        group: string (name)
    }
*/
export function clearFavoriteGroup(params: any): Promise<any> {
    return legacyApi(
        `favorite/group/${params.type}/${params.group}/${currentUser_.id}`,
        {
            method: 'DELETE',
            params
        }
    ).then((json) => {
        var args = {
            json,
            params
        };
        pubsub.publish('FAVORITE:GROUP:CLEAR', args);
        return args;
    });
}

pubsub.subscribe('FAVORITE:WORLD:LIST', function(args: any) {
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

/*
    params: {
        n: number,
        offset: number
    }
*/
export function getFavoriteWorlds(params: any): Promise<any> {
    return legacyApi('worlds/favorites', {
        method: 'GET',
        params
    }).then((json) => {
        var args = {
            json,
            params
        };
        pubsub.publish('FAVORITE:WORLD:LIST', args);
        return args;
    });
}

pubsub.subscribe('FAVORITE:AVATAR:LIST', function(args: any) {
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

/*
    params: {
        n: number,
        offset: number
    }
*/
export function getFavoriteAvatars(params: any): Promise<any> {
    return legacyApi('avatars/favorites', {
        method: 'GET',
        params
    }).then((json) => {
        var args = {
            json,
            params
        };
        pubsub.publish('FAVORITE:AVATAR:LIST', args);
        return args;
    });
}

export async function refreshFavorites(): Promise<void> {
    if (isFavoriteLoading_.value) {
        return;
    }

    isFavoriteLoading_.value = true;

    for (var ref of favoriteMap_.values()) {
        ref.$isExpired = true;
    }

    try {
        for (var offset = 0; ; offset += 100) {
            var {json} = await getFavorites({
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

    for (var ref of favoriteMap_.values()) {
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

    await refreshFavoriteItems();
    await refreshFavoriteGroups();

    isFavoriteLoading_.value = false;
}

export async function refreshFavoriteItems(): Promise<void> {
    var favoriteGroups: any = {
        world: [0, 'getFavoriteWorlds'],
        avatar: [0, 'getFavoriteAvatars']
    };

    var avatarTags: string[] = [];

    for (var apiFavorite of favoriteMap_.values()) {
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
                var {json} = await getFavoriteWorlds({
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
                    var {json} = await getFavoriteAvatars({
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
}

function buildFavoriteGroups(): void {
    // 192 = ['group_0', 'group_1', 'group_2'] x 64
    favoriteFriendGroups_.length = 0;
    for (var i = 0; i < 3; ++i) {
        favoriteFriendGroups_.push({
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
    favoriteWorldGroups_.length = 0;
    for (var i = 0; i < 4; ++i) {
        favoriteWorldGroups_.push({
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
    favoriteAvatarGroups_.length = 0;
    for (var i = 0; i < 4; ++i) {
        favoriteAvatarGroups_.push({
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

    var types: any = {
        friend: favoriteFriendGroups_,
        world: favoriteWorldGroups_,
        avatar: favoriteAvatarGroups_
    };

    var assigns = new Set();

    // assign the same name first
    for (var ref of favoriteGroupMap_.values()) {
        if (ref.$isDeleted) {
            continue;
        }
        var groups = types[ref.type];
        if (groups === void 0) {
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
    for (var ref of favoriteGroupMap_.values()) {
        if (ref.$isDeleted || assigns.has(ref.id)) {
            continue;
        }
        var groups = types[ref.type];
        if (groups === void 0) {
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
    favoriteGroupMapByTypeName_.clear();
    for (var type in types) {
        for (var group of types[type]) {
            favoriteGroupMapByTypeName_.set(group.key, group);
        }
    }

    for (var ref of favoriteMap_.values()) {
        ref.$groupRef = null;
        if (ref.$isDeleted) {
            continue;
        }
        var group2 = favoriteGroupMapByTypeName_.get(ref.$groupKey);
        if (group2 === void 0) {
            continue;
        }
        ref.$groupRef = group2;
        ++group2.count;
    }
}

export async function refreshFavoriteGroups(): Promise<void> {
    if (isFavoriteGroupLoading_.value) {
        return;
    }

    isFavoriteGroupLoading_.value = true;

    for (var ref of favoriteGroupMap_.values()) {
        ref.$isExpired = true;
    }

    try {
        for (var offset = 0; ; offset += 100) {
            var {json} = await getFavoriteGroups({
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

    for (var ref of favoriteGroupMap_.values()) {
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

    buildFavoriteGroups();
    isFavoriteGroupLoading_.value = false;
}

pubsub.subscribe('LOGOUT', function() {
    closeWebSocket();
});

pubsub.subscribe('USER:CURRENT', function() {
    if (socket_ === null) {
        getAuth();
    }
});

pubsub.subscribe('AUTH', function(args: any) {
    if (args.json.ok) {
        connectWebSocket(args.json.token);
    }
});

pubsub.subscribe('PIPELINE', function(args: any) {
    var {type, content} = args.json;

    if (content.user !== void 0) {
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
            if (content.userId === currentUser_.id) {
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
    }
});

export function closeWebSocket(): void {
    if (socket_ === void 0) {
        return;
    }
    try {
        socket_.close();
    } catch (err) {
        console.error(err);
    }
    socket_ = void 0;
}

function onSocketClose(this: WebSocket) {
    if (this !== socket_) {
        this.close();
        return;
    }
    closeWebSocket();
}

function onSocketError(this: WebSocket) {
    if (this !== socket_) {
        this.close();
        return;
    }
    closeWebSocket();
}

function onSocketMessage(this: WebSocket, ev: MessageEvent) {
    if (this !== socket_) {
        this.close();
        return;
    }
    try {
        var json = JSON.parse(ev.data);
        json.content = JSON.parse(json.content);
        pubsub.publish('PIPELINE', {
            json
        });
    } catch (err) {
        console.error(err);
    }
}

export function connectWebSocket(token: string): void {
    if (socket_ !== void 0) {
        return;
    }
    socket_ = new WebSocket(`wss://pipeline.vrchat.cloud/?auth=${token}`);
    socket_.onclose = onSocketClose;
    socket_.onerror = onSocketError;
    socket_.onmessage = onSocketMessage;
}

import Noty from 'noty';
import {isEquals, escapeHtml} from './util';
import * as pubsub from './pubsub';
import {Ref} from './ref';

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
var worldMap_: Map<string, ApiUser> = new Map();
export {
    isLoggedIn_ as isLoggedIn,
    config_ as config,
    currentUser_ as currentUser,
    userMap_ as userMap,
    worldMap_ as worldMap
};

var friends200_: Set<string> = new Set();
var friends404_: Set<string> = new Set();
var isFriendsLoading_: Ref<boolean> = {value: false};
export {
    friends200_ as friends200,
    friends404_ as friends404,
    isFriendsLoading_ as isFriendsLoading
};

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

export function applyCurrentUser(apiCurrentUser: ApiCurrentUser): void {
    applyObject(currentUser_, apiCurrentUser);
}

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

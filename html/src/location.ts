export const enum ReservedLocation {
    Offline = 'offline',
    InBetween = 'inbetween',
    Private = 'private'
}

export const enum InstanceAccessType {
    FriendsOfGuests = 'friends+',
    FriendsOnly = 'friends',
    InviteOnly = 'invite',
    InvitePlus = 'invite+',
    Public = 'public'
}

export interface LocationInfo {
    location: string;
    isOffline?: boolean;
    isPrivate?: boolean;
    worldId?: string;
    instanceId?: string;
    name?: string;
    accessType?: InstanceAccessType;
    ownerId?: string;
}

export function parseLocation(location: string): LocationInfo {
    if (
        typeof location !== 'string' ||
        location === '' ||
        location === ReservedLocation.Offline ||
        location === ReservedLocation.InBetween
    ) {
        return {
            location: ReservedLocation.Offline,
            isOffline: true
        };
    }

    var locationInfo: LocationInfo = {
        location
    };

    if (location === ReservedLocation.Private) {
        locationInfo.isPrivate = true;
        return locationInfo;
    }

    var pos = location.indexOf(':');
    if (pos < 0) {
        locationInfo.worldId = location;
        return locationInfo;
    }

    locationInfo.worldId = location.substr(0, pos);

    var instanceId = location.substr(pos + 1);
    locationInfo.instanceId = instanceId;

    var instanceTags = instanceId.split('~');
    locationInfo.name = instanceTags[0];

    var canRequestInvite = false;
    var privateId: string | undefined = void 0;
    var friendsId: string | undefined = void 0;
    var hiddenId: string | undefined = void 0;

    var {length} = instanceTags;
    for (var i = 1; i < length; ++i) {
        var tagName = instanceTags[i];
        var tagData = '';

        var start = tagName.indexOf('(') + 1;
        if (start > 0) {
            var end = tagName.lastIndexOf(')');
            if (end > start) {
                tagData = tagName.substr(start, end - start);
                tagName = tagName.substr(0, start - 1);
            }
        }

        switch (tagName) {
            case 'canRequestInvite':
                canRequestInvite = true;
                break;

            case 'friends':
                friendsId = tagData;
                break;

            case 'hidden':
                hiddenId = tagData;
                break;

            case 'private':
                privateId = tagData;
                break;
        }
    }

    if (privateId !== void 0) {
        if (canRequestInvite === true) {
            locationInfo.accessType = InstanceAccessType.InvitePlus;
            // locationInfo.accessDetail = 'Invite Plus';
        } else {
            locationInfo.accessType = InstanceAccessType.InviteOnly;
            // locationInfo.accessDetail = 'Invite Only';
        }
        locationInfo.ownerId = privateId;
    } else if (friendsId !== void 0) {
        locationInfo.accessType = InstanceAccessType.FriendsOnly;
        // locationInfo.accessDetail = 'Friends Only';
        locationInfo.ownerId = friendsId;
    } else if (hiddenId !== void 0) {
        locationInfo.accessType = InstanceAccessType.FriendsOfGuests;
        // locationInfo.accessDetail = 'Friends of Guests';
        locationInfo.ownerId = hiddenId;
    } else {
        locationInfo.accessType = InstanceAccessType.Public;
        // locationInfo.accessDetail = 'Public';
    }

    // { name: 'pop', type: 'popcount', accessDetail: '[Internal Use Only] Population Counter' }

    return locationInfo;
}

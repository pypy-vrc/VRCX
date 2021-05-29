export function nop(..._params: any[]): any {}

export async function sleep(msec: number): Promise<void> {
    return new Promise(function onPromiseSleep(resolve) {
        setTimeout(resolve, msec);
    });
}

export function escapeHtml(str: string): string {
    return str.replace(/[\x0a"&'<>]/g, (s) => `&#${s.charCodeAt(0)};`);
}

export function getDurationString(sec: number): string {
    var dd = Math.floor(sec / 86400);
    var hh = Math.floor(sec / 3600) % 24;
    var mm = Math.floor(sec / 60) % 60;
    var ss = Math.floor(sec) % 60;
    if (dd > 0) {
        if (ss === 0) {
            if (mm === 0) {
                if (hh === 0) {
                    return `${dd}d`;
                }
                return `${dd}d ${hh}h`;
            }
            return `${dd}d ${hh}h ${mm}m`;
        }
        return `${dd}d ${hh}h ${mm}m ${ss}s`;
    }
    if (hh > 0) {
        if (ss === 0) {
            if (mm === 0) {
                return `${hh}h`;
            }
            return `${hh}h ${mm}m`;
        }
        return `${hh}h ${mm}m ${ss}s`;
    }
    if (mm > 0) {
        if (ss === 0) {
            return `${mm}m`;
        }
        return `${mm}m ${ss}s`;
    }
    return `${ss}s`;
}

export function isEquals(a: any, b: any): boolean {
    // string | number | boolean | null
    if (a === b) {
        return true;
    }

    if (
        typeof a !== 'object' ||
        typeof b !== 'object' ||
        a.constructor !== b.constructor
    ) {
        return false;
    }

    // array
    if (Array.isArray(a) === true) {
        var {length} = a;
        if (length !== b.length) {
            return false;
        }
        for (var i = 0; i < length; ++i) {
            if (a[i] !== b[i] && isEquals(a[i], b[i]) === false) {
                return false;
            }
        }
        return true;
    }

    // plain object
    var keysA = Object.keys(a);
    var keysB = Object.keys(b);
    if (keysA.length !== keysB.length) {
        return false;
    }

    for (var key of keysB) {
        if (key in a === false) {
            return false;
        }
    }

    for (var key of keysA) {
        if (a[key] !== b[key] && isEquals(a[key], b[key]) === false) {
            return false;
        }
    }

    return true;
}

//

export function commaNumber(value: string | number): string {
    var s = String(Number(value));
    return s.replace(/(\d)(?=(\d{3})+(?!\d))/g, '$1,');
}

export function formatDate(date: string | number, format: string): string {
    var dt = new Date(date);
    if (isNaN(dt.getTime())) {
        return escapeHtml(String(date));
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
    // @ts-ignore
    return format.replace(/YYYY|MM|DD|HH24|HH|MI|SS|AMPM/g, (c) => map[c] || c);
}

export function textToHex(text: any): string {
    var s = String(text);
    return s
        .split('')
        .map((c) => c.charCodeAt(0).toString(16))
        .join(' ');
}

export function timeToText(sec: any): string {
    var n = Number(sec);
    if (isNaN(n)) {
        return escapeHtml(sec);
    }
    n = Math.floor(n / 1000);
    var arr = [];
    if (n < 0) {
        n = -n;
    }
    if (n >= 86400) {
        arr.push(`${Math.floor(n / 86400)}d`);
        n %= 86400;
    }
    if (n >= 3600) {
        arr.push(`${Math.floor(n / 3600)}h`);
        n %= 3600;
    }
    if (n >= 60) {
        arr.push(`${Math.floor(n / 60)}m`);
        n %= 60;
    }
    if (n || arr.length === 0) {
        arr.push(`${n}s`);
    }
    return arr.join(' ');
}

export function removeFromArray(array: any[], item: any): boolean {
    var {length} = array;
    for (var i = 0; i < length; ++i) {
        if (array[i] === item) {
            array.splice(i, 1);
            return true;
        }
    }
    return false;
}

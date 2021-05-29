var map_: Map<string, Set<Function>> = new Map();

export function publish(name: string, ...args: any[]): void {
    var set = map_.get(name);
    if (set === void 0) {
        return;
    }

    switch (args.length) {
        case 0:
            for (var f of set) {
                f();
            }
            break;
        case 1: {
            var [a] = args;
            for (var f of set) {
                f(a);
            }
            break;
        }
        case 2: {
            var [a, b] = args;
            for (var f of set) {
                f(a, b);
            }
            break;
        }
        case 3: {
            var [a, b, c] = args;
            for (var f of set) {
                f(a, b, c);
            }
            break;
        }
        case 4: {
            var [a, b, c, d] = args;
            for (var f of set) {
                f(a, b, c, d);
            }
            break;
        }
        case 5: {
            var [a, b, c, d, e] = args;
            for (var f of set) {
                f(a, b, c, d, e);
            }
            break;
        }
        default:
            for (var f of set) {
                f(...args);
            }
            break;
    }
}

export function subscribe(name: string, fn: Function): void {
    var set = map_.get(name);
    if (set === void 0) {
        set = new Set();
        map_.set(name, set);
    }
    set.add(fn);
}

export function unsubscribe(name: string, fn: Function): void {
    var set = map_.get(name);
    if (set === void 0) {
        return;
    }
    if (set.delete(fn) === true && set.size === 0) {
        map_.delete(name);
    }
}

// requires binding of SharedVariable

function transformKey(key) {
    return String(key).toLowerCase();
}

class SharedRepository {
    remove(key) {
        key = transformKey(key);
        return SharedVariable.Remove(key);
    }

    getString(key, defaultValue = null) {
        key = transformKey(key);
        var value = SharedVariable.Get(key);
        if (value === null) {
            return defaultValue;
        }
        return value;
    }

    setString(key, value) {
        key = transformKey(key);
        value = String(value);
        SharedVariable.Set(key, value);
    }

    getBool(key, defaultValue = null) {
        var value = this.getString(key, null);
        if (value === null) {
            return defaultValue;
        }
        return value === 'true';
    }

    setBool(key, value) {
        this.setString(key, value ? 'true' : 'false');
    }

    getInt(key, defaultValue = null) {
        var value = this.getString(key, null);
        if (value === null) {
            return defaultValue;
        }
        value = parseInt(value, 10);
        if (isNaN(value) === true) {
            return defaultValue;
        }
        return value;
    }

    setInt(key, value) {
        this.setString(key, value);
    }

    getFloat(key, defaultValue = null) {
        var value = this.getString(key, null);
        if (value === null) {
            return defaultValue;
        }
        value = parseFloat(value);
        if (isNaN(value) === true) {
            return defaultValue;
        }
        return value;
    }

    setFloat(key, value) {
        this.setString(key, value);
    }

    getObject(key, defaultValue = null) {
        var value = this.getString(key, null);
        if (value === null) {
            return defaultValue;
        }
        try {
            value = JSON.parse(value);
        } catch (err) {}
        if (value !== Object(value)) {
            return defaultValue;
        }
        return value;
    }

    setObject(key, value) {
        this.setString(key, JSON.stringify(value));
    }

    getArray(key, defaultValue = null) {
        var value = this.getObject(key, null);
        if (Array.isArray(value) === false) {
            return defaultValue;
        }
        return value;
    }

    setArray(key, value) {
        this.setObject(key, value);
    }
}

var self = new SharedRepository();
window.sharedRepository = self;

export {self as default, SharedRepository};

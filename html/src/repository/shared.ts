// requires binding of SharedVariable

function transformKey(key: string): string {
    return String(key).toLowerCase();
}

export class SharedRepository {
    remove(key: string): boolean {
        // @ts-ignore
        var sharedVariable: any = window.SharedVariable;
        return sharedVariable.Remove(transformKey(key));
    }

    getString(key: string, defaultValue: string | null = null): string | null {
        // @ts-ignore
        var sharedVariable: any = window.SharedVariable;
        var value = sharedVariable.Get(transformKey(key));
        if (value === null) {
            return defaultValue;
        }
        return value;
    }

    setString(key: string, value: string): void {
        // @ts-ignore
        var sharedVariable: any = window.SharedVariable;
        sharedVariable.Set(transformKey(key), String(value));
    }

    getBool(key: string, defaultValue: boolean | null = null): boolean | null {
        var value = this.getString(key);
        if (value === null) {
            return defaultValue;
        }
        return value === 'true';
    }

    setBool(key: string, value: boolean): void {
        this.setString(key, value ? 'true' : 'false');
    }

    getInt(key: string, defaultValue: number | null = null): number | null {
        var strValue = this.getString(key);
        if (strValue === null) {
            return defaultValue;
        }
        var value = parseInt(strValue, 10);
        if (isNaN(value) === true) {
            return defaultValue;
        }
        return value;
    }

    setInt(key: string, value: number): void {
        this.setString(key, String(value));
    }

    getFloat(key: string, defaultValue: number | null = null): number | null {
        var strValue = this.getString(key);
        if (strValue === null) {
            return defaultValue;
        }
        var value = parseFloat(strValue);
        if (isNaN(value) === true) {
            return defaultValue;
        }
        return value;
    }

    setFloat(key: string, value: number): void {
        this.setString(key, String(value));
    }

    getObject(key: string, defaultValue: any | null = null): any | null {
        var value = this.getString(key);
        if (value === null) {
            return defaultValue;
        }
        try {
            return JSON.parse(value);
        } catch {
            return defaultValue;
        }
    }

    setObject(key: string, value: any): void {
        this.setString(key, JSON.stringify(value));
    }

    getArray(key: string, defaultValue: any[] | null = null): any[] | null {
        var value = this.getObject(key);
        if (Array.isArray(value) === false) {
            return defaultValue;
        }
        return value;
    }

    setArray(key: string, value: any[]): void {
        this.setObject(key, value);
    }
}

var self = new SharedRepository();
export {self as default};

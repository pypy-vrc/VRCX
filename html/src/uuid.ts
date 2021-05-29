export function v4(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        var v = (Math.random() * 16) | 0;
        if (c !== 'x') {
            v |= 8;
        }
        return v.toString(16);
    });
}

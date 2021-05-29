import * as pubsub from '../../pubsub';
import * as api from '../../api';
import {parseLocation} from '../../location';

export default {
    name: 'Location',
    props: {
        location: String,
        hint: {
            type: String,
            default: ''
        },
        link: {
            type: Boolean,
            default: true
        }
    },
    data(this: any): any {
        return {
            text: this.location
        };
    },
    methods: {
        async parse(this: any) {
            var L = parseLocation(this.location);
            if (L.isOffline) {
                this.text = 'Offline';
            } else if (L.isPrivate) {
                this.text = 'Private';
            } else if (typeof this.hint === 'string' && this.hint !== '') {
                if (L.instanceId) {
                    this.text = `${this.hint} #${L.name} ${L.accessType}`;
                } else {
                    this.text = this.hint;
                }
            } else if (L.worldId) {
                this.text = `${L.worldId} #${L.name} ${L.accessType}`;
                var ref = api.worldMap.get(L.worldId);
                if (ref === void 0) {
                    try {
                        var {json} = await api.getWorld({
                            worldId: L.worldId
                        });
                        if (json !== void 0 && L.location === this.location) {
                            if (L.instanceId) {
                                this.text = `${json.name} #${L.name} ${L.accessType}`;
                            } else {
                                this.text = json.name;
                            }
                        }
                    } catch (err) {
                        console.error(err);
                    }
                } else if (L.instanceId) {
                    this.text = `${ref.name} #${L.name} ${L.accessType}`;
                } else {
                    this.text = ref.name;
                }
            }
        },
        showWorldDialog(this: any) {
            if (this.link) {
                pubsub.publish('SHOW_WORLD_DIALOG', this.location);
            }
        }
    },
    watch: {
        location(this: any) {
            this.parse();
        }
    },
    created(this: any) {
        this.parse();
    }
};

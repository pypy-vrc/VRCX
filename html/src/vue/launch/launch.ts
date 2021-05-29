import * as pubsub from '../../pubsub';
import {parseLocation} from '../../location';

export default {
    name: 'Launch',
    props: {
        location: String
    },
    methods: {
        parse(this: any) {
            var L = parseLocation(this.location);
            this.$el.style.display = L.isOffline || L.isPrivate ? 'none' : '';
        },
        confirm(this: any) {
            pubsub.publish('SHOW_LAUNCH_DIALOG', this.location);
        }
    },
    watch: {
        location(this: any) {
            this.parse();
        }
    },
    mounted(this: any) {
        this.parse();
    }
};

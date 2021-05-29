import {timeToText, removeFromArray} from '../../util';

var $countDownTimers: any = [];

setInterval(function() {
    for (var $countDownTimer of $countDownTimers) {
        $countDownTimer.update();
    }
}, 5000);

export default {
    name: 'CountdownTimer',
    props: {
        datetime: {
            type: String,
            default() {
                return '';
            }
        },
        hours: {
            type: Number,
            default() {
                return 1;
            }
        }
    },
    data(): any {
        return {
            text: ''
        };
    },
    methods: {
        update(this: any) {
            var epoch =
                new Date(this.datetime).getTime() +
                1000 * 60 * 60 * this.hours -
                Date.now();
            if (epoch >= 0) {
                this.text = timeToText(epoch);
            } else {
                this.text = '';
            }
        }
    },
    watch: {
        date(this: any) {
            this.update();
        }
    },
    mounted(this: any) {
        $countDownTimers.push(this);
        this.update();
    },
    destroyed(this: any) {
        removeFromArray($countDownTimers, this);
    }
};

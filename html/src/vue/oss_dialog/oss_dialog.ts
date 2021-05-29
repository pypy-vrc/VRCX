import {Ref} from '../../ref';

var isDialogVisible_: Ref<Boolean> = {value: false};

export function showDialog(): void {
    isDialogVisible_.value = true;
}

export default {
    name: 'OssDialog',
    data(): any {
        return {
            isDialogVisible: isDialogVisible_
        };
    }
};

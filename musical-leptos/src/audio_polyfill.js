// TODO: actual polyfill here. i was just hoping to see these stubs called, but we don't even get that far. i think because of "strict"

globalThis.TextDecoder = class TextDecoder {
    decode(arg) {
        if (typeof arg !== 'undefined') {
            throw Error('TextDecoder stub called');
        } else {
            return '';
        }
    }
};

globalThis.TextEncoder = class TextEncoder {
    encode(arg) {
        if (typeof arg !== 'undefined') {
            throw Error('TextEncoder stub called');
        } else {
            return new Uint8Array(0);
        }
    }
};

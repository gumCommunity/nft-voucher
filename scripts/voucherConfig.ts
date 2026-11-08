// Gumcoin Vouchers — off-chain metadata and the three voucher kinds.
export const COLLECTION_CONTENT_URL = 'https://cdn.gumcoin.org/vouchers/collection.json';
export const COMMON_CONTENT_URL = 'https://cdn.gumcoin.org/vouchers/';

// Every item stores only its suffix; full URL = COMMON_CONTENT_URL + content.
export const VOUCHER_KINDS = [
    { kind: 0, content: '0.json', name: '10 000 GUM Voucher' },
    { kind: 1, content: '1.json', name: '5 000 GUM Voucher' },
    { kind: 2, content: '2.json', name: '1 000 GUM Voucher' },
] as const;

export type VoucherKind = (typeof VOUCHER_KINDS)[number];

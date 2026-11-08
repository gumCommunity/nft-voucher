// Gumcoin Vouchers — off-chain metadata and the three voucher kinds.
export const COLLECTION_CONTENT_URL = 'https://cdn.gumcoin.org/vouchers/collection.json';
export const COMMON_CONTENT_URL = 'https://cdn.gumcoin.org/vouchers/';

// Default royalty for marketplace sales: ROYALTY_FACTOR / ROYALTY_BASE = 0 / 100 = 0%.
// (e.g. 5 / 100 = 5%). Paid to the deployer wallet unless ROYALTY_ADDRESS is set.
// Can be changed later at any time with changeRoyalty.
export const ROYALTY_FACTOR = 0;
export const ROYALTY_BASE = 100;
export const ROYALTY_ADDRESS: string | null = null;

// Every item stores only its suffix; full URL = COMMON_CONTENT_URL + content.
export const VOUCHER_KINDS = [
    { kind: 0, content: '0.json', name: '10 000 GUM Voucher' },
    { kind: 1, content: '1.json', name: '5 000 GUM Voucher' },
    { kind: 2, content: '2.json', name: '1 000 GUM Voucher' },
] as const;

export type VoucherKind = (typeof VOUCHER_KINDS)[number];

// Minter: max vouchers the operator (server) may mint per 24 hours.
// null = deployMinter asks for it. Can be changed later with manageMinter.
export const MINTER_LIMIT_PER_DAY: number | null = null;

import {
    Address,
    beginCell,
    Cell,
    Contract,
    contractAddress,
    ContractProvider,
    Dictionary,
    DictionaryValue,
    Sender,
    SendMode,
    toNano,
} from '@ton/core';

export type RoyaltyParams = {
    royaltyFactor: number; // numerator, e.g. 5
    royaltyBase: number; // denominator, e.g. 100 -> 5%
    royaltyAddress: Address;
};

export type NftVoucherCollectionConfig = {
    ownerAddress: Address;
    nextItemIndex?: number;
    collectionContentUrl: string; // full URL of collection metadata json
    commonContentUrl: string; // prefix that is prepended to every item content
    nftItemCode: Cell;
    royaltyParams: RoyaltyParams;
};

export type MintParams = {
    itemIndex: number | bigint;
    itemOwner: Address;
    itemContent: string; // individual part of the item URL (appended to commonContentUrl)
    voucherValue: bigint; // TON locked inside the item = voucher value
    storageReserve?: bigint; // extra TON for item deploy/storage, default 0.05
};

export const Opcodes = {
    mint: 1,
    batchMint: 2,
    changeOwner: 3,
};

export const DEFAULT_ITEM_STORAGE_RESERVE = toNano('0.05');

export function buildCollectionContent(collectionContentUrl: string, commonContentUrl: string): Cell {
    return beginCell()
        .storeRef(beginCell().storeUint(1, 8).storeStringTail(collectionContentUrl).endCell()) // off-chain tag
        .storeRef(beginCell().storeStringTail(commonContentUrl).endCell())
        .endCell();
}

export function nftVoucherCollectionConfigToCell(config: NftVoucherCollectionConfig): Cell {
    return beginCell()
        .storeAddress(config.ownerAddress)
        .storeUint(config.nextItemIndex ?? 0, 64)
        .storeRef(buildCollectionContent(config.collectionContentUrl, config.commonContentUrl))
        .storeRef(config.nftItemCode)
        .storeRef(
            beginCell()
                .storeUint(config.royaltyParams.royaltyFactor, 16)
                .storeUint(config.royaltyParams.royaltyBase, 16)
                .storeAddress(config.royaltyParams.royaltyAddress)
                .endCell(),
        )
        .endCell();
}

function buildItemInit(p: MintParams): Cell {
    return beginCell()
        .storeAddress(p.itemOwner)
        .storeRef(beginCell().storeStringTail(p.itemContent).endCell())
        .endCell();
}

function itemAmount(p: MintParams): bigint {
    return p.voucherValue + (p.storageReserve ?? DEFAULT_ITEM_STORAGE_RESERVE);
}

const MintDictValue: DictionaryValue<MintParams> = {
    serialize(src, builder) {
        builder.storeCoins(itemAmount(src)).storeRef(buildItemInit(src));
    },
    parse() {
        throw new Error('not supported');
    },
};

export class NftVoucherCollection implements Contract {
    constructor(
        readonly address: Address,
        readonly init?: { code: Cell; data: Cell },
    ) {}

    static createFromAddress(address: Address) {
        return new NftVoucherCollection(address);
    }

    static createFromConfig(config: NftVoucherCollectionConfig, code: Cell, workchain = 0) {
        const data = nftVoucherCollectionConfigToCell(config);
        const init = { code, data };
        return new NftVoucherCollection(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        });
    }

    /** Mint one voucher. `value` must cover voucherValue + storageReserve + ~0.05 TON for fees. */
    async sendMint(provider: ContractProvider, via: Sender, params: MintParams & { value?: bigint; queryId?: number }) {
        await provider.internal(via, {
            value: params.value ?? itemAmount(params) + toNano('0.05'),
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(Opcodes.mint, 32)
                .storeUint(params.queryId ?? 0, 64)
                .storeUint(params.itemIndex, 64)
                .storeCoins(itemAmount(params))
                .storeRef(buildItemInit(params))
                .endCell(),
        });
    }

    /** Mint up to 249 vouchers in one message. */
    async sendBatchMint(provider: ContractProvider, via: Sender, items: MintParams[], opts?: { value?: bigint; queryId?: number }) {
        if (items.length >= 250) throw new Error('Too many items in one batch (max 249)');
        const dict = Dictionary.empty(Dictionary.Keys.BigUint(64), MintDictValue);
        for (const item of items) dict.set(BigInt(item.itemIndex), item);
        const total = items.reduce((acc, i) => acc + itemAmount(i), 0n);
        await provider.internal(via, {
            value: opts?.value ?? total + toNano('0.05') * BigInt(items.length),
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(Opcodes.batchMint, 32)
                .storeUint(opts?.queryId ?? 0, 64)
                .storeRef(beginCell().storeDictDirect(dict).endCell())
                .endCell(),
        });
    }

    async sendChangeOwner(provider: ContractProvider, via: Sender, newOwner: Address, value = toNano('0.05')) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().storeUint(Opcodes.changeOwner, 32).storeUint(0, 64).storeAddress(newOwner).endCell(),
        });
    }

    async getCollectionData(provider: ContractProvider) {
        const res = (await provider.get('get_collection_data', [])).stack;
        return {
            nextItemIndex: res.readBigNumber(),
            collectionContent: res.readCell(),
            ownerAddress: res.readAddress(),
        };
    }

    /** Full item metadata URL as wallets/marketplaces resolve it (common prefix + item suffix). */
    async getNftContentUrl(provider: ContractProvider, index: number | bigint, individualContent: Cell): Promise<string> {
        const res = (
            await provider.get('get_nft_content', [
                { type: 'int', value: BigInt(index) },
                { type: 'cell', cell: individualContent },
            ])
        ).stack;
        const s = res.readCell().beginParse();
        if (s.loadUint(8) !== 1) throw new Error('Not off-chain content');
        const prefix = s.loadBuffer(s.remainingBits / 8).toString();
        const suffix = s.loadRef().beginParse().loadStringTail();
        return prefix + suffix;
    }

    async getNftAddressByIndex(provider: ContractProvider, index: number | bigint): Promise<Address> {
        const res = (await provider.get('get_nft_address_by_index', [{ type: 'int', value: BigInt(index) }])).stack;
        return res.readAddress();
    }
}

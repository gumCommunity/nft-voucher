import { Address, beginCell, Cell, Contract, contractAddress, ContractProvider, Dictionary, Sender, SendMode, toNano } from '@ton/core';
import { buildItemInit, itemAmount, MintDictValue, MintParams, Opcodes as CollectionOpcodes, RoyaltyParams, buildCollectionContent, royaltyParamsToCell } from './NftVoucherCollection';

export const MinterOpcodes = {
    mint: 0x2eb92088,
    batchMint: 0x76671074,
    setOperator: 0x25745a78,
    setPaused: 0x5ce84131,
    setLimit: 0x1907b1ec,
    setKind: 0x26796708,
    collectionCall: 0x75f071b1,
    withdrawTon: 0x1c88f70d,
    proposeAdmin: 0x3d8bf3c0,
    acceptAdmin: 0x26728af0,
};

export const MinterErrors = {
    notAdmin: 401,
    notOperator: 402,
    paused: 403,
    kindNotAllowed: 404,
    limitExceeded: 405,
    notEnoughTon: 406,
    notPendingAdmin: 407,
    badBatch: 408,
    unknownOp: 0xffff,
};

/** TON per voucher the operator must attach on top of the voucher amount (collection gas + deploy fees). */
export const MINT_FEE_PER_ITEM = toNano('0.03');
export const PERIOD_SECONDS = 86400;

/** Item content cell exactly as stored in the item ("0.json" etc.). */
export const kindContentCell = (suffix: string) => beginCell().storeStringTail(suffix).endCell();
export const kindHash = (suffix: string) => BigInt('0x' + kindContentCell(suffix).hash().toString('hex'));

export type NftVoucherMinterConfig = {
    admin: Address;
    operator: Address | null;
    collection: Address;
    limitPerDay: number;
    kinds: string[]; // allowed item content suffixes
    paused?: boolean;
};

export function nftVoucherMinterConfigToCell(c: NftVoucherMinterConfig): Cell {
    const kinds = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());
    for (const k of c.kinds) kinds.set(kindHash(k), beginCell().endCell());
    return beginCell()
        .storeAddress(c.admin)
        .storeAddress(c.operator)
        .storeBit(c.paused ?? false)
        .storeUint(c.limitPerDay, 32)
        .storeUint(0, 32) // period_start
        .storeUint(0, 32) // minted
        .storeRef(beginCell().storeAddress(c.collection).storeAddress(null).storeDict(kinds).endCell())
        .endCell();
}

export class NftVoucherMinter implements Contract {
    constructor(
        readonly address: Address,
        readonly init?: { code: Cell; data: Cell },
    ) {}

    static createFromAddress(address: Address) {
        return new NftVoucherMinter(address);
    }

    static createFromConfig(config: NftVoucherMinterConfig, code: Cell, workchain = 0) {
        const init = { code, data: nftVoucherMinterConfigToCell(config) };
        return new NftVoucherMinter(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, { value, sendMode: SendMode.PAY_GAS_SEPARATELY, body: beginCell().endCell() });
    }

    // ---------- operator ----------

    /** Mint one voucher. `value` defaults to voucherValue + storage reserve + 0.03 TON fee. */
    async sendMint(provider: ContractProvider, via: Sender, p: MintParams & { value?: bigint; queryId?: number }) {
        await provider.internal(via, {
            value: p.value ?? itemAmount(p) + MINT_FEE_PER_ITEM,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(MinterOpcodes.mint, 32)
                .storeUint(p.queryId ?? 0, 64)
                .storeUint(p.itemIndex, 64)
                .storeCoins(itemAmount(p))
                .storeRef(buildItemInit(p))
                .endCell(),
        });
    }

    /** Mint up to 249 vouchers in one message. */
    async sendBatchMint(provider: ContractProvider, via: Sender, items: MintParams[], opts?: { value?: bigint; queryId?: number }) {
        const dict = Dictionary.empty(Dictionary.Keys.BigUint(64), MintDictValue);
        for (const i of items) dict.set(BigInt(i.itemIndex), i);
        const total = items.reduce((a, i) => a + itemAmount(i) + MINT_FEE_PER_ITEM, 0n);
        await provider.internal(via, {
            value: opts?.value ?? total,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(MinterOpcodes.batchMint, 32)
                .storeUint(opts?.queryId ?? 0, 64)
                .storeRef(beginCell().storeDictDirect(dict).endCell())
                .endCell(),
        });
    }

    // ---------- admin ----------

    private async admin(provider: ContractProvider, via: Sender, op: number, build: (b: ReturnType<typeof beginCell>) => void, value = toNano('0.02')) {
        const b = beginCell().storeUint(op, 32).storeUint(0, 64);
        build(b);
        await provider.internal(via, { value, sendMode: SendMode.PAY_GAS_SEPARATELY, body: b.endCell() });
    }

    /** null disables operator minting. */
    sendSetOperator(provider: ContractProvider, via: Sender, operator: Address | null) {
        return this.admin(provider, via, MinterOpcodes.setOperator, (b) => b.storeAddress(operator));
    }

    sendSetPaused(provider: ContractProvider, via: Sender, paused: boolean) {
        return this.admin(provider, via, MinterOpcodes.setPaused, (b) => b.storeBit(paused));
    }

    sendSetLimit(provider: ContractProvider, via: Sender, limitPerDay: number) {
        return this.admin(provider, via, MinterOpcodes.setLimit, (b) => b.storeUint(limitPerDay, 32));
    }

    sendSetKind(provider: ContractProvider, via: Sender, suffix: string, allowed: boolean) {
        return this.admin(provider, via, MinterOpcodes.setKind, (b) => b.storeUint(kindHash(suffix), 256).storeBit(allowed));
    }

    /** Any message to the collection as its owner. */
    sendCollectionCall(provider: ContractProvider, via: Sender, body: Cell, value = toNano('0.05')) {
        return this.admin(provider, via, MinterOpcodes.collectionCall, (b) => b.storeRef(body), value);
    }

    /** Transfer the collection ownership (e.g. to a new minter or back to a wallet). */
    sendChangeCollectionOwner(provider: ContractProvider, via: Sender, newOwner: Address) {
        const body = beginCell().storeUint(CollectionOpcodes.changeOwner, 32).storeUint(0, 64).storeAddress(newOwner).endCell();
        return this.sendCollectionCall(provider, via, body);
    }

    /** Change royalty and/or metadata URLs of the collection (op 4). */
    sendChangeCollectionContent(
        provider: ContractProvider,
        via: Sender,
        opts: { collectionContentUrl: string; commonContentUrl: string; royaltyParams: RoyaltyParams },
    ) {
        const body = beginCell()
            .storeUint(CollectionOpcodes.changeContent, 32)
            .storeUint(0, 64)
            .storeRef(buildCollectionContent(opts.collectionContentUrl, opts.commonContentUrl))
            .storeRef(royaltyParamsToCell(opts.royaltyParams))
            .endCell();
        return this.sendCollectionCall(provider, via, body);
    }

    /** amount = 0 withdraws everything except 0.05 TON. */
    sendWithdrawTon(provider: ContractProvider, via: Sender, amount = 0n) {
        return this.admin(provider, via, MinterOpcodes.withdrawTon, (b) => b.storeCoins(amount));
    }

    /** Step 1 of the admin change; null cancels a pending change. */
    sendProposeAdmin(provider: ContractProvider, via: Sender, newAdmin: Address | null) {
        return this.admin(provider, via, MinterOpcodes.proposeAdmin, (b) => b.storeAddress(newAdmin));
    }

    /** Step 2: sent by the proposed admin. */
    sendAcceptAdmin(provider: ContractProvider, via: Sender) {
        return this.admin(provider, via, MinterOpcodes.acceptAdmin, () => {});
    }

    // ---------- get methods ----------

    async getMinterData(provider: ContractProvider) {
        const s = (await provider.get('get_minter_data', [])).stack;
        const admin = s.readAddress();
        const pendingAdmin = s.readAddressOpt();
        const operator = s.readAddressOpt();
        const collection = s.readAddress();
        const paused = s.readBoolean();
        const limit = s.readNumber();
        const mintedToday = s.readNumber();
        const periodEndsAt = s.readNumber();
        return { admin, pendingAdmin, operator, collection, paused, limit, mintedToday, remainingToday: Math.max(0, limit - mintedToday), periodEndsAt };
    }

    async getIsKindAllowed(provider: ContractProvider, suffix: string): Promise<boolean> {
        return (await provider.get('is_kind_allowed', [{ type: 'int', value: kindHash(suffix) }])).stack.readBoolean();
    }
}

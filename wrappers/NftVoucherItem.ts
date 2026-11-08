import { Address, beginCell, Cell, Contract, ContractProvider, Sender, SendMode, toNano } from '@ton/core';

export const ItemOpcodes = {
    transfer: 0x5fcc3d14,
    ownershipAssigned: 0x05138d91,
    excesses: 0xd53276db,
    getStaticData: 0x2fcb26a2,
    reportStaticData: 0x8b771735,
    destroy: 0x1f04537a,
};

export const ItemErrors = {
    notOwner: 401,
    notEnoughTon: 402,
    notFromCollection: 405,
    unknownOp: 0xffff,
};

export class NftVoucherItem implements Contract {
    constructor(readonly address: Address) {}

    static createFromAddress(address: Address) {
        return new NftVoucherItem(address);
    }

    /**
     * TEP-62 transfer. All fees are paid from `value`; the voucher value stays inside the item.
     * `value` must be >= 0.01 TON + forwardAmount + forward fees.
     */
    async sendTransfer(
        provider: ContractProvider,
        via: Sender,
        opts: {
            newOwner: Address;
            responseDestination?: Address | null;
            forwardAmount?: bigint;
            forwardPayload?: Cell;
            value?: bigint;
            queryId?: number;
        },
    ) {
        const body = beginCell()
            .storeUint(ItemOpcodes.transfer, 32)
            .storeUint(opts.queryId ?? 0, 64)
            .storeAddress(opts.newOwner)
            .storeAddress(opts.responseDestination ?? null)
            .storeBit(false) // no custom_payload
            .storeCoins(opts.forwardAmount ?? 0n);
        if (opts.forwardPayload) {
            body.storeBit(true).storeRef(opts.forwardPayload);
        } else {
            body.storeBit(false);
        }
        await provider.internal(via, {
            value: opts.value ?? toNano('0.05') + (opts.forwardAmount ?? 0n),
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: body.endCell(),
        });
    }

    /** Burn the voucher: the whole item balance is sent back to the sender (must be the owner). */
    async sendDestroy(provider: ContractProvider, via: Sender, opts?: { value?: bigint; queryId?: number }) {
        await provider.internal(via, {
            value: opts?.value ?? toNano('0.02'),
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(ItemOpcodes.destroy, 32)
                .storeUint(opts?.queryId ?? 0, 64)
                .endCell(),
        });
    }

    /** Top up the voucher value (empty-body transfer). */
    async sendTopUp(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, { value, sendMode: SendMode.PAY_GAS_SEPARATELY });
    }

    async sendGetStaticData(provider: ContractProvider, via: Sender, value = toNano('0.05'), queryId = 0) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().storeUint(ItemOpcodes.getStaticData, 32).storeUint(queryId, 64).endCell(),
        });
    }

    async getNftData(provider: ContractProvider) {
        const res = (await provider.get('get_nft_data', [])).stack;
        return {
            initialized: res.readBoolean(),
            index: res.readBigNumber(),
            collectionAddress: res.readAddress(),
            ownerAddress: res.readAddressOpt(), // null when not initialized or burned
            content: res.readCellOpt(),
        };
    }

    async getIsBurned(provider: ContractProvider): Promise<boolean> {
        return (await provider.get('is_burned', [])).stack.readBoolean();
    }

    async getVoucherValue(provider: ContractProvider): Promise<bigint> {
        return (await provider.get('get_voucher_value', [])).stack.readBigNumber();
    }
}

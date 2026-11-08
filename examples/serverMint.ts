// Example: a backend mints vouchers with the OPERATOR key through the minter (no Blueprint).
//
//   OPERATOR_MNEMONIC="word1 ... word24" MINTER=EQ... NETWORK=testnet \
//   npx ts-node examples/serverMint.ts <owner_address> <kind 0|1|2> <ton_inside>
//
// Keep the mnemonic only on the server (env / secret manager). If it leaks, the admin replaces
// the operator with manageMinter; until then at most `limit` vouchers per 24h can be minted.
//
// Mint ONE voucher at a time (or use sendBatchMint): the item index comes from the collection,
// and two mints with the same index produce only one voucher.
import { Address, toNano } from '@ton/core';
import { TonClient, WalletContractV4 } from '@ton/ton';
import { mnemonicToPrivateKey } from '@ton/crypto';
import { NftVoucherMinter } from '../wrappers/NftVoucherMinter';
import { NftVoucherCollection } from '../wrappers/NftVoucherCollection';
import { NftVoucherItem } from '../wrappers/NftVoucherItem';

const KINDS = ['0.json', '1.json', '2.json']; // 10 000 / 5 000 / 1 000 GUM
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function mintVoucher(client: TonClient, mnemonic: string[], minterAddress: Address, owner: Address, kind: number, tonInside: bigint) {
    const key = await mnemonicToPrivateKey(mnemonic);
    // use the same wallet version the operator address was created with (v4 here)
    const wallet = client.open(WalletContractV4.create({ workchain: 0, publicKey: key.publicKey }));
    const minter = client.open(NftVoucherMinter.createFromAddress(minterAddress));

    const m = await minter.getMinterData();
    if (!m.operator?.equals(wallet.address)) throw new Error(`${wallet.address.toString()} is not the operator`);
    if (m.paused) throw new Error('minter is paused');
    if (m.remainingToday < 1) throw new Error('daily limit reached');

    const collection = client.open(NftVoucherCollection.createFromAddress(m.collection));
    const { nextItemIndex } = await collection.getCollectionData();
    const seqno = await wallet.getSeqno();

    await minter.sendMint(wallet.sender(key.secretKey), {
        itemIndex: nextItemIndex,
        itemOwner: owner,
        itemContent: KINDS[kind],
        voucherValue: tonInside,
    });

    // wait until the wallet sent the message and the voucher exists
    for (let i = 0; i < 60 && (await wallet.getSeqno()) === seqno; i++) await sleep(2000);
    const item = client.open(NftVoucherItem.createFromAddress(await collection.getNftAddressByIndex(nextItemIndex)));
    for (let i = 0; i < 60; i++) {
        await sleep(2000);
        try {
            const d = await item.getNftData();
            if (d.initialized) return { index: nextItemIndex, address: item.address };
        } catch {
            /* not deployed yet */
        }
    }
    throw new Error('voucher not confirmed, check the minter transactions (limit / paused / kind)');
}

async function main() {
    const [owner, kind, ton] = process.argv.slice(2);
    const testnet = process.env.NETWORK !== 'mainnet';
    const client = new TonClient({
        endpoint: testnet ? 'https://testnet.toncenter.com/api/v2/jsonRPC' : 'https://toncenter.com/api/v2/jsonRPC',
        apiKey: process.env.TONCENTER_API_KEY,
    });
    const res = await mintVoucher(
        client,
        process.env.OPERATOR_MNEMONIC!.trim().split(/\s+/),
        Address.parse(process.env.MINTER!),
        Address.parse(owner),
        Number(kind),
        toNano(ton ?? '0.1'),
    );
    console.log(`minted #${res.index}: ${res.address.toString()}`);
}

if (require.main === module) {
    main().catch((e) => {
        console.error(e);
        process.exit(1);
    });
}

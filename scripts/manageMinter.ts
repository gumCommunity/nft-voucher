import { Address, fromNano, toNano } from '@ton/core';
import { NetworkProvider } from '@ton/blueprint';
import { NftVoucherCollection } from '../wrappers/NftVoucherCollection';
import { NftVoucherMinter } from '../wrappers/NftVoucherMinter';

const pct = (f: number, b: number) => `${(f * 100) / b}%`;

// Admin panel of the minter: operator, pause, limit, kinds, royalty, collection ownership, TON, admin change.
export async function run(provider: NetworkProvider, args: string[]) {
    const ui = provider.ui();
    const minterAddress = args[0] ? Address.parse(args[0]) : await ui.inputAddress('Minter address');
    const minter = provider.open(NftVoucherMinter.createFromAddress(minterAddress));
    let d;
    try {
        d = await minter.getMinterData();
    } catch {
        throw new Error(`${minterAddress.toString()} is not a voucher minter.`);
    }
    const collection = provider.open(NftVoucherCollection.createFromAddress(d.collection));
    const col = await collection.getCollectionData();
    const royalty = await collection.getRoyaltyParams();
    const ton = (await provider.provider(minterAddress).getState()).balance;
    const me = provider.sender().address!;

    ui.write(`Minter:          ${minterAddress.toString()}`);
    ui.write(`Admin:           ${d.admin.toString()}${d.pendingAdmin ? `  (pending: ${d.pendingAdmin.toString()})` : ''}`);
    ui.write(`Operator:        ${d.operator?.toString() ?? 'DISABLED'}`);
    ui.write(`Paused:          ${d.paused}`);
    ui.write(`Limit:           ${d.limit} / 24h, minted ${d.mintedToday}, left ${d.remainingToday} (window ends ${new Date(d.periodEndsAt * 1000).toISOString()})`);
    ui.write(`Collection:      ${d.collection.toString()}  owner: ${col.ownerAddress.equals(minterAddress) ? 'this minter' : col.ownerAddress.toString()}`);
    ui.write(`Vouchers minted: ${col.nextItemIndex}`);
    ui.write(`Royalty:         ${pct(royalty.royaltyFactor, royalty.royaltyBase)} to ${royalty.royaltyAddress.toString()}`);
    ui.write(`TON on minter:   ${Number(ton) / 1e9}`);
    ui.write(`Collection fees: ${fromNano(d.feePerItem)} TON per voucher + ${fromNano(d.feePerCall)} TON per message`);

    const isAdmin = d.admin.equals(me);
    const isPending = !!d.pendingAdmin && d.pendingAdmin.equals(me);
    if (isPending) {
        if (await ui.prompt('You are the proposed admin. Accept the admin role now?')) {
            await minter.sendAcceptAdmin(provider.sender());
            await waitFor(async () => (await minter.getMinterData()).admin.equals(me), ui, 'You are now the admin.');
        }
        return;
    }
    if (!isAdmin) throw new Error(`Your wallet ${me.toString()} is not the minter admin.`);
    if (!col.ownerAddress.equals(minterAddress)) ui.write('\n⚠ The minter does not own the collection, collection actions will fail.\n');

    const action = await ui.choose(
        'Action:',
        [
            'replace operator',
            'disable operator',
            d.paused ? 'unpause' : 'pause',
            'set daily limit',
            'allow voucher kind',
            'forbid voucher kind',
            'change royalty',
            'set collection fees',
            'transfer collection ownership',
            'withdraw TON',
            d.pendingAdmin ? 'cancel pending admin change' : 'propose new admin',
            'exit',
        ],
        (x) => x,
    );
    const s = provider.sender();
    switch (action) {
        case 'replace operator': {
            const a = await askAddressTwice(ui, 'New operator address (server wallet)');
            if (!(await ui.prompt(`Set operator to ${a.toString()}? The old operator stops working immediately.`))) return;
            await minter.sendSetOperator(s, a);
            await waitFor(async () => !!(await minter.getMinterData()).operator?.equals(a), ui, 'Operator replaced.');
            break;
        }
        case 'disable operator':
            if (!(await ui.prompt('Disable the operator (nobody can mint through the minter until a new one is set)?'))) return;
            await minter.sendSetOperator(s, null);
            await waitFor(async () => (await minter.getMinterData()).operator === null, ui, 'Operator disabled.');
            break;
        case 'pause':
        case 'unpause':
            await minter.sendSetPaused(s, action === 'pause');
            await waitFor(async () => (await minter.getMinterData()).paused === (action === 'pause'), ui, `Minter ${action}d.`);
            break;
        case 'set daily limit': {
            const n = Number((await ui.input(`New limit, vouchers per 24h (now ${d.limit})`)).trim());
            if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new Error('Enter a whole number.');
            await minter.sendSetLimit(s, n);
            await waitFor(async () => (await minter.getMinterData()).limit === n, ui, `Limit set to ${n}.`);
            break;
        }
        case 'allow voucher kind':
        case 'forbid voucher kind': {
            const k = (await ui.input('Kind (item content suffix, e.g. 0.json)')).trim();
            const allow = action === 'allow voucher kind';
            await minter.sendSetKind(s, k, allow);
            await waitFor(async () => (await minter.getIsKindAllowed(k)) === allow, ui, `${k} ${allow ? 'allowed' : 'forbidden'}.`);
            break;
        }
        case 'change royalty': {
            const input = (await ui.input(`New royalty percent, e.g. 0, 5 or 2.5 (now ${pct(royalty.royaltyFactor, royalty.royaltyBase)})`)).trim().replace(',', '.');
            const m = input.match(/^(\d+)(?:\.(\d))?$/);
            if (!m) throw new Error('Enter a number with at most one decimal.');
            const [factor, base] = m[2] !== undefined ? [Number(m[1]) * 10 + Number(m[2]), 1000] : [Number(m[1]), 100];
            if (factor > base) throw new Error('Royalty cannot exceed 100%.');
            const receiver = await ui.inputAddress(`Royalty receiver (Enter = keep ${royalty.royaltyAddress.toString()})`, royalty.royaltyAddress);
            if (!(await ui.prompt(`Set royalty to ${pct(factor, base)} paid to ${receiver.toString()}?`))) return;
            const urls = await collection.getContentUrls();
            await minter.sendChangeCollectionContent(s, { ...urls, royaltyParams: { royaltyFactor: factor, royaltyBase: base, royaltyAddress: receiver } });
            await waitFor(async () => {
                const r = await collection.getRoyaltyParams();
                return r.royaltyFactor === factor && r.royaltyBase === base && r.royaltyAddress.equals(receiver);
            }, ui, 'Royalty changed.');
            break;
        }
        case 'set collection fees': {
            ui.write('TON the minter forwards to the collection on top of voucher amounts. Too low = the collection pays the difference');
            ui.write('from its own balance; when that runs out, mints bounce (TON back to the operator); too high = the surplus stays on the collection.');
            const item = toNano((await ui.input(`Per voucher, TON (now ${fromNano(d.feePerItem)})`)).trim() || fromNano(d.feePerItem));
            const call = toNano((await ui.input(`Per message, TON (now ${fromNano(d.feePerCall)})`)).trim() || fromNano(d.feePerCall));
            if (!(await ui.prompt(`Set fees to ${fromNano(item)} per voucher + ${fromNano(call)} per message?`))) return;
            await minter.sendSetFees(s, item, call);
            await waitFor(async () => {
                const x = await minter.getMinterData();
                return x.feePerItem === item && x.feePerCall === call;
            }, ui, 'Fees updated.');
            break;
        }
        case 'transfer collection ownership': {
            ui.write('⚠ The new owner gets the right to mint. Use a new minter address (rotation) or your wallet.');
            ui.write('⚠ One step, effective immediately: a wrong address means minting is lost forever.');
            const a = await askAddressTwice(ui, 'New collection owner');
            if (a.equals(minterAddress) || a.equals(d.collection)) throw new Error('That is the minter or the collection itself. Nothing sent.');
            if (!(await ui.prompt(`Transfer the collection ${d.collection.toString()} to ${a.toString()}?`))) return;
            await minter.sendChangeCollectionOwner(s, a);
            await waitFor(async () => (await collection.getCollectionData()).ownerAddress.equals(a), ui, `Collection owner is now ${a.toString()}.`);
            break;
        }
        case 'withdraw TON': {
            const a = (await ui.input('Amount in TON (empty = everything except 0.05)')).trim();
            await minter.sendWithdrawTon(s, a ? toNano(a) : 0n);
            ui.write('Sent.');
            break;
        }
        case 'propose new admin': {
            ui.write('The new admin must then run manageMinter from their wallet and accept. Until then you stay the admin.');
            const a = await askAddressTwice(ui, 'New admin address');
            if (!(await ui.prompt(`Propose ${a.toString()} as the new admin?`))) return;
            await minter.sendProposeAdmin(s, a);
            await waitFor(async () => !!(await minter.getMinterData()).pendingAdmin?.equals(a), ui, 'Proposed. Waiting for the new admin to accept.');
            break;
        }
        case 'cancel pending admin change':
            await minter.sendProposeAdmin(s, null);
            await waitFor(async () => (await minter.getMinterData()).pendingAdmin === null, ui, 'Pending admin change cancelled.');
            break;
    }
}

async function askAddressTwice(ui: ReturnType<NetworkProvider['ui']>, label: string): Promise<Address> {
    const a = await ui.inputAddress(label);
    const b = await ui.inputAddress(`Repeat: ${label}`);
    if (!a.equals(b)) throw new Error('Addresses do not match, nothing sent.');
    return a;
}

async function waitFor(check: () => Promise<boolean>, ui: ReturnType<NetworkProvider['ui']>, done: string) {
    for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        try {
            if (await check()) {
                ui.write(done);
                return;
            }
        } catch {
            /* indexer lag, retry */
        }
    }
    ui.write('Not confirmed yet, check the contract in an explorer.');
}

// Network fee changes in the sandbox: multiplies basechain gas and forward prices (config params 21 and 25).
import { Blockchain, loadConfig, updateConfig } from '@ton/sandbox';

export function scaleFees(blockchain: Blockchain, k: bigint) {
    const c = loadConfig(blockchain.config) as any;
    const g = c[21];
    const f = c[25];
    const gas = {
        ...g,
        anon0: { ...g.anon0, flat_gas_price: g.anon0.flat_gas_price * k, other: { ...g.anon0.other, gas_price: g.anon0.other.gas_price * k } },
    };
    const fwd = { ...f, anon0: { ...f.anon0, lump_price: f.anon0.lump_price * k, bit_price: f.anon0.bit_price * k, _cell_price: f.anon0._cell_price * k } };
    blockchain.setConfig(updateConfig(blockchain.config, gas, fwd));
}

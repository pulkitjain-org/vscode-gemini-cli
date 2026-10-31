/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// A sample program for Debug mode in the real app (DEBUG_MODE.md, Testing):
// a shop's cart server with a discount bug. Applying the code SAVE10 and
// then reloading the cart applies the discount a second time, so a cart of
// 9.00 shows 7.29 instead of 8.10. TypeScript, which Node runs as it is
// (upstream's hygiene allows no new .js files).
//
//   node server.mts           then open http://localhost:3001/cart?code=SAVE10 twice
//   node server.mts --check   prints both totals and exits 1 while the bug is there

import * as http from 'node:http';

interface Item {
	readonly name: string;
	readonly price: number;
}

const codes: Readonly<Record<string, number>> = { SAVE10: 0.1 };
const cart: { readonly items: readonly Item[]; readonly discounts: number[] } = { items: [{ name: 'Mug', price: 4.5 }, { name: 'Tea', price: 4.5 }], discounts: [] };

function subtotal(items: readonly Item[]): number {
	return items.reduce((sum, item) => sum + item.price, 0);
}

function applyDiscount(code: string): void {
	const rate = codes[code];
	if (rate === undefined) {
		return;
	}
	// The bug: the code is pushed on every request, not once per cart.
	cart.discounts.push(rate);
}

function total(): number {
	let value = subtotal(cart.items);
	for (const rate of cart.discounts) {
		value = value * (1 - rate);
	}
	return Math.round(value * 100) / 100;
}

function handle(url: URL): { readonly items: number; readonly total: number } {
	const code = url.searchParams.get('code');
	if (code) {
		applyDiscount(code);
	}
	return { items: cart.items.length, total: total() };
}

if (process.argv.includes('--check')) {
	const first = handle(new URL('http://localhost/cart?code=SAVE10'));
	const second = handle(new URL('http://localhost/cart?code=SAVE10'));
	console.log(`first ${first.total}, after reload ${second.total}`);
	process.exitCode = first.total === second.total ? 0 : 1;
} else {
	const port = Number(process.env.PORT ?? 3001);
	http.createServer((req, res) => {
		const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
		if (url.pathname !== '/cart') {
			res.writeHead(404).end();
			return;
		}
		res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(handle(url)));
	}).listen(port, '127.0.0.1', () => console.log(`listening on ${port}`));
}

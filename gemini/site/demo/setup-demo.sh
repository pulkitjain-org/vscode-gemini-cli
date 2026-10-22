#!/bin/bash
#---------------------------------------------------------------------------------------------
#  Copyright (c) pulkitjain-org and contributors. All rights reserved.
#  Licensed under the MIT License. See License.txt in the project root for license information.
#---------------------------------------------------------------------------------------------

# Creates the demo for the site's screenshots and clips in DEMO_ROOT, a path without your user
# name so it never shows in a shot (default /Users/Shared/geminicode-shots):
#
#   acme-checkout/, billing-api/   two repositories whose `origin` is the demo GitLab
#   acme.code-workspace            both folders in one workspace
#   gitlab/acme/*.git              the demo GitLab's copies, served by demo-tools.mts
#   profile/                       a clean GeminiCode profile in GeminiCode Dark and Light
#
# The repositories carry .gemini/geminicode-tools.json, so Connections finds the demo Jira,
# GitLab and SonarQube on its own and asks only for a token (any text works).
#
#   bash gemini/site/demo/setup-demo.sh           # create everything (refuses if the demo is already there)
#   bash gemini/site/demo/setup-demo.sh --reset   # delete the demo and start again (keeps shots)
#
# Needs git, node and npm (for vitest), and python3 (for the cart page server).
set -euo pipefail

KIT="$(cd "$(dirname "$0")" && pwd)"
ROOT="${DEMO_ROOT:-/Users/Shared/geminicode-shots}"
DEMO="acme-checkout billing-api acme.code-workspace profile gitlab"
JIRA="http://localhost:${DEMO_JIRA_PORT:-8781}"
GITLAB="http://localhost:${DEMO_GITLAB_PORT:-8782}"
SONAR="http://localhost:${DEMO_SONAR_PORT:-8783}"

if [ "${1:-}" = "--reset" ]; then
	for item in $DEMO; do
		rm -rf "${ROOT:?}/$item"
	done
fi
for item in $DEMO; do
	if [ -e "$ROOT/$item" ]; then
		echo "$ROOT/$item already exists. Run with --reset to start again." >&2
		exit 1
	fi
done
mkdir -p "$ROOT"
cd "$ROOT"

# Commits as one of the demo's people: commit_as <name> <message>
commit_as() {
	local email
	email="$(echo "$1" | tr 'A-Z ' 'a-z.')@acme.test"
	git -c user.name="$1" -c user.email="$email" add -A
	git -c user.name="$1" -c user.email="$email" commit -q -m "$2"
}

# The team's defaults for its tools, so each person only pastes a token.
tools_file() {
	mkdir -p .gemini
	cat > .gemini/geminicode-tools.json <<EOF
{
	"jira": { "site": "$JIRA", "projects": ["ACME"] },
	"gitlab": { "url": "$GITLAB", "releaseBranches": "release/*", "defaultTarget": "main" },
	"sonar": { "url": "$SONAR", "projectKey": "$1" }
}
EOF
	echo "sonar.projectKey=$1" > sonar-project.properties
}

# Puts the repository in the demo GitLab and makes that its origin: publish <repo> <local branches to keep>...
publish() {
	local repo="$1" bare="$ROOT/gitlab/acme/$1.git"
	shift
	git init -q --bare -b main "$bare"
	git -c push.negotiate=false push -q "$bare" --all
	git -c push.negotiate=false push -q "$bare" --tags
	git remote add origin "$GITLAB/acme/$repo.git"
	git fetch -q "$bare" '+refs/heads/*:refs/remotes/origin/*'
	git branch -q --set-upstream-to=origin/main main
	for branch in $(git for-each-ref refs/heads --format='%(refname:short)'); do
		case " main $* " in
		*" $branch "*) ;;
		*) git branch -q -D "$branch" ;;
		esac
	done
	git checkout -q main
}

# ---------------------------------------------------------------- acme-checkout
mkdir -p acme-checkout && cd acme-checkout
mkdir -p src/cart src/billing test web .gemini/commands/git .gemini/skills/release-notes

cat > package.json <<'EOF'
{
  "name": "acme-checkout",
  "version": "1.4.2",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "test": "vitest run"
  },
  "devDependencies": {
    "vitest": "3.2.4",
    "typescript": "5.9.3"
  }
}
EOF
echo "20" > .nvmrc
cat > tsconfig.json <<'EOF'
{
  "compilerOptions": { "target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler", "strict": true, "noEmit": true },
  "include": ["src", "test"]
}
EOF
printf 'node_modules/\ncoverage/\n' > .gitignore

cat > src/cart/types.ts <<'EOF'
export interface CartItem {
	sku: string;
	name: string;
	/** In dollars, such as 0.1 for ten cents. */
	price: number;
	quantity: number;
}
EOF

cat > src/cart/total.ts <<'EOF'
import { CartItem } from './types';
import { applyDiscount } from './discount';

/** The amount to charge for a cart, in dollars. */
export function cartTotal(items: CartItem[], code?: string): number {
	let subtotal = 0;
	for (const item of items) {
		subtotal += item.price * item.quantity;
	}
	const discounted = code ? applyDiscount(subtotal, code) : subtotal;
	const tax = discounted * 0.0825;
	return discounted + tax;
}
EOF

cat > src/cart/discount.ts <<'EOF'
/** Discount codes. SAVE10 takes 10% off; TAKE5 takes $5 off. */
const CODES: Record<string, (amount: number) => number> = {
	SAVE10: amount => amount * 0.9,
	TAKE5: amount => Math.max(0, amount - 5),
};

export function applyDiscount(amount: number, code: string): number {
	const discount = CODES[code.toUpperCase()];
	return discount ? discount(amount) : amount;
}

/** Applies several codes. TAKE5 should come off before SAVE10, but they run in the order given. */
export function applyDiscounts(amount: number, codes: string[]): number {
	return codes.reduce((total, code) => applyDiscount(total, code), amount);
}
EOF

cat > src/cart/tax.ts <<'EOF'
export const TAX_RATE = 0.0825;

/** Sales tax on an amount in dollars. */
export function taxFor(amount: number): number {
	return amount * TAX_RATE;
}
EOF

cat > src/billing/invoice.ts <<'EOF'
export interface Invoice {
	invoice_id: string;
	customer_name: string;
	issued_at: string;
	total_amount: number;
	is_paid: boolean;
}

export function describeInvoice(invoice: Invoice): string {
	const status = invoice.is_paid ? 'paid' : 'due';
	return `${invoice.invoice_id} for ${invoice.customer_name}: $${invoice.total_amount.toFixed(2)} (${status})`;
}

export function overdue(invoices: Invoice[], today: Date): Invoice[] {
	return invoices.filter(invoice => !invoice.is_paid && new Date(invoice.issued_at) < today);
}
EOF

cat > test/total.test.ts <<'EOF'
import { expect, test } from 'vitest';
import { cartTotal } from '../src/cart/total';

test('adds up items', () => {
	expect(cartTotal([{ sku: 'a', name: 'Notebook', price: 2, quantity: 3 }])).toBeCloseTo(6.495);
});

test('an empty cart costs nothing', () => {
	expect(cartTotal([])).toBe(0);
});

test('applies a discount code', () => {
	expect(cartTotal([{ sku: 'b', name: 'Pen', price: 10, quantity: 1 }], 'SAVE10')).toBeCloseTo(9.7425);
});

test('ignores an unknown code', () => {
	expect(cartTotal([{ sku: 'b', name: 'Pen', price: 10, quantity: 1 }], 'NOPE')).toBeCloseTo(10.825);
});
EOF

cat > test/discount.test.ts <<'EOF'
import { expect, test } from 'vitest';
import { applyDiscount, applyDiscounts } from '../src/cart/discount';

test('SAVE10 takes 10% off', () => expect(applyDiscount(20, 'SAVE10')).toBe(18));
test('TAKE5 takes $5 off', () => expect(applyDiscount(20, 'TAKE5')).toBe(15));
test('codes are not case sensitive', () => expect(applyDiscount(20, 'save10')).toBe(18));
test('TAKE5 never goes below zero', () => expect(applyDiscount(3, 'TAKE5')).toBe(0));
test('unknown codes do nothing', () => expect(applyDiscount(20, 'HELLO')).toBe(20));
test('one code in a list', () => expect(applyDiscounts(20, ['SAVE10'])).toBe(18));
test('no codes', () => expect(applyDiscounts(20, [])).toBe(20));
test('SAVE10 then TAKE5', () => expect(applyDiscounts(20, ['SAVE10', 'TAKE5'])).toBe(13));
test('TAKE5 then SAVE10', () => expect(applyDiscounts(20, ['TAKE5', 'SAVE10'])).toBe(13.5));
EOF

cat > test/tax.test.ts <<'EOF'
import { expect, test } from 'vitest';
import { TAX_RATE, taxFor } from '../src/cart/tax';

test('the rate is 8.25%', () => expect(TAX_RATE).toBe(0.0825));
test('tax on $100', () => expect(taxFor(100)).toBeCloseTo(8.25));
test('tax on nothing', () => expect(taxFor(0)).toBe(0));
test('tax on $19.99', () => expect(taxFor(19.99)).toBeCloseTo(1.649));
test('tax on $0.30', () => expect(taxFor(0.3)).toBeCloseTo(0.02475));
test('tax is never negative', () => expect(taxFor(-1)).toBeLessThan(0));
test('tax on $1', () => expect(taxFor(1)).toBeCloseTo(0.0825));
EOF

# A slow suite, so the "Working" strip stays on screen for a few seconds while you take the shot.
cat > test/checkout.test.ts <<'EOF'
import { expect, test } from 'vitest';
import { cartTotal } from '../src/cart/total';

const pencils = (n: number) => [{ sku: 'p', name: 'Pencil', price: 0.1, quantity: n }];
const gateway = () => new Promise(resolve => setTimeout(resolve, 600));

for (let n = 1; n <= 14; n++) {
	test(`checkout with ${n} pencil${n === 1 ? '' : 's'}`, async () => {
		await gateway();
		expect(cartTotal(pencils(n))).toBeGreaterThan(0);
	}, 15_000);
}
EOF

cat > web/index.html <<'EOF'
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Acme Checkout</title>
<style>
	body { font: 15px/1.5 -apple-system, system-ui, sans-serif; margin: 0; background: #f6f6f4; color: #1d1d1f; }
	main { max-width: 520px; margin: 48px auto; background: #fff; border: 1px solid #e3e3e0; border-radius: 12px; padding: 24px 28px; }
	h1 { font-size: 20px; margin: 0 0 16px; }
	.row { display: flex; align-items: center; gap: 12px; padding: 10px 0; border-bottom: 1px solid #eee; }
	.row span:first-child { flex: 1; }
	button { font: inherit; border: 1px solid #d0d0cc; background: #fff; border-radius: 8px; padding: 4px 12px; cursor: pointer; }
	.total { display: flex; justify-content: space-between; font-weight: 600; font-size: 18px; padding-top: 16px; }
	#checkout { margin-top: 18px; width: 100%; padding: 10px; background: #1d1d1f; color: #fff; border: 0; }
</style>
</head>
<body>
<main>
	<h1>Your cart</h1>
	<div class="row"><span>Pencil</span><span>$0.10</span><button data-sku="pencil" data-price="0.1">Add</button><span id="q-pencil">0</span></div>
	<div class="row"><span>Notebook</span><span>$2.00</span><button data-sku="notebook" data-price="2">Add</button><span id="q-notebook">0</span></div>
	<div class="total"><span>Subtotal</span><span id="total">$0</span></div>
	<button id="checkout">Checkout</button>
	<p id="status"></p>
</main>
<script>
	// Same floating-point bug as src/cart/total.ts: three pencils show $0.30000000000000004.
	const cart = {};
	document.querySelectorAll('button[data-sku]').forEach(button => button.addEventListener('click', () => {
		const sku = button.dataset.sku;
		cart[sku] = cart[sku] || { price: Number(button.dataset.price), quantity: 0 };
		cart[sku].quantity++;
		document.getElementById('q-' + sku).textContent = cart[sku].quantity;
		let total = 0;
		for (const item of Object.values(cart)) {
			for (let i = 0; i < item.quantity; i++) { total += item.price; }
		}
		document.getElementById('total').textContent = '$' + total;
	}));
	document.getElementById('checkout').addEventListener('click', () => {
		document.getElementById('status').textContent = 'Order placed for ' + document.getElementById('total').textContent;
	});
</script>
</body>
</html>
EOF

cat > GEMINI.md <<'EOF'
# Acme Checkout

- Money is in dollars at the edges and must be exact: round to whole cents once, at the end.
- Run `npm test` after every change. Tests live in `test/` and use Vitest.
- TypeScript, tabs for indentation, no new dependencies without asking.
EOF

cat > .gemini/commands/git/commit.toml <<'EOF'
description = "Write a commit message for the staged changes"
prompt = """
Write a one-line commit message, under 60 characters, for this diff:

!{git diff --staged}
"""
EOF

cat > .gemini/skills/release-notes/SKILL.md <<'EOF'
---
name: release-notes
description: Write release notes for Acme Checkout from the commits since the last tag.
---

1. Run `git log --oneline $(git describe --tags --abbrev=0)..HEAD`.
2. Group the changes into Fixes and Improvements.
3. Write one plain sentence per change, for shoppers, not developers.
EOF

cat > .gitlab-ci.yml <<'EOF'
image: node:20
stages: [test]
lint:
  stage: test
  script: [npm ci, npm run lint --if-present]
test:
  stage: test
  script: [npm ci, npm test]
EOF

cat > README.md <<'EOF'
# Acme Checkout

The cart, discount and tax code behind the Acme store. `npm test` runs the tests; `python3 -m http.server 5173 -d web` serves the cart page.
EOF

tools_file acme-checkout
echo "Installing vitest (one time)..."
npm install --silent --no-audit --no-fund
git init -q -b main
commit_as "Diego Alvarez" "Acme Checkout 1.4.2"
git tag v1.4.2
git branch release/1.4
git branch fix/invoice-names
printf '\nThe cart page shows the tax on its own line from 1.5.0 (ACME-405).\n' >> README.md
commit_as "Sam Rivera" "Show tax on the cart page"
git branch release/1.5

# ACME-418, Priya's merge request that waits for Sam's review.
git checkout -q -b ACME-418-round-cents
cat > src/cart/total.ts <<'EOF'
import { CartItem } from './types';
import { applyDiscount } from './discount';
import { TAX_RATE } from './tax';

/** The amount to charge for a cart, in dollars, rounded to whole cents. */
export function cartTotal(items: CartItem[], code?: string): number {
	let subtotal = 0;
	for (const item of items) {
		subtotal += item.price * item.quantity;
	}
	const discounted = code ? applyDiscount(subtotal, code) : subtotal;
	const tax = discounted * TAX_RATE;
	// Round once, at the end, so the cents add up.
	return Math.round((discounted + tax) * 100) / 100;
}
EOF
cat > test/total.test.ts <<'EOF'
import { expect, test } from 'vitest';
import { cartTotal } from '../src/cart/total';

test('adds up items', () => {
	expect(cartTotal([{ sku: 'a', name: 'Notebook', price: 2, quantity: 3 }])).toBe(6.5);
});

test('an empty cart costs nothing', () => {
	expect(cartTotal([])).toBe(0);
});

test('applies a discount code', () => {
	expect(cartTotal([{ sku: 'b', name: 'Pen', price: 10, quantity: 1 }], 'SAVE10')).toBe(9.74);
});

test('ignores an unknown code', () => {
	expect(cartTotal([{ sku: 'b', name: 'Pen', price: 10, quantity: 1 }], 'NOPE')).toBe(10.83);
});

test('rounds to whole cents', () => {
	expect(cartTotal([{ sku: 'p', name: 'Pencil', price: 0.1, quantity: 3 }])).toBe(0.32);
});
EOF
perl -pi -e 's/\x27\$\x27 \+ total;/\x27\$\x27 + total.toFixed(2);/' web/index.html
commit_as "Priya Nair" "Round cart totals to whole cents"
git checkout -q main

# ACME-421, Sam's merge request whose pipeline failed: one test still expects the old order.
git checkout -q -b ACME-421-discount-order
cat > src/cart/discount.ts <<'EOF'
/** Discount codes. SAVE10 takes 10% off; TAKE5 takes $5 off. */
const CODES: Record<string, (amount: number) => number> = {
	SAVE10: amount => amount * 0.9,
	TAKE5: amount => Math.max(0, amount - 5),
};

export function applyDiscount(amount: number, code: string): number {
	const discount = CODES[code.toUpperCase()];
	return discount ? discount(amount) : amount;
}

/** Applies several codes, the fixed ones first. */
export function applyDiscounts(amount: number, codes: string[]): number {
	const ordered = [...codes].sort((a, b) => (a.toUpperCase() === 'TAKE5' ? -1 : 0) - (b.toUpperCase() === 'TAKE5' ? -1 : 0));
	return ordered.reduce((total, code) => applyDiscount(total, code), amount);
}
EOF
cat >> test/discount.test.ts <<'EOF'
test('TAKE5 comes off first whatever the order', () => expect(applyDiscounts(20, ['save10', 'take5'])).toBe(13.5));
EOF
commit_as "Sam Rivera" "Apply TAKE5 before SAVE10"
git checkout -q main
publish acme-checkout ACME-421-discount-order fix/invoice-names
cd ..

# ---------------------------------------------------------------- billing-api
mkdir -p billing-api/src billing-api/test && cd billing-api
cat > package.json <<'EOF'
{
  "name": "billing-api",
  "version": "2.3.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run"
  },
  "devDependencies": {
    "vitest": "3.2.4"
  }
}
EOF
printf 'node_modules/\n' > .gitignore
cat > src/upload.ts <<'EOF'
/** Uploads an invoice PDF to storage. Fails on the first network error. */
export async function uploadInvoice(url: string, pdf: Uint8Array): Promise<void> {
	const response = await fetch(url, { method: 'PUT', body: pdf });
	if (!response.ok) {
		throw new Error(`Upload failed: HTTP ${response.status}`);
	}
}
EOF
cat > src/pdf.ts <<'EOF'
/** Where the invoice footer starts on an A4 page, in points from the top. */
export const PAGE_HEIGHT = 842;
export const FOOTER_HEIGHT = 48;

export function footerTop(): number {
	return PAGE_HEIGHT;
}
EOF
cat > README.md <<'EOF'
# Billing API

Invoices, their PDFs and the upload to storage. `npm test` runs the tests.
EOF
tools_file billing-api
git init -q -b main
commit_as "Diego Alvarez" "Billing API 2.3.0"
git branch release/2.3

# ACME-412, Sam's merge request that is approved and can merge.
git checkout -q -b ACME-412-upload-retries
cat > src/upload.ts <<'EOF'
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Uploads an invoice PDF to storage, retrying a network error, a 429 or a 5xx up to three times. */
export async function uploadInvoice(url: string, pdf: Uint8Array, wait: (ms: number) => Promise<unknown> = sleep): Promise<void> {
	let last = 'no answer';
	for (let attempt = 0; attempt < 4; attempt++) {
		if (attempt) {
			await wait(1000 * 2 ** (attempt - 1));
		}
		try {
			const response = await fetch(url, { method: 'PUT', body: pdf });
			if (response.ok) {
				return;
			}
			last = `HTTP ${response.status}`;
			if (response.status < 500 && response.status !== 429) {
				break;
			}
		} catch (err) {
			last = err instanceof Error ? err.message : String(err);
		}
	}
	throw new Error(`Upload failed: ${last}`);
}
EOF
cat > test/upload.test.ts <<'EOF'
import { afterEach, expect, test, vi } from 'vitest';
import { uploadInvoice } from '../src/upload';

const noWait = async () => undefined;
afterEach(() => vi.unstubAllGlobals());

test('retries a 503', async () => {
	const fetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 503 })).mockResolvedValueOnce(new Response(null, { status: 200 }));
	vi.stubGlobal('fetch', fetch);
	await uploadInvoice('https://storage.acme.test/inv-1', new Uint8Array(), noWait);
	expect(fetch).toHaveBeenCalledTimes(2);
});

test('fails at once on a 403', async () => {
	vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 403 })));
	await expect(uploadInvoice('https://storage.acme.test/inv-1', new Uint8Array(), noWait)).rejects.toThrow('HTTP 403');
});
EOF
commit_as "Sam Rivera" "Retry invoice uploads with backoff"
git checkout -q main

# ACME-409, Mei's draft that asks Sam to review.
git checkout -q -b ACME-409-pdf-footer
perl -pi -e 's/return PAGE_HEIGHT;/return PAGE_HEIGHT - FOOTER_HEIGHT;/' src/pdf.ts
commit_as "Mei Chen" "Keep the invoice PDF footer on the page"
git checkout -q main
publish billing-api ACME-412-upload-retries
cd ..

# ---------------------------------------------------------------- workspace and profile
cat > acme.code-workspace <<'EOF'
{
	"folders": [
		{ "path": "acme-checkout" },
		{ "path": "billing-api" }
	]
}
EOF

mkdir -p profile/User
cat > profile/User/settings.json <<'EOF'
{
	// Follow the macOS appearance, so `shots.sh theme dark|light` flips the app too.
	"window.autoDetectColorScheme": true,
	"workbench.preferredDarkColorTheme": "GeminiCode Dark",
	"workbench.preferredLightColorTheme": "GeminiCode Light",
	"window.zoomLevel": 0,
	"workbench.tips.enabled": false,
	"workbench.startupEditor": "none",
	"update.mode": "none",
	"gemini.app.checkForUpdates": false,
	"gemini.cli.checkForUpdates": false,
	"gemini.notifications.enabled": false,
	"git.openRepositoryInParentFolders": "never",
	"security.workspace.trust.enabled": false
}
EOF

echo
echo "Done: $ROOT"
echo "Start the demo Jira, GitLab and SonarQube:  bash \"$KIT/shots.sh\" tools"
echo "Start the cart page when you need it:       python3 -m http.server 5173 -d \"$ROOT/acme-checkout/web\""
echo "Then launch GeminiCode:                     bash \"$KIT/shots.sh\" launch-dev"

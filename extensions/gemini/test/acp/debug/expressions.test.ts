/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { checkExpression, environmentGuard, isPlainCondition, isPlainPath, joinCondition, languageOf } from '../../../src/acp/debug/expressions';

describe('expressions', () => {
	it('knows a plain path per language', () => {
		expect({
			js: ['cart.total', 'a?.b', 'a["k"]', 'items[0].price', 'a?.[0]', '$el.value', 'this.state'].map(e => isPlainPath(e, 'javascript')),
			jsNot: ['items.map(i => i.price)', 'a + b', 'a = 1', '`${a}`', 'a[b]', 'deleteAll()', '', 'a.b.'].map(e => isPlainPath(e, 'javascript')),
			python: ['order.total', 'items[0]', 'd["k"]', `d['k']`, 'self.cart'].map(e => isPlainPath(e, 'python')),
			pythonNot: ['a?.b', 'len(items)', '$x', 'a.b()'].map(e => isPlainPath(e, 'python')),
			go: ['req.URL.Path', 'items[0]', 'm["k"]'].map(e => isPlainPath(e, 'go')),
			goNot: ['a?.b', '*p', 'f()'].map(e => isPlainPath(e, 'go')),
			java: ['this.cart.total', 'items[0]'].map(e => isPlainPath(e, 'java')),
			javaNot: ['m["k"]', 'a?.b', 'get()'].map(e => isPlainPath(e, 'java')),
		}).toEqual({
			js: [true, true, true, true, true, true, true],
			jsNot: [false, false, false, false, false, false, false, false],
			python: [true, true, true, true, true],
			pythonNot: [false, false, false, false],
			go: [true, true, true],
			goNot: [false, false, false],
			java: [true, true],
			javaNot: [false, false, false],
		});
	});

	it('asks for anything else, with why, and treats the environment specially', () => {
		expect([
			checkExpression('cart.total', 'typescript'),
			checkExpression('items.map(i => i.price).join(",")', 'typescript'),
			checkExpression('a = 1', 'javascript'),
			checkExpression('`${a}`', 'javascript'),
			checkExpression('fetch(url)', 'javascript'),
			checkExpression('a + 1', 'javascript'),
			checkExpression('process.env.PORT', 'javascript'),
			checkExpression('process.env["PORT"]', 'javascript'),
			checkExpression('process.env', 'javascript'),
			checkExpression('os.environ', 'python'),
			checkExpression('os.environ["PORT"]', 'python'),
			checkExpression('System.getenv("PORT")', 'java'),
			checkExpression('  ', 'go'),
		]).toEqual([
			{ kind: 'plain' },
			{ kind: 'asks', why: 'It defines a function.' },
			{ kind: 'asks', why: 'It assigns.' },
			{ kind: 'asks', why: 'It is a template string.' },
			{ kind: 'asks', why: 'It calls something.' },
			{ kind: 'asks', why: 'It is not a plain property path (a.b[0].c).' },
			{ kind: 'asks', why: 'process.env holds the program\'s environment, which can include credentials.' },
			{ kind: 'asks', why: 'process.env holds the program\'s environment, which can include credentials.' },
			{ kind: 'refused', why: 'The whole environment is never shown: name the one variable you need, such as process.env.PORT.' },
			{ kind: 'refused', why: 'The whole environment is never shown: name the one variable you need, such as process.env.PORT.' },
			{ kind: 'asks', why: 'os.environ holds the program\'s environment, which can include credentials.' },
			{ kind: 'refused', why: 'The whole environment is never shown: name the one variable you need, such as process.env.PORT.' },
			{ kind: 'refused', why: 'The expression is empty.' },
		]);
	});

	it('accepts a condition that only compares plain paths and literals, joined by the language\'s and', () => {
		expect({
			js: ['n > 1', 'cart.items.length === 2 && user.id !== "x"', 'a == null', '(a > 1) && (b < 2)'].map(c => isPlainCondition(c, 'javascript')),
			jsNot: ['n', 'f() > 1', 'a > 1 || b', 'a > 1 and b', 'process.env > 1', 'a = 1'].map(c => isPlainCondition(c, 'javascript')),
			python: ['n > 1 and x is None', 'order.total >= 10'].map(c => isPlainCondition(c, 'python')),
			pythonNot: ['n > 1 && x', 'len(x) > 1'].map(c => isPlainCondition(c, 'python')),
		}).toEqual({
			js: [true, true, true, true],
			jsNot: [false, false, false, false, false, false],
			python: [true, true],
			pythonNot: [false, false],
		});
	});

	it('joins the environment guard with the agent\'s condition in the language\'s syntax', () => {
		expect({
			node: joinCondition('javascript', environmentGuard('javascript', 'gc7f3a'), 'n > 1'),
			python: joinCondition('python', environmentGuard('python', 'gc7f3a'), 'n > 1'),
			guardOnly: joinCondition('typescript', environmentGuard('typescript', 'gc7f3a'), ''),
			conditionOnly: joinCondition('go', environmentGuard('go', 'gc7f3a'), 'n > 1'),
			none: joinCondition('java', undefined, undefined),
			languages: ['a.ts', 'b.tsx', 'c.mjs', 'd.py', 'e.go', 'f.java', 'g.vue', 'h.rb'].map(languageOf),
		}).toEqual({
			node: '(process.env.GEMINI_DEBUG === "gc7f3a") && (n > 1)',
			python: '(__import__("os").environ.get("GEMINI_DEBUG") == "gc7f3a") and (n > 1)',
			guardOnly: 'process.env.GEMINI_DEBUG === "gc7f3a"',
			conditionOnly: 'n > 1',
			none: undefined,
			languages: ['typescript', 'typescript', 'javascript', 'python', 'go', 'java', 'javascript', undefined],
		});
	});
});

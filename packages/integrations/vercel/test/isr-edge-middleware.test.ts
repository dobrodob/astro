import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { type Fixture, loadFixture } from './test-utils.ts';

describe('ISR + edge middleware routing (issue #17732)', () => {
	let fixture: Fixture;
	let deploymentConfig: any;

	before(async () => {
		fixture = await loadFixture({
			root: './fixtures/isr-with-edge-middleware/',
		});
		await fixture.build({});
		deploymentConfig = JSON.parse(await fixture.readFile('../.vercel/output/config.json'));
	});

	it('ISR routes should go through _middleware', () => {
		const indexRoute = deploymentConfig.routes.find((r: any) => r.src === '^/$');
		assert.ok(indexRoute, 'Should have a route for /');
		assert.equal(
			indexRoute.dest,
			'_middleware',
			'ISR route should be routed through _middleware when middlewareMode is "edge"',
		);
	});

	it('excluded routes should go through _middleware', () => {
		const excludedRoute = deploymentConfig.routes.find(
			(r: any) => r.src && r.src.includes('excluded') && r.dest,
		);
		assert.ok(excludedRoute, 'Should have a route for /excluded');
		assert.equal(excludedRoute.dest, '_middleware');
	});

	it('internal routes should go directly to _render', () => {
		const imageRoute = deploymentConfig.routes.find((r: any) => r.src && r.src.includes('_image'));
		assert.ok(imageRoute, 'Should have a route for _image');
		assert.equal(imageRoute.dest, '_render');
	});

	it('middleware edge function should be built', async () => {
		const middlewareFunc = await fixture.readFile(
			'../.vercel/output/functions/_middleware.func/middleware.mjs',
		);
		assert.ok(middlewareFunc, 'Middleware function should exist');
		// The middleware should contain ISR forwarding logic
		assert.ok(middlewareFunc.includes('_isr'), 'Middleware should contain ISR forwarding logic');
	});
});

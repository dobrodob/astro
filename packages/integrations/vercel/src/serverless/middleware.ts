import { existsSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AstroIntegrationLogger } from 'astro';
import {
	ASTRO_LOCALS_HEADER,
	ASTRO_MIDDLEWARE_SECRET_HEADER,
	ASTRO_PATH_HEADER,
	ASTRO_PATH_PARAM,
	ASTRO_PATH_TOKEN_PARAM,
	NODE_PATH,
} from '../index.js';

/**
 * It generates the Vercel Edge Middleware file.
 *
 * It creates a temporary file, the edge middleware, with some dynamic info.
 *
 * Then this file gets bundled with esbuild. The bundle phase will inline the Astro middleware code.
 *
 * @param astroMiddlewareEntryPointPath
 * @param root
 * @param vercelEdgeMiddlewareHandlerPath
 * @param outPath
 * @param middlewareSecret
 * @param logger
 * @returns {Promise<URL>} The path to the bundled file
 */
export interface EdgeMiddlewareIsrConfig {
	/** Expanded ISR exclusion patterns (resolved route pathnames, not regexes). */
	excludePatterns: string[];
	/** The secret token used to authenticate ISR rewrites. */
	pathToken: string;
}

export async function generateEdgeMiddleware(
	astroMiddlewareEntryPointPath: URL,
	root: URL,
	vercelEdgeMiddlewareHandlerPath: URL,
	outPath: URL,
	middlewareSecret: string,
	logger: AstroIntegrationLogger,
	isrConfig?: EdgeMiddlewareIsrConfig,
): Promise<URL> {
	const code = edgeMiddlewareTemplate(
		astroMiddlewareEntryPointPath,
		vercelEdgeMiddlewareHandlerPath,
		middlewareSecret,
		logger,
		isrConfig,
	);
	// https://vercel.com/docs/concepts/functions/edge-middleware#create-edge-middleware
	const bundledFilePath = fileURLToPath(outPath);
	const esbuild = await import('esbuild');
	try {
		await esbuild.build({
			stdin: {
				contents: code,
				resolveDir: fileURLToPath(root),
			},
			// Vercel Edge runtime targets ESNext, because Cloudflare Workers update v8 weekly
			// https://github.com/vercel/vercel/blob/1006f2ae9d67ea4b3cbb1073e79d14d063d42436/packages/next/scripts/build-edge-function-template.js
			target: 'esnext',
			platform: 'browser',
			// esbuild automatically adds the browser, import and default conditions
			// https://esbuild.github.io/api/#conditions
			// https://runtime-keys.proposal.wintercg.org/#edge-light
			conditions: ['edge-light', 'workerd', 'worker'],
			outfile: bundledFilePath,
			allowOverwrite: true,
			format: 'esm',
			bundle: true,
			minify: false,
			// ensure node built-in modules are namespaced with `node:`
			plugins: [
				{
					name: 'esbuild-namespace-node-built-in-modules',
					setup(build) {
						const filter = new RegExp(builtinModules.map((mod) => `(^${mod}$)`).join('|'));
						build.onResolve(
							{
								filter,
							},
							(args) => ({
								path: 'node:' + args.path,
								external: true,
							}),
						);
					},
				},
			],
		});
	} catch (err) {
		if ((err as Error).message.includes('Could not resolve "node:')) {
			logger.error(
				`Vercel does not allow the use of Node.js built-ins in edge functions. Please ensure your middleware code and 3rd-party packages don’t use Node built-ins.`,
			);
		}

		throw err;
	}
	return pathToFileURL(bundledFilePath);
}

function edgeMiddlewareTemplate(
	astroMiddlewareEntryPointPath: URL,
	vercelEdgeMiddlewareHandlerPath: URL,
	middlewareSecret: string,
	logger: AstroIntegrationLogger,
	isrConfig?: EdgeMiddlewareIsrConfig,
) {
	const middlewarePath = JSON.stringify(
		fileURLToPath(astroMiddlewareEntryPointPath).replace(/\\/g, '/'),
	);
	const filePathEdgeMiddleware = fileURLToPath(vercelEdgeMiddlewareHandlerPath);
	let handlerTemplateImport = '';
	let handlerTemplateCall = '{}';
	if (existsSync(filePathEdgeMiddleware + '.js') || existsSync(filePathEdgeMiddleware + '.ts')) {
		logger.warn(
			'Usage of `vercel-edge-middleware.js` is deprecated. You can now use the `waitUntil(promise)` function directly as `ctx.locals.waitUntil(promise)`.',
		);
		const stringified = JSON.stringify(filePathEdgeMiddleware.replace(/\\/g, '/'));
		handlerTemplateImport = `import handler from ${stringified}`;
		handlerTemplateCall = `await handler({ request, context })`;
	} else {
	}
	// Build the ISR forwarding logic. When ISR is configured, routes not matching
	// an exclusion pattern forward to the ISR function; excluded routes and
	// non-ISR setups forward to the Node serverless function.
	let resolveDestination: string;
	if (isrConfig) {
		const excludePatternsJson = JSON.stringify(isrConfig.excludePatterns);
		resolveDestination = `
	const _isrExcludePatterns = ${excludePatternsJson};
	function _resolveDestination(pathname) {
		const isExcluded = _isrExcludePatterns.some(p => p === pathname);
		if (isExcluded) {
			return '/${NODE_PATH}';
		}
		return '/_isr?' + '${ASTRO_PATH_PARAM}=' + encodeURIComponent(pathname) + '&${ASTRO_PATH_TOKEN_PARAM}=${isrConfig.pathToken}';
	}`;
	} else {
		resolveDestination = `
	function _resolveDestination() {
		return '/${NODE_PATH}';
	}`;
	}

	return `
	${handlerTemplateImport}
import { onRequest } from ${middlewarePath};
import { createContext, trySerializeLocals } from 'astro/middleware';
${resolveDestination}
export default async function middleware(request, context) {
	const ctx = createContext({
		request,
		params: {},
		clientAddress: request.headers.get('x-real-ip') || undefined,
	});
	Object.assign(ctx.locals, { vercel: { edge: context }, ...${handlerTemplateCall} });
	const { origin } = new URL(request.url);
	const next = async () => {
		const { vercel, ...locals } = ctx.locals;
		const pathname = request.url.replace(origin, '');
		const dest = _resolveDestination(pathname);
		const response = await fetch(new URL(dest, request.url), {
			method: request.method,
			headers: {
				...Object.fromEntries(request.headers.entries()),
				'${ASTRO_MIDDLEWARE_SECRET_HEADER}': '${middlewareSecret}',
				'${ASTRO_PATH_HEADER}': pathname,
				'${ASTRO_LOCALS_HEADER}': trySerializeLocals(locals)
			},
			...(request.body ? { body: request.body, duplex: 'half' } : {}),
		});
		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	};

	const response = await onRequest(ctx, next);
	// Append cookies from Astro.cookies
	for(const setCookieHeaderValue of ctx.cookies.headers()) {
		response.headers.append('set-cookie', setCookieHeaderValue);
	}
	return response;
}`;
}

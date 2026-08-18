/**
 * @type {import("astro").MiddlewareResponseHandler}
 */
export const onRequest = async (context, next) => {
	const response = await next();
	response.headers.set('x-edge-middleware', 'true');
	return response;
};

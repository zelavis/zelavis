import { createMiddleware } from "hono/factory";
export function honoAdapter(runtime) {
    return createMiddleware(async (context, next) => {
        const result = await runtime.dispatch(context.req.raw, {
            platform: {
                hono: context,
            },
        });
        if (!result.matched) {
            return next();
        }
        return result.response;
    });
}

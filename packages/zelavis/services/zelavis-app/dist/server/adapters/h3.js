export function h3Adapter(runtime) {
    return async (event, next) => {
        const result = await runtime.dispatch(event.req, {
            platform: {
                h3: event,
            },
        });
        if (!result.matched) {
            return next();
        }
        return result.response;
    };
}

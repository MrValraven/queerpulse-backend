"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("reflect-metadata");
const directory_controller_1 = require("./src/listings/directory.controller");
const changemakers_controller_1 = require("./src/changemakers/changemakers.controller");
const anonymous_public_cache_interceptor_1 = require("./src/subprofiles/anonymous-public-cache.interceptor");
for (const ctrl of [directory_controller_1.DirectoryController, changemakers_controller_1.ChangemakersController]) {
    const proto = ctrl.prototype;
    for (const key of Object.getOwnPropertyNames(proto)) {
        if (key === 'constructor')
            continue;
        const headers = Reflect.getMetadata('__headers__', proto[key]);
        if (headers)
            console.log(ctrl.name + '.' + key, JSON.stringify(headers));
    }
}
const set = {};
const ctx = {
    getType: () => 'http',
    switchToHttp: () => ({
        getRequest: () => ({ user: process.env.SIGNED_IN ? { id: 'x' } : undefined }),
        getResponse: () => ({ setHeader: (k, v) => (set[k] = v), vary: () => { } }),
    }),
};
new anonymous_public_cache_interceptor_1.AnonymousPublicCacheInterceptor().intercept(ctx, { handle: () => ({}) });
console.log('interceptor', process.env.SIGNED_IN ? 'authenticated' : 'anonymous', JSON.stringify(set));
//# sourceMappingURL=headercheck.tmp.js.map
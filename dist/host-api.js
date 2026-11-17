/** Check only the methods used by this plugin; extra host APIs are welcome. */
export function assertHostMethods(plugin, host, methods) {
    const missingMethods = methods.filter(path => {
        let value = host;
        for (const key of path.split('.')) {
            if (value === null || (typeof value !== 'object' && typeof value !== 'function'))
                return true;
            value = Reflect.get(value, key);
        }
        return typeof value !== 'function';
    });
    if (missingMethods.length) {
        throw Object.assign(new Error(`[${plugin}] 当前 DSH 缺少必需接口：${missingMethods.join('、')}。请升级插件以适配当前 DSH。`), {
            code: 'DSH_API_UNSUPPORTED', missingMethods,
        });
    }
}

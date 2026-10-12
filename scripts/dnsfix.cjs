// Build-time helper: some networks have a flaky system resolver for github.com / release hosts.
// When the OS lookup fails, retry through public DNS. Used only via NODE_OPTIONS for build commands;
// it changes nothing system-wide and is never loaded by the server or the apps.
const dns = require('node:dns');
const resolver = new dns.Resolver();
resolver.setServers(['8.8.8.8', '1.1.1.1']);
const orig = dns.lookup;

function fallback(host, opts, cb, err) {
  resolver.resolve4(host, (e2, addrs) => {
    if (e2 || !addrs?.length) return cb(err);
    if (opts.all) return cb(null, addrs.map((address) => ({ address, family: 4 })));
    return cb(null, addrs[0], 4);
  });
}

dns.lookup = function lookup(host, opts, cb) {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  if (typeof opts === 'number') opts = { family: opts };
  opts = opts || {};
  return orig.call(dns, host, opts, (err, address, family) => {
    if (!err) return cb(null, address, family);
    return fallback(host, opts, cb, err);
  });
};
const origP = dns.promises.lookup;
dns.promises.lookup = async function lookup(host, opts) {
  try { return await origP.call(dns.promises, host, opts); } catch (err) {
    const addrs = await resolver.resolve4(host).catch(() => null);
    if (!addrs?.length) throw err;
    return opts?.all ? addrs.map((address) => ({ address, family: 4 })) : { address: addrs[0], family: 4 };
  }
};

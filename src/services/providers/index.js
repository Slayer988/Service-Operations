'use strict';
const providers = { imap: require('./imap'), graph: require('./graph'), gmail: require('./gmail') };
module.exports = { providers, get: (name) => providers[name] || providers.imap, names: Object.keys(providers) };

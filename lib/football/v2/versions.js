'use strict';

// Las versiones comprometidas son inmutables: nunca reconstruir un partido con
// una revisión que pueda producir otro resultado o una cronología distinta.
const current = require('./simulator');
const causal2 = require('./simulator-causal-2');
const legacy = require('./simulator-legacy');
const BY_VERSION = new Map([[current.VERSION, current], [causal2.VERSION, causal2], [legacy.VERSION, legacy]]);

function simulatorFor(version) { return BY_VERSION.get(version) || null; }
function supportedVersion(version) { return BY_VERSION.has(version); }

module.exports = { current, causal2, legacy, simulatorFor, supportedVersion };

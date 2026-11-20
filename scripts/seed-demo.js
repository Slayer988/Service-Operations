'use strict';
// Kept for the installer's --demo option: loads the demo data (see scripts/demo-data.js, which can also remove it).
process.argv[2] = 'load';
require('./demo-data');

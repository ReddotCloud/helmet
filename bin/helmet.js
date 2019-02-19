#!/usr/bin/env node

const helmet = require('..');
helmet().catch(function(err) {
	console.error(((err || {}).message || 'Unknown error').red);
	process.exit(1);
});

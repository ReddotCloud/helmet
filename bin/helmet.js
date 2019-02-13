#!/usr/bin/env node

const helmet = require('..');
helmet().catch(function(err) {
	console.error(err.message.red);
	process.exit(1);
});

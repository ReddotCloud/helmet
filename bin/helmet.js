#!/usr/bin/env node

const helmet = require('..');
helmet().catch(function(err) {
	console.error(err.message.red);
	console.error(err.stack.red);
	process.exit(1);
});

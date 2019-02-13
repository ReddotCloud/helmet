require('colors');

/**
 * Requirements
 */
const _ = require('lodash');
const util = require('util');
const os = require('os');
const fs = require('fs');
const path = require('path');
const yargs = require('yargs');
const yaml = require('js-yaml');
const dotenv = require('dotenv');
const dotenvExpand = require('dotenv-expand');
const minimatch = require('minimatch');
const { highlight } = require('cli-highlight');
const exec = require('execa');

/**
 * Preloads environment variables
 */
if (yargs.argv.envfile) {
	let files = util.isArray(yargs.argv.envfile) ? yargs.argv.envfile : [ yargs.argv.envfile ];
	for (const file of files) {
		dotenvExpand(
			dotenv.config({
				path: path.resolve(file)
			})
		);
	}
} else {
	dotenvExpand(dotenv.config());
}

/**
 * Loads a skaffold file from disk
 */
function coerceFile(file) {
	if (file !== 'helmet.yaml') {
		return yaml.safeLoad(fs.readFileSync(file));
	} else if (fs.existsSync('helmet.yml')) {
		return yaml.safeLoad(fs.readFileSync('helmet.yml'));
	}
	return yaml.safeLoad(fs.readFileSync('helmet.yaml'));
}

/**
 * Main
 */
module.exports = async function() {
	yargs.strict().env('HELMET').demandCommand(1);

	yargs.options({
		profile: {
			global: true,
			type: 'string',
			default: 'default',
			description: 'Which profile to use'
		},
		config: {
			global: true,
			type: 'object',
			default: {},
			description: 'Helmet configuration options'
		},
		envfile: {
			global: true,
			type: 'string',
			default: '.env',
			description: 'Loads a .env file'
		},
		/*
		env: {
			global: true,
			type: 'string',
			default: undefined,
			description: 'Passes environment variables to values key'
		},*/
		file: {
			global: true,
			type: 'string',
			default: 'helmet.yaml',
			coerce: coerceFile,
			description: 'Helmet filename'
		},
		values: {
			global: true,
			type: 'object',
			default: {},
			description: 'Overrides valus in releases'
		}
	});

	/**
     * Normalize the initial skaffold file
     */
	yargs.middleware(function(argv) {
		argv.skaffold = {
			apiVersion: 'skaffold/v1beta4',
			kind: 'Config'
		};
	});

	/**
	 * Normalize helmet file with defaults
	 */
	yargs.middleware(function(argv) {
		argv.file = _.merge(
			{
				projects: {},
				profile: 'default',
				profiles: {
					default: {
						push: false,
						cleanup: true,
						forward: true,
						repository: ''
					}
				}
			},
			argv.file
		);

		if (!(argv.file in argv.file.profiles)) {
			throw new Error(`Unknown default profile "${argv.file.profile}" specified`);
		}
	});

	yargs.middleware(function(argv) {
		// Add default profile if it doesn't exists
		argv.file.profiles = argv.file.profiles || [];
		if (!argv.file.profiles.some((profile) => profile.name === 'default')) {
			argv.file.profiles.push({
				name: 'default'
			});
		}

		const profiles = (argv.file.profiles || []).map((profile) => profile.name);
		if (profiles.indexOf(argv.profile) < 0) {
			throw new Error(`Profile "${argv.profile}" not found in skaffold file.`);
		}
	});

	/**
     * Normalizes skaffold
     */
	yargs.middleware(function(argv) {
		// Configs
		const profile = argv.file.profiles.find((profile) => profile.name === argv.profile);

		// defaults <- file.config <- profile.config <- cli args
		argv.config = _.merge(
			{
				cleanup: true,
				release: '',
				namespace: '',
				'port-forward': false,
				'default-repo': ''
			},
			argv.file.config || {},
			profile.config || {},
			argv.config || {}
		);

		const rootHasReleases =
			argv.file.deploy &&
			argv.file.deploy.helm &&
			argv.file.deploy.helm.releases &&
			argv.file.deploy.helm.releases.length > 0;

		if (!rootHasReleases) {
			throw new Error('Cannot find any helm releases in root deploy');
		}

		const profileHasReleases = profile.deploy && profile.deploy.helm && profile.deploy.helm.releases;
		if (profileHasReleases) {
			if (rootHasReleases) {
			}
		}

		// Put overrides on the releases
		if (rootHasReleases) {
			for (const valuesName of Object.keys(argv.values)) {
				const values = argv.values[valuesName];
				for (const release of argv.file.deploy.helm.releases) {
					release.overrides || {};
					if (minimatch(release.name, valuesName, { noglobstar: true })) {
						release.overrides = _.merge(release.overrides || {}, values);
					}
				}
			}
		}

		// Delete additional keys
		if (argv.file.config) {
			delete argv.file.config;
		}

		for (const profile of argv.file.profiles) {
			if (profile.config) {
				delete profile.config;
			}
		}
	});

	/**
	 * Normalize values
	 */
	yargs.middleware(function(argv) {
		const skaffold = argv.file;
		let releases = [];
		if (skaffold.deploy && skaffold.deploy.helm && skaffold.deploy.helm.releases) {
			releases = skaffold.deploy.helm.releases.map((release) => release.name);
		}

		const configs = Object.keys(argv.values);
		for (const config of configs) {
			let found = false;
			for (const release of releases) {
				if (minimatch(release, config, { noglobstar: true })) {
					found = true;
				}
			}
			if (!found) {
				throw new Error(`No release name matches "${config}" pattern. Check your values.`);
			}
		}
	});

	/**
     * Wear command
     */
	yargs.command({
		command: 'wear',
		description: 'starts working on a profile',
		handler: async (argv) => {
			if (argv.config.release) {
				console.log('release specified', argv.config.release);
			}

			if (argv.config.namespace) {
				console.log('namespace specified', argv.config.namespace);
			}

			console.log(`wearing ${argv.profile.blue} helm`, argv.dry ? '(dry)'.red : '');

			const args = [
				'dev',
				'--profile',
				argv.profile,
				'--filename',
				'-',
				`--cleanup=${argv.config.cleanup ? 'true' : 'false'}`,
				`--port-forward=${argv.config['port-forward'] ? 'true' : 'false'}`
			];

			if (argv.config['default-repo']) {
				args.push('--default-repo', argv.config['default-repo']);
			}

			console.log('Executing...'.blue);
			console.log('');
			console.log(' λ', [ 'skaffold', ...args ].join(' ').green);
			console.log('');

			await exec('skaffold', args, {
				input: yaml.safeDump(argv.file),
				stdout: 'inherit',
				stderr: 'inherit',
				env: process.env,
				cwd: process.cwd()
			});
		}
	});

	/**
     * Config command
     */
	yargs.command({
		command: 'config',
		description: 'prints the generated config',
		handler: async (argv) => {
			console.log(highlight(yaml.safeDump(argv.config), { language: 'yaml' }));
		}
	});

	/**
     * Skaffold command
     */
	yargs.command({
		command: 'skaffold',
		description: 'prints the generated skaffold file',
		handler: async (argv) => {
			console.log(highlight(yaml.safeDump(argv.file), { language: 'yaml' }));
		}
	});

	/**
     * Cast the spell
     */
	yargs.argv;
};

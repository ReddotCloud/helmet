require('colors');

/**
 * Requirements
 */
const _ = require('lodash');
const util = require('util');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const yargs = require('yargs');
const yaml = require('js-yaml');
const dotenv = require('dotenv');
const dotenvExpand = require('dotenv-expand');
const minimatch = require('minimatch');
const { highlight } = require('cli-highlight');
const moment = require('moment');
const exec = require('execa');
const Liquid = require('liquidjs');
const Ajv = require('ajv');
const AjvKeywords = require('ajv-keywords');
const AjvErrors = require('better-ajv-errors');

const liquid = new Liquid();

liquid.registerFilter('sha1', (value) => {
	return crypto.createHash('sha1').update(value).digest('hex');
});

liquid.registerFilter('md5', (value) => {
	return crypto.createHash('md5').update(value).digest('hex');
});

liquid.registerFilter('sha256', (value) => {
	return crypto.createHash('sha256').update(value).digest('hex');
});

liquid.registerFilter('short', (value, size = 8) => {
	return (value || '').substr(0, size);
});

liquid.registerFilter('safe', (value) => {
	return (value || '').replace(/^[a-zA-Z0-1-_]/g, '_');
});

/**
 * Schema
 */
const ajv = new Ajv({
	allErrors: true,
	validateSchema: true,
	ownProperties: true,
	jsonPointers: true,
	useDefaults: true,
	$data: true
});

AjvKeywords(ajv);

const schema = require('./schema');
const validator = ajv.compile(schema);

/**
 * Preloads environment variables
 */
if (yargs.argv.load) {
	let files = util.isArray(yargs.argv.load) ? yargs.argv.load : [ yargs.argv.load ];
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
		file = yaml.safeLoad(fs.readFileSync(file));
	} else if (fs.existsSync('helmet.yml')) {
		file = yaml.safeLoad(fs.readFileSync('helmet.yml'));
	} else {
		file = yaml.safeLoad(fs.readFileSync('helmet.yaml'));
	}

	const result = validator(file);
	if (!result) {
		console.error('Failed to validate configuration format.'.red);
		console.error(
			AjvErrors(schema, file, validator.errors, {
				format: 'cli',
				indent: 2
			})
		);
		process.exit(1);
	}

	return _.merge(file || {}, {
		profile: 'default',
		profiles: {}
	});
}

/**
 * Builds the skaffold image name
 */
function buildImageName(defaultRepo, originalImage) {
	if (defaultRepo === '') {
		return originalImage;
	}

	if (defaultRepo.startsWith('gcr.io')) {
		let originalPrefix = originalImage.match(/^gcr\.io\/[a-zA-Z-_]+\//);
		originalPrefix = originalPrefix ? originalPrefix[0] : '';

		let defaultRepoPrefix = defaultRepo.match(/^gcr\.io\/[a-zA-Z-_]+\//);
		defaultRepoPrefix = defaultRepoPrefix ? defaultRepoPrefix[0] : '';

		if (originalPrefix === defaultRepoPrefix) {
			return defaultRepo + '/' + originalImage.substr(originalPrefix.length);
		} else if (originalImage.startsWith(defaultRepo)) {
			return originalImage;
		}
		return `${defaultRepo}/${originalImage}`;
	}

	return `${defaultRepo}/${originalImage.replace(/[\/._:@]/g, '_')}`;
}

/**
 * Main
 */
module.exports = async function() {
	/**
     * Settings
     */
	yargs.strict().env('HELMET').demandCommand(1);

	/**
     * Options definition
     */
	yargs.options({
		/**
         * Helmet file
         */
		file: {
			global: true,
			type: 'string',
			default: 'helmet.yaml',
			coerce: coerceFile,
			description: 'Helmet filename'
		},

		/**
         * Profile name to  use
         */
		profile: {
			global: true,
			type: 'string',
			default: undefined,
			description: 'Profile name'
		},

		/**
         * Sets project variables
         */
		project: {
			global: true,
			type: 'object',
			default: {},
			description: 'Set project variables'
		},

		/**
         * Sets profile variables
         */
		option: {
			global: true,
			type: 'object',
			default: {},
			description: 'Set profile options variables'
		},

		/**
         * Sets profile variables
         */
		metadata: {
			global: true,
			type: 'object',
			default: {},
			description: 'Set profile metadata variables'
		},

		/**
         * Loads environment variable files (.env)
         */
		load: {
			global: true,
			type: 'string',
			default: '.env',
			description: 'Loads a .env file'
		},

		/**
         * Verbose logging
         */
		verbose: {
			global: true,
			alias: 'v',
			type: 'boolean',
			default: false,
			description: 'Prints additional stuff'
		}
	});

	/**
     * Build view variables
     */
	yargs.middleware(async function(argv) {
		const gitTag = await exec('git', [ 'describe', '--tags', '--exact-match' ], { reject: false });
		const gitCommit = await exec('git', [ 'rev-parse', 'HEAD' ], { reject: false });
		const gitBranch = await exec('git', [ 'rev-parse', '--abbrev-ref', 'HEAD' ], { reject: false });
		const gitStatus = await exec('git', [ 'status', '.', '--porcelain' ]);

		const template = {
			/**
             * View data
             */
			variables: {
				user: os.userInfo().username,
				timestamp: moment.utc().toISOString(),
				git: {
					tag: gitTag.stdout || null,
					commit: gitCommit.stdout || null,
					dirty: gitStatus.stdout.length > 0,
					branch: gitBranch.stdout
				},
				env: process.env
			},

			/**
             * Renders a template
             */
			async renderTemplate(template, values, convert = false) {
				const result = await liquid.parseAndRender(template, _.merge({}, this.variables, values));
				if (convert) {
					try {
						return JSON.parse(result);
					} catch (err) {
						return result;
					}
				}
				return result;
			},

			/**
             * Renders a object with templates
             */
			async renderObject(obj, values, convert) {
				await Promise.all(
					Object.entries(obj).map(async ([ name, entry ]) => {
						if (typeof entry === 'string') {
							obj[name] = await this.renderTemplate(entry, values, convert);
						} else if (typeof entry === 'object') {
							obj[name] = await this.renderObject(entry, values, convert);
						}
					})
				);
				return obj;
			}
		};

		argv.template = template;
	});

	/**
	 * Load profile
	 */
	yargs.middleware(async function(argv) {
		// Find base profile candidates
		let baseProfile = {};
		const baseProfiles = Object.entries(argv.file.profiles).filter(([ name, _ ]) => name.startsWith('$'));
		if (!baseProfiles.length) {
			console.error('WARNING: No base profile found. No variables to override.'.yellow);
		} else {
			baseProfile = baseProfiles[0][1];
		}

		// Find default profile candidates
		const defaultProfiles = Object.entries(argv.file.profiles).filter(([ _, profile ]) => profile.default);
		if (!defaultProfiles.length) {
			throw new Error('No default profile found.');
		}
		const defaultProfile = defaultProfiles[0][0];

		// Gets the current and default profile
		argv.profile = argv.profile || defaultProfile;
		if (!(argv.profile in argv.file.profiles)) {
			throw new Error(`Missing profile definition for "${argv.profile}"`);
		}

		// Values to fill missing variables
		const defaultValues = {
			options: {
				push: true,
				cleanup: true,
				forward: true,
				repository: '',
				tag: '{{ git.tag | default: git.commit | short }}{% if git.dirty %}-dirty{% endif %}'
			},
			projects: {}
		};

		// Merge default profile into current profile
		// Adds name to profile
		argv.profile = _.merge({}, defaultValues, baseProfile, argv.file.profiles[argv.profile], {
			name: argv.profile
		});

		// Remove default value that was carried from default profile
		delete argv.profile.default;

		// Merge options from cli arguments
		argv.profile.options = _.merge(argv.profile.options, argv.option || {});
		argv.profile.metadata = _.merge(argv.profile.metadata, argv.metadata || {});

		// Renders the template tag
		argv.profile.options.tag = await argv.template.renderTemplate(argv.profile.options.tag, {
			profile: argv.profile
		});

		// Default project values
		Object.entries(argv.profile.projects).forEach(([ name, project ]) => {
			argv.profile.projects[name] = _.merge(
				{
					name: name,
					values: {}
				},
				project
			);

			if (!project.deploy) {
				throw new Error(`Project "${name}" has no deployment information`);
			}

			if (!project.deploy.release) {
				throw new Error(`Project "${name}" is missing deployment release`);
			}

			if (!project.deploy.namespace) {
				throw new Error(`Project "${name}" is missing deployment namespace`);
			}

			if (!project.deploy.chart) {
				throw new Error(`Project "${name}" is missing deployment chart path`);
			}

			if (!project.image) {
				throw new Error(`Project "${name}" is missing image information`);
			}

			if (!project.image.name) {
				throw new Error(`Project "${name}" is missing image name`);
			}

			if (!project.image.context) {
				throw new Error(`Project "${name}" is missing image context`);
			}
		});
	});

	/**
	 * Normalize project settings passed through cli
	 */
	yargs.middleware(async function(argv) {
		const keys = Object.keys(argv.project);
		const projects = Object.keys(argv.profile.projects);
		for (const key of keys) {
			let found = false;
			for (const project of projects) {
				if (minimatch(project, key, { noglobstar: true })) {
					found = true;
					_.merge(argv.profile.projects[project], argv.project[key]);
				}
			}
			if (!found) {
				throw new Error(`No project name matches "${key}" pattern. Check your values.`);
			}
		}

		for (const project of Object.values(argv.profile.projects)) {
			const image = buildImageName(argv.profile.options.repository, project.image.name);
			project.image.fqin = `${image}:${argv.profile.options.tag}`;
		}

		await Promise.all(
			Object.entries(argv.profile.projects).map(async ([ name, project ]) => {
				if (argv.profile.options.namespace) {
					project.deploy.namespace = await argv.template.renderTemplate(argv.profile.options.namespace, {
						project,
						profile: argv.profile
					});
				}
				if (argv.profile.options.release) {
					project.deploy.release = await argv.template.renderTemplate(argv.profile.options.release, {
						project,
						profile: argv.profile
					});
				}
			})
		);
	});

	/**
     * Build skaffold config definition
     */
	yargs.middleware(async function(argv) {
		const { template, profile } = argv;
		const projects = Object.entries(profile.projects);
		argv.skaffold = {
			apiVersion: 'skaffold/v1beta5',
			kind: 'Config',
			build: {
				local: {
					push: argv.profile.options.push
				},
				tagPolicy: {
					envTemplate: {
						template: `{{ .IMAGE_NAME }}:${argv.profile.options.tag}`
					}
				},
				artifacts: projects.map(([ name, project ]) => ({
					image: project.image.name,
					context: project.image.context,
					sync: project.sync
				}))
			},
			deploy: {
				helm: {
					releases: await Promise.all(
						projects.map(async ([ name, project ]) => {
							return {
								name: project.deploy.release,
								namespace: project.deploy.namespace,
								chartPath: project.deploy.chart,
								overrides: await template.renderObject(project, { profile, project }, true)
							};
						})
					)
				}
			}
		};
	});

	/**
     * Wear command
     */
	yargs.command({
		command: 'wear',
		description: 'starts working on a profile',
		handler: async (argv) => {
			console.log(`wearing ${argv.profile.name.blue} helmet`, argv.dry ? '(dry)'.red : '');

			const args = [
				'dev',
				'--filename',
				'-',
				`--cleanup=${argv.profile.cleanup ? 'true' : 'false'}`,
				`--port-forward=${argv.profile.forward ? 'true' : 'false'}`
			];

			if (argv.profile.options.repository !== '') {
				args.push('--default-repo', argv.profile.options.repository);
			}

			if (argv.verbose) {
				console.log('λ'.yellow, [ 'skaffold', ...args ].join(' ').green, '<<EOF');
				console.log(highlight(yaml.safeDump(argv.skaffold), { language: 'yaml' }));
				console.log('EOF');
				console.log('');
			}

			await exec('skaffold', args, {
				input: yaml.safeDump(argv.skaffold),
				stdout: 'inherit',
				stderr: 'inherit',
				env: process.env,
				cwd: process.cwd()
			});
		}
	});

	/**
     * Wear command
     */
	yargs.command({
		command: 'deploy',
		description: 'deploy a profile',
		handler: async (argv) => {
			console.log(`deploying ${argv.profile.name.blue} helmet`, argv.dry ? '(dry)'.red : '');

			const args = [ 'deploy', '--filename', '-' ];

			if (argv.profile.options.repository !== '') {
				args.push('--default-repo', argv.profile.options.repository);
			}

			if (argv.verbose) {
				console.log('λ'.yellow, [ 'skaffold', ...args ].join(' ').green, '<<EOF');
				console.log(highlight(yaml.safeDump(argv.skaffold), { language: 'yaml' }));
				console.log('EOF');
				console.log('');
			}

			await exec('skaffold', args, {
				input: yaml.safeDump(argv.skaffold),
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
		description: 'prints the normalized config',
		handler: async (argv) => {
			console.log(highlight(yaml.safeDump(argv.file), { language: 'yaml' }));
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
     * Errors
     */
	yargs.fail(function(message, error) {
		console.error((message || '').red);
		console.error(error.stack.red);
		process.exit(1);
	});

	/**
     * Cast the spell
     */
	yargs.argv;
};

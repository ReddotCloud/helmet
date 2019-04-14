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
const dot = require('dot-object');
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
const semver = require('semver');

const pkg = require('./package.json');

const dotargv = dot.dot(Object.assign({}, yargs.argv));

/**
 * Liquid.js
 */

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

liquid.registerFilter('required', function(value) {
	if (typeof value === 'undefined') {
		throw new Error('Required value missing.');
	}
	return value;
});

// Usage: {% upper name%}
liquid.registerTag('meta', {
	parse: function(token, _) {
		this.path = token.args;
	},
	render: function(scope, _) {
		for (const context of scope.contexts) {
			if (this.path in context.profile.metadata) {
				return Promise.resolve(liquid.evalValue(`profile.metadata.${this.path}`, scope));
			}
		}
		return Promise.reject(
			new Error(`Could not find metadata "${this.path}". Did you miss --metadata.${this.path}?`)
		);
	}
});

liquid.registerTag('param', {
	parse: function(token, _) {
		this.path = token.args;
	},
	render: function(scope, _) {
		if (!(this.path in dotargv)) {
			return Promise.reject(
				new Error(`Param "${this.path}" is used in this profile. Did you miss --${this.path}?`)
			);
		}
		return dotargv[this.path];
	}
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
 * Asserts a dependency version
 */
function assertVersion(name, version, expression) {
	if (!semver.valid(version)) {
		console.error(`WARNING: Couldn't parse ${name} version.`.yellow);
	} else {
		if (!semver.satisfies(version, expression)) {
			console.error(`ERROR: ${name} version ${version} doesn't satisfy "${expression}"`.red);
			process.exit(1);
		}
	}
	return true;
}

/**
 * Checks for a dependency
 */
async function checkDependency(command, args, wanted, regex) {
	const child = await exec(command, args, { reject: false });
	if (child.failed) {
		console.error(`You must have ${command} installed and working.`.red);
		if (child.stdout) {
			console.error(child.stdout.yellow);
		}
		if (child.stderr) {
			console.error(child.stderr.red);
		}
		process.exit(1);
	} else {
		const version = regex.exec(child.stdout);
		if (!version) {
			console.log(`WARNING: Cannot detect ${command} version`.yellow);
		} else {
			assertVersion(command, version[1], wanted);
		}
	}
}

/**
 * Dependencies
 */
async function checkDependencies() {
	await checkDependency('kubectl', [ 'version' ], '^1.x', /Client.*GitVersion:"v(.*?)"/);
	await checkDependency('helm', [ 'version' ], '^2.x', /Client.*SemVer:"v(.*?)"/);
	await checkDependency('skaffold', [ 'version' ], '^0.22', /v(.*)/);
}

/**
 * Transforms an object into a named array
 * {
 *   test: {
 *     hello: "world"
 *   }
 * }
 * ->
 * [
 *   {
 *     name: "test",
 *     hello: "world"
 *   }
 * ]
 */
Object.prototype.toNamedArray = function() {
	return Object.entries(this).map(([ name, object ]) => _.merge({ name }, object));
};

/**
 * Injects the object name into object's children
 */
Object.prototype.injectName = function(key = 'name') {
	return Object.entries(this)
		.map(([ name, object ]) => _.merge({ [key]: name }, object))
		.reduce((prev, current) => _.merge(prev, { [`${current[key]}`]: current }), {});
};

/**
 * Main
 */
module.exports = async function() {
	/**
     * Dependencies
     */
	await checkDependencies();

	/**
     * Settings
     */
	yargs.version(pkg.version).env('HELMET').demandCommand(1);

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
		const gitStatus = await exec('git', [ 'status', '.', '--porcelain' ], { reject: false });

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
				if (typeof obj === 'string') {
					return await this.renderTemplate(obj, values, convert);
				}
				if (util.isArray(obj)) {
					return await Promise.all(
						obj.map(async (value) => {
							return await this.renderObject(value, values, convert);
						})
					);
				}
				await Promise.all(
					Object.entries(obj).map(async ([ name, entry ]) => {
						obj[name] = await this.renderObject(entry, values, convert);
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

			argv.profile.projects[name].deployments = project.deployments.injectName();

			/*
			if (!project.deployments) {
				throw new Error(`Project "${name}" has no deployment information`);
			}

			if (!project.deployments.release) {
				throw new Error(`Project "${name}" is missing deployment release`);
			}

			if (!project.deployments.namespace) {
				throw new Error(`Project "${name}" is missing deployment namespace`);
			}

			if (!project.deployments.chart) {
				throw new Error(`Project "${name}" is missing deployment chart path`);
            }
            */

			if (project.image && !project.image.name) {
				throw new Error(`Project "${name}" is missing image name`);
			}

			if (project.image && !project.image.context) {
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

		for (const project of Object.values(argv.profile.projects).filter((project) => !!project.image)) {
			const image = buildImageName(argv.profile.options.repository, project.image.name);
			project.image.fqin = `${image}:${argv.profile.options.tag}`;
		}

		await Promise.all(
			Object.values(argv.profile.projects).map(async (project) => {
				if (argv.profile.options.namespace) {
					for (const deployment of Object.values(project.deployments)) {
						deployment.namespace = await argv.template.renderTemplate(argv.profile.options.namespace, {
							deployment,
							project,
							profile: argv.profile
						});
					}
				}
				if (argv.profile.options.release) {
					for (const deployment of Object.values(project.deployments)) {
						deployment.release = await argv.template.renderTemplate(argv.profile.options.release, {
							deployment,
							project,
							profile: argv.profile
						});
					}
				}
			})
		);
	});

	/**
     * Build skaffold config definition
     */
	yargs.middleware(async function(argv) {
		const { template, profile } = argv;
		const projects = Object.values(profile.projects);

		const deployments = projects
			.map((project) =>
				Object.entries(project.deployments || {}).map((deployment) => {
					return _.merge({ project }, deployment[1]);
				})
			)
			.reduce((prev, curr) => prev.concat(curr), []);

		argv.skaffold = {
			apiVersion: 'skaffold/v1beta4',
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
				artifacts: projects.filter((project) => !!project.image).map((project) => ({
					image: project.image.name,
					context: project.image.context,
					sync: project.sync || {}
				}))
			},
			deploy: {
				helm: {
					releases: await Promise.all(
						deployments.map(async (deployment) => {
							return {
								name: deployment.release,
								recreatePods: deployment.recreate,
								namespace: deployment.namespace,
								chartPath: deployment.chart,
								overrides: await template.renderObject(
									deployment.values || {},
									{ profile, project: deployment.project, deployment },
									true
								)
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
				console.log(' Command:'.yellow, [ 'skaffold', ...args ].join(' ').green);
				console.log('Skaffold:'.yellow);
				console.log(highlight(yaml.safeDump(argv.skaffold), { language: 'yaml' }));
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
     * Deploy command
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
				console.log(' Command:'.yellow, [ 'skaffold', ...args ].join(' ').green);
				console.log('Skaffold:'.yellow);
				console.log(highlight(yaml.safeDump(argv.skaffold), { language: 'yaml' }));
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
     * Destroy command
     */
	yargs.command({
		command: 'destroy',
		description: 'destroy a release',
		handler: async (argv) => {
			for (const release of argv.skaffold.deploy.helm.releases) {
				console.log('removing release'.green, release.name.blue);
				const deleteRelease = await exec('helm', [ 'delete', release.name, '--purge' ], {
					stdout: 'inherit',
					stderr: 'inherit',
					reject: false
				});
				if (deleteRelease.failed) {
					console.log('helm delete failed'.red);
				}

				if (argv.withNamespace) {
					console.log('removing namespace'.green, release.namespace.blue);
					const deleteNamespace = await exec('kubectl', [ 'delete', 'ns', release.namespace ], {
						stdout: 'inherit',
						stderr: 'inherit',
						reject: false
					});
					if (deleteNamespace.failed) {
						console.log('kubectl delete ns failed'.red);
					}
				}
			}
		}
	});

	/**
     * Skaffold command
     */
	yargs.command({
		command: 'skaffold',
		description: 'prints the generated skaffold file',
		handler: async (argv) => {
			console.log(highlight(yaml.safeDump(argv.skaffold), { language: 'yaml' }));
		}
	});

	/**
     * Skaffold command
     */
	yargs.command({
		command: 'version',
		description: 'prints the version',
		handler: async (argv) => {
			console.log(pkg.version);
		}
	});

	/**
     * Errors
     */
	yargs.fail(function(message, error) {
		if (message) {
			console.error(message.red);
		} else {
			error = (error || {}).originalError || error || {};
			console.error((error.message || message || 'Unknown error').red);
			console.error(error.stack.red);
		}
		process.exit(1);
	});

	/**
     * Cast the spell
     */
	yargs.argv;
};

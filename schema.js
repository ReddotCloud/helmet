module.exports = {
	$schema: 'http://json-schema.org/draft-07/schema#',
	description: 'Helmet definition',
	type: 'object',
	properties: {
		profiles: {
			description: 'Profile definitions',
			type: 'object',
			additionalProperties: {
				$ref: '#/definitions/IProfile'
			}
		}
	},
	additionalProperties: false,
	required: [ 'profiles' ],
	definitions: {
		/**
         * Profile definition
         */
		IProfile: {
			description: 'Profile definition',
			type: 'object',
			properties: {
				default: {
					description: 'Sets the profile as the default one',
					default: false,
					type: 'boolean'
				},
				options: {
					description: 'Profile options',
					default: {},
					$ref: '#/definitions/IOptions'
				},
				projects: {
					description: 'Project definitions',
					type: 'object',
					minProperties: 1,
					additionalProperties: {
						$ref: '#/definitions/IProject'
					}
				},
				metadata: {
					description: 'Profile metadata',
					type: 'object',
					default: {},
					additionalProperties: true
				}
			},
			additionalProperties: false
		},

		/**
         * Options definition
         */
		IOptions: {
			description: 'Project options',
			type: 'object',
			properties: {
				push: {
					description: 'Should push images to the registry',
					type: 'boolean'
				},
				cleanup: {
					description: 'Should cleanup resources after development mode stops',
					type: 'boolean'
				},
				forward: {
					description: 'Should port-forward pod ports',
					type: 'boolean'
				},
				repository: {
					description: 'The base repository name',
					type: 'string'
				},
				release: {
					description: 'The release template',
					default: '{{ project.deploy.release }}',
					type: 'string'
				},
				namespace: {
					description: 'The namespace template',
					default: '{{ project.deploy.namespace }}',
					type: 'string'
				},
				tag: {
					description: 'Image tags',
					type: 'string'
				}
			},
			additionalProperties: false
		},

		/**
         * Project definition
         */
		IProject: {
			properties: {
				/**
                 * Image
                 */
				image: {
					description: 'Image definition',
					type: 'object',
					properties: {
						name: {
							description: 'Image name',
							type: 'string'
						},
						context: {
							description: 'Project folder',
							type: 'string'
						}
					},
					additionalProperties: false,
					required: [ 'name' ]
				},

				/**
                 * Sync
                 */
				sync: {
					description: 'Sync patterns',
					type: 'object',
					additionalProperties: true
				},

				/**
                 * Deploy
                 */
				deploy: {
					description: 'Deploy definition',
					type: 'object',
					properties: {
						release: {
							description: 'Release name',
							type: 'string'
						},
						namespace: {
							description: 'Namespace name',
							type: 'string'
						},
						chart: {
							description: 'Chart folder',
							type: 'string'
						}
					},
					additionalProperties: false,
					required: [ 'release', 'namespace', 'chart' ]
				},

				/**
                 * Values
                 */
				values: {
					description: 'Override values',
					type: 'object',
					additionalProperties: true
				}
			},
			additionalProperties: false
		}
	}
};
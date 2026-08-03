// The OpenAPI 3.1 description of /api/v1, served (unauthenticated — it is only
// a schema) from /api/openapi.json. Keep it in step with apiv1.js: this file is
// what generates clients, drives Swagger/Scalar UIs, and is the fastest way for
// somebody to see what the panel can be told to do from CI.

const { BUILD_VERSION } = require('./updateroutes');

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema) => ({ content: { 'application/json': { schema } } });
const ok = (schema, description = 'Success') => ({ description, ...json(schema) });

const ERRORS = {
  400: { description: 'Invalid request', ...json(ref('Error')) },
  401: { description: 'Missing or invalid token', ...json(ref('Error')) },
  403: { description: 'Token is read-only', ...json(ref('Error')) },
  404: { description: 'Not found', ...json(ref('Error')) },
};

const appName = {
  name: 'name', in: 'path', required: true, description: 'App name',
  schema: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{1,30}$' },
};

function document(baseUrl) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'i9x API',
      version: BUILD_VERSION || '0.0.0',
      description:
        'Automation surface for a i9x host: deploy apps, inspect deployments, manage managed ' +
        'databases, trigger scheduled tasks and watch disk usage.\n\n' +
        'Authenticate with an API token created in Settings → API tokens:\n\n' +
        '```\ncurl -X POST -H "Authorization: Bearer i9x_1_…" \\\n' +
        '  https://panel.example.com/api/v1/apps/my-app/deploy\n```\n\n' +
        'Read-scoped tokens may only issue GET requests.',
    },
    servers: [{ url: baseUrl || '/', description: 'This i9x instance' }],
    security: [{ bearerAuth: [] }],
    tags: [
      { name: 'Meta' }, { name: 'Applications' }, { name: 'Databases' },
      { name: 'Scheduled tasks' }, { name: 'System' },
    ],
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'i9x_<id>_<secret>' } },
      schemas: {
        Error: { type: 'object', properties: { error: { type: 'string' } }, required: ['error'] },
        App: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            repo: { type: 'string' },
            branch: { type: 'string' },
            framework: { type: 'string', enum: ['next', 'vite', 'node', 'auto'] },
            port: { type: 'integer' },
            url: { type: 'string' },
            status: { type: 'string', enum: ['running', 'stopped', 'building', 'failed', 'unknown'] },
            envCount: { type: 'integer' },
            autodeploy: { type: 'boolean' },
            cpus: { type: 'string', description: 'CPU cap in cores, "" when unlimited' },
            memory: { type: 'string', description: 'Memory cap, e.g. 512m; "" when unlimited' },
            mountCount: { type: 'integer' },
            container: { type: 'string' },
            domains: {
              type: 'array',
              items: { type: 'object', properties: { domain: { type: 'string' }, https: { type: 'boolean' } } },
            },
            created: { type: 'integer', description: 'Unix milliseconds' },
          },
        },
        Deployment: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            app: { type: 'string' },
            number: { type: 'integer' },
            status: { type: 'string', enum: ['building', 'running', 'failed'] },
            trigger: { type: 'string', enum: ['create', 'manual', 'env', 'push', 'api'] },
            started: { type: 'integer' },
            finished: { type: 'integer', nullable: true },
          },
        },
        Database: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            engine: { type: 'string', enum: ['postgres', 'mysql', 'mariadb', 'redis', 'valkey', 'mongodb', 'clickhouse'] },
            version: { type: 'string' },
            port: { type: 'integer' },
            state: { type: 'string' },
            dbName: { type: 'string' },
            dbUser: { type: 'string' },
            container: { type: 'string', nullable: true },
            uri: { type: 'string', nullable: true, description: 'Connection URI, including the password' },
          },
        },
        Task: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            name: { type: 'string' },
            targetType: { type: 'string', enum: ['app', 'database', 'container', 'host'] },
            target: { type: 'string' },
            command: { type: 'string' },
            schedule: { type: 'string', description: '5-field cron expression' },
            enabled: { type: 'boolean' },
            timeout: { type: 'integer', description: 'Seconds' },
            lastRun: { type: 'integer', nullable: true },
            nextRun: { type: 'integer', nullable: true },
            lastStatus: { type: 'string', nullable: true, enum: ['success', 'failed', 'timeout', 'running', null] },
          },
        },
        TaskRun: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            taskId: { type: 'integer' },
            trigger: { type: 'string', enum: ['schedule', 'manual', 'api'] },
            status: { type: 'string', enum: ['running', 'success', 'failed', 'timeout'] },
            exitCode: { type: 'integer', nullable: true },
            started: { type: 'integer' },
            finished: { type: 'integer', nullable: true },
            output: { type: 'string' },
          },
        },
        Disk: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            filesystem: { type: 'string' },
            total: { type: 'integer' }, used: { type: 'integer' }, avail: { type: 'integer' },
            percent: { type: 'integer' },
          },
        },
      },
    },
    paths: {
      '/api/v1/version': {
        get: { tags: ['Meta'], summary: 'Panel and API version', responses: { 200: ok({ type: 'object' }) } },
      },
      '/api/v1/whoami': {
        get: {
          tags: ['Meta'], summary: 'Identity and scope behind the current credential',
          responses: { 200: ok({ type: 'object' }), 401: ERRORS[401] },
        },
      },
      '/api/v1/apps': {
        get: {
          tags: ['Applications'], summary: 'List deployed apps',
          responses: { 200: ok({ type: 'object', properties: { apps: { type: 'array', items: ref('App') } } }), 401: ERRORS[401] },
        },
      },
      '/api/v1/apps/{name}': {
        get: {
          tags: ['Applications'], summary: 'Get one app', parameters: [appName],
          responses: { 200: ok({ type: 'object', properties: { app: ref('App') } }), 404: ERRORS[404] },
        },
      },
      '/api/v1/apps/{name}/deploy': {
        post: {
          tags: ['Applications'],
          summary: 'Pull the latest commit, rebuild and redeploy',
          description: 'Returns as soon as the build is queued. Poll /deployments for the outcome.',
          parameters: [appName],
          responses: {
            200: ok({ type: 'object', properties: { ok: { type: 'boolean' }, building: { type: 'boolean' }, build: { type: 'integer' } } }),
            403: ERRORS[403], 404: ERRORS[404],
          },
        },
      },
      '/api/v1/apps/{name}/{action}': {
        post: {
          tags: ['Applications'], summary: 'Start, stop or restart the container',
          parameters: [appName, { name: 'action', in: 'path', required: true, schema: { type: 'string', enum: ['start', 'stop', 'restart'] } }],
          responses: { 200: ok({ type: 'object' }), 403: ERRORS[403], 404: ERRORS[404] },
        },
      },
      '/api/v1/apps/{name}/logs': {
        get: {
          tags: ['Applications'], summary: 'Container logs',
          parameters: [appName, { name: 'tail', in: 'query', schema: { type: 'integer', default: 300, maximum: 5000 } }],
          responses: { 200: ok({ type: 'object', properties: { text: { type: 'string' } } }), 404: ERRORS[404] },
        },
      },
      '/api/v1/apps/{name}/env': {
        get: {
          tags: ['Applications'], summary: 'Read environment variables', parameters: [appName],
          responses: { 200: ok({ type: 'object', properties: { env: { type: 'object', additionalProperties: { type: 'string' } } } }), 404: ERRORS[404] },
        },
        put: {
          tags: ['Applications'], summary: 'Merge or replace environment variables', parameters: [appName],
          requestBody: json({
            type: 'object',
            properties: {
              env: { type: 'object', additionalProperties: { type: 'string' } },
              replace: { type: 'boolean', default: false, description: 'Replace the whole set instead of merging' },
              rebuild: { type: 'boolean', default: false, description: 'Rebuild immediately so the values take effect' },
            },
            required: ['env'],
          }),
          responses: { 200: ok({ type: 'object' }), 400: ERRORS[400], 403: ERRORS[403], 404: ERRORS[404] },
        },
      },
      '/api/v1/apps/{name}/deployments': {
        get: {
          tags: ['Applications'], summary: 'Deployment history (newest first)', parameters: [appName],
          responses: { 200: ok({ type: 'object', properties: { deployments: { type: 'array', items: ref('Deployment') } } }), 404: ERRORS[404] },
        },
      },
      '/api/v1/apps/{name}/deployments/{number}': {
        get: {
          tags: ['Applications'], summary: 'One deployment and its build log',
          parameters: [appName, { name: 'number', in: 'path', required: true, schema: { type: 'integer' } }],
          responses: { 200: ok({ type: 'object', properties: { deployment: ref('Deployment'), log: { type: 'string' } } }), 404: ERRORS[404] },
        },
      },
      '/api/v1/databases': {
        get: {
          tags: ['Databases'], summary: 'List managed databases',
          responses: { 200: ok({ type: 'object', properties: { databases: { type: 'array', items: ref('Database') } } }), 401: ERRORS[401] },
        },
      },
      '/api/v1/databases/{name}/{action}': {
        post: {
          tags: ['Databases'], summary: 'Start, stop or restart an instance',
          parameters: [
            { name: 'name', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'action', in: 'path', required: true, schema: { type: 'string', enum: ['start', 'stop', 'restart'] } },
          ],
          responses: { 200: ok({ type: 'object' }), 403: ERRORS[403], 404: ERRORS[404] },
        },
      },
      '/api/v1/tasks': {
        get: {
          tags: ['Scheduled tasks'], summary: 'List scheduled tasks',
          responses: { 200: ok({ type: 'object', properties: { tasks: { type: 'array', items: ref('Task') } } }), 401: ERRORS[401] },
        },
      },
      '/api/v1/tasks/{id}/run': {
        post: {
          tags: ['Scheduled tasks'], summary: 'Run a task now',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
          responses: { 200: ok({ type: 'object', properties: { runId: { type: 'integer' }, status: { type: 'string' } } }), 403: ERRORS[403], 404: ERRORS[404] },
        },
      },
      '/api/v1/tasks/{id}/runs': {
        get: {
          tags: ['Scheduled tasks'], summary: 'Recent runs with their output',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
          responses: { 200: ok({ type: 'object', properties: { runs: { type: 'array', items: ref('TaskRun') } } }), 404: ERRORS[404] },
        },
      },
      '/api/v1/system': {
        get: {
          tags: ['System'], summary: 'Disk usage, Docker reclaimable space and cleanup state',
          responses: {
            200: ok({
              type: 'object',
              properties: {
                disk: { type: 'object', properties: { disks: { type: 'array', items: ref('Disk') }, worst: ref('Disk') } },
                reclaimable: { type: 'integer', description: 'Bytes Docker could free' },
              },
            }),
            401: ERRORS[401],
          },
        },
      },
      '/api/v1/maintenance/cleanup': {
        post: {
          tags: ['System'], summary: 'Run a Docker cleanup now',
          responses: { 200: ok({ type: 'object' }), 403: ERRORS[403] },
        },
      },
    },
  };
}

module.exports = { document };

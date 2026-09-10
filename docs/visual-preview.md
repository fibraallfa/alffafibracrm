# Local visual preview

Run from the Allfa Fibra repository:

```sh
CRM_VISUAL_PREVIEW=1 npm run dev -- --hostname 127.0.0.1 --port 3001
```

Open http://127.0.0.1:3001/dashboard. The dashboard uses labeled synthetic
data. The /conversas page also has synthetic contacts and messages. This preview covers the shared visual shell, inbox and dashboard, not complete
functional testing of every CRM module. Period filters do not change demo data.

The preview only activates in development on a loopback hostname. All API
requests except GET /api/auth/me, GET /api/dashboard and GET /api/conversations are blocked, including
webhooks, cron, authentication mutations and real data changes. Server actions
are also blocked. Production always retains the existing authentication rules.

Stop the server with Ctrl+C. Do not remove the preview flag to perform functional
tests unless the local environment uses an isolated test database and sandbox
integration credentials. The existing .env may point to production services.

Nothing is deployed by running this command. Review the visual changes locally
before committing or deploying.

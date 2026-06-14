// Production boot entry — the Dockerfile CMD. Imports the factory
// from index.ts (which is also what tests import) and starts the
// HTTP listener. Keeping the bind out of index.ts means tests can
// import the factory N times without racing on a port.

import { createApp } from "./index.js";

const PORT = Number(process.env.PORT ?? 8080);

createApp().listen(PORT, () => {
  console.info(
    "[cloud-run render started]",
    JSON.stringify({
      port: PORT,
      cron_secret_set: Boolean(process.env.CRON_SECRET),
      gcs_bucket_set: Boolean(process.env.GCS_BUCKET),
    }),
  );
});
